import type { CategoryName, Policy, Rule, RuleAction, RuleScope } from "./policy.ts";

export const COMPILER_VERSION = "clearbrowse-dns-compiler/1";

export const CATEGORY_IDS: Readonly<Record<CategoryName, number>> = {
  pornography: 133,
};

export const MAX_EXPRESSION_CHARACTERS = 4096;
export const EXPRESSION_BUDGET = 4000;
export const MAX_COMPILED_RULES = 100;

export interface CompiledRule {
  readonly logicalName: string;
  readonly action: RuleAction;
  readonly precedence: number;
  readonly traffic: string;
}

export interface SuppressedAllow {
  readonly hostname: string;
  readonly scope: RuleScope;
  readonly supersededBy: string;
}

export interface CompiledPlan {
  readonly compilerVersion: string;
  readonly policyRevision: number;
  readonly locationSubdomain: string;
  readonly rules: readonly CompiledRule[];
  readonly suppressedAllows: readonly SuppressedAllow[];
}

export type CompilationFailure =
  | { readonly type: "ExpressionTooLong"; readonly logicalName: string }
  | { readonly type: "RuleBudgetExceeded"; readonly limit: number };

export type Compilation =
  | { readonly ok: true; readonly plan: CompiledPlan }
  | { readonly ok: false; readonly failure: CompilationFailure };

export interface CompileInput {
  readonly policy: Policy;
  readonly locationSubdomain: string;
  readonly precedenceBase: number;
  readonly expressionBudget?: number;
}

export const compilationFailureMessage = (failure: CompilationFailure): string => {
  switch (failure.type) {
    case "ExpressionTooLong":
      return `The ${failure.logicalName} filter cannot be expressed within the ${String(MAX_EXPRESSION_CHARACTERS)}-character Gateway expression limit.`;
    case "RuleBudgetExceeded":
      return `The compiled plan needs more than ${String(failure.limit)} Gateway rules.`;
  }
};

const JOIN = " or ";

const quote = (value: string): string => `"${value}"`;

const hostnameExpression = (hostname: string, scope: RuleScope): string =>
  scope === "host"
    ? `dns.fqdn == ${quote(hostname)}`
    : `any(dns.domains[*] == ${quote(hostname)})`;

const alternatives = (parts: readonly string[]): string =>
  parts.length === 1 ? (parts[0] ?? "") : `(${parts.join(JOIN)})`;

const scopedTo = (location: string, matcher: string): string =>
  `dns.doh_subdomain == ${quote(location)} and ${matcher}`;

export const hostnameMatchesRule = (
  rule: { readonly hostname: string; readonly scope: RuleScope },
  query: string,
): boolean =>
  rule.scope === "host"
    ? query === rule.hostname
    : query === rule.hostname || query.endsWith(`.${rule.hostname}`);

export const compiledRuleCanonical = (rule: CompiledRule): string =>
  JSON.stringify({
    logicalName: rule.logicalName,
    action: rule.action,
    precedence: rule.precedence,
    traffic: rule.traffic,
  });

export const compiledPlanCanonical = (plan: CompiledPlan): string =>
  JSON.stringify({
    compilerVersion: plan.compilerVersion,
    policyRevision: plan.policyRevision,
    locationSubdomain: plan.locationSubdomain,
    rules: plan.rules.map((rule) => compiledRuleCanonical(rule)),
  });

const chunkParts = (
  location: string,
  parts: readonly string[],
  budget: number,
): readonly (readonly string[])[] | undefined => {
  if (parts.length === 0) {
    return [];
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const part of parts) {
    const candidate = [...current, part];
    if (scopedTo(location, alternatives(candidate)).length <= budget) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      return undefined;
    }
    chunks.push(current);
    current = [part];
    if (scopedTo(location, alternatives(current)).length > budget) {
      return undefined;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

const sortByHostname = (rules: readonly Rule[]): readonly Rule[] =>
  [...rules].sort((left, right) => (left.hostname < right.hostname ? -1 : 1));

interface RuleGroup {
  readonly logicalName: string;
  readonly action: RuleAction;
  readonly parts: readonly string[];
}

const selectByScope = (rules: readonly Rule[], scope: RuleScope): readonly Rule[] =>
  rules.filter((rule) => rule.scope === scope);

const partsFor = (rules: readonly Rule[], scope: RuleScope): readonly string[] =>
  sortByHostname(selectByScope(rules, scope)).map((rule) =>
    hostnameExpression(rule.hostname, scope),
  );

const categoryParts = (policy: Policy): readonly string[] => {
  if (policy.categories.length === 0) {
    return [];
  }
  const ids = [...policy.categories]
    .map((name) => CATEGORY_IDS[name])
    .sort((left, right) => left - right);
  return [`any(dns.content_category[*] in {${ids.join(", ")}})`];
};

export const compilePolicy = (input: CompileInput): Compilation => {
  const { policy, locationSubdomain, precedenceBase } = input;
  const budget = input.expressionBudget ?? EXPRESSION_BUDGET;
  const groups: RuleGroup[] = [];
  const suppressedAllows: SuppressedAllow[] = [];

  if (policy.enabled) {
    const blocks = policy.rules.filter((rule) => rule.action === "block");
    const effectiveAllows: Rule[] = [];
    for (const allow of policy.rules.filter((rule) => rule.action === "allow")) {
      const supersededBy = blocks.find((block) => hostnameMatchesRule(block, allow.hostname));
      if (supersededBy === undefined) {
        effectiveAllows.push(allow);
      } else {
        suppressedAllows.push({
          hostname: allow.hostname,
          scope: allow.scope,
          supersededBy: supersededBy.hostname,
        });
      }
    }
    groups.push(
      { logicalName: "block-host", action: "block", parts: partsFor(blocks, "host") },
      { logicalName: "block-domain", action: "block", parts: partsFor(blocks, "domain") },
      { logicalName: "allow-host", action: "allow", parts: partsFor(effectiveAllows, "host") },
      { logicalName: "allow-domain", action: "allow", parts: partsFor(effectiveAllows, "domain") },
      { logicalName: "category", action: "block", parts: categoryParts(policy) },
    );
  }

  const rules: CompiledRule[] = [];
  for (const group of groups) {
    if (group.parts.length === 0) {
      continue;
    }
    const chunks = chunkParts(locationSubdomain, group.parts, budget);
    if (chunks === undefined) {
      return { ok: false, failure: { type: "ExpressionTooLong", logicalName: group.logicalName } };
    }
    for (const [index, chunk] of chunks.entries()) {
      if (rules.length >= MAX_COMPILED_RULES) {
        return { ok: false, failure: { type: "RuleBudgetExceeded", limit: MAX_COMPILED_RULES } };
      }
      rules.push({
        logicalName: `${group.logicalName}#${String(index)}`,
        action: group.action,
        precedence: precedenceBase + rules.length,
        traffic: scopedTo(locationSubdomain, alternatives(chunk)),
      });
    }
  }

  return {
    ok: true,
    plan: {
      compilerVersion: COMPILER_VERSION,
      policyRevision: policy.revision,
      locationSubdomain,
      rules,
      suppressedAllows,
    },
  };
};
