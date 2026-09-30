import { Schema } from "effect";
import * as api from "../../src/contracts/api.ts";
import { Instant } from "../../src/domain/instants.ts";
import { Rule, RuleId, type Policy } from "../../src/domain/policy.ts";
import type { ClientFailure } from "../../src/web/client/result.ts";

export const RAW_RULE_ID = "11111111-1111-4111-8111-111111111111";
export const RULE_ID = Schema.decodeSync(RuleId)(RAW_RULE_ID);
export const INSTANT = "2026-09-30T10:00:00.000Z";
export const UPDATED = "2026-09-30T09:00:00.000Z";
export const ELIGIBLE = "2026-10-01T10:00:00.000Z";
export const EXPIRES = "2026-10-08T10:00:00.000Z";
export const GATEWAY_ENDPOINT = "https://local.cloudflare-gateway.com/dns-query";

export const instant = (value: string): Instant => Schema.decodeSync(Instant)(value);

const ruleFixture = (input: {
  readonly id: string;
  readonly hostname: string;
  readonly action: "block" | "allow";
  readonly scope: "host" | "domain";
}): Rule =>
  Schema.decodeSync(Rule)({
    id: input.id,
    hostname: input.hostname,
    action: input.action,
    scope: input.scope,
    createdAt: INSTANT,
  });

export const blockRule = ruleFixture({
  id: RAW_RULE_ID,
  hostname: "example.com",
  action: "block",
  scope: "domain",
});

export const allowRule = ruleFixture({
  id: "22222222-2222-4222-8222-222222222222",
  hostname: "example.org",
  action: "allow",
  scope: "host",
});

export const policyResponseFixture = (
  revision: number,
  rules: readonly Rule[] = [blockRule],
): api.PolicyResponse =>
  Schema.decodeSync(api.PolicyResponse)({
    policy: {
      schemaVersion: 1,
      revision,
      enabled: true,
      categories: ["pornography"],
      cooldownSeconds: 86400,
      dnsEndpoint: GATEWAY_ENDPOINT,
      rules,
      updatedAt: UPDATED,
    },
    etag: `"p-${revision}"`,
  });

export const policyFixture = (revision: number, rules: readonly Rule[] = [blockRule]): Policy =>
  policyResponseFixture(revision, rules).policy;

export const relaxationFixture = (input: {
  readonly id: string;
  readonly state: api.RelaxationState;
  readonly canConfirm: boolean;
  readonly operation: api.RelaxationSummary["operation"];
}): api.RelaxationSummary =>
  Schema.decodeSync(api.RelaxationSummary)({
    id: input.id,
    baseRevision: 1,
    operation: input.operation,
    strength: "weaker",
    state: input.state,
    requestedAt: UPDATED,
    eligibleAt: ELIGIBLE,
    expiresAt: EXPIRES,
    resultingRevision: null,
    operationHash: "operation-hash",
    canConfirm: input.canConfirm,
  });

export const statusFixture = (
  revision: number,
  relaxations: readonly api.RelaxationSummary[] = [],
  overrides: {
    readonly reconciliation?: api.ReconciliationState;
    readonly gatewayAppliedRevision?: number | null;
    readonly lastErrorCode?: string | null;
    readonly nextRetryAt?: string | null;
  } = {},
): api.StatusResponse =>
  Schema.decodeSync(api.StatusResponse)({
    serverTime: INSTANT,
    desiredRevision: revision,
    gatewayAppliedRevision:
      overrides.gatewayAppliedRevision === undefined ? revision : overrides.gatewayAppliedRevision,
    reconciliation: overrides.reconciliation ?? "idle",
    gatewayMode: "simulated",
    lastErrorCode: overrides.lastErrorCode === undefined ? null : overrides.lastErrorCode,
    nextRetryAt: overrides.nextRetryAt === undefined ? null : overrides.nextRetryAt,
    relaxations,
  });

export const backupFixture = (policy: Policy): api.BackupResponse =>
  Schema.decodeSync(api.BackupResponse)({
    exportedAt: INSTANT,
    sourceRevision: policy.revision,
    policy,
  });

export const diagnosticsFixture = (): api.DiagnosticsResponse =>
  Schema.decodeSync(api.DiagnosticsResponse)({
    serverTime: INSTANT,
    gatewayMode: "simulated",
    compilerVersion: "clearbrowse-dns-compiler/1",
    locationSubdomain: "local",
    planRevision: 1,
    planFailure: null,
    planRules: [{ logicalName: "block-domain", action: "block", precedence: 1000, traffic: "dns.fqdn == \"example.com\"" }],
    suppressedAllows: [],
    ownedResources: [{ logicalName: "block-domain", cloudflareId: "resource-1", appliedContentHash: null }],
    reconciliationJob: null,
  });

export const changeFixture = (
  state: api.ChangeState,
  appliedRevision: number | null,
  desiredRevision: number | null = 2,
): api.ChangeResponse =>
  Schema.decodeSync(api.ChangeResponse)({
    id: RAW_RULE_ID,
    state,
    strength: "stronger",
    baseRevision: 1,
    desiredRevision,
    appliedRevision,
    eligibleAt: null,
    relaxationId: null,
  });

export const apiFailure = (code: api.ApiErrorCode, status: number): ClientFailure => ({
  kind: "api",
  status,
  error: Schema.decodeSync(api.ApiErrorResponse)({
    code,
    message: "request failed",
    requestId: RAW_RULE_ID,
  }),
});

export const offlineFailure = (): ClientFailure => ({
  kind: "offline",
  detail: "network unavailable",
});
