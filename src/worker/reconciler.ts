import { Effect, Either } from "effect";
import type { ReconciliationState } from "../contracts/api.ts";
import { instantFromMilliseconds, instantToMilliseconds, type Instant } from "../domain/instants.ts";
import { compiledRuleCanonical, type CompiledPlan } from "../domain/plan.ts";
import { trafficEquivalent } from "../domain/traffic.ts";
import {
  isPermanentErrorCode,
  logicalNameFor,
  remoteRuleCanonical,
  ruleNameFor,
  type GatewayAdapter,
  type GatewayError,
  type RemoteRule,
} from "./gateway.ts";
import { sha256Hex } from "./http.ts";
import { FAILURE_STATE_CODE, type AccountStore, type OwnedResource, type ReconcileJob } from "./store.ts";

const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 900;

const MISMATCH_CODES = new Set([
  "gateway_readback_missing",
  "gateway_readback_mismatch",
  "drift",
  "collision",
]);

export interface ReconcileOutcome {
  readonly state: ReconciliationState;
  readonly appliedRevision: number | null;
  readonly errorCode: string | null;
  readonly retryAt: Instant | null;
}

export const backoffSeconds = (attempt: number): number =>
  Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_SECONDS);

const runGateway = <A>(
  effect: Effect.Effect<A, GatewayError>,
): Promise<Either.Either<A, GatewayError>> => Effect.runPromise(Effect.either(effect));

export interface ReconcileInput {
  readonly store: AccountStore;
  readonly adapter: GatewayAdapter;
  readonly plan: CompiledPlan;
  readonly desiredRevision: number;
  readonly now: Instant;
  readonly verify: boolean;
}

export const reconcilePlan = async (input: ReconcileInput): Promise<ReconcileOutcome> => {
  const { store, adapter, plan, desiredRevision, now, verify } = input;
  const state = store.getAccountState();
  if (state === undefined) {
    return {
      state: "degraded",
      appliedRevision: null,
      errorCode: FAILURE_STATE_CODE,
      retryAt: null,
    };
  }
  const currentJob = store.getJob(desiredRevision);
  if (!verify && state.appliedRevision === desiredRevision && currentJob === undefined) {
    return { state: "idle", appliedRevision: desiredRevision, errorCode: null, retryAt: null };
  }

  const job: ReconcileJob =
    currentJob ?? {
      revision: desiredRevision,
      stage: "apply",
      completed: [],
      attempt: 0,
      updatedAt: now,
    };
  const completed = new Set(job.completed);
  const resources = new Map<string, OwnedResource>();
  for (const resource of store.listResources()) {
    resources.set(resource.logicalName, resource);
  }
  const planNames = new Set(plan.rules.map((rule) => rule.logicalName));

  const degrade = (code: string, attempt: number): ReconcileOutcome => {
    const permanent = isPermanentErrorCode(code);
    const retryAt = permanent
      ? null
      : instantFromMilliseconds(instantToMilliseconds(now) + backoffSeconds(attempt) * 1000);
    const mismatch = MISMATCH_CODES.has(code);
    if (mismatch) {
      store.clearApplied();
    }
    store.setReconciliation("degraded", code, retryAt);
    store.saveJob({ ...job, attempt, updatedAt: now, completed: [...completed] });
    return {
      state: "degraded",
      appliedRevision: mismatch ? null : state.appliedRevision,
      errorCode: code,
      retryAt,
    };
  };

  const preflight = await runGateway(adapter.listOwnedRules());
  if (Either.isLeft(preflight)) {
    return degrade(preflight.left.code, job.attempt + 1);
  }
  const remoteLogicalNames = new Set<string>();
  for (const remote of preflight.right) {
    const logical = logicalNameFor(remote.name);
    if (logical === undefined) {
      continue;
    }
    remoteLogicalNames.add(logical);
    const recorded = resources.get(logical);
    if (recorded === undefined && !planNames.has(logical)) {
      return degrade("drift", job.attempt + 1);
    }
    if (recorded !== undefined && recorded.cloudflareId !== remote.id) {
      return degrade("collision", job.attempt + 1);
    }
  }
  for (const resource of resources.values()) {
    if (planNames.has(resource.logicalName) && !remoteLogicalNames.has(resource.logicalName)) {
      return degrade("collision", job.attempt + 1);
    }
  }

  for (const rule of plan.rules) {
    const recorded = resources.get(rule.logicalName);
    if (recorded !== undefined && completed.has(rule.logicalName)) {
      continue;
    }
    const ensured = await runGateway(
      adapter.upsertRule({
        logicalName: rule.logicalName,
        action: rule.action,
        precedence: rule.precedence,
        traffic: rule.traffic,
      }),
    );
    if (Either.isLeft(ensured)) {
      return degrade(ensured.left.code, job.attempt + 1);
    }
    const remote = ensured.right;
    if (remote.name !== ruleNameFor(rule.logicalName)) {
      return degrade("drift", job.attempt + 1);
    }
    if (recorded !== undefined && recorded.cloudflareId !== remote.id) {
      return degrade("collision", job.attempt + 1);
    }
    if (remote.action !== rule.action || !trafficEquivalent(rule.traffic, remote.traffic)) {
      return degrade("gateway_readback_mismatch", job.attempt + 1);
    }
    const resource: OwnedResource = {
      logicalName: rule.logicalName,
      cloudflareId: remote.id,
      appliedContentHash: await sha256Hex(compiledRuleCanonical(rule)),
      remoteCanonical: remoteRuleCanonical(rule.logicalName, remote),
    };
    store.upsertResource(resource, now);
    resources.set(rule.logicalName, resource);
    completed.add(rule.logicalName);
    store.saveJob({ ...job, completed: [...completed], updatedAt: now });
  }

  const stale: string[] = [];
  for (const resource of [...resources.values()]) {
    if (planNames.has(resource.logicalName)) {
      continue;
    }
    const deleted = await runGateway(adapter.deleteRule(resource.cloudflareId));
    if (Either.isLeft(deleted)) {
      return degrade(deleted.left.code, job.attempt + 1);
    }
    store.deleteResource(resource.logicalName);
    resources.delete(resource.logicalName);
    stale.push(resource.logicalName);
  }

  const listed = await runGateway(adapter.listOwnedRules());
  if (Either.isLeft(listed)) {
    return degrade(listed.left.code, job.attempt + 1);
  }
  const remoteByName = new Map<string, RemoteRule>();
  for (const rule of listed.right) {
    const logical = logicalNameFor(rule.name);
    if (logical === undefined) {
      continue;
    }
    remoteByName.set(logical, rule);
  }
  if (remoteByName.size !== listed.right.length) {
    return degrade("drift", job.attempt + 1);
  }

  let previousPrecedence: number | null = null;
  for (const rule of plan.rules) {
    const remote = remoteByName.get(rule.logicalName);
    if (remote === undefined || !remote.enabled) {
      return degrade("gateway_readback_missing", job.attempt + 1);
    }
    const resource = resources.get(rule.logicalName);
    if (resource === undefined || resource.cloudflareId !== remote.id) {
      return degrade("collision", job.attempt + 1);
    }
    if (remote.action !== rule.action || !trafficEquivalent(rule.traffic, remote.traffic)) {
      return degrade("gateway_readback_mismatch", job.attempt + 1);
    }
    if (previousPrecedence !== null && remote.precedence <= previousPrecedence) {
      return degrade("gateway_readback_mismatch", job.attempt + 1);
    }
    previousPrecedence = remote.precedence;
    const acknowledged = remoteRuleCanonical(rule.logicalName, remote);
    if (resource.remoteCanonical === null) {
      store.updateRemoteCanonical(rule.logicalName, acknowledged, now);
    } else if (resource.remoteCanonical !== acknowledged) {
      return degrade("gateway_readback_mismatch", job.attempt + 1);
    }
  }
  for (const logical of remoteByName.keys()) {
    if (!planNames.has(logical)) {
      return degrade("drift", job.attempt + 1);
    }
  }
  for (const logical of stale) {
    if (remoteByName.has(logical)) {
      return degrade("gateway_readback_mismatch", job.attempt + 1);
    }
  }

  store.setApplied(desiredRevision);
  return { state: "idle", appliedRevision: desiredRevision, errorCode: null, retryAt: null };
};
