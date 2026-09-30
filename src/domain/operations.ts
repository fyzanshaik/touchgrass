import { Schema } from "effect";
import type { HostnameRejectionReason } from "./hostname.ts";
import { normalizeHostnameInput } from "./hostname.ts";
import type { Instant } from "./instants.ts";
import {
  CategoryList,
  CooldownSeconds,
  MAX_RULES,
  Policy,
  RuleId,
  RuleInput,
  findRuleConflicts,
  policyContent,
  ruleKey,
  sameContent,
  sortCategories,
  sortRules,
  type CategoryName,
  type PolicyContent,
  type Rule,
  type RuleAction,
  type RuleId as RuleIdValue,
  type RuleScope,
} from "./policy.ts";

export const Operation = Schema.Union(
  Schema.Struct({ type: Schema.Literal("addRule"), rule: RuleInput }),
  Schema.Struct({ type: Schema.Literal("removeRule"), ruleId: RuleId }),
  Schema.Struct({ type: Schema.Literal("setCategories"), categories: CategoryList }),
  Schema.Struct({ type: Schema.Literal("setEnabled"), enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("setCooldown"), cooldownSeconds: CooldownSeconds }),
  Schema.Struct({ type: Schema.Literal("restorePolicy"), policy: Policy }),
);
export type Operation = typeof Operation.Type;

export type OperationStrength = "stronger" | "weaker" | "unchanged";

export type OperationFailure =
  | {
      readonly type: "InvalidHostname";
      readonly input: string;
      readonly reason: HostnameRejectionReason;
    }
  | { readonly type: "RuleLimit"; readonly limit: number }
  | { readonly type: "RuleNotFound"; readonly ruleId: string }
  | {
      readonly type: "RuleConflict";
      readonly hostname: string;
      readonly scope: RuleScope;
      readonly kind: "duplicate" | "action_conflict";
    }
  | { readonly type: "BackupEndpointMismatch"; readonly received: string };

export type OperationOutcome =
  | { readonly ok: true; readonly policy: Policy; readonly changed: boolean }
  | { readonly ok: false; readonly failure: OperationFailure };

export interface OperationContext {
  readonly now: Instant;
  readonly newRuleId: () => RuleIdValue;
}

interface RuleShape {
  readonly hostname: string;
  readonly action: RuleAction;
  readonly scope: RuleScope;
}

const compareStrength = (strengths: readonly OperationStrength[]): OperationStrength => {
  if (strengths.includes("weaker")) {
    return "weaker";
  }
  if (strengths.includes("stronger")) {
    return "stronger";
  }
  return "unchanged";
};

const classifyRuleSetChange = (
  current: PolicyContent["rules"],
  target: PolicyContent["rules"],
): OperationStrength => {
  const currentByKey = new Map(current.map((rule) => [ruleKey(rule), rule.action] as const));
  const targetByKey = new Map(target.map((rule) => [ruleKey(rule), rule.action] as const));
  const strengths: OperationStrength[] = [];
  for (const [key, action] of currentByKey) {
    const next = targetByKey.get(key);
    if (next === undefined) {
      strengths.push(action === "allow" ? "stronger" : "weaker");
      continue;
    }
    if (next !== action) {
      strengths.push(next === "block" ? "stronger" : "weaker");
    }
  }
  for (const [key, action] of targetByKey) {
    if (!currentByKey.has(key)) {
      strengths.push(action === "block" ? "stronger" : "weaker");
    }
  }
  return compareStrength(strengths);
};

const classifyCategories = (
  current: readonly CategoryName[],
  target: readonly CategoryName[],
): OperationStrength => {
  const currentSet = new Set(current);
  const targetSet = new Set(target);
  if (current.some((name) => !targetSet.has(name))) {
    return "weaker";
  }
  return target.some((name) => !currentSet.has(name)) ? "stronger" : "unchanged";
};

export const classifyPolicyChange = (
  current: PolicyContent,
  target: PolicyContent,
): OperationStrength =>
  compareStrength([
    current.enabled === target.enabled ? "unchanged" : target.enabled ? "stronger" : "weaker",
    classifyCategories(current.categories, target.categories),
    current.cooldownSeconds === target.cooldownSeconds
      ? "unchanged"
      : target.cooldownSeconds > current.cooldownSeconds
        ? "stronger"
        : "weaker",
    classifyRuleSetChange(current.rules, target.rules),
  ]);

export const classifyOperation = (
  current: Policy,
  operation: Operation,
): OperationStrength => {
  switch (operation.type) {
    case "addRule":
      return operation.rule.action === "block" ? "stronger" : "weaker";
    case "removeRule": {
      const rule = current.rules.find((entry) => entry.id === operation.ruleId);
      return rule === undefined ? "unchanged" : rule.action === "allow" ? "stronger" : "weaker";
    }
    case "setCategories":
      return classifyCategories(current.categories, operation.categories);
    case "setEnabled":
      return current.enabled === operation.enabled
        ? "unchanged"
        : operation.enabled
          ? "stronger"
          : "weaker";
    case "setCooldown":
      return current.cooldownSeconds === operation.cooldownSeconds
        ? "unchanged"
        : operation.cooldownSeconds > current.cooldownSeconds
          ? "stronger"
          : "weaker";
    case "restorePolicy":
      return classifyPolicyChange(policyContent(current), policyContent(operation.policy));
  }
};

const buildRule = (
  input: RuleShape,
  context: OperationContext,
): { readonly ok: true; readonly rule: Rule } | { readonly ok: false; readonly failure: OperationFailure } => {
  const normalized = normalizeHostnameInput(input.hostname);
  if (!normalized.ok) {
    return {
      ok: false,
      failure: { type: "InvalidHostname", input: input.hostname, reason: normalized.reason },
    };
  }
  return {
    ok: true,
    rule: {
      id: context.newRuleId(),
      hostname: normalized.hostname,
      action: input.action,
      scope: input.scope,
      createdAt: context.now,
    },
  };
};

const buildRuleSet = (
  inputs: readonly RuleShape[],
  context: OperationContext,
): { readonly ok: true; readonly rules: readonly Rule[] } | { readonly ok: false; readonly failure: OperationFailure } => {
  const rules: Rule[] = [];
  for (const input of inputs) {
    const built = buildRule(input, context);
    if (!built.ok) {
      return built;
    }
    rules.push(built.rule);
  }
  const conflict = findRuleConflicts(rules)[0];
  if (conflict !== undefined) {
    return {
      ok: false,
      failure: {
        type: "RuleConflict",
        hostname: conflict.hostname,
        scope: conflict.scope,
        kind: conflict.kind,
      },
    };
  }
  if (rules.length > MAX_RULES) {
    return { ok: false, failure: { type: "RuleLimit", limit: MAX_RULES } };
  }
  return { ok: true, rules: sortRules(rules) };
};

const revisionOf = (
  current: Policy,
  next: {
    readonly enabled: boolean;
    readonly categories: readonly CategoryName[];
    readonly cooldownSeconds: number;
    readonly rules: readonly Rule[];
  },
  context: OperationContext,
): Policy => ({
  schemaVersion: 1,
  revision: current.revision + 1,
  enabled: next.enabled,
  categories: sortCategories(next.categories),
  cooldownSeconds: next.cooldownSeconds,
  dnsEndpoint: current.dnsEndpoint,
  rules: sortRules(next.rules),
  updatedAt: context.now,
});

const unchanged = (current: Policy): OperationOutcome => ({
  ok: true,
  policy: current,
  changed: false,
});

const contentWithRules = (
  current: Policy,
  rules: readonly Rule[],
): { readonly enabled: boolean; readonly categories: readonly CategoryName[]; readonly cooldownSeconds: number; readonly rules: readonly Rule[] } => ({
  enabled: current.enabled,
  categories: current.categories,
  cooldownSeconds: current.cooldownSeconds,
  rules,
});

export const applyOperation = (
  current: Policy,
  operation: Operation,
  context: OperationContext,
): OperationOutcome => {
  switch (operation.type) {
    case "addRule": {
      const built = buildRule(operation.rule, context);
      if (!built.ok) {
        return built;
      }
      const existing = current.rules.find((rule) => ruleKey(rule) === ruleKey(built.rule));
      if (existing !== undefined) {
        if (existing.action === built.rule.action) {
          return unchanged(current);
        }
        return {
          ok: false,
          failure: {
            type: "RuleConflict",
            hostname: built.rule.hostname,
            scope: built.rule.scope,
            kind: "action_conflict",
          },
        };
      }
      const rules = [...current.rules, built.rule];
      if (rules.length > MAX_RULES) {
        return { ok: false, failure: { type: "RuleLimit", limit: MAX_RULES } };
      }
      return {
        ok: true,
        policy: revisionOf(current, contentWithRules(current, rules), context),
        changed: true,
      };
    }
    case "removeRule": {
      const existing = current.rules.find((rule) => rule.id === operation.ruleId);
      if (existing === undefined) {
        return { ok: false, failure: { type: "RuleNotFound", ruleId: operation.ruleId } };
      }
      const rules = current.rules.filter((rule) => rule.id !== operation.ruleId);
      return {
        ok: true,
        policy: revisionOf(current, contentWithRules(current, rules), context),
        changed: true,
      };
    }
    case "setCategories": {
      const categories = sortCategories(operation.categories);
      const content = policyContent(current);
      const target: PolicyContent = { ...content, categories };
      if (sameContent(content, target)) {
        return unchanged(current);
      }
      return {
        ok: true,
        policy: revisionOf(
          current,
          { enabled: current.enabled, categories, cooldownSeconds: current.cooldownSeconds, rules: current.rules },
          context,
        ),
        changed: true,
      };
    }
    case "setEnabled": {
      if (current.enabled === operation.enabled) {
        return unchanged(current);
      }
      return {
        ok: true,
        policy: revisionOf(
          current,
          {
            enabled: operation.enabled,
            categories: current.categories,
            cooldownSeconds: current.cooldownSeconds,
            rules: current.rules,
          },
          context,
        ),
        changed: true,
      };
    }
    case "setCooldown": {
      if (current.cooldownSeconds === operation.cooldownSeconds) {
        return unchanged(current);
      }
      return {
        ok: true,
        policy: revisionOf(
          current,
          {
            enabled: current.enabled,
            categories: current.categories,
            cooldownSeconds: operation.cooldownSeconds,
            rules: current.rules,
          },
          context,
        ),
        changed: true,
      };
    }
    case "restorePolicy": {
      if (operation.policy.dnsEndpoint !== current.dnsEndpoint) {
        return {
          ok: false,
          failure: { type: "BackupEndpointMismatch", received: operation.policy.dnsEndpoint },
        };
      }
      const built = buildRuleSet(
        operation.policy.rules.map((rule) => ({
          hostname: rule.hostname,
          action: rule.action,
          scope: rule.scope,
        })),
        context,
      );
      if (!built.ok) {
        return built;
      }
      const target: PolicyContent = {
        enabled: operation.policy.enabled,
        categories: operation.policy.categories,
        cooldownSeconds: operation.policy.cooldownSeconds,
        rules: built.rules,
      };
      if (sameContent(policyContent(current), target)) {
        return unchanged(current);
      }
      return {
        ok: true,
        policy: revisionOf(
          current,
          {
            enabled: target.enabled,
            categories: target.categories,
            cooldownSeconds: target.cooldownSeconds,
            rules: built.rules,
          },
          context,
        ),
        changed: true,
      };
    }
  }
};
