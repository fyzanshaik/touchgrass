import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "../../src/web/client/api-client.ts";
import { createDashboardStore } from "../../src/web/state/dashboard-store.ts";
import {
  apiFailure,
  backupFixture,
  blockRule,
  allowRule,
  changeFixture,
  diagnosticsFixture,
  offlineFailure,
  policyFixture,
  statusFixture,
} from "./fixtures.ts";

const baseClient = (): ApiClient => ({
  readPolicy: async () => ({
    ok: true,
    value: { notModified: false, etag: '"p-1"', policy: policyFixture(1) },
  }),
  readStatus: async () => ({ ok: true, value: statusFixture(1) }),
  readDiagnostics: async () => ({ ok: true, value: diagnosticsFixture() }),
  preview: async () => ({
    ok: true,
    value: {
      accepted: true,
      hostname: "example.com",
      reason: null,
      source: "hostname",
      scope: "domain",
      message: "The hostname is stored for the selected scope.",
    },
  }),
  submitChange: async () => ({ ok: true, value: changeFixture("revised", 1) }),
  confirmRelaxation: async () => ({ ok: true, value: changeFixture("revised", 2) }),
  cancelRelaxation: async () => ({ ok: true, value: statusFixture(2) }),
  reconcile: async () => ({ ok: true, value: statusFixture(2) }),
  restore: async () => ({ ok: true, value: changeFixture("revised", 2) }),
  readBackup: async () => ({ ok: true, value: backupFixture(policyFixture(1)) }),
});

const fakeClient = (overrides: Partial<ApiClient>): ApiClient => ({
  ...baseClient(),
  ...overrides,
});

test("refresh loads policy, status and diagnostics and becomes ready", async () => {
  const store = createDashboardStore(fakeClient({}));

  await store.refresh();

  const state = store.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.offline, false);
  assert.equal(state.stale, false);
  assert.equal(state.etag, '"p-1"');
  assert.ok(state.policy !== null);
  assert.equal(state.policy.revision, 1);
  assert.ok(state.status !== null);
  assert.ok(state.diagnostics !== null);
});

test("refresh keeps the last known policy when the service is offline", async () => {
  let offline = false;
  const store = createDashboardStore(
    fakeClient({
      readPolicy: async () =>
        offline
          ? { ok: false, failure: offlineFailure() }
          : { ok: true, value: { notModified: false, etag: '"p-2"', policy: policyFixture(2) } },
      readStatus: async () =>
        offline ? { ok: false, failure: offlineFailure() } : { ok: true, value: statusFixture(2) },
    }),
  );

  await store.refresh();
  offline = true;
  await store.refresh();

  const state = store.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.offline, true);
  assert.equal(state.stale, true);
  assert.ok(state.policy !== null);
  assert.equal(state.policy.revision, 2);
  assert.ok(state.failure !== null);
  assert.equal(state.failure.kind, "offline");
});

test("refresh reports a failed phase when nothing has ever loaded", async () => {
  const store = createDashboardStore(
    fakeClient({
      readPolicy: async () => ({ ok: false, failure: offlineFailure() }),
      readStatus: async () => ({ ok: false, failure: offlineFailure() }),
      readDiagnostics: async () => ({ ok: false, failure: offlineFailure() }),
    }),
  );

  await store.refresh();

  const state = store.getState();
  assert.equal(state.phase, "failed");
  assert.equal(state.policy, null);
});

test("a 304 reuses the cached policy and updates the etag only", async () => {
  let notModified = false;
  const store = createDashboardStore(
    fakeClient({
      readPolicy: async () =>
        notModified
          ? { ok: true, value: { notModified: true, etag: '"p-9"' } }
          : { ok: true, value: { notModified: false, etag: '"p-1"', policy: policyFixture(1) } },
    }),
  );

  await store.refresh();
  notModified = true;
  await store.refresh();

  const state = store.getState();
  assert.equal(state.etag, '"p-9"');
  assert.ok(state.policy !== null);
  assert.equal(state.policy.revision, 1);
});

test("an ambiguous failure keeps the key and original base revision across a retry", async () => {
  const calls: { readonly idempotencyKey: string; readonly baseRevision: number }[] = [];
  let revision = 1;
  const store = createDashboardStore(
    fakeClient({
      readPolicy: async () => ({
        ok: true,
        value: { notModified: false, etag: `"p-${revision}"`, policy: policyFixture(revision) },
      }),
      readStatus: async () => ({ ok: true, value: statusFixture(revision) }),
      submitChange: async (_operation, headers) => {
        calls.push({
          idempotencyKey: headers.idempotencyKey,
          baseRevision: headers.baseRevision,
        });
        return { ok: false, failure: offlineFailure() };
      },
    }),
    { createKey: () => "stable-key" },
  );

  await store.refresh();
  const first = await store.applyChange({ type: "setEnabled", enabled: false });
  assert.equal(first.retryable, true);

  revision = 5;
  await store.refresh();

  const second = await store.retryLast();
  assert.equal(second.retryable, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[1]?.baseRevision, 1);
  assert.equal(calls[1]?.idempotencyKey, "stable-key");
});

test("a definitive failure releases the identity and refreshes from the server", async () => {
  const keys: string[] = [];
  let revision = 1;
  let counter = 0;
  const store = createDashboardStore(
    fakeClient({
      readPolicy: async () => ({
        ok: true,
        value: { notModified: false, etag: `"p-${revision}"`, policy: policyFixture(revision) },
      }),
      readStatus: async () => ({ ok: true, value: statusFixture(revision) }),
      submitChange: async (_operation, headers) => {
        keys.push(headers.idempotencyKey);
        revision = 2;
        return { ok: false, failure: apiFailure("stale_revision", 412) };
      },
    }),
    {
      createKey: () => {
        counter += 1;
        return `key-${counter}`;
      },
    },
  );

  await store.refresh();
  const first = await store.applyChange({ type: "setEnabled", enabled: false });

  assert.equal(first.retryable, false);
  assert.ok(store.getState().policy !== null);
  assert.equal(store.getState().policy?.revision, 2);

  await store.applyChange({ type: "setEnabled", enabled: false });
  assert.deepEqual(keys, ["key-1", "key-2"]);
});

test("mutation phases are observable through subscribe", async () => {
  const seen: string[] = [];
  const store = createDashboardStore(fakeClient({}));
  const unsubscribe = store.subscribe(() => {
    seen.push(store.getState().mutation.phase);
  });

  await store.refresh();
  seen.length = 0;
  await store.applyChange({ type: "setEnabled", enabled: false });

  assert.ok(seen.includes("sending"));
  assert.ok(seen.includes("succeeded"));
  unsubscribe();
});

test("retrying with nothing pending reports that there is nothing to retry", async () => {
  const store = createDashboardStore(fakeClient({}));

  const outcome = await store.retryLast();

  assert.equal(outcome.ok, false);
  assert.equal(outcome.retryable, false);
});

test("making a change before the policy loads is refused", async () => {
  const store = createDashboardStore(fakeClient({}));

  const outcome = await store.applyChange({ type: "setEnabled", enabled: false });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, "Load the current policy before making changes.");
});

test("exportBackup returns the decoded backup without changing load state", async () => {
  const store = createDashboardStore(fakeClient({}));
  await store.refresh();

  const result = await store.exportBackup();

  assert.ok(result.ok);
  assert.equal(result.value.sourceRevision, 1);
  assert.equal(store.getState().phase, "ready");
});

test("restore identity is content-scoped and an exact retry keeps key and base", async () => {
  const calls: { readonly key: string; readonly base: number; readonly rules: number }[] = [];
  let revision = 1;
  let counter = 0;
  const store = createDashboardStore(
    fakeClient({
      readPolicy: async () => ({
        ok: true,
        value: {
          notModified: false,
          etag: `"p-${revision}"`,
          policy: policyFixture(revision, [blockRule]),
        },
      }),
      readStatus: async () => ({ ok: true, value: statusFixture(revision) }),
      restore: async (request, headers) => {
        calls.push({
          key: headers.idempotencyKey,
          base: headers.baseRevision,
          rules: request.policy.rules.length,
        });
        return { ok: false, failure: offlineFailure() };
      },
    }),
    {
      createKey: () => {
        counter += 1;
        return `key-${counter}`;
      },
    },
  );

  await store.refresh();

  const firstBackup = policyFixture(2, [blockRule]);
  const secondBackup = policyFixture(2, [blockRule, allowRule]);

  await store.restore(firstBackup);
  await store.restore(secondBackup);
  await store.retryLast();

  revision = 5;
  await store.refresh();
  await store.restore(firstBackup);

  assert.deepEqual(calls.map((call) => call.key), ["key-1", "key-2", "key-2", "key-1"]);
  assert.deepEqual(calls.map((call) => call.base), [1, 1, 1, 1]);
  assert.deepEqual(calls.map((call) => call.rules), [1, 2, 2, 1]);
});
