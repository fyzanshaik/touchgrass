import { Brand, Schema } from "effect";
import { GatewayEndpoint } from "../dns-profile/endpoint.ts";
import { Instant } from "./instants.ts";
import { RuleHostname } from "./hostname.ts";

export const MAX_RULES = 1000;
export const MAX_COOLDOWN_SECONDS = 604800;
export const DEFAULT_COOLDOWN_SECONDS = 86400;

export const CategoryName = Schema.Literal("pornography");
export type CategoryName = typeof CategoryName.Type;

export const RuleAction = Schema.Literal("block", "allow");
export type RuleAction = typeof RuleAction.Type;

export const RuleScope = Schema.Literal("host", "domain");
export type RuleScope = typeof RuleScope.Type;

export const Revision = Schema.Number.pipe(Schema.int(), Schema.between(1, 2147483647));
export type Revision = typeof Revision.Type;

export const CooldownSeconds = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, MAX_COOLDOWN_SECONDS),
);
export type CooldownSeconds = typeof CooldownSeconds.Type;

const RULE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RuleIdBranded = Schema.String.pipe(
  Schema.pattern(RULE_ID_PATTERN, { message: () => "Expected a lowercase UUID." }),
  Schema.brand("RuleId"),
);

export type RuleId = typeof RuleIdBranded.Type;

export const RuleId = RuleIdBranded;

export const makeRuleId = Brand.nominal<RuleId>();

export const CategoryList = Schema.Array(CategoryName).pipe(
  Schema.filter((names) => new Set(names).size === names.length, {
    message: () => "Category names must be unique.",
  }),
);

export const Rule = Schema.Struct({
  id: RuleId,
  hostname: RuleHostname,
  action: RuleAction,
  scope: RuleScope,
  createdAt: Instant,
});
export type Rule = typeof Rule.Type;

export const RuleInput = Schema.Struct({
  hostname: Schema.String,
  action: RuleAction,
  scope: RuleScope,
});
export type RuleInput = typeof RuleInput.Type;

export interface RuleConflict {
  readonly kind: "duplicate" | "action_conflict";
  readonly hostname: string;
  readonly scope: RuleScope;
}

export const ruleKey = (rule: {
  readonly scope: RuleScope;
  readonly hostname: string;
}): string => `${rule.scope}:${rule.hostname}`;

export const findRuleConflicts = (rules: readonly Rule[]): readonly RuleConflict[] => {
  const seen = new Map<string, RuleAction>();
  const conflicts: RuleConflict[] = [];
  for (const rule of rules) {
    const key = ruleKey(rule);
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, rule.action);
      continue;
    }
    conflicts.push({
      kind: previous === rule.action ? "duplicate" : "action_conflict",
      hostname: rule.hostname,
      scope: rule.scope,
    });
  }
  return conflicts;
};

const compareRules = (left: Rule, right: Rule): number => {
  if (left.hostname !== right.hostname) {
    return left.hostname < right.hostname ? -1 : 1;
  }
  if (left.scope !== right.scope) {
    return left.scope < right.scope ? -1 : 1;
  }
  return left.action < right.action ? -1 : 1;
};

export const sortRules = (rules: readonly Rule[]): readonly Rule[] =>
  [...rules].sort(compareRules);

export const sortCategories = (names: readonly CategoryName[]): readonly CategoryName[] =>
  [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

export const RuleList = Schema.Array(Rule).pipe(
  Schema.filter((rules) => rules.length <= MAX_RULES, {
    message: () => `A policy can hold at most ${MAX_RULES} rules.`,
  }),
  Schema.filter((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, {
    message: () => "Rule identifiers must be unique.",
  }),
  Schema.filter((rules) => findRuleConflicts(rules).length === 0, {
    message: () =>
      "Conflicting rule entries are not allowed: one hostname and scope can only carry one action.",
  }),
);

export const Policy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Revision,
  enabled: Schema.Boolean,
  categories: CategoryList,
  cooldownSeconds: CooldownSeconds,
  dnsEndpoint: GatewayEndpoint,
  rules: RuleList,
  updatedAt: Instant,
});
export type Policy = typeof Policy.Type;

export const initialPolicy = (input: {
  readonly dnsEndpoint: Policy["dnsEndpoint"];
  readonly now: Instant;
}): Policy => ({
  schemaVersion: 1,
  revision: 1,
  enabled: true,
  categories: ["pornography"],
  cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
  dnsEndpoint: input.dnsEndpoint,
  rules: [],
  updatedAt: input.now,
});

export interface PolicyContent {
  readonly enabled: boolean;
  readonly categories: readonly CategoryName[];
  readonly cooldownSeconds: number;
  readonly rules: readonly {
    readonly hostname: string;
    readonly scope: RuleScope;
    readonly action: RuleAction;
  }[];
}

export const policyContent = (policy: Policy): PolicyContent => ({
  enabled: policy.enabled,
  categories: policy.categories,
  cooldownSeconds: policy.cooldownSeconds,
  rules: policy.rules.map((rule) => ({
    hostname: rule.hostname,
    scope: rule.scope,
    action: rule.action,
  })),
});

export const sameContent = (left: PolicyContent, right: PolicyContent): boolean => {
  if (left.enabled !== right.enabled) {
    return false;
  }
  if (left.cooldownSeconds !== right.cooldownSeconds) {
    return false;
  }
  const leftCategories = sortCategories(left.categories);
  const rightCategories = sortCategories(right.categories);
  if (leftCategories.length !== rightCategories.length) {
    return false;
  }
  if (leftCategories.some((name, index) => name !== rightCategories[index])) {
    return false;
  }
  const encode = (content: PolicyContent): readonly string[] =>
    content.rules
      .map((rule) => `${rule.scope}:${rule.hostname}:${rule.action}`)
      .sort();
  const leftRules = encode(left);
  const rightRules = encode(right);
  if (leftRules.length !== rightRules.length) {
    return false;
  }
  return leftRules.every((entry, index) => entry === rightRules[index]);
};
