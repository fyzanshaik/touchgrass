import { Schema } from "effect";
import { Instant } from "../domain/instants.ts";
import { Operation } from "../domain/operations.ts";
import type { OperationStrength } from "../domain/operations.ts";
import { Policy } from "../domain/policy.ts";
import type { ReconciliationState, RelaxationState } from "../contracts/api.ts";
import type { DbRow } from "./sql.ts";

export const SCHEMA_VERSION = 2;
export const IDEMPOTENCY_TTL_SECONDS = 86400;
export const FAILURE_STATE_CODE = "state_unreadable";

export interface AccountState {
  readonly desiredRevision: number;
  readonly appliedRevision: number | null;
  readonly reconciliation: ReconciliationState;
  readonly nextRetryAt: Instant | null;
  readonly lastErrorCode: string | null;
}

export interface OwnedResource {
  readonly logicalName: string;
  readonly cloudflareId: string;
  readonly appliedContentHash: string | null;
  readonly remoteCanonical: string | null;
}

export interface ReconcileJob {
  readonly revision: number;
  readonly stage: string;
  readonly completed: readonly string[];
  readonly attempt: number;
  readonly updatedAt: Instant;
}

export interface RelaxationRecord {
  readonly id: string;
  readonly baseRevision: number;
  readonly operation: Operation;
  readonly operationHash: string;
  readonly strength: OperationStrength;
  readonly state: RelaxationState;
  readonly requestedAt: Instant;
  readonly eligibleAt: Instant;
  readonly expiresAt: Instant;
  readonly resultingRevision: number | null;
}

export interface IdempotencyRecord {
  readonly requestHash: string;
  readonly resultJson: string;
}

export type CommitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "revision_exists" };

interface StateRow {
  readonly desired_revision: number;
  readonly gateway_applied_revision: number | null;
  readonly reconciliation_state: string;
  readonly next_retry_at: string | null;
  readonly last_error_code: string | null;
}

interface PolicyRow {
  readonly policy_json: string;
}

interface ResourceRow {
  readonly logical_name: string;
  readonly cloudflare_id: string;
  readonly applied_content_hash: string | null;
  readonly remote_canonical: string | null;
}

interface JobRow {
  readonly stage: string;
  readonly checkpoint_json: string;
  readonly attempt: number;
  readonly updated_at: string;
}

interface RelaxationRow {
  readonly id: string;
  readonly base_revision: number;
  readonly operation_json: string;
  readonly operation_hash: string;
  readonly strength: string;
  readonly state: string;
  readonly requested_at: string;
  readonly eligible_at: string;
  readonly expires_at: string;
  readonly resulting_revision: number | null;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly result_json: string;
}

interface SimulatedRuleRow {
  readonly id: string;
  readonly name: string;
  readonly action: string;
  readonly precedence: number;
  readonly traffic: string;
  readonly enabled: number;
}

const Checkpoint = Schema.Struct({ completed: Schema.Array(Schema.String) });

const decodePolicyOption = Schema.decodeUnknownOption(Policy);
const decodeOperationOption = Schema.decodeUnknownOption(Operation);
const decodeInstantOption = Schema.decodeUnknownOption(Instant);

const asInstant = (value: string | null): Instant | undefined => {
  if (value === null) {
    return undefined;
  }
  const decoded = decodeInstantOption(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

const reconciliationStateOf = (value: string): ReconciliationState => {
  switch (value) {
    case "idle":
    case "applying":
    case "degraded":
      return value;
    default:
      return "degraded";
  }
};

const relaxationStateOf = (value: string): RelaxationState => {
  switch (value) {
    case "pending":
    case "cancelled":
    case "confirmed":
    case "expired":
      return value;
    default:
      return "expired";
  }
};

const strengthOf = (value: string): OperationStrength => {
  switch (value) {
    case "stronger":
    case "weaker":
    case "unchanged":
      return value;
    default:
      return "weaker";
  }
};

const parseCompleted = (value: string): readonly string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  const decoded = Schema.decodeUnknownOption(Checkpoint)(parsed);
  return decoded._tag === "Some" ? decoded.value.completed : [];
};

export interface RelaxationResolution {
  readonly id: string;
  readonly state: RelaxationState;
  readonly resolvedAt: Instant;
}

export interface CommitRevisionInput {
  readonly policy: Policy;
  readonly compilerVersion: string;
  readonly now: Instant;
  readonly relaxation?: RelaxationResolution;
  readonly idempotency?: {
    readonly key: string;
    readonly requestHash: string;
    readonly resultJson: string;
    readonly expiresAt: Instant;
  };
}

export class AccountStore {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
  }

  transactionSync<T>(run: () => T): T {
    return this.#storage.transactionSync(run);
  }

  migrate(): void {
    const statements = [
      `CREATE TABLE IF NOT EXISTS _schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS policy_revisions (
        revision INTEGER PRIMARY KEY,
        policy_json TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS account_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        desired_revision INTEGER NOT NULL,
        gateway_applied_revision INTEGER,
        reconciliation_state TEXT NOT NULL,
        next_retry_at TEXT,
        last_error_code TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS relaxations (
        id TEXT PRIMARY KEY,
        base_revision INTEGER NOT NULL,
        operation_json TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        strength TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        eligible_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resulting_revision INTEGER,
        resolved_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS idempotency (
        request_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_resources (
        logical_name TEXT PRIMARY KEY,
        cloudflare_id TEXT NOT NULL,
        applied_content_hash TEXT,
        remote_canonical TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS reconcile_jobs (
        revision INTEGER PRIMARY KEY,
        stage TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_simulated_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        precedence INTEGER NOT NULL,
        traffic TEXT NOT NULL,
        enabled INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_simulated_faults (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        timing TEXT NOT NULL,
        error TEXT NOT NULL,
        remaining INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_simulated_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS relaxations_state_idx ON relaxations (state, expires_at)`,
    ];
    for (const statement of statements) {
      this.#sql.exec(statement);
    }
    this.#ensureColumn("gateway_resources", "remote_canonical", "TEXT");
    this.#sql.exec(
      "INSERT OR REPLACE INTO _schema_migrations (version, applied_at) VALUES (?, ?)",
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
  }

  #ensureColumn(table: string, column: string, definition: string): void {
    const existing = this.#sql
      .exec<DbRow<{ name: string }>>(`SELECT name FROM pragma_table_info('${table}')`)
      .toArray();
    if (!existing.some((row) => row.name === column)) {
      this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  getAccountState(): AccountState | undefined {
    const row = this.#sql
      .exec<DbRow<StateRow>>(
        "SELECT desired_revision, gateway_applied_revision, reconciliation_state, next_retry_at, last_error_code FROM account_state WHERE singleton = 1",
      )
      .toArray()[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      desiredRevision: row.desired_revision,
      appliedRevision: row.gateway_applied_revision,
      reconciliation: reconciliationStateOf(row.reconciliation_state),
      nextRetryAt: asInstant(row.next_retry_at) ?? null,
      lastErrorCode: row.last_error_code,
    };
  }

  hasRevision(revision: number): boolean {
    const row = this.#sql
      .exec<DbRow<{ revision: number }>>(
        "SELECT revision FROM policy_revisions WHERE revision = ?",
        revision,
      )
      .toArray()[0];
    return row !== undefined;
  }

  getPolicy(revision: number): Policy | undefined {
    const row = this.#sql
      .exec<DbRow<PolicyRow>>(
        "SELECT policy_json FROM policy_revisions WHERE revision = ?",
        revision,
      )
      .toArray()[0];
    if (row === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.policy_json);
    } catch {
      return undefined;
    }
    const decoded = decodePolicyOption(parsed);
    return decoded._tag === "Some" ? decoded.value : undefined;
  }

  getDesiredPolicy(): Policy | undefined {
    const state = this.getAccountState();
    return state === undefined ? undefined : this.getPolicy(state.desiredRevision);
  }

  commitRevision(input: CommitRevisionInput): CommitOutcome {
    const policyJson = JSON.stringify(Schema.encodeSync(Policy)(input.policy));
    return this.transactionSync((): CommitOutcome => {
      if (this.hasRevision(input.policy.revision)) {
        return { ok: false, reason: "revision_exists" };
      }
      this.#sql.exec(
        "INSERT INTO policy_revisions (revision, policy_json, compiler_version, created_at) VALUES (?, ?, ?, ?)",
        input.policy.revision,
        policyJson,
        input.compilerVersion,
        input.now,
      );
      this.#sql.exec(
        `INSERT INTO account_state (singleton, desired_revision, gateway_applied_revision, reconciliation_state, next_retry_at, last_error_code)
         VALUES (1, ?, NULL, 'applying', NULL, NULL)
         ON CONFLICT(singleton) DO UPDATE SET desired_revision = excluded.desired_revision, reconciliation_state = 'applying', next_retry_at = NULL, last_error_code = NULL`,
        input.policy.revision,
      );
      this.#sql.exec("DELETE FROM reconcile_jobs WHERE revision <> ?", input.policy.revision);
      this.#sql.exec(
        `INSERT INTO reconcile_jobs (revision, stage, checkpoint_json, attempt, updated_at)
         VALUES (?, 'apply', '{"completed":[]}', 0, ?)
         ON CONFLICT(revision) DO UPDATE SET stage = 'apply', checkpoint_json = '{"completed":[]}', attempt = 0, updated_at = excluded.updated_at`,
        input.policy.revision,
        input.now,
      );
      if (input.relaxation !== undefined) {
        this.#sql.exec(
          "UPDATE relaxations SET state = ?, resulting_revision = ?, resolved_at = ? WHERE id = ?",
          input.relaxation.state,
          input.policy.revision,
          input.relaxation.resolvedAt,
          input.relaxation.id,
        );
      }
      if (input.idempotency !== undefined) {
        this.putIdempotency({
          key: input.idempotency.key,
          requestHash: input.idempotency.requestHash,
          resultJson: input.idempotency.resultJson,
          now: input.now,
          expiresAt: input.idempotency.expiresAt,
        });
      }
      this.#sql.exec("DELETE FROM idempotency WHERE expires_at <= ?", input.now);
      return { ok: true };
    });
  }

  initialise(policy: Policy, compilerVersion: string, now: Instant): void {
    const policyJson = JSON.stringify(Schema.encodeSync(Policy)(policy));
    this.transactionSync(() => {
      this.#sql.exec(
        "INSERT OR IGNORE INTO policy_revisions (revision, policy_json, compiler_version, created_at) VALUES (?, ?, ?, ?)",
        policy.revision,
        policyJson,
        compilerVersion,
        now,
      );
      this.#sql.exec(
        `INSERT OR IGNORE INTO account_state (singleton, desired_revision, gateway_applied_revision, reconciliation_state, next_retry_at, last_error_code)
         VALUES (1, ?, NULL, 'applying', ?, NULL)`,
        policy.revision,
        now,
      );
    });
  }

  setApplied(revision: number): void {
    this.transactionSync(() => {
      this.#sql.exec(
        `UPDATE account_state
         SET gateway_applied_revision = ?,
             reconciliation_state = CASE WHEN desired_revision = ? THEN 'idle' ELSE 'applying' END,
             next_retry_at = NULL,
             last_error_code = NULL
         WHERE singleton = 1`,
        revision,
        revision,
      );
      this.#sql.exec("DELETE FROM reconcile_jobs WHERE revision = ?", revision);
    });
  }

  clearApplied(): void {
    this.#sql.exec(
      "UPDATE account_state SET gateway_applied_revision = NULL WHERE singleton = 1",
    );
  }

  setReconciliation(
    state: ReconciliationState,
    errorCode: string | null,
    nextRetryAt: Instant | null,
  ): void {
    this.#sql.exec(
      "UPDATE account_state SET reconciliation_state = ?, last_error_code = ?, next_retry_at = ? WHERE singleton = 1",
      state,
      errorCode,
      nextRetryAt,
    );
  }

  listResources(): readonly OwnedResource[] {
    return this.#sql
      .exec<DbRow<ResourceRow>>(
        "SELECT logical_name, cloudflare_id, applied_content_hash, remote_canonical FROM gateway_resources ORDER BY logical_name ASC",
      )
      .toArray()
      .map((row) => ({
        logicalName: row.logical_name,
        cloudflareId: row.cloudflare_id,
        appliedContentHash: row.applied_content_hash,
        remoteCanonical: row.remote_canonical,
      }));
  }

  upsertResource(resource: OwnedResource, now: Instant): void {
    this.#sql.exec(
      `INSERT INTO gateway_resources (logical_name, cloudflare_id, applied_content_hash, remote_canonical, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(logical_name) DO UPDATE SET cloudflare_id = excluded.cloudflare_id, applied_content_hash = excluded.applied_content_hash, remote_canonical = excluded.remote_canonical, updated_at = excluded.updated_at`,
      resource.logicalName,
      resource.cloudflareId,
      resource.appliedContentHash,
      resource.remoteCanonical,
      now,
    );
  }

  updateRemoteCanonical(logicalName: string, remoteCanonical: string, now: Instant): void {
    this.#sql.exec(
      "UPDATE gateway_resources SET remote_canonical = ?, updated_at = ? WHERE logical_name = ?",
      remoteCanonical,
      now,
      logicalName,
    );
  }

  deleteResource(logicalName: string): void {
    this.#sql.exec("DELETE FROM gateway_resources WHERE logical_name = ?", logicalName);
  }

  getJob(revision: number): ReconcileJob | undefined {
    const row = this.#sql
      .exec<DbRow<JobRow>>(
        "SELECT stage, checkpoint_json, attempt, updated_at FROM reconcile_jobs WHERE revision = ?",
        revision,
      )
      .toArray()[0];
    if (row === undefined) {
      return undefined;
    }
    const updatedAt = asInstant(row.updated_at);
    if (updatedAt === undefined) {
      return undefined;
    }
    return {
      revision,
      stage: row.stage,
      completed: parseCompleted(row.checkpoint_json),
      attempt: row.attempt,
      updatedAt,
    };
  }

  saveJob(job: ReconcileJob): void {
    this.#sql.exec(
      `INSERT INTO reconcile_jobs (revision, stage, checkpoint_json, attempt, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(revision) DO UPDATE SET stage = excluded.stage, checkpoint_json = excluded.checkpoint_json, attempt = excluded.attempt, updated_at = excluded.updated_at`,
      job.revision,
      job.stage,
      JSON.stringify({ completed: job.completed }),
      job.attempt,
      job.updatedAt,
    );
  }

  listRelaxations(): readonly RelaxationRecord[] {
    const rows = this.#sql
      .exec<DbRow<RelaxationRow>>(
        "SELECT id, base_revision, operation_json, operation_hash, strength, state, requested_at, eligible_at, expires_at, resulting_revision FROM relaxations ORDER BY requested_at DESC",
      )
      .toArray();
    const records: RelaxationRecord[] = [];
    for (const row of rows) {
      const record = this.toRelaxation(row);
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records;
  }

  getRelaxation(id: string): RelaxationRecord | undefined {
    const row = this.#sql
      .exec<DbRow<RelaxationRow>>(
        "SELECT id, base_revision, operation_json, operation_hash, strength, state, requested_at, eligible_at, expires_at, resulting_revision FROM relaxations WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row === undefined ? undefined : this.toRelaxation(row);
  }

  private toRelaxation(row: RelaxationRow): RelaxationRecord | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.operation_json);
    } catch {
      return undefined;
    }
    const operation = decodeOperationOption(parsed);
    const requestedAt = asInstant(row.requested_at);
    const eligibleAt = asInstant(row.eligible_at);
    const expiresAt = asInstant(row.expires_at);
    if (
      operation._tag === "None" ||
      requestedAt === undefined ||
      eligibleAt === undefined ||
      expiresAt === undefined
    ) {
      return undefined;
    }
    return {
      id: row.id,
      baseRevision: row.base_revision,
      operation: operation.value,
      operationHash: row.operation_hash,
      strength: strengthOf(row.strength),
      state: relaxationStateOf(row.state),
      requestedAt,
      eligibleAt,
      expiresAt,
      resultingRevision: row.resulting_revision,
    };
  }

  insertRelaxation(record: RelaxationRecord): void {
    this.#sql.exec(
      `INSERT INTO relaxations (id, base_revision, operation_json, operation_hash, strength, state, requested_at, eligible_at, expires_at, resulting_revision, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      record.id,
      record.baseRevision,
      JSON.stringify(record.operation),
      record.operationHash,
      record.strength,
      record.state,
      record.requestedAt,
      record.eligibleAt,
      record.expiresAt,
    );
  }

  resolveRelaxation(
    id: string,
    state: RelaxationState,
    resultingRevision: number | null,
    resolvedAt: Instant,
  ): void {
    this.#sql.exec(
      "UPDATE relaxations SET state = ?, resulting_revision = ?, resolved_at = ? WHERE id = ?",
      state,
      resultingRevision,
      resolvedAt,
      id,
    );
  }

  expirePendingRelaxations(now: Instant): number {
    const expired = this.#sql
      .exec<DbRow<{ id: string }>>(
        "SELECT id FROM relaxations WHERE state = 'pending' AND expires_at <= ?",
        now,
      )
      .toArray();
    for (const row of expired) {
      this.#sql.exec("UPDATE relaxations SET state = 'expired' WHERE id = ?", row.id);
    }
    return expired.length;
  }

  earliestPendingExpiry(): Instant | undefined {
    const row = this.#sql
      .exec<DbRow<{ expires_at: string | null }>>(
        "SELECT MIN(expires_at) AS expires_at FROM relaxations WHERE state = 'pending'",
      )
      .toArray()[0];
    return row === undefined ? undefined : asInstant(row.expires_at);
  }

  getIdempotency(key: string): IdempotencyRecord | undefined {
    const row = this.#sql
      .exec<DbRow<IdempotencyRow>>(
        "SELECT request_hash, result_json FROM idempotency WHERE request_key = ?",
        key,
      )
      .toArray()[0];
    return row === undefined
      ? undefined
      : { requestHash: row.request_hash, resultJson: row.result_json };
  }

  putIdempotency(input: {
    readonly key: string;
    readonly requestHash: string;
    readonly resultJson: string;
    readonly now: Instant;
    readonly expiresAt: Instant;
  }): void {
    this.#sql.exec(
      `INSERT INTO idempotency (request_key, request_hash, result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(request_key) DO UPDATE SET request_hash = excluded.request_hash, result_json = excluded.result_json, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      input.key,
      input.requestHash,
      input.resultJson,
      input.now,
      input.expiresAt,
    );
  }

  listSimulatedRules(): readonly SimulatedRuleRow[] {
    return this.#sql
      .exec<DbRow<SimulatedRuleRow>>(
        "SELECT id, name, action, precedence, traffic, enabled FROM gateway_simulated_rules ORDER BY precedence ASC, name ASC",
      )
      .toArray();
  }

  addSimulatedFault(input: {
    readonly operation: string;
    readonly timing: string;
    readonly error: string;
    readonly remaining: number;
  }): void {
    this.#sql.exec(
      "INSERT INTO gateway_simulated_faults (operation, timing, error, remaining) VALUES (?, ?, ?, ?)",
      input.operation,
      input.timing,
      input.error,
      input.remaining,
    );
  }

  setSimulatedSetting(key: string, value: string): void {
    this.#sql.exec(
      "INSERT INTO gateway_simulated_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  putSimulatedRule(input: {
    readonly id: string;
    readonly name: string;
    readonly action: string;
    readonly precedence: number;
    readonly traffic: string;
    readonly enabled: number;
  }): void {
    this.#sql.exec(
      `INSERT INTO gateway_simulated_rules (id, name, action, precedence, traffic, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, action = excluded.action, precedence = excluded.precedence, traffic = excluded.traffic, enabled = excluded.enabled`,
      input.id,
      input.name,
      input.action,
      input.precedence,
      input.traffic,
      input.enabled,
    );
  }

  deleteSimulatedRule(id: string): void {
    this.#sql.exec("DELETE FROM gateway_simulated_rules WHERE id = ?", id);
  }
}
