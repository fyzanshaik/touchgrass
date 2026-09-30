import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "effect";
import { GatewayEndpoint } from "../src/dns-profile/endpoint.ts";
import {
  Operation,
  applyOperation,
  classifyOperation,
  type Operation as OperationType,
  type OperationStrength,
} from "../src/domain/operations.ts";
import { MAX_RULES, RuleId, makeRuleId } from "../src/domain/policy.ts";
import { instantFromMilliseconds } from "../src/domain/instants.ts";
import { atEpoch, policyOf, ruleOf } from "./support/policy.ts";

const later = instantFromMilliseconds(1000);

const nextIds = (): (() => RuleId) => {
  let counter = 0;
  return () => {
    counter += 1;
    return makeRuleId(`00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`);
  };
};

const context = (): { now: typeof later; newRuleId: () => RuleId } => ({
  now: later,
  newRuleId: nextIds(),
});

const decodeOperation = Schema.decodeUnknownEither(Operation);
const strictDecodeOperation = Schema.decodeUnknownEither(Operation, {
  onExcessProperty: "error",
});

const blockRule = ruleOf({
  id: "11111111-1111-4111-8111-111111111111",
  hostname: "blocked.example.org",
  action: "block",
  scope: "domain",
});
const allowRule = ruleOf({
  id: "22222222-2222-4222-8222-222222222222",
  hostname: "allowed.example.org",
  action: "allow",
  scope: "host",
});

const withRules = (rules: readonly (typeof blockRule)[]) =>
  policyOf({ rules, categories: ["pornography"], enabled: true, cooldownSeconds: 86400 });

describe("operation schema", () => {
  it("accepts every documented operation", () => {
    const operations = [
      { type: "addRule", rule: { hostname: "example.org", action: "block", scope: "domain" } },
      { type: "removeRule", ruleId: blockRule.id },
      { type: "setCategories", categories: ["pornography"] },
      { type: "setEnabled", enabled: false },
      { type: "setCooldown", cooldownSeconds: 3600 },
      { type: "restorePolicy", policy: policyOf({}) },
    ];
    for (const operation of operations) {
      assert.equal(decodeOperation(operation)._tag, "Right");
    }
  });

  it("rejects unknown operation types", () => {
    assert.equal(decodeOperation({ type: "deleteEverything" })._tag, "Left");
    assert.equal(decodeOperation({ type: "setEnabled" })._tag, "Left");
    assert.equal(decodeOperation({ type: "addRule", rule: { hostname: "x" } })._tag, "Left");
  });

  it("rejects unexpected fields when decoding strictly", () => {
    assert.equal(
      strictDecodeOperation({ type: "setEnabled", enabled: true, extra: 1 })._tag,
      "Left",
    );
    assert.equal(strictDecodeOperation({ type: "setEnabled", enabled: true })._tag, "Right");
  });

  it("rejects out-of-range cooldowns and categories", () => {
    assert.equal(decodeOperation({ type: "setCooldown", cooldownSeconds: -1 })._tag, "Left");
    assert.equal(decodeOperation({ type: "setCooldown", cooldownSeconds: 604801 })._tag, "Left");
    assert.equal(
      decodeOperation({ type: "setCategories", categories: ["pornography", "pornography"] })._tag,
      "Left",
    );
    assert.equal(decodeOperation({ type: "setCategories", categories: ["unknown"] })._tag, "Left");
    assert.equal(decodeOperation({ type: "setCategories", categories: ["nudity"] })._tag, "Left");
    assert.equal(decodeOperation({ type: "setCategories", categories: ["adultThemes"] })._tag, "Left");
  });
});

describe("operation strength classification", () => {
  const current = withRules([blockRule, allowRule]);

  const cases: readonly {
    readonly name: string;
    readonly operation: OperationType;
    readonly strength: OperationStrength;
  }[] = [
    {
      name: "adding a block is stronger",
      operation: { type: "addRule", rule: { hostname: "new.example.org", action: "block", scope: "domain" } },
      strength: "stronger",
    },
    {
      name: "adding an allow is weaker",
      operation: { type: "addRule", rule: { hostname: "new.example.org", action: "allow", scope: "domain" } },
      strength: "weaker",
    },
    { name: "removing an allow is stronger", operation: { type: "removeRule", ruleId: allowRule.id }, strength: "stronger" },
    { name: "removing a block is weaker", operation: { type: "removeRule", ruleId: blockRule.id }, strength: "weaker" },
    { name: "removing an unknown rule is unchanged", operation: { type: "removeRule", ruleId: makeRuleId("33333333-3333-4333-8333-333333333333") }, strength: "unchanged" },
    { name: "removing a category is weaker", operation: { type: "setCategories", categories: [] }, strength: "weaker" },
    { name: "keeping categories is unchanged", operation: { type: "setCategories", categories: ["pornography"] }, strength: "unchanged" },
    { name: "keeping protection on is unchanged", operation: { type: "setEnabled", enabled: true }, strength: "unchanged" },
    { name: "disabling protection is weaker", operation: { type: "setEnabled", enabled: false }, strength: "weaker" },
    { name: "same cooldown is unchanged", operation: { type: "setCooldown", cooldownSeconds: 86400 }, strength: "unchanged" },
    { name: "longer cooldown is stronger", operation: { type: "setCooldown", cooldownSeconds: 172800 }, strength: "stronger" },
    { name: "shorter cooldown is weaker", operation: { type: "setCooldown", cooldownSeconds: 3600 }, strength: "weaker" },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      assert.equal(classifyOperation(current, entry.operation), entry.strength);
    });
  }

  it("is stronger when protection is switched on from off", () => {
    assert.equal(
      classifyOperation(policyOf({ enabled: false }), { type: "setEnabled", enabled: true }),
      "stronger",
    );
    assert.equal(
      classifyOperation(policyOf({ enabled: true }), { type: "setEnabled", enabled: false }),
      "weaker",
    );
  });
});

describe("restore classification", () => {
  const current = withRules([blockRule, allowRule]);

  const restore = (policy: Parameters<typeof classifyOperation>[0]): OperationType => ({
    type: "restorePolicy",
    policy,
  });

  it("classifies an identical restore as unchanged", () => {
    assert.equal(classifyOperation(current, restore(current)), "unchanged");
  });

  it("classifies a cooldown decrease as weaker", () => {
    assert.equal(
      classifyOperation(current, restore(policyOf({ rules: [blockRule, allowRule], cooldownSeconds: 60 }))),
      "weaker",
    );
  });

  it("classifies removing a block as weaker", () => {
    assert.equal(classifyOperation(current, restore(policyOf({ rules: [allowRule] }))), "weaker");
  });

  it("classifies adding a block as stronger", () => {
    assert.equal(
      classifyOperation(current, restore(policyOf({ rules: [blockRule, allowRule, ruleOf({ id: "44444444-4444-4444-8444-444444444444", hostname: "extra.example.org", action: "block", scope: "domain" })] }))),
      "stronger",
    );
  });

  it("classifies mixed strengthening and weakening as weaker", () => {
    const mixed = policyOf({
      rules: [
        ruleOf({ id: "55555555-5555-4555-8555-555555555555", hostname: "extra.example.org", action: "block", scope: "domain" }),
        allowRule,
      ],
      cooldownSeconds: 60,
    });
    assert.equal(classifyOperation(current, restore(mixed)), "weaker");
  });
});

describe("operation application", () => {
  it("normalizes the hostname and starts a new revision", () => {
    const current = withRules([]);
    const outcome = applyOperation(
      current,
      { type: "addRule", rule: { hostname: "EXAMPLE.ORG.", action: "block", scope: "domain" } },
      context(),
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.changed, true);
      assert.equal(outcome.policy.revision, current.revision + 1);
      assert.equal(outcome.policy.rules.length, 1);
      assert.equal(outcome.policy.rules[0]?.hostname, "example.org");
      assert.equal(outcome.policy.updatedAt, later);
    }
  });

  it("does not mutate the input policy", () => {
    const current = withRules([blockRule]);
    const before = JSON.stringify(current);
    applyOperation(
      current,
      { type: "removeRule", ruleId: blockRule.id },
      context(),
    );
    assert.equal(JSON.stringify(current), before);
  });

  it("reports an unchanged outcome for a duplicate rule and keeps the same object", () => {
    const current = withRules([blockRule]);
    const outcome = applyOperation(
      current,
      { type: "addRule", rule: { hostname: blockRule.hostname, action: "block", scope: "domain" } },
      context(),
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.changed, false);
      assert.equal(outcome.policy, current);
    }
  });

  it("rejects an opposite action for the same hostname and scope", () => {
    const current = withRules([blockRule]);
    const outcome = applyOperation(
      current,
      { type: "addRule", rule: { hostname: blockRule.hostname, action: "allow", scope: "domain" } },
      context(),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok && outcome.failure.type === "RuleConflict") {
      assert.equal(outcome.failure.kind, "action_conflict");
    } else {
      assert.fail("expected a rule conflict");
    }
  });

  it("rejects an unknown rule removal", () => {
    const outcome = applyOperation(
      withRules([]),
      { type: "removeRule", ruleId: makeRuleId("99999999-9999-4999-8999-999999999999") },
      context(),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? null : outcome.failure.type, "RuleNotFound");
  });

  it("rejects an invalid hostname", () => {
    const outcome = applyOperation(
      withRules([]),
      { type: "addRule", rule: { hostname: "github.io", action: "block", scope: "domain" } },
      context(),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? null : outcome.failure.type, "InvalidHostname");
  });

  it("enforces the rule limit", () => {
    const rules = Array.from({ length: MAX_RULES }, (_unused, index) =>
      ruleOf({
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        hostname: `host${index}.example.org`,
        action: "block",
        scope: "domain",
      }),
    );
    const full = policyOf({ rules });
    const addOutcome = applyOperation(
      full,
      { type: "addRule", rule: { hostname: "extra.example.org", action: "block", scope: "domain" } },
      context(),
    );
    assert.equal(addOutcome.ok ? null : addOutcome.failure.type, "RuleLimit");

    const tooMany = [...rules, ruleOf({
      id: "10000000-0000-4000-8000-999999999999",
      hostname: "extra.example.org",
      action: "block",
      scope: "domain",
    })];
    const restoreOutcome = applyOperation(
      full,
      { type: "restorePolicy", policy: policyOf({ rules: tooMany }) },
      context(),
    );
    assert.equal(restoreOutcome.ok ? null : restoreOutcome.failure.type, "RuleLimit");
  });

  it("rejects a restore from a different Gateway endpoint", () => {
    const decodeEndpoint = Schema.decodeSync(GatewayEndpoint);
    const foreign = {
      ...policyOf({}),
      dnsEndpoint: decodeEndpoint("https://other-location.cloudflare-gateway.com/dns-query"),
    };
    const outcome = applyOperation(
      withRules([]),
      { type: "restorePolicy", policy: foreign },
      context(),
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      assert.fail("expected a backup endpoint mismatch");
    } else {
      assert.equal(outcome.failure.type, "BackupEndpointMismatch");
    }
  });

  it("restores content while regenerating rule identifiers", () => {
    const backup = policyOf({
      rules: [blockRule, allowRule],
      cooldownSeconds: 3600,
      categories: ["pornography"],
    });
    const outcome = applyOperation(withRules([]), { type: "restorePolicy", policy: backup }, context());
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.changed, true);
      assert.equal(outcome.policy.rules.length, 2);
      assert.equal(outcome.policy.cooldownSeconds, 3600);
      assert.equal(outcome.policy.categories.length, 1);
      const ids = outcome.policy.rules.map((rule) => rule.id);
      assert.equal(ids.includes(blockRule.id), false);
    }
  });

  it("sorts rules deterministically", () => {
    const first = applyOperation(
      withRules([]),
      {
        type: "restorePolicy",
        policy: policyOf({
          rules: [
            ruleOf({ id: "66666666-6666-4666-8666-666666666666", hostname: "zzz.example.org", action: "allow", scope: "host" }),
            ruleOf({ id: "77777777-7777-4777-8777-777777777777", hostname: "aaa.example.org", action: "block", scope: "domain" }),
          ],
        }),
      },
      context(),
    );
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.deepEqual(
        first.policy.rules.map((rule) => rule.hostname),
        ["aaa.example.org", "zzz.example.org"],
      );
    }
  });

  it("applies scalar setters without touching rules", () => {
    const current = withRules([blockRule]);
    const disabled = applyOperation(current, { type: "setEnabled", enabled: false }, context());
    assert.equal(disabled.ok, true);
    if (disabled.ok) {
      assert.equal(disabled.policy.enabled, false);
      assert.equal(disabled.policy.rules.length, 1);
      assert.equal(disabled.policy.revision, current.revision + 1);
    }
    const same = applyOperation(current, { type: "setEnabled", enabled: true }, context());
    assert.equal(same.ok, true);
    assert.equal(same.ok ? same.changed : true, false);
  });

  it("preserves the single supported category across a restore", () => {
    const outcome = applyOperation(
      withRules([]),
      { type: "restorePolicy", policy: policyOf({ categories: ["pornography"] }) },
      context(),
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.policy.categories, ["pornography"]);
    }
  });

  it("uses the untouched timestamp for a created rule", () => {
    const outcome = applyOperation(
      withRules([]),
      { type: "addRule", rule: { hostname: "example.org", action: "block", scope: "host" } },
      { now: atEpoch, newRuleId: nextIds() },
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.policy.rules[0]?.createdAt, atEpoch);
    }
  });
});
