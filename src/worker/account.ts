import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import {
  ChangeResponse,
  StatusResponse,
  type BackupResponse,
  type DiagnosticsResponse,
  type PolicyResponse,
  type RelaxationSummary,
} from "../contracts/api.ts";
import {
  compareInstants,
  instantFromMilliseconds,
  instantPlusSeconds,
  instantToMilliseconds,
  type Instant,
} from "../domain/instants.ts";
import {
  applyOperation,
  classifyOperation,
  Operation,
  type OperationFailure,
  type OperationStrength,
} from "../domain/operations.ts";
import {
  COMPILER_VERSION,
  compilePolicy,
  compilationFailureMessage,
  type Compilation,
} from "../domain/plan.ts";
import { Policy, initialPolicy, makeRuleId, type RuleId } from "../domain/policy.ts";
import { decodeConfig, type AppConfig } from "./config.ts";
import { createLiveGateway, createSimulatedGateway, type GatewayAdapter } from "./gateway.ts";
import { sha256Hex } from "./http.ts";
import { reconcilePlan, type ReconcileOutcome } from "./reconciler.ts";
import { ServiceFailure, failed, succeeded, type ServiceResult } from "./service-result.ts";
import {
  AccountStore,
  FAILURE_STATE_CODE,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyRecord,
  type RelaxationRecord,
} from "./store.ts";

export const RELAXATION_EXPIRY_SECONDS = 604800;
export const RECONCILE_LIVENESS_SECONDS = 15;
export const OWNER_OBJECT_NAME = "owner";

export interface PolicyReadCommand {
  readonly ifNoneMatch: string | null;
}

export interface PolicyReadValue {
  readonly notModified: boolean;
  readonly etag: string;
  readonly policy: PolicyResponse["policy"];
}

export interface ChangeCommand {
  readonly operation: unknown;
  readonly baseRevision: number | null;
  readonly idempotencyKey: string;
}

export interface RelaxationCommand {
  readonly relaxationId: string;
  readonly baseRevision: number | null;
  readonly idempotencyKey: string;
}

export interface RestoreCommand {
  readonly policy: unknown;
  readonly baseRevision: number | null;
  readonly idempotencyKey: string;
}

export interface ReconcileCommand {
  readonly baseRevision: number | null;
  readonly idempotencyKey: string;
}

export type DebugCommand =
  | { readonly kind: "snapshot" }
  | { readonly kind: "clock"; readonly now: string }
  | { readonly kind: "advance"; readonly seconds: number }
  | {
      readonly kind: "fault";
      readonly operation: string;
      readonly timing: string;
      readonly error: string;
      readonly count: number;
    }
  | {
      readonly kind: "rule";
      readonly id: string;
      readonly name: string;
      readonly action: string;
      readonly precedence: number;
      readonly traffic: string;
      readonly enabled: number;
    }
  | { readonly kind: "deleteRule"; readonly id: string }
  | { readonly kind: "expressionBudget"; readonly value: number }
  | { readonly kind: "latency"; readonly value: number }
  | { readonly kind: "formatter"; readonly value: string };

export interface DebugSnapshot {
  readonly serverTime: string;
  readonly gatewayMode: string;
  readonly desiredRevision: number;
  readonly appliedRevision: number | null;
  readonly reconciliation: string;
  readonly simulatedRules: readonly {
    readonly id: string;
    readonly name: string;
    readonly action: string;
    readonly precedence: number;
    readonly traffic: string;
    readonly enabled: number;
  }[];
  readonly ownedResources: readonly {
    readonly logicalName: string;
    readonly cloudflareId: string;
    readonly appliedContentHash: string | null;
  }[];
}

const decodeOperation = Schema.decodeUnknownEither(Operation);
const decodePolicy = Schema.decodeUnknownEither(Policy);

const ChangeEnvelope = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(true), value: ChangeResponse }),
  Schema.Struct({ ok: Schema.Literal(false), failure: ServiceFailure }),
);

const StatusEnvelope = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(true), value: StatusResponse }),
  Schema.Struct({ ok: Schema.Literal(false), failure: ServiceFailure }),
);

const decodeChangeResult = (value: unknown): ServiceResult<ChangeResponse> | undefined => {
  const decoded = Schema.decodeUnknownEither(ChangeEnvelope)(value);
  return decoded._tag === "Left" ? undefined : decoded.right;
};

const decodeStatusResult = (value: unknown): ServiceResult<StatusResponse> | undefined => {
  const decoded = Schema.decodeUnknownEither(StatusEnvelope)(value);
  return decoded._tag === "Left" ? undefined : decoded.right;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

export class AccountDurableObject extends DurableObject<Env> {
  readonly #store: AccountStore;
  #configCache: AppConfig | null | undefined;
  #adapter: GatewayAdapter | undefined;
  #clockOverride: number | undefined;
  #expressionBudget: number | undefined;
  #reconcileInFlight: Promise<ReconcileOutcome> | undefined;
  #reconcileAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new AccountStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      this.#store.migrate();
    });
  }

  override async alarm(): Promise<void> {
    const config = this.#config();
    if (config === undefined) {
      return;
    }
    await this.#ensureInitialised(config);
    const now = this.#now();
    this.#store.expirePendingRelaxations(now);
    const state = this.#store.getAccountState();
    if (state === undefined) {
      return;
    }
    const dueForRetry = state.nextRetryAt !== null && compareInstants(now, state.nextRetryAt) >= 0;
    const neverAttempted = state.reconciliation === "applying";
    if (dueForRetry || neverAttempted) {
      await this.#runReconcile(config, true);
    }
    await this.#scheduleAlarm();
  }

  async readPolicy(command: PolicyReadCommand): Promise<ServiceResult<PolicyReadValue>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    await this.#ensureInitialised(config);
    const policy = this.#store.getDesiredPolicy();
    if (policy === undefined) {
      return failed({ type: "unavailable", code: FAILURE_STATE_CODE });
    }
    const etag = `"p-${policy.revision}"`;
    return succeeded({
      notModified: command.ifNoneMatch !== null && command.ifNoneMatch.trim() === etag,
      etag,
      policy,
    });
  }

  async submitChange(command: ChangeCommand): Promise<ServiceResult<ChangeResponse>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    await this.#ensureInitialised(config);
    const guarded = this.#validateMutation(command.baseRevision, command.idempotencyKey);
    if (guarded !== undefined) {
      return failed(guarded);
    }
    const decoded = decodeOperation(command.operation);
    if (decoded._tag === "Left") {
      return failed({ type: "invalid_request", detail: "The operation is not recognised." });
    }
    const baseRevision = command.baseRevision ?? 0;
    const operationHash = await sha256Hex(JSON.stringify(decoded.right));
    const requestHash = await sha256Hex(
      JSON.stringify({ kind: "change", baseRevision, operation: decoded.right }),
    );
    const replay = this.#replay(command.idempotencyKey, requestHash, decodeChangeResult);
    if (replay !== undefined) {
      return replay;
    }
    return this.#applyOrPropose(
      config,
      decoded.right,
      operationHash,
      baseRevision,
      command.idempotencyKey,
      requestHash,
    );
  }

  async confirmRelaxation(command: RelaxationCommand): Promise<ServiceResult<ChangeResponse>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    await this.#ensureInitialised(config);
    const guarded = this.#validateMutation(command.baseRevision, command.idempotencyKey);
    if (guarded !== undefined) {
      return failed(guarded);
    }
    if (!isUuid(command.relaxationId)) {
      return failed({
        type: "invalid_request",
        detail: "The relaxation identifier is malformed.",
      });
    }
    const baseRevision = command.baseRevision ?? 0;
    const requestHash = await sha256Hex(
      JSON.stringify({ kind: "confirm", relaxationId: command.relaxationId, baseRevision }),
    );
    const replay = this.#replay(command.idempotencyKey, requestHash, decodeChangeResult);
    if (replay !== undefined) {
      return replay;
    }
    const now = this.#now();
    this.#store.expirePendingRelaxations(now);
    const relaxation = this.#store.getRelaxation(command.relaxationId);
    if (relaxation === undefined) {
      return failed({ type: "not_found", id: command.relaxationId });
    }
    const state = this.#store.getAccountState();
    const policy = this.#store.getDesiredPolicy();
    if (state === undefined || policy === undefined) {
      return failed({ type: "unavailable", code: FAILURE_STATE_CODE });
    }
    if (relaxation.state !== "pending") {
      return failed({
        type: "conflict",
        detail: `The proposal is ${relaxation.state} and can no longer be confirmed.`,
      });
    }
    if (compareInstants(now, relaxation.requestedAt) < 0) {
      return failed({
        type: "conflict",
        detail: "Server time moved behind the request time; recreate the proposal.",
      });
    }
    if (compareInstants(now, relaxation.eligibleAt) < 0) {
      return failed({
        type: "conflict",
        detail: `The proposal becomes eligible at ${relaxation.eligibleAt}.`,
      });
    }
    if (compareInstants(now, relaxation.expiresAt) >= 0) {
      this.#store.resolveRelaxation(relaxation.id, "expired", null, now);
      return failed({ type: "conflict", detail: "The proposal has expired." });
    }
    if (relaxation.baseRevision !== baseRevision || state.desiredRevision !== baseRevision) {
      return failed({
        type: "stale_revision",
        expected: baseRevision,
        actual: state.desiredRevision,
      });
    }
    const applied = applyOperation(policy, relaxation.operation, {
      now,
      newRuleId: () => this.#newRuleId(),
    });
    if (!applied.ok) {
      this.#retireProposal(relaxation.id, now);
      return failed({
        type: "conflict",
        detail: "The proposal no longer applies to the current policy; it has been cancelled.",
      });
    }
    if (!applied.changed) {
      const unchangedResult: ChangeResponse = {
        id: relaxation.id,
        state: "unchanged",
        strength: relaxation.strength,
        baseRevision,
        desiredRevision: policy.revision,
        appliedRevision: state.appliedRevision,
        eligibleAt: relaxation.eligibleAt,
        relaxationId: relaxation.id,
      };
      this.#store.transactionSync(() => {
        this.#store.resolveRelaxation(relaxation.id, "confirmed", null, now);
        this.#store.putIdempotency({
          key: command.idempotencyKey,
          requestHash,
          resultJson: JSON.stringify(succeeded(unchangedResult)),
          now,
          expiresAt: instantPlusSeconds(now, IDEMPOTENCY_TTL_SECONDS),
        });
      });
      await this.#scheduleAlarm();
      return succeeded(unchangedResult);
    }
    const next = this.#withConfigEndpoint(applied.policy, config);
    const compilation = this.#compileFor(next, config);
    if (!compilation.ok) {
      this.#retireProposal(relaxation.id, now);
      return failed({
        type: "conflict",
        detail: compilationFailureMessage(compilation.failure),
      });
    }
    const result: ChangeResponse = {
      id: crypto.randomUUID(),
      state: "revised",
      strength: relaxation.strength,
      baseRevision,
      desiredRevision: next.revision,
      appliedRevision: state.appliedRevision,
      eligibleAt: relaxation.eligibleAt,
      relaxationId: relaxation.id,
    };
    const committed = this.#store.commitRevision({
      policy: next,
      compilerVersion: COMPILER_VERSION,
      now,
      relaxation: { id: relaxation.id, state: "confirmed", resolvedAt: now },
      idempotency: this.#idempotencyRecord(command.idempotencyKey, requestHash, result, now),
    });
    if (!committed.ok) {
      this.#retireProposal(relaxation.id, now);
      return failed({ type: "conflict", detail: "The revision already exists." });
    }
    const outcome = await this.#runReconcile(config, false);
    return this.#finalise(command.idempotencyKey, requestHash, result, outcome, now);
  }

  #retireProposal(id: string, now: Instant): void {
    this.#store.transactionSync(() => {
      this.#store.resolveRelaxation(id, "cancelled", null, now);
    });
  }

  async cancelRelaxation(command: RelaxationCommand): Promise<ServiceResult<StatusResponse>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    await this.#ensureInitialised(config);
    const guarded = this.#validateMutation(command.baseRevision, command.idempotencyKey);
    if (guarded !== undefined) {
      return failed(guarded);
    }
    if (!isUuid(command.relaxationId)) {
      return failed({
        type: "invalid_request",
        detail: "The relaxation identifier is malformed.",
      });
    }
    const baseRevision = command.baseRevision ?? 0;
    const requestHash = await sha256Hex(
      JSON.stringify({ kind: "cancel", relaxationId: command.relaxationId, baseRevision }),
    );
    const replay = this.#replay(command.idempotencyKey, requestHash, decodeStatusResult);
    if (replay !== undefined) {
      return replay;
    }
    const now = this.#now();
    this.#store.expirePendingRelaxations(now);
    const relaxation = this.#store.getRelaxation(command.relaxationId);
    if (relaxation === undefined) {
      return failed({ type: "not_found", id: command.relaxationId });
    }
    const state = this.#store.getAccountState();
    if (state === undefined) {
      return failed({ type: "unavailable", code: FAILURE_STATE_CODE });
    }
    if (relaxation.state !== "pending") {
      return failed({
        type: "conflict",
        detail: `The proposal is ${relaxation.state} and cannot be cancelled.`,
      });
    }
    if (baseRevision !== state.desiredRevision) {
      return failed({
        type: "stale_revision",
        expected: baseRevision,
        actual: state.desiredRevision,
      });
    }
    const raced = this.#store.transactionSync((): IdempotencyRecord | undefined => {
      const existing = this.#store.getIdempotency(command.idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      this.#store.resolveRelaxation(relaxation.id, "cancelled", null, now);
      this.#store.putIdempotency({
        key: command.idempotencyKey,
        requestHash,
        resultJson: JSON.stringify(succeeded(this.#statusValue(config, now))),
        now,
        expiresAt: instantPlusSeconds(now, IDEMPOTENCY_TTL_SECONDS),
      });
      return undefined;
    });
    if (raced !== undefined) {
      return this.#storedResult(raced, command.idempotencyKey, requestHash, decodeStatusResult);
    }
    await this.#scheduleAlarm();
    return succeeded(this.#statusValue(config, now));
  }

  async requestReconcile(command: ReconcileCommand): Promise<ServiceResult<StatusResponse>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    await this.#ensureInitialised(config);
    const guarded = this.#validateMutation(command.baseRevision, command.idempotencyKey);
    if (guarded !== undefined) {
      return failed(guarded);
    }
    const baseRevision = command.baseRevision ?? 0;
    const requestHash = await sha256Hex(JSON.stringify({ kind: "reconcile", baseRevision }));
    const replay = this.#replay(command.idempotencyKey, requestHash, decodeStatusResult);
    if (replay !== undefined) {
      return replay;
    }
    const state = this.#store.getAccountState();
    if (state === undefined) {
      return failed({ type: "unavailable", code: FAILURE_STATE_CODE });
    }
    if (baseRevision !== state.desiredRevision) {
      return failed({
        type: "stale_revision",
        expected: baseRevision,
        actual: state.desiredRevision,
      });
    }
    const now = this.#now();
    await this.#runReconcile(config, true);
    const status = this.#statusValue(config, this.#now());
    this.#store.putIdempotency({
      key: command.idempotencyKey,
      requestHash,
      resultJson: JSON.stringify(succeeded(status)),
      now,
      expiresAt: instantPlusSeconds(now, IDEMPOTENCY_TTL_SECONDS),
    });
    return succeeded(status);
  }

  async restorePolicy(command: RestoreCommand): Promise<ServiceResult<ChangeResponse>> {
    const decoded = decodePolicy(command.policy);
    if (decoded._tag === "Left") {
      return failed({
        type: "invalid_request",
        detail: "The backup document is not a valid policy.",
      });
    }
    return this.submitChange({
      operation: { type: "restorePolicy", policy: decoded.right },
      baseRevision: command.baseRevision,
      idempotencyKey: command.idempotencyKey,
    });
  }

  async readStatus(): Promise<ServiceResult<StatusResponse>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    await this.#ensureInitialised(config);
    const now = this.#now();
    this.#store.expirePendingRelaxations(now);
    return succeeded(this.#statusValue(config, now));
  }

  #statusValue(config: AppConfig, now: Instant): StatusResponse {
    const state = this.#store.getAccountState();
    const desiredRevision = state === undefined ? 1 : state.desiredRevision;
    return {
      serverTime: now,
      desiredRevision,
      gatewayAppliedRevision: state === undefined ? null : state.appliedRevision,
      reconciliation: state === undefined ? "degraded" : state.reconciliation,
      gatewayMode: config.gatewayMode,
      lastErrorCode: state === undefined ? FAILURE_STATE_CODE : state.lastErrorCode,
      nextRetryAt: state === undefined ? null : state.nextRetryAt,
      relaxations: this.#relaxationSummaries(now, desiredRevision),
    };
  }

  async readDiagnostics(): Promise<ServiceResult<DiagnosticsResponse>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    await this.#ensureInitialised(config);
    const state = this.#store.getAccountState();
    const policy = this.#store.getDesiredPolicy();
    if (state === undefined || policy === undefined) {
      return failed({ type: "unavailable", code: FAILURE_STATE_CODE });
    }
    const compilation = this.#compileFor(policy, config);
    const plan = compilation.ok ? compilation.plan : undefined;
    const job = this.#store.getJob(state.desiredRevision);
    return succeeded({
      serverTime: this.#now(),
      gatewayMode: config.gatewayMode,
      compilerVersion: plan?.compilerVersion ?? COMPILER_VERSION,
      locationSubdomain: plan?.locationSubdomain ?? config.locationSubdomain,
      planRevision: policy.revision,
      planFailure: compilation.ok ? null : compilationFailureMessage(compilation.failure),
      planRules:
        plan === undefined
          ? []
          : plan.rules.map((rule) => ({
              logicalName: rule.logicalName,
              action: rule.action,
              precedence: rule.precedence,
              traffic: rule.traffic,
            })),
      suppressedAllows:
        plan === undefined
          ? []
          : plan.suppressedAllows.map((entry) => ({
              hostname: entry.hostname,
              scope: entry.scope,
              supersededBy: entry.supersededBy,
            })),
      ownedResources: this.#store.listResources().map((resource) => ({
        logicalName: resource.logicalName,
        cloudflareId: resource.cloudflareId,
        appliedContentHash: resource.appliedContentHash,
      })),
      reconciliationJob:
        job === undefined
          ? null
          : {
              revision: job.revision,
              stage: job.stage,
              attempt: job.attempt,
              updatedAt: job.updatedAt,
            },
    });
  }

  async exportBackup(): Promise<ServiceResult<BackupResponse>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    await this.#ensureInitialised(config);
    const policy = this.#store.getDesiredPolicy();
    if (policy === undefined) {
      return failed({ type: "unavailable", code: FAILURE_STATE_CODE });
    }
    return succeeded({
      exportedAt: this.#now(),
      sourceRevision: policy.revision,
      policy,
    });
  }

  async debug(command: DebugCommand): Promise<ServiceResult<DebugSnapshot>> {
    const config = this.#config();
    if (config === undefined) {
      return this.#configFailure();
    }
    if (config.environment !== "local" || config.gatewayMode !== "simulated") {
      return failed({
        type: "conflict",
        detail: "Local debug commands require local mode with a simulated Gateway.",
      });
    }
    await this.#ensureInitialised(config);
    switch (command.kind) {
      case "clock": {
        const parsed = Date.parse(command.now);
        if (Number.isSafeInteger(parsed)) {
          this.#clockOverride = parsed;
        }
        break;
      }
      case "advance": {
        const base = this.#clockOverride ?? Date.now();
        this.#clockOverride = base + command.seconds * 1000;
        break;
      }
      case "fault": {
        this.#store.addSimulatedFault({
          operation: command.operation,
          timing: command.timing,
          error: command.error,
          remaining: command.count,
        });
        break;
      }
      case "rule": {
        this.#store.putSimulatedRule({
          id: command.id,
          name: command.name,
          action: command.action,
          precedence: command.precedence,
          traffic: command.traffic,
          enabled: command.enabled,
        });
        break;
      }
      case "deleteRule": {
        this.#store.deleteSimulatedRule(command.id);
        break;
      }
      case "expressionBudget": {
        this.#expressionBudget = command.value;
        break;
      }
      case "latency": {
        this.#store.setSimulatedSetting("latency", String(command.value));
        break;
      }
      case "formatter": {
        this.#store.setSimulatedSetting("formatter", command.value);
        break;
      }
      case "snapshot": {
        break;
      }
    }
    return succeeded(this.#snapshot(config));
  }

  #snapshot(config: AppConfig): DebugSnapshot {
    const state = this.#store.getAccountState();
    return {
      serverTime: this.#now(),
      gatewayMode: config.gatewayMode,
      desiredRevision: state?.desiredRevision ?? 0,
      appliedRevision: state?.appliedRevision ?? null,
      reconciliation: state?.reconciliation ?? "degraded",
      simulatedRules: this.#store.listSimulatedRules(),
      ownedResources: this.#store.listResources().map((resource) => ({
        logicalName: resource.logicalName,
        cloudflareId: resource.cloudflareId,
        appliedContentHash: resource.appliedContentHash,
      })),
    };
  }

  #config(): AppConfig | undefined {
    if (this.#configCache === undefined) {
      const decoded = decodeConfig(this.env);
      this.#configCache = decoded.ok ? decoded.config : null;
    }
    return this.#configCache === null ? undefined : this.#configCache;
  }

  #configFailure<T>(): ServiceResult<T> {
    const decoded = decodeConfig(this.env);
    return failed(
      decoded.ok
        ? { type: "config", missing: [], detail: "Configuration rejected." }
        : {
            type: "config",
            missing: decoded.rejection.missing,
            detail: decoded.rejection.detail,
          },
    );
  }

  #now(): Instant {
    return instantFromMilliseconds(this.#clockOverride ?? Date.now());
  }

  #newRuleId(): RuleId {
    return makeRuleId(crypto.randomUUID());
  }

  #withConfigEndpoint(policy: Policy, config: AppConfig): Policy {
    return policy.dnsEndpoint === config.dnsEndpoint
      ? policy
      : { ...policy, dnsEndpoint: config.dnsEndpoint };
  }

  #compileFor(policy: Policy, config: AppConfig): Compilation {
    return compilePolicy({
      policy,
      locationSubdomain: config.locationSubdomain,
      precedenceBase: config.precedenceBase,
      ...(this.#expressionBudget === undefined
        ? {}
        : { expressionBudget: this.#expressionBudget }),
    });
  }

  #validateMutation(
    baseRevision: number | null,
    idempotencyKey: string,
  ): ServiceFailure | undefined {
    if (baseRevision === null) {
      return { type: "precondition_required", header: "If-Match" };
    }
    if (!isUuid(idempotencyKey)) {
      return { type: "invalid_request", detail: "Idempotency-Key must be a UUID." };
    }
    return undefined;
  }

  #storedResult<T>(
    record: IdempotencyRecord,
    key: string,
    requestHash: string,
    decode: (value: unknown) => ServiceResult<T> | undefined,
  ): ServiceResult<T> {
    if (record.requestHash !== requestHash) {
      return failed({ type: "idempotency_conflict", key });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.resultJson);
    } catch {
      return failed({ type: "unavailable", code: "idempotency_unreadable" });
    }
    return decode(parsed) ?? failed({ type: "unavailable", code: "idempotency_unreadable" });
  }

  #replay<T>(
    key: string,
    requestHash: string,
    decode: (value: unknown) => ServiceResult<T> | undefined,
  ): ServiceResult<T> | undefined {
    const record = this.#store.getIdempotency(key);
    return record === undefined
      ? undefined
      : this.#storedResult(record, key, requestHash, decode);
  }

  #idempotencyRecord(
    key: string,
    requestHash: string,
    result: ChangeResponse,
    now: Instant,
  ): {
    readonly key: string;
    readonly requestHash: string;
    readonly resultJson: string;
    readonly expiresAt: Instant;
  } {
    return {
      key,
      requestHash,
      resultJson: JSON.stringify(succeeded(result)),
      expiresAt: instantPlusSeconds(now, IDEMPOTENCY_TTL_SECONDS),
    };
  }

  async #applyOrPropose(
    config: AppConfig,
    operation: Operation,
    operationHash: string,
    baseRevision: number,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ServiceResult<ChangeResponse>> {
    const state = this.#store.getAccountState();
    const policy = this.#store.getDesiredPolicy();
    if (state === undefined || policy === undefined) {
      return failed({ type: "unavailable", code: FAILURE_STATE_CODE });
    }
    if (baseRevision !== state.desiredRevision) {
      return failed({
        type: "stale_revision",
        expected: baseRevision,
        actual: state.desiredRevision,
      });
    }
    const now = this.#now();
    const applied = applyOperation(policy, operation, {
      now,
      newRuleId: () => this.#newRuleId(),
    });
    if (!applied.ok) {
      return failed(this.#mapOperationFailure(applied.failure));
    }
    const strength = classifyOperation(policy, operation);
    if (!applied.changed) {
      return this.#unchanged(policy, strength, baseRevision, idempotencyKey, requestHash, now);
    }
    const outcomePolicy = this.#withConfigEndpoint(applied.policy, config);
    const compilation = this.#compileFor(outcomePolicy, config);
    if (!compilation.ok) {
      return failed({
        type: "conflict",
        detail: compilationFailureMessage(compilation.failure),
      });
    }
    if (strength === "weaker") {
      const relaxationId = crypto.randomUUID();
      const eligibleAt = instantPlusSeconds(now, policy.cooldownSeconds);
      const expiresAt = instantPlusSeconds(eligibleAt, RELAXATION_EXPIRY_SECONDS);
      const result: ChangeResponse = {
        id: relaxationId,
        state: "pendingRelaxation",
        strength,
        baseRevision,
        desiredRevision: null,
        appliedRevision: state.appliedRevision,
        eligibleAt,
        relaxationId,
      };
      const relaxationRecord: RelaxationRecord = {
        id: relaxationId,
        baseRevision,
        operation,
        operationHash,
        strength,
        state: "pending",
        requestedAt: now,
        eligibleAt,
        expiresAt,
        resultingRevision: null,
      };
      const raced = this.#store.transactionSync((): IdempotencyRecord | undefined => {
        const existing = this.#store.getIdempotency(idempotencyKey);
        if (existing !== undefined) {
          return existing;
        }
        this.#store.insertRelaxation(relaxationRecord);
        this.#store.putIdempotency({
          key: idempotencyKey,
          requestHash,
          resultJson: JSON.stringify(succeeded(result)),
          now,
          expiresAt: instantPlusSeconds(now, IDEMPOTENCY_TTL_SECONDS),
        });
        return undefined;
      });
      if (raced !== undefined) {
        return this.#storedResult(raced, idempotencyKey, requestHash, decodeChangeResult);
      }
      await this.#scheduleAlarm();
      return succeeded(result);
    }
    const result: ChangeResponse = {
      id: crypto.randomUUID(),
      state: "revised",
      strength,
      baseRevision,
      desiredRevision: outcomePolicy.revision,
      appliedRevision: state.appliedRevision,
      eligibleAt: null,
      relaxationId: null,
    };
    const committed = this.#store.commitRevision({
      policy: outcomePolicy,
      compilerVersion: COMPILER_VERSION,
      now,
      idempotency: this.#idempotencyRecord(idempotencyKey, requestHash, result, now),
    });
    if (!committed.ok) {
      return failed({ type: "conflict", detail: "The revision already exists." });
    }
    const outcome = await this.#runReconcile(config, false);
    return this.#finalise(idempotencyKey, requestHash, result, outcome, now);
  }

  #unchanged(
    policy: Policy,
    strength: OperationStrength,
    baseRevision: number,
    idempotencyKey: string,
    requestHash: string,
    now: Instant,
  ): ServiceResult<ChangeResponse> {
    const state = this.#store.getAccountState();
    const result: ChangeResponse = {
      id: crypto.randomUUID(),
      state: "unchanged",
      strength,
      baseRevision,
      desiredRevision: policy.revision,
      appliedRevision: state === undefined ? null : state.appliedRevision,
      eligibleAt: null,
      relaxationId: null,
    };
    const raced = this.#store.transactionSync((): IdempotencyRecord | undefined => {
      const existing = this.#store.getIdempotency(idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      this.#store.putIdempotency({
        key: idempotencyKey,
        requestHash,
        resultJson: JSON.stringify(succeeded(result)),
        now,
        expiresAt: instantPlusSeconds(now, IDEMPOTENCY_TTL_SECONDS),
      });
      return undefined;
    });
    return raced === undefined
      ? succeeded(result)
      : this.#storedResult(raced, idempotencyKey, requestHash, decodeChangeResult);
  }

  #finalise(
    key: string,
    requestHash: string,
    result: ChangeResponse,
    outcome: ReconcileOutcome,
    now: Instant,
  ): ServiceResult<ChangeResponse> {
    const final: ChangeResponse = { ...result, appliedRevision: outcome.appliedRevision };
    this.#store.putIdempotency({
      key,
      requestHash,
      resultJson: JSON.stringify(succeeded(final)),
      now,
      expiresAt: instantPlusSeconds(now, IDEMPOTENCY_TTL_SECONDS),
    });
    return succeeded(final);
  }

  #mapOperationFailure(failure: OperationFailure): ServiceFailure {
    switch (failure.type) {
      case "RuleNotFound":
        return { type: "not_found", id: failure.ruleId };
      case "InvalidHostname":
        return { type: "invalid_request", detail: `Hostname rejected: ${failure.reason}.` };
      case "RuleLimit":
        return { type: "conflict", detail: "The policy rule limit is reached." };
      case "BackupEndpointMismatch":
        return {
          type: "conflict",
          detail: "The backup belongs to a different Gateway endpoint.",
        };
      case "RuleConflict":
        return {
          type: "conflict",
          detail: "The rule conflicts with an existing entry for the same hostname and scope.",
        };
    }
  }

  #relaxationSummaries(now: Instant, desiredRevision: number): readonly RelaxationSummary[] {
    return this.#store.listRelaxations().map((relaxation) => ({
      id: relaxation.id,
      baseRevision: relaxation.baseRevision,
      operation: relaxation.operation,
      strength: relaxation.strength,
      state: relaxation.state,
      requestedAt: relaxation.requestedAt,
      eligibleAt: relaxation.eligibleAt,
      expiresAt: relaxation.expiresAt,
      resultingRevision: relaxation.resultingRevision,
      operationHash: relaxation.operationHash,
      canConfirm:
        relaxation.state === "pending" &&
        compareInstants(now, relaxation.eligibleAt) >= 0 &&
        compareInstants(now, relaxation.expiresAt) < 0 &&
        relaxation.baseRevision === desiredRevision,
    }));
  }

  #adapterFor(config: AppConfig): GatewayAdapter {
    if (this.#adapter === undefined) {
      this.#adapter =
        config.gatewayMode === "live"
          ? createLiveGateway({
              accountId: config.accountId,
              apiToken: config.apiToken,
              fetcher: (url, init) => fetch(url, init),
            })
          : createSimulatedGateway({ sql: this.ctx.storage.sql });
    }
    return this.#adapter;
  }

  async #ensureInitialised(config: AppConfig): Promise<void> {
    if (this.#store.getAccountState() !== undefined) {
      return;
    }
    const now = this.#now();
    const seeded = this.#withConfigEndpoint(
      initialPolicy({ dnsEndpoint: config.dnsEndpoint, now }),
      config,
    );
    this.#store.initialise(seeded, COMPILER_VERSION, now);
    await this.#runReconcile(config, false);
  }

  async #reconcile(config: AppConfig, verify: boolean): Promise<ReconcileOutcome> {
    const state = this.#store.getAccountState();
    const policy = state === undefined ? undefined : this.#store.getPolicy(state.desiredRevision);
    if (state === undefined || policy === undefined) {
      return {
        state: "degraded",
        appliedRevision: null,
        errorCode: FAILURE_STATE_CODE,
        retryAt: null,
      };
    }
    const compilation = this.#compileFor(policy, config);
    if (!compilation.ok) {
      this.#store.setReconciliation("degraded", "plan_invalid", null);
      return {
        state: "degraded",
        appliedRevision: state.appliedRevision,
        errorCode: "plan_invalid",
        retryAt: null,
      };
    }
    const outcome = await reconcilePlan({
      store: this.#store,
      adapter: this.#adapterFor(config),
      plan: compilation.plan,
      desiredRevision: state.desiredRevision,
      now: this.#now(),
      verify,
    });
    return outcome;
  }

  #desiredPending(): boolean {
    const state = this.#store.getAccountState();
    if (state === undefined) {
      return false;
    }
    return (
      state.desiredRevision !== state.appliedRevision ||
      this.#store.getJob(state.desiredRevision) !== undefined
    );
  }

  #runReconcile(config: AppConfig, verify: boolean): Promise<ReconcileOutcome> {
    const existing = this.#reconcileInFlight;
    if (existing !== undefined) {
      this.#reconcileAgain = true;
      return existing;
    }
    const run = this.#reconcileLoop(config, verify).finally(() => {
      this.#reconcileInFlight = undefined;
      this.#reconcileAgain = false;
    });
    this.#reconcileInFlight = run;
    return run;
  }

  async #armReconcileAlarm(): Promise<void> {
    const state = this.#store.getAccountState();
    if (state === undefined) {
      return;
    }
    const pending = state.reconciliation === "applying" || state.nextRetryAt !== null;
    if (!pending) {
      return;
    }
    await this.ctx.storage.setAlarm(
      instantToMilliseconds(instantPlusSeconds(this.#now(), RECONCILE_LIVENESS_SECONDS)),
    );
  }

  async #reconcileLoop(config: AppConfig, verify: boolean): Promise<ReconcileOutcome> {
    await this.#armReconcileAlarm();
    let outcome = await this.#reconcile(config, verify);
    for (let pass = 0; pass < 8 && outcome.state !== "degraded"; pass += 1) {
      const pending = this.#reconcileAgain || this.#desiredPending();
      this.#reconcileAgain = false;
      if (!pending) {
        break;
      }
      outcome = await this.#reconcile(config, verify);
    }
    await this.#scheduleAlarm();
    return outcome;
  }

  async #scheduleAlarm(): Promise<void> {
    const state = this.#store.getAccountState();
    const candidates: number[] = [];
    if (state !== undefined) {
      if (state.nextRetryAt !== null) {
        candidates.push(instantToMilliseconds(state.nextRetryAt));
      }
      if (
        state.reconciliation === "applying" &&
        state.desiredRevision !== state.appliedRevision
      ) {
        candidates.push(instantToMilliseconds(this.#now()));
      }
    }
    const expiry = this.#store.earliestPendingExpiry();
    if (expiry !== undefined) {
      candidates.push(instantToMilliseconds(expiry));
    }
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }
}
