import type { BackupResponse, DiagnosticsResponse, PreviewResponse, StatusResponse } from "../../contracts/api.ts";
import type { Instant } from "../../domain/instants.ts";
import type { Operation } from "../../domain/operations.ts";
import type { Policy, RuleScope } from "../../domain/policy.ts";
import type { ApiClient } from "../client/api-client.ts";
import { isRetryable, type ClientFailure, type Result } from "../client/result.ts";
import { describeFailure, describeOperation } from "../format/labels.ts";
import { changeMessage, operationSignature } from "./selectors.ts";
import {
  createMutationTracker,
  mutationSignature,
  type MutationIdentity,
} from "./mutation-tracker.ts";

export type DataPhase = "idle" | "loading" | "ready" | "failed";

export type MutationPhase = "idle" | "sending" | "failed" | "succeeded";

export interface MutationStatus {
  readonly phase: MutationPhase;
  readonly label: string | null;
  readonly message: string | null;
  readonly failure: ClientFailure | null;
  readonly retryable: boolean;
  readonly signature: string | null;
}

export interface DashboardState {
  readonly phase: DataPhase;
  readonly offline: boolean;
  readonly stale: boolean;
  readonly loadedAt: Instant | null;
  readonly policy: Policy | null;
  readonly etag: string | null;
  readonly status: StatusResponse | null;
  readonly diagnostics: DiagnosticsResponse | null;
  readonly failure: ClientFailure | null;
  readonly mutation: MutationStatus;
}

export interface MutationOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly failure: ClientFailure | null;
  readonly retryable: boolean;
}

export interface DashboardStore {
  readonly getState: () => DashboardState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<void>;
  readonly preview: (input: string, scope: RuleScope) => Promise<Result<PreviewResponse>>;
  readonly applyChange: (operation: Operation) => Promise<MutationOutcome>;
  readonly confirmChange: (relaxationId: string) => Promise<MutationOutcome>;
  readonly cancelChange: (relaxationId: string) => Promise<MutationOutcome>;
  readonly reconcile: () => Promise<MutationOutcome>;
  readonly restore: (policy: Policy) => Promise<MutationOutcome>;
  readonly exportBackup: () => Promise<Result<BackupResponse>>;
  readonly retryLast: () => Promise<MutationOutcome>;
  readonly clearMutationNotice: () => void;
}

export interface DashboardStoreOptions {
  readonly createKey?: () => string;
}

interface MutationRun<R> {
  readonly signature: string;
  readonly label: string;
  readonly send: (identity: MutationIdentity) => Promise<Result<R>>;
  readonly describe: (value: R) => string;
}

const idleMutation: MutationStatus = {
  phase: "idle",
  label: null,
  message: null,
  failure: null,
  retryable: false,
  signature: null,
};

const firstFailure = (results: readonly Result<unknown>[]): ClientFailure | null => {
  for (const result of results) {
    if (!result.ok) {
      return result.failure;
    }
  }
  return null;
};

export const createDashboardStore = (
  client: ApiClient,
  options: DashboardStoreOptions = {},
): DashboardStore => {
  const createKey = options.createKey ?? ((): string => crypto.randomUUID());
  const tracker = createMutationTracker(createKey);
  const listeners = new Set<() => void>();
  let state: DashboardState = {
    phase: "idle",
    offline: false,
    stale: false,
    loadedAt: null,
    policy: null,
    etag: null,
    status: null,
    diagnostics: null,
    failure: null,
    mutation: idleMutation,
  };
  let lastRetry: (() => Promise<MutationOutcome>) | null = null;

  const update = (partial: Partial<DashboardState>): void => {
    state = { ...state, ...partial };
    for (const listener of listeners) {
      listener();
    }
  };

  const refresh = async (): Promise<void> => {
    const before = state;
    const [policyResult, statusResult, diagnosticsResult] = await Promise.all([
      client.readPolicy(before.etag),
      client.readStatus(),
      client.readDiagnostics(),
    ]);
    const failure = firstFailure([policyResult, statusResult, diagnosticsResult]);
    const policy = policyResult.ok
      ? policyResult.value.notModified
        ? before.policy
        : policyResult.value.policy
      : before.policy;
    const hasData = policy !== null;
    update({
      phase: hasData ? "ready" : "failed",
      offline: failure !== null && failure.kind === "offline",
      stale: failure !== null && hasData,
      loadedAt: statusResult.ok ? statusResult.value.serverTime : before.loadedAt,
      policy,
      etag: policyResult.ok ? policyResult.value.etag : before.etag,
      status: statusResult.ok ? statusResult.value : before.status,
      diagnostics: diagnosticsResult.ok ? diagnosticsResult.value : before.diagnostics,
      failure,
    });
  };

  const runMutation = async <R>(run: MutationRun<R>): Promise<MutationOutcome> => {
    const policy = state.policy;
    if (policy === null) {
      return {
        ok: false,
        message: "Load the current policy before making changes.",
        failure: null,
        retryable: false,
      };
    }
    const identity = tracker.acquire(run.signature, policy.revision);
    update({
      mutation: {
        phase: "sending",
        label: run.label,
        message: null,
        failure: null,
        retryable: false,
        signature: run.signature,
      },
    });
    const result = await run.send(identity);
    if (result.ok) {
      tracker.release(run.signature);
      lastRetry = null;
      const message = run.describe(result.value);
      update({
        mutation: {
          phase: "succeeded",
          label: run.label,
          message,
          failure: null,
          retryable: false,
          signature: run.signature,
        },
      });
      await refresh();
      return { ok: true, message, failure: null, retryable: false };
    }
    const retryable = isRetryable(result.failure);
    if (retryable) {
      lastRetry = () => runMutation(run);
    } else {
      tracker.release(run.signature);
      lastRetry = null;
    }
    const message = describeFailure(result.failure);
    update({
      mutation: {
        phase: "failed",
        label: run.label,
        message,
        failure: result.failure,
        retryable,
        signature: run.signature,
      },
    });
    if (!retryable) {
      await refresh();
    }
    return { ok: false, message, failure: result.failure, retryable };
  };

  const mutationHeaders = (identity: MutationIdentity) => ({
    idempotencyKey: identity.idempotencyKey,
    baseRevision: identity.baseRevision,
  });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    preview: (input, scope) => client.preview(input, scope),
    applyChange: (operation) =>
      runMutation({
        signature: mutationSignature(["change", operationSignature(operation)]),
        label: describeOperation(operation),
        send: (identity) => client.submitChange(operation, mutationHeaders(identity)),
        describe: changeMessage,
      }),
    confirmChange: (relaxationId) =>
      runMutation({
        signature: mutationSignature(["confirm", relaxationId]),
        label: "Confirming a pending change",
        send: (identity) => client.confirmRelaxation(relaxationId, mutationHeaders(identity)),
        describe: changeMessage,
      }),
    cancelChange: (relaxationId) =>
      runMutation({
        signature: mutationSignature(["cancel", relaxationId]),
        label: "Cancelling a pending change",
        send: (identity) => client.cancelRelaxation(relaxationId, mutationHeaders(identity)),
        describe: () => "The pending change was cancelled.",
      }),
    reconcile: () =>
      runMutation({
        signature: mutationSignature(["reconcile"]),
        label: "Requesting reconciliation",
        send: (identity) => client.reconcile(mutationHeaders(identity)),
        describe: () => "Reconciliation was requested; Gateway state will be re-read.",
      }),
    restore: (policy) =>
      runMutation({
        signature: mutationSignature(["change", operationSignature({ type: "restorePolicy", policy })]),
        label: "Restoring an exported policy",
        send: (identity) => client.restore({ policy }, mutationHeaders(identity)),
        describe: changeMessage,
      }),
    exportBackup: () => client.readBackup(),
    retryLast: async () => {
      const retry = lastRetry;
      if (retry === null) {
        return {
          ok: false,
          message: "There is nothing to retry.",
          failure: null,
          retryable: false,
        };
      }
      lastRetry = null;
      return retry();
    },
    clearMutationNotice: () => {
      update({ mutation: idleMutation });
    },
  };
};
