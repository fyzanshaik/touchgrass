import { Schema } from "effect";
import { Instant } from "../domain/instants.ts";
import { Operation } from "../domain/operations.ts";
import {
  Policy,
  Revision,
  RuleAction,
  RuleScope,
} from "../domain/policy.ts";
import { HostnameRejectionReason } from "../domain/hostname.ts";

export const apiErrorCodes = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "stale_revision",
  "precondition_required",
  "payload_too_large",
  "unavailable",
  "internal",
] as const;

export const ApiErrorCode = Schema.Literal(
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "stale_revision",
  "precondition_required",
  "payload_too_large",
  "unavailable",
  "internal",
);
export type ApiErrorCode = typeof ApiErrorCode.Type;

export const Uuid = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {
    message: () => "Expected a lowercase UUID.",
  }),
);

export const IdempotencyKey = Uuid;
export const RelaxationId = Uuid;

export const ReconciliationState = Schema.Literal("idle", "applying", "degraded");
export type ReconciliationState = typeof ReconciliationState.Type;

export const RelaxationState = Schema.Literal("pending", "cancelled", "confirmed", "expired");
export type RelaxationState = typeof RelaxationState.Type;

export const ChangeState = Schema.Literal("revised", "pendingRelaxation", "unchanged");
export type ChangeState = typeof ChangeState.Type;

export const GatewayMode = Schema.Literal("live", "simulated");
export type GatewayMode = typeof GatewayMode.Type;

export const OperationStrength = Schema.Literal("stronger", "weaker", "unchanged");
export type OperationStrength = typeof OperationStrength.Type;

export const ApiErrorResponse = Schema.Struct({
  code: ApiErrorCode,
  message: Schema.String,
  requestId: Uuid,
});
export type ApiErrorResponse = typeof ApiErrorResponse.Type;

export const PolicyResponse = Schema.Struct({
  policy: Policy,
  etag: Schema.String,
});
export type PolicyResponse = typeof PolicyResponse.Type;

export const ChangeRequest = Schema.Struct({ operation: Operation });
export type ChangeRequest = typeof ChangeRequest.Type;

export const RestoreRequest = Schema.Struct({ policy: Policy });
export type RestoreRequest = typeof RestoreRequest.Type;

export const PreviewRequest = Schema.Struct({
  input: Schema.String,
  scope: RuleScope,
});
export type PreviewRequest = typeof PreviewRequest.Type;

export const PreviewResponse = Schema.Struct({
  accepted: Schema.Boolean,
  hostname: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(HostnameRejectionReason),
  source: Schema.NullOr(Schema.Literal("hostname", "url")),
  scope: RuleScope,
  message: Schema.String,
});
export type PreviewResponse = typeof PreviewResponse.Type;

export const ChangeResponse = Schema.Struct({
  id: Uuid,
  state: ChangeState,
  strength: OperationStrength,
  baseRevision: Revision,
  desiredRevision: Schema.NullOr(Revision),
  appliedRevision: Schema.NullOr(Revision),
  eligibleAt: Schema.NullOr(Instant),
  relaxationId: Schema.NullOr(Uuid),
});
export type ChangeResponse = typeof ChangeResponse.Type;

export const RelaxationSummary = Schema.Struct({
  id: Uuid,
  baseRevision: Revision,
  operation: Operation,
  strength: OperationStrength,
  state: RelaxationState,
  requestedAt: Instant,
  eligibleAt: Instant,
  expiresAt: Instant,
  resultingRevision: Schema.NullOr(Revision),
  operationHash: Schema.String,
  canConfirm: Schema.Boolean,
});
export type RelaxationSummary = typeof RelaxationSummary.Type;

export const OwnedResourceSummary = Schema.Struct({
  logicalName: Schema.String,
  cloudflareId: Schema.String,
  appliedContentHash: Schema.NullOr(Schema.String),
});
export type OwnedResourceSummary = typeof OwnedResourceSummary.Type;

export const StatusResponse = Schema.Struct({
  serverTime: Instant,
  desiredRevision: Revision,
  gatewayAppliedRevision: Schema.NullOr(Revision),
  reconciliation: ReconciliationState,
  gatewayMode: GatewayMode,
  lastErrorCode: Schema.NullOr(Schema.String),
  nextRetryAt: Schema.NullOr(Instant),
  relaxations: Schema.Array(RelaxationSummary),
});
export type StatusResponse = typeof StatusResponse.Type;

export const DiagnosticsResponse = Schema.Struct({
  serverTime: Instant,
  gatewayMode: GatewayMode,
  compilerVersion: Schema.String,
  locationSubdomain: Schema.String,
  planRevision: Revision,
  planFailure: Schema.NullOr(Schema.String),
  planRules: Schema.Array(
    Schema.Struct({
      logicalName: Schema.String,
      action: RuleAction,
      precedence: Schema.Number,
      traffic: Schema.String,
    }),
  ),
  suppressedAllows: Schema.Array(
    Schema.Struct({
      hostname: Schema.String,
      scope: RuleScope,
      supersededBy: Schema.String,
    }),
  ),
  ownedResources: Schema.Array(OwnedResourceSummary),
  reconciliationJob: Schema.NullOr(
    Schema.Struct({
      revision: Revision,
      stage: Schema.String,
      attempt: Schema.Number,
      updatedAt: Instant,
    }),
  ),
});
export type DiagnosticsResponse = typeof DiagnosticsResponse.Type;

export const BackupResponse = Schema.Struct({
  exportedAt: Instant,
  sourceRevision: Revision,
  policy: Policy,
});
export type BackupResponse = typeof BackupResponse.Type;

export const decodeChangeRequest = Schema.decodeUnknownEither(ChangeRequest, {
  onExcessProperty: "error",
  errors: "all",
});

export const decodeRestoreRequest = Schema.decodeUnknownEither(RestoreRequest, {
  onExcessProperty: "error",
  errors: "all",
});

export const decodePreviewRequest = Schema.decodeUnknownEither(PreviewRequest, {
  onExcessProperty: "error",
  errors: "all",
});

export const EmptyBody = Schema.Record({ key: Schema.String, value: Schema.Unknown }).pipe(
  Schema.filter((value) => Object.keys(value).length === 0, {
    message: () => "This operation accepts no request fields.",
  }),
);

export const decodeEmptyBody = Schema.decodeUnknownEither(EmptyBody, {
  onExcessProperty: "error",
  errors: "all",
});

export const decodeIdempotencyKey = Schema.decodeUnknownEither(IdempotencyKey, {
  onExcessProperty: "error",
});

export const decodeRelaxationId = Schema.decodeUnknownEither(RelaxationId, {
  onExcessProperty: "error",
});
