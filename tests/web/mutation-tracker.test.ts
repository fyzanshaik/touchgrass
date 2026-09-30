import assert from "node:assert/strict";
import test from "node:test";
import { createMutationTracker, mutationSignature } from "../../src/web/state/mutation-tracker.ts";
import { policyFixture } from "./fixtures.ts";

const counterKey = (): (() => string) => {
  let counter = 0;
  return () => {
    counter += 1;
    return `key-${counter}`;
  };
};

test("a signature keeps one key and the original base revision across retries", () => {
  const tracker = createMutationTracker(counterKey());
  const first = tracker.acquire("change:a", policyFixture(1).revision);
  const second = tracker.acquire("change:a", policyFixture(5).revision);

  assert.equal(second.idempotencyKey, first.idempotencyKey);
  assert.equal(second.baseRevision, first.baseRevision);
  assert.equal(second.baseRevision, policyFixture(1).revision);
});

test("releasing a signature allows a fresh identity with the new base revision", () => {
  const tracker = createMutationTracker(counterKey());
  const first = tracker.acquire("change:a", policyFixture(1).revision);
  tracker.release("change:a");
  const second = tracker.acquire("change:a", policyFixture(5).revision);

  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
  assert.equal(second.baseRevision, policyFixture(5).revision);
});

test("distinct signatures do not share an identity", () => {
  const tracker = createMutationTracker(counterKey());
  const first = tracker.acquire("change:a", policyFixture(1).revision);
  const second = tracker.acquire("change:b", policyFixture(1).revision);

  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
});

test("isRetained reports whether an identity is held", () => {
  const tracker = createMutationTracker(counterKey());

  assert.equal(tracker.isRetained("change:a"), false);
  tracker.acquire("change:a", policyFixture(1).revision);
  assert.equal(tracker.isRetained("change:a"), true);
  tracker.release("change:a");
  assert.equal(tracker.isRetained("change:a"), false);
});

test("mutationSignature joins its parts", () => {
  assert.equal(mutationSignature(["change", "setEnabled:off"]), "change|setEnabled:off");
});
