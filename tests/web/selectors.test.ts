import assert from "node:assert/strict";
import test from "node:test";
import {
  changeMessage,
  cooldownStrength,
  countRules,
  describeRelaxation,
  filterRules,
  operationSignature,
  pendingRelaxations,
  relaxationWindow,
  summariseProtection,
} from "../../src/web/state/selectors.ts";
import {
  ELIGIBLE,
  RULE_ID,
  allowRule,
  blockRule,
  changeFixture,
  policyFixture,
  relaxationFixture,
  statusFixture,
} from "./fixtures.ts";

const weakening = { type: "setEnabled", enabled: false } as const;

test("summariseProtection reports an applied policy as applied", () => {
  const summary = summariseProtection(policyFixture(3), statusFixture(3));

  assert.equal(summary.applied, true);
  assert.equal(summary.drift, false);
  assert.equal(summary.desiredRevision, 3);
  assert.equal(summary.gatewayMode, "simulated");
});

test("summariseProtection reports a drift when Gateway has not caught up", () => {
  const summary = summariseProtection(policyFixture(3), statusFixture(2));

  assert.equal(summary.applied, false);
  assert.equal(summary.drift, true);
});

test("summariseProtection tolerates missing data", () => {
  const summary = summariseProtection(null, null);

  assert.equal(summary.applied, false);
  assert.equal(summary.drift, false);
  assert.equal(summary.desiredRevision, null);
  assert.equal(summary.cooldownSeconds, null);
  assert.deepEqual(summary.categories, []);
});

test("filterRules matches case-insensitively and returns everything for an empty query", () => {
  const rules = [blockRule, allowRule];

  assert.equal(filterRules(rules, "").length, 2);
  assert.equal(filterRules(rules, "EXAMPLE").length, 2);
  assert.equal(filterRules(rules, "org").length, 1);
  assert.equal(filterRules(rules, "missing").length, 0);
});

test("countRules splits blocks and exceptions", () => {
  const counts = countRules([blockRule, allowRule]);

  assert.deepEqual(counts, { total: 2, blocks: 1, allows: 1 });
});

test("pendingRelaxations excludes settled requests", () => {
  const pending = relaxationFixture({
    id: RULE_ID,
    state: "pending",
    canConfirm: false,
    operation: weakening,
  });
  const confirmed = relaxationFixture({
    id: "33333333-3333-4333-8333-333333333333",
    state: "confirmed",
    canConfirm: false,
    operation: weakening,
  });

  const result = pendingRelaxations(statusFixture(1, [pending, confirmed]));

  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "pending");
});

test("describeRelaxation resolves a removal to the stored hostname", () => {
  const summary = relaxationFixture({
    id: RULE_ID,
    state: "pending",
    canConfirm: false,
    operation: { type: "removeRule", ruleId: RULE_ID },
  });

  assert.equal(describeRelaxation(summary, policyFixture(1)), "Remove the block rule for example.com");
  assert.equal(describeRelaxation(summary, null), "Remove a rule from the current policy");
});

test("relaxationWindow marks an eligible request as eligible", () => {
  const summary = relaxationFixture({
    id: RULE_ID,
    state: "pending",
    canConfirm: true,
    operation: weakening,
  });

  const window = relaxationWindow(summary, Date.parse(ELIGIBLE));

  assert.equal(window.eligible, true);
  assert.equal(window.expired, false);
});

test("relaxationWindow holds a request before its eligibility time", () => {
  const summary = relaxationFixture({
    id: RULE_ID,
    state: "pending",
    canConfirm: true,
    operation: weakening,
  });

  const window = relaxationWindow(summary, Date.parse(ELIGIBLE) - 3_600_000);

  assert.equal(window.eligible, false);
  assert.equal(window.expired, false);
  assert.ok(window.waitingLabel.startsWith("Eligible "));
});

test("relaxationWindow marks an expired request as expired", () => {
  const summary = relaxationFixture({
    id: RULE_ID,
    state: "expired",
    canConfirm: false,
    operation: weakening,
  });

  const window = relaxationWindow(summary, Date.parse(ELIGIBLE) + 86_400_000);

  assert.equal(window.eligible, false);
  assert.equal(window.expired, true);
});

test("operationSignature is stable and distinguishes actions", () => {
  assert.equal(operationSignature({ type: "setEnabled", enabled: false }), "setEnabled:off");
  assert.equal(operationSignature({ type: "setEnabled", enabled: true }), "setEnabled:on");
  assert.equal(
    operationSignature({
      type: "addRule",
      rule: { hostname: "example.com", action: "block", scope: "domain" },
    }),
    "addRule:block:domain:example.com",
  );
  assert.equal(
    operationSignature({ type: "setCategories", categories: ["pornography"] }),
    "setCategories:pornography",
  );
  assert.equal(operationSignature({ type: "setCooldown", cooldownSeconds: 3600 }), "setCooldown:3600");
});

test("operationSignature for a restore covers backup content, not just metadata", () => {
  const oneRule = operationSignature({ type: "restorePolicy", policy: policyFixture(2, [blockRule]) });
  const twoRules = operationSignature({
    type: "restorePolicy",
    policy: policyFixture(2, [blockRule, allowRule]),
  });

  assert.notEqual(oneRule, twoRules);

  const reordered = operationSignature({
    type: "restorePolicy",
    policy: policyFixture(2, [allowRule, blockRule]),
  });
  assert.equal(reordered, twoRules);

  const repeated = operationSignature({ type: "restorePolicy", policy: policyFixture(2, [blockRule]) });
  assert.equal(repeated, oneRule);
});

test("changeMessage only claims applied when the new revision is the applied one", () => {
  assert.match(changeMessage(changeFixture("revised", 2)), /was applied to Gateway/);
});

test("changeMessage does not claim applied when the applied revision is stale", () => {
  assert.match(changeMessage(changeFixture("revised", 1)), /being applied to Gateway/);
  assert.match(changeMessage(changeFixture("revised", 1, 3)), /being applied to Gateway/);
});

test("changeMessage does not claim applied when the revisions are unknown", () => {
  assert.match(changeMessage(changeFixture("revised", null, null)), /being applied to Gateway/);
  assert.match(changeMessage(changeFixture("revised", 5, null)), /being applied to Gateway/);
});

test("summariseProtection does not call Gateway up to date while reconciliation is degraded", () => {
  const summary = summariseProtection(
    policyFixture(3),
    statusFixture(3, [], { reconciliation: "degraded" }),
  );

  assert.equal(summary.desiredRevision, 3);
  assert.equal(summary.appliedRevision, 3);
  assert.equal(summary.applied, false);
  assert.equal(summary.drift, false);
  assert.equal(summary.trustworthy, false);
  assert.equal(summary.standing, "untrusted");
});

test("summariseProtection does not call Gateway up to date while it is applying", () => {
  const summary = summariseProtection(
    policyFixture(3),
    statusFixture(3, [], { reconciliation: "applying" }),
  );

  assert.equal(summary.applied, false);
  assert.equal(summary.trustworthy, false);
  assert.equal(summary.standing, "applying");
});

test("summariseProtection does not call Gateway up to date with an error or a scheduled retry", () => {
  const errored = summariseProtection(
    policyFixture(3),
    statusFixture(3, [], { lastErrorCode: "gateway_timeout" }),
  );
  assert.equal(errored.applied, false);
  assert.equal(errored.standing, "untrusted");

  const retrying = summariseProtection(
    policyFixture(3),
    statusFixture(3, [], { nextRetryAt: ELIGIBLE }),
  );
  assert.equal(retrying.applied, false);
  assert.equal(retrying.standing, "untrusted");
});

test("summariseProtection standing separates drift, unknown and applied", () => {
  assert.equal(summariseProtection(policyFixture(3), statusFixture(2)).standing, "drift");
  assert.equal(summariseProtection(policyFixture(3), statusFixture(3)).standing, "applied");
  assert.equal(summariseProtection(policyFixture(3), null).standing, "unknown");
  assert.equal(summariseProtection(null, statusFixture(3)).standing, "unknown");
});

test("cooldownStrength classifies cooldown changes", () => {
  assert.equal(cooldownStrength(86400, 86400), "unchanged");
  assert.equal(cooldownStrength(86400, 172800), "stronger");
  assert.equal(cooldownStrength(86400, 60), "weaker");
  assert.equal(cooldownStrength(null, 60), "unchanged");
});
