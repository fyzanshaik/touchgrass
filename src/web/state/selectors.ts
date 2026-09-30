import type {
  ChangeResponse,
  GatewayMode,
  ReconciliationState,
  RelaxationSummary,
  StatusResponse,
} from "../../contracts/api.ts";
import type { Instant } from "../../domain/instants.ts";
import type { Operation } from "../../domain/operations.ts";
import type { CategoryName, Policy, PolicyContent, Revision, Rule } from "../../domain/policy.ts";
import { policyContent, ruleKey } from "../../domain/policy.ts";
import { toEpochMilliseconds, formatInstant, formatRemaining, formatDuration } from "../format/time.ts";
import { actionLabels, categoryLabel, scopeLabels } from "../format/labels.ts";

const canonicalRules = (rules: PolicyContent["rules"]): string =>
  rules
    .map((rule) => `${ruleKey(rule)}:${rule.action}`)
    .sort()
    .join(",");

const restoreSignature = (policy: Policy): string => {
  const content = policyContent(policy);
  return [
    "restorePolicy",
    content.enabled ? "on" : "off",
    [...content.categories].sort().join(","),
    String(content.cooldownSeconds),
    policy.dnsEndpoint,
    canonicalRules(content.rules),
  ].join(":");
};

export const operationSignature = (operation: Operation): string => {
  switch (operation.type) {
    case "addRule":
      return `addRule:${operation.rule.action}:${operation.rule.scope}:${operation.rule.hostname}`;
    case "removeRule":
      return `removeRule:${operation.ruleId}`;
    case "setCategories":
      return `setCategories:${[...operation.categories].sort().join(",")}`;
    case "setEnabled":
      return `setEnabled:${operation.enabled ? "on" : "off"}`;
    case "setCooldown":
      return `setCooldown:${operation.cooldownSeconds}`;
    case "restorePolicy":
      return restoreSignature(operation.policy);
  }
};

export const filterRules = (rules: readonly Rule[], query: string): readonly Rule[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return rules;
  }
  return rules.filter((rule) => rule.hostname.includes(needle));
};

export interface RuleCounts {
  readonly total: number;
  readonly blocks: number;
  readonly allows: number;
}

export const countRules = (rules: readonly Rule[]): RuleCounts => ({
  total: rules.length,
  blocks: rules.filter((rule) => rule.action === "block").length,
  allows: rules.filter((rule) => rule.action === "allow").length,
});

export interface ProtectionSummary {
  readonly enabled: boolean | null;
  readonly categories: readonly CategoryName[];
  readonly cooldownSeconds: number | null;
  readonly desiredRevision: Revision | null;
  readonly appliedRevision: Revision | null;
  readonly applied: boolean;
  readonly drift: boolean;
  readonly reconciliation: ReconciliationState | null;
  readonly gatewayMode: GatewayMode | null;
  readonly lastErrorCode: string | null;
  readonly nextRetryAt: Instant | null;
  readonly trustworthy: boolean;
  readonly standing: GatewayStanding;
}

export type GatewayStanding = "applied" | "applying" | "drift" | "untrusted" | "unknown";

const standingOf = (input: {
  readonly status: StatusResponse | null;
  readonly desiredRevision: Revision | null;
  readonly appliedRevision: Revision | null;
}): GatewayStanding => {
  const { status, desiredRevision, appliedRevision } = input;
  if (status === null || desiredRevision === null) {
    return "unknown";
  }
  if (appliedRevision !== desiredRevision) {
    return "drift";
  }
  if (status.reconciliation === "applying") {
    return "applying";
  }
  if (status.reconciliation !== "idle" || status.lastErrorCode !== null || status.nextRetryAt !== null) {
    return "untrusted";
  }
  return "applied";
};

export const summariseProtection = (
  policy: Policy | null,
  status: StatusResponse | null,
): ProtectionSummary => {
  const desiredRevision = policy === null ? null : policy.revision;
  const appliedRevision = status === null ? null : status.gatewayAppliedRevision;
  const standing = standingOf({ status, desiredRevision, appliedRevision });
  return {
    enabled: policy === null ? null : policy.enabled,
    categories: policy === null ? [] : policy.categories,
    cooldownSeconds: policy === null ? null : policy.cooldownSeconds,
    desiredRevision,
    appliedRevision,
    applied: standing === "applied",
    drift: standing === "drift",
    reconciliation: status === null ? null : status.reconciliation,
    gatewayMode: status === null ? null : status.gatewayMode,
    lastErrorCode: status === null ? null : status.lastErrorCode,
    nextRetryAt: status === null ? null : status.nextRetryAt,
    trustworthy:
      status !== null &&
      status.reconciliation === "idle" &&
      status.lastErrorCode === null &&
      status.nextRetryAt === null,
    standing,
  };
};

export const pendingRelaxations = (status: StatusResponse | null): readonly RelaxationSummary[] =>
  status === null ? [] : status.relaxations.filter((summary) => summary.state === "pending");

export const settledRelaxations = (status: StatusResponse | null): readonly RelaxationSummary[] =>
  status === null ? [] : status.relaxations.filter((summary) => summary.state !== "pending");

export const describeRelaxation = (
  summary: RelaxationSummary,
  policy: Policy | null,
): string => {
  const operation = summary.operation;
  switch (operation.type) {
    case "removeRule": {
      if (policy === null) {
        return "Remove a rule from the current policy";
      }
      const rule = policy.rules.find((entry) => entry.id === operation.ruleId);
      return rule === undefined
        ? "Remove a rule that is no longer in the current policy"
        : `Remove the ${actionLabels[rule.action].toLowerCase()} rule for ${rule.hostname}`;
    }
    case "addRule":
      return `${actionLabels[operation.rule.action]} ${operation.rule.hostname} (${scopeLabels[operation.rule.scope].toLowerCase()})`;
    case "setCategories":
      return operation.categories.length === 0
        ? "Turn off all adult-content categories"
        : `Set categories to ${operation.categories.map((name) => categoryLabel(name)).join(", ")}`;
    case "setEnabled":
      return operation.enabled ? "Turn protection on" : "Turn protection off";
    case "setCooldown":
      return `Set the cooldown to ${formatDuration(operation.cooldownSeconds)}`;
    case "restorePolicy":
      return "Restore an exported policy";
  }
};

export interface RelaxationWindow {
  readonly eligible: boolean;
  readonly expired: boolean;
  readonly eligibleLabel: string;
  readonly expiresLabel: string;
  readonly waitingLabel: string;
}

export const relaxationWindow = (summary: RelaxationSummary, now: number): RelaxationWindow => {
  const eligibleAtMs = toEpochMilliseconds(summary.eligibleAt);
  const expired = summary.state === "expired" || now >= toEpochMilliseconds(summary.expiresAt);
  const eligible = summary.canConfirm && !expired && now >= eligibleAtMs;
  return {
    eligible,
    expired,
    eligibleLabel: formatInstant(summary.eligibleAt),
    expiresLabel: formatInstant(summary.expiresAt),
    waitingLabel: eligible ? "Eligible now" : `Eligible ${formatRemaining(summary.eligibleAt, now)}`,
  };
};

export const changeMessage = (change: ChangeResponse): string => {
  switch (change.state) {
    case "unchanged":
      return "No change was needed; the policy already matched that request.";
    case "pendingRelaxation":
      return "This weakening change is pending. Confirm it from the Pending screen once it is eligible.";
    case "revised":
      return change.desiredRevision !== null &&
        change.appliedRevision !== null &&
        change.appliedRevision === change.desiredRevision
        ? "The change was applied to Gateway."
        : "The change was accepted and is being applied to Gateway.";
  }
};

export const cooldownStrength = (currentSeconds: number | null, nextSeconds: number): string => {
  if (currentSeconds === null || currentSeconds === nextSeconds) {
    return "unchanged";
  }
  return nextSeconds > currentSeconds ? "stronger" : "weaker";
};
