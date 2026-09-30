import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CATEGORY_IDS,
  EXPRESSION_BUDGET,
  MAX_COMPILED_RULES,
  compilePolicy,
  compiledPlanCanonical,
  type CompiledPlan,
} from "../src/domain/plan.ts";
import type { CategoryName, Policy, Rule, RuleAction, RuleScope } from "../src/domain/policy.ts";
import { policyOf, ruleOf } from "./support/policy.ts";

const subdomain = "clearbrowse-test";
const precedenceBase = 1000;
const scopePrefix = `dns.doh_subdomain == "${subdomain}" and `;

const compile = (policy: Policy, expressionBudget?: number): CompiledPlan => {
  const compilation = compilePolicy({
    policy,
    locationSubdomain: subdomain,
    precedenceBase,
    ...(expressionBudget === undefined ? {} : { expressionBudget }),
  });
  if (!compilation.ok) {
    throw new Error(`compilation failed: ${compilation.failure.type}`);
  }
  return compilation.plan;
};

const compileFailure = (policy: Policy, expressionBudget?: number) => {
  const compilation = compilePolicy({
    policy,
    locationSubdomain: subdomain,
    precedenceBase,
    ...(expressionBudget === undefined ? {} : { expressionBudget }),
  });
  if (compilation.ok) {
    throw new Error("expected the compilation to fail");
  }
  return compilation.failure;
};

const ruleOfHost = (index: number, hostname: string, action: RuleAction, scope: RuleScope): Rule =>
  ruleOf({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    hostname,
    action,
    scope,
  });

const blockDomain = ruleOfHost(1, "blocked.example.org", "block", "domain");
const blockHost = ruleOfHost(2, "www.blocked.example.org", "block", "host");
const allowHost = ruleOfHost(3, "safe.example.net", "allow", "host");
const allowDomain = ruleOfHost(4, "example.com", "allow", "domain");

describe("gateway compiler", () => {
  it("emits only the category rule for the default policy", () => {
    const plan = compile(policyOf({ categories: ["pornography"] }));
    assert.equal(plan.rules.length, 1);
    const rule = plan.rules[0];
    assert.equal(rule?.logicalName, "category#0");
    assert.equal(rule?.action, "block");
    assert.equal(rule?.precedence, precedenceBase);
    assert.equal(
      rule?.traffic,
      `${scopePrefix}any(dns.content_category[*] in {${CATEGORY_IDS.pornography}})`,
    );
  });

  it("emits no project filtering rules when protection is off", () => {
    const disabled = compile(
      policyOf({ enabled: false, rules: [blockDomain, blockHost, allowDomain, allowHost] }),
    );
    assert.deepEqual(disabled.rules, []);
    assert.deepEqual(disabled.suppressedAllows, []);
  });

  it("emits no rules when protection is off and no categories are selected", () => {
    assert.deepEqual(compile(policyOf({ enabled: false, categories: [] })).rules, []);
  });

  it("orders blocks before allows and before the category rule", () => {
    const plan = compile(
      policyOf({ rules: [allowDomain, blockHost, blockDomain, allowHost] }),
    );
    assert.deepEqual(
      plan.rules.map((rule) => rule.logicalName),
      ["block-host#0", "block-domain#0", "allow-host#0", "allow-domain#0", "category#0"],
    );
    assert.deepEqual(
      plan.rules.map((rule) => rule.precedence),
      [
        precedenceBase,
        precedenceBase + 1,
        precedenceBase + 2,
        precedenceBase + 3,
        precedenceBase + 4,
      ],
    );
  });

  it("uses the documented host and domain expressions", () => {
    const plan = compile(policyOf({ rules: [blockDomain, blockHost], categories: [] }));
    const hostRule = plan.rules.find((rule) => rule.logicalName === "block-host#0");
    const domainRule = plan.rules.find((rule) => rule.logicalName === "block-domain#0");
    assert.equal(hostRule?.traffic, `${scopePrefix}dns.fqdn == "www.blocked.example.org"`);
    assert.equal(
      domainRule?.traffic,
      `${scopePrefix}any(dns.domains[*] == "blocked.example.org")`,
    );
  });

  it("combines multiple entries with or inside one rule, sorted by hostname", () => {
    const second = ruleOfHost(5, "another-blocked.example.org", "block", "domain");
    const plan = compile(policyOf({ rules: [blockDomain, second], categories: [] }));
    const domainRule = plan.rules.find((rule) => rule.logicalName === "block-domain#0");
    assert.equal(
      domainRule?.traffic,
      `${scopePrefix}(any(dns.domains[*] == "another-blocked.example.org") or any(dns.domains[*] == "blocked.example.org"))`,
    );
  });

  it("suppresses an allow that a block already covers", () => {
    const allowSame = ruleOfHost(6, "blocked.example.org", "allow", "domain");
    const plan = compile(policyOf({ rules: [blockDomain, allowSame], categories: [] }));
    assert.equal(plan.suppressedAllows.length, 1);
    assert.equal(plan.suppressedAllows[0]?.supersededBy, "blocked.example.org");
    assert.equal(
      plan.rules.some((rule) => rule.logicalName.startsWith("allow")),
      false,
    );
  });

  it("suppresses a narrower allow when a block covers it", () => {
    const allowUnderBlock = ruleOfHost(11, "www.blocked.example.org", "allow", "host");
    const plan = compile(policyOf({ rules: [blockHost, allowUnderBlock], categories: [] }));
    assert.equal(plan.suppressedAllows.length, 1);
    assert.equal(plan.rules.some((rule) => rule.logicalName.startsWith("allow")), false);
  });

  it("keeps an allow that a host block does not cover", () => {
    const allowApex = ruleOfHost(7, "blocked.example.org", "allow", "domain");
    const plan = compile(policyOf({ rules: [blockHost, allowApex], categories: [] }));
    assert.deepEqual(plan.suppressedAllows, []);
    assert.equal(plan.rules.some((rule) => rule.logicalName === "allow-domain#0"), true);
  });

  it("never emits a catch-all allow rule", () => {
    const plan = compile(policyOf({ rules: [allowHost, allowDomain], categories: [] }));
    const allowRules = plan.rules.filter((rule) => rule.action === "allow");
    assert.equal(allowRules.length, 2);
    for (const rule of allowRules) {
      assert.equal(rule.traffic.startsWith(scopePrefix), true);
      assert.equal(
        rule.traffic.includes("dns.fqdn ==") || rule.traffic.includes("any(dns.domains[*] =="),
        true,
      );
    }
  });

  it("is deterministic for the same input", () => {
    const policy = policyOf({ rules: [blockDomain, blockHost, allowHost] });
    assert.equal(compiledPlanCanonical(compile(policy)), compiledPlanCanonical(compile(policy)));
    assert.deepEqual(
      compile(policy).rules.map((rule) => rule.logicalName),
      compile(policy).rules.map((rule) => rule.logicalName),
    );
  });

  it("records the policy revision and location in the plan", () => {
    const plan = compile(policyOf({ categories: ["pornography"] }));
    assert.equal(plan.policyRevision, 1);
    assert.equal(plan.locationSubdomain, subdomain);
    assert.equal(plan.compilerVersion, "clearbrowse-dns-compiler/1");
  });
});

describe("gateway compiler expression bounds", () => {
  const manyRules = (count: number): readonly Rule[] =>
    Array.from({ length: count }, (_unused, index) =>
      ruleOfHost(index + 1, `host-${String(index)}.example.org`, "block", "domain"),
    );

  it("keeps every rule within the Gateway expression limit", () => {
    const plan = compile(policyOf({ rules: manyRules(400), categories: [] }));
    assert.equal(plan.rules.length >= 2, true);
    for (const rule of plan.rules) {
      assert.equal(rule.traffic.length <= EXPRESSION_BUDGET, true);
    }
    const covered = plan.rules.flatMap(
      (rule) => rule.traffic.match(/host-\d+\.example\.org/g) ?? [],
    );
    assert.equal(covered.length, 400);
    assert.equal(new Set(covered).size, 400);
  });

  it("names split rules deterministically and contiguously", () => {
    const plan = compile(policyOf({ rules: manyRules(200), categories: [] }));
    assert.deepEqual(
      plan.rules.map((rule) => rule.logicalName),
      plan.rules.map((_unused, index) => `block-domain#${String(index)}`),
    );
    assert.deepEqual(
      plan.rules.map((rule) => rule.precedence),
      plan.rules.map((_unused, index) => precedenceBase + index),
    );
    const recompiled = compile(policyOf({ rules: manyRules(200), categories: [] }));
    assert.deepEqual(
      plan.rules.map((rule) => rule.logicalName),
      recompiled.rules.map((rule) => rule.logicalName),
    );
  });

  it("splits at a smaller configured budget", () => {
    const plan = compile(policyOf({ rules: manyRules(6), categories: [] }), 120);
    assert.equal(plan.rules.length, 6);
    for (const rule of plan.rules) {
      assert.equal(rule.traffic.length <= 120, true);
    }
  });

  it("refuses a single entry that cannot fit the budget", () => {
    const failure = compileFailure(policyOf({ rules: [blockDomain], categories: [] }), 10);
    assert.equal(failure.type, "ExpressionTooLong");
  });

  it("refuses a plan that needs more rules than the owned budget", () => {
    const failure = compileFailure(policyOf({ rules: manyRules(MAX_COMPILED_RULES + 20), categories: [] }), 120);
    assert.equal(failure.type, "RuleBudgetExceeded");
  });

  it("handles the product rule cap without exceeding the expression budget", () => {
    const plan = compile(policyOf({ rules: manyRules(1000), categories: ["pornography"] }));
    assert.equal(plan.rules.length <= MAX_COMPILED_RULES, true);
    for (const rule of plan.rules) {
      assert.equal(rule.traffic.length <= EXPRESSION_BUDGET, true);
    }
  });
});

describe("category scope", () => {
  it("only accepts pornography", () => {
    const accepted: CategoryName = "pornography";
    assert.equal(CATEGORY_IDS[accepted], 133);
  });
});
