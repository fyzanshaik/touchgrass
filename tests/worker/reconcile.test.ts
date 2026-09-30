import { describe, expect, it } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  addRuleOperation,
  drainAlarm,
  freshStubName,
  snapshotOf,
  statusOf,
  stubFor,
  uniqueKey,
} from "./support.ts";

const strengthen = (hostname: string) =>
  addRuleOperation({ hostname, action: "block", scope: "domain" });

const weakenFor = (hostname: string) =>
  addRuleOperation({ hostname, action: "allow", scope: "domain" });

const fault = (
  operation: string,
  timing: string,
  count: number,
  error = "timeout",
): {
  readonly kind: "fault";
  readonly operation: string;
  readonly timing: string;
  readonly error: string;
  readonly count: number;
} => ({ kind: "fault", operation, timing, error, count });

const ruleNames = async (name: string): Promise<readonly string[]> =>
  (await snapshotOf(name)).simulatedRules.map((rule) => rule.name).sort();

describe("reconciliation", () => {
  it("advances the applied revision only after a successful read-back", async () => {
    const name = freshStubName("readback");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug(fault("upsert", "before", 1));

    const change = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(change.ok ? change.value.desiredRevision : 0).toBe(2);

    const degraded = await statusOf(name);
    expect(degraded.desiredRevision).toBe(2);
    expect(degraded.gatewayAppliedRevision).toBe(1);
    expect(degraded.reconciliation).toBe("degraded");
    expect(degraded.lastErrorCode).toBe("timeout");
    expect(degraded.nextRetryAt).not.toBeNull();
    expect(await ruleNames(name)).toEqual(["clearbrowse:category#0"]);

    await stub.debug({ kind: "advance", seconds: 5 });
    await drainAlarm(name);

    const recovered = await statusOf(name);
    expect(recovered.gatewayAppliedRevision).toBe(2);
    expect(recovered.reconciliation).toBe("idle");
    expect(recovered.lastErrorCode).toBeNull();
    expect(await ruleNames(name)).toEqual([
      "clearbrowse:block-domain#0",
      "clearbrowse:category#0",
    ]);
    expect((await snapshotOf(name)).ownedResources.length).toBe(2);
  });

  it("arms a durable alarm before any awaited network reconcile", async () => {
    const name = freshStubName("armalarm");
    const stub = stubFor(name);
    await statusOf(name);
    const readAlarm = (): Promise<number | null> =>
      runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    expect(await readAlarm()).toBeNull();

    await stub.debug({ kind: "latency", value: 200 });
    await stub.debug(fault("upsert", "before", 1));

    const pending = stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(await readAlarm()).not.toBeNull();
    const midFlight = await runInDurableObject(stub, async (_instance, state) => [
      ...state.storage.sql
        .exec(
          "SELECT desired_revision, gateway_applied_revision, reconciliation_state, next_retry_at FROM account_state",
        )
        .raw(),
    ]);
    expect(midFlight).toEqual([[2, 1, "applying", null]]);

    const change = await pending;
    expect(change.ok ? change.value.desiredRevision : 0).toBe(2);
    const degraded = await statusOf(name);
    expect(degraded.reconciliation).toBe("degraded");
    expect(degraded.nextRetryAt).not.toBeNull();
    expect(await readAlarm()).not.toBeNull();

    await stub.debug({ kind: "advance", seconds: 10 });
    await drainAlarm(name);
    expect((await statusOf(name)).gatewayAppliedRevision).toBe(2);
  });

  it("recovers an ambiguous write without duplicating resources", async () => {
    const name = freshStubName("ambiguous");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug(fault("upsert", "after", 1));

    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });

    const midway = await snapshotOf(name);
    expect(midway.simulatedRules.some((rule) => rule.name === "clearbrowse:block-domain#0")).toBe(
      true,
    );
    expect(midway.ownedResources.length).toBe(1);
    expect((await statusOf(name)).gatewayAppliedRevision).toBe(1);

    await stub.debug({ kind: "advance", seconds: 5 });
    await drainAlarm(name);

    expect(await ruleNames(name)).toEqual([
      "clearbrowse:block-domain#0",
      "clearbrowse:category#0",
    ]);
    expect((await snapshotOf(name)).ownedResources.length).toBe(2);
    expect((await statusOf(name)).gatewayAppliedRevision).toBe(2);
  });

  it("never marks a mismatched read-back as applied", async () => {
    const name = freshStubName("mismatch");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect((await statusOf(name)).gatewayAppliedRevision).toBe(2);

    await stub.debug(fault("upsert", "ignore", 1));
    const updated = await stub.submitChange({
      operation: strengthen("second.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(updated.ok ? updated.value.desiredRevision : 0).toBe(3);

    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("gateway_readback_mismatch");
    expect(status.gatewayAppliedRevision).toBeNull();

    const policies = await stub.readPolicy({ ifNoneMatch: null });
    expect(policies.ok ? policies.value.policy.rules.length : -1).toBe(2);
  });

  it("never marks a missing rule as applied", async () => {
    const name = freshStubName("missing");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug(fault("upsert", "ignore", 1));
    const change = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(change.ok ? change.value.desiredRevision : 0).toBe(2);
    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("gateway_readback_missing");
    expect(status.gatewayAppliedRevision).toBeNull();
  });

  it("surfaces drift for an unexpected owned resource and preserves it", async () => {
    const name = freshStubName("drift");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug({
      kind: "rule",
      id: "sim-stranger",
      name: "clearbrowse:not-in-plan#0",
      action: "block",
      precedence: 4000,
      traffic: 'dns.doh_subdomain == "clearbrowse-test" and dns.fqdn == "stranger.example.org"',
      enabled: 1,
    });

    const reconcile = await stub.requestReconcile({ baseRevision: 1, idempotencyKey: uniqueKey() });
    expect(reconcile.ok).toBe(true);
    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("drift");
    expect(status.gatewayAppliedRevision).toBeNull();

    const snapshot = await snapshotOf(name);
    expect(snapshot.simulatedRules.some((rule) => rule.name === "clearbrowse:not-in-plan#0")).toBe(
      true,
    );
    expect(snapshot.ownedResources.some((resource) => resource.logicalName === "not-in-plan#0")).toBe(
      false,
    );
  });

  it("surfaces a collision when an owned name maps to a different resource", async () => {
    const name = freshStubName("collision");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    await stub.debug({ kind: "deleteRule", id: "sim-block-domain#0" });
    await stub.debug({
      kind: "rule",
      id: "sim-foreign-id",
      name: "clearbrowse:block-domain#0",
      action: "block",
      precedence: 1000,
      traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      enabled: 1,
    });

    const reconcile = await stub.requestReconcile({ baseRevision: 2, idempotencyKey: uniqueKey() });
    expect(reconcile.ok).toBe(true);
    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("collision");
    const snapshot = await snapshotOf(name);
    expect(snapshot.simulatedRules.some((rule) => rule.id === "sim-foreign-id")).toBe(true);
  });

  it("never marks a consistently mutated write as applied", async () => {
    const name = freshStubName("widened");
    const stub = stubFor(name);
    await statusOf(name);
    const before = await snapshotOf(name);
    expect(before.ownedResources.length).toBe(1);

    await stub.debug({ kind: "formatter", value: "widen" });
    const change = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(change.ok ? change.value.desiredRevision : 0).toBe(2);

    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("gateway_readback_mismatch");
    expect(status.gatewayAppliedRevision).toBeNull();

    const mutated = await snapshotOf(name);
    const widened = mutated.simulatedRules.find(
      (rule) => rule.name === "clearbrowse:block-domain#0",
    );
    expect(widened?.traffic.includes(" or ")).toBe(true);
    expect(mutated.ownedResources.length).toBe(1);

    await stub.debug({ kind: "formatter", value: "whitespace" });
    const repaired = await stub.requestReconcile({
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(repaired.ok).toBe(true);
    const recovered = await statusOf(name);
    expect(recovered.gatewayAppliedRevision).toBe(2);
    expect(recovered.reconciliation).toBe("idle");
  });

  it("fails closed when remote traffic is too deeply nested", async () => {
    const name = freshStubName("deepnest");
    const stub = stubFor(name);
    await statusOf(name);
    const nested = `${"(".repeat(1500)}dns.fqdn == "blocked.example.org"${")".repeat(1500)}`;
    expect(nested.length).toBeLessThan(4096);
    await stub.debug({
      kind: "rule",
      id: "sim-block-domain#0",
      name: "clearbrowse:block-domain#0",
      action: "block",
      precedence: 1000,
      traffic: nested,
      enabled: 1,
    });
    await stub.debug(fault("upsert", "ignore", 1));

    const change = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(change.ok ? change.value.desiredRevision : 0).toBe(2);

    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("gateway_readback_mismatch");
    expect(status.gatewayAppliedRevision).toBeNull();
  });

  it("records a partial change as degraded rather than applied", async () => {
    const name = freshStubName("partial");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug(fault("list", "ignore", 1));
    await stub.debug(fault("list", "before", 1));

    const change = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(change.ok ? change.value.desiredRevision : 0).toBe(2);

    const partial = await snapshotOf(name);
    expect(partial.simulatedRules.length).toBe(2);
    expect(partial.ownedResources.length).toBe(2);
    const degraded = await statusOf(name);
    expect(degraded.reconciliation).toBe("degraded");
    expect(degraded.gatewayAppliedRevision).toBe(1);

    await stub.debug({ kind: "advance", seconds: 5 });
    await drainAlarm(name);
    expect((await statusOf(name)).gatewayAppliedRevision).toBe(2);
  });

  it("persists retry attempts with growing backoff", async () => {
    const name = freshStubName("backoff");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug(fault("upsert", "before", 2));

    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    const first = await statusOf(name);
    const firstWait = Date.parse(first.nextRetryAt ?? "") - Date.parse(first.serverTime);

    await stub.debug(fault("upsert", "before", 1));
    await stub.requestReconcile({ baseRevision: 2, idempotencyKey: uniqueKey() });
    const second = await statusOf(name);
    const secondWait = Date.parse(second.nextRetryAt ?? "") - Date.parse(second.serverTime);

    expect(Math.abs(firstWait - 5000)).toBeLessThan(2000);
    expect(Math.abs(secondWait - 10000)).toBeLessThan(2000);
    expect(secondWait).toBeGreaterThan(firstWait);
  });

  it("resumes from persisted state after eviction", async () => {
    const name = freshStubName("resume");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug(fault("upsert", "before", 1));
    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect((await statusOf(name)).reconciliation).toBe("degraded");
    expect(await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm())).not.toBeNull();

    await evictDurableObject(stub);
    await stub.debug({ kind: "advance", seconds: 5 });
    await drainAlarm(name);

    expect((await statusOf(name)).gatewayAppliedRevision).toBe(2);
    expect(await ruleNames(name)).toEqual([
      "clearbrowse:block-domain#0",
      "clearbrowse:category#0",
    ]);
  });

  it("converges without duplicating resources when forced repeatedly", async () => {
    const name = freshStubName("noop");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    const first = await stub.requestReconcile({ baseRevision: 2, idempotencyKey: uniqueKey() });
    const second = await stub.requestReconcile({ baseRevision: 2, idempotencyKey: uniqueKey() });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const snapshot = await snapshotOf(name);
    expect(snapshot.simulatedRules.length).toBe(2);
    expect(snapshot.ownedResources.length).toBe(2);
    expect((await statusOf(name)).gatewayAppliedRevision).toBe(2);
  });

  it("replays a reconcile request and requires revision headers", async () => {
    const name = freshStubName("reconcilereplay");
    const stub = stubFor(name);
    await statusOf(name);
    const key = uniqueKey();
    const first = await stub.requestReconcile({ baseRevision: 1, idempotencyKey: key });
    const replay = await stub.requestReconcile({ baseRevision: 1, idempotencyKey: key });
    expect(replay).toEqual(first);

    const conflict = await stub.requestReconcile({ baseRevision: 99, idempotencyKey: uniqueKey() });
    expect(conflict.ok ? "" : conflict.failure.type).toBe("stale_revision");

    const noRevision = await stub.requestReconcile({ baseRevision: null, idempotencyKey: uniqueKey() });
    expect(noRevision.ok ? "" : noRevision.failure.type).toBe("precondition_required");
  });

  it("refuses a remote rule whose precedence breaks the plan order", async () => {
    const name = freshStubName("order");
    const stub = stubFor(name);
    await statusOf(name);

    const planned = await stub.readDiagnostics();
    if (!planned.ok) {
      throw new Error("expected diagnostics");
    }
    const desiredTraffic = planned.value.planRules[0]?.traffic ?? "";
    await stub.debug({
      kind: "rule",
      id: "sim-block-domain#0",
      name: "clearbrowse:block-domain#0",
      action: "block",
      precedence: 9999,
      traffic: desiredTraffic,
      enabled: 1,
    });
    await stub.debug(fault("upsert", "ignore", 1));

    const change = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(change.ok ? change.value.desiredRevision : 0).toBe(2);

    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("gateway_readback_mismatch");
    expect(status.gatewayAppliedRevision).toBeNull();
  });

  it("stops autonomous retries on a permanent failure and keeps it visible", async () => {
    const name = freshStubName("permanent");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug(fault("upsert", "before", 1, "collision"));

    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    const first = await statusOf(name);
    expect(first.reconciliation).toBe("degraded");
    expect(first.lastErrorCode).toBe("collision");
    expect(first.nextRetryAt).toBeNull();

    const resourcesBefore = (await snapshotOf(name)).ownedResources.length;
    await stub.debug({ kind: "advance", seconds: 3600 });
    await drainAlarm(name);

    const attemptOf = async (): Promise<number> => {
      const diagnostics = await stub.readDiagnostics();
      return diagnostics.ok ? (diagnostics.value.reconciliationJob?.attempt ?? 0) : -1;
    };
    expect(await attemptOf()).toBe(1);

    await stub.submitChange({
      operation: weakenFor("permanent.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    await drainAlarm(name);
    const afterOtherAlarm = await statusOf(name);
    expect(afterOtherAlarm.lastErrorCode).toBe("collision");
    expect(afterOtherAlarm.reconciliation).toBe("degraded");
    expect(await attemptOf()).toBe(1);
    expect((await snapshotOf(name)).ownedResources.length).toBe(resourcesBefore);

    const manual = await stub.requestReconcile({
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(manual.ok).toBe(true);
    const recovered = await statusOf(name);
    expect(recovered.gatewayAppliedRevision).toBe(2);
    expect(recovered.reconciliation).toBe("idle");
  });

  it("refuses to commit a policy that cannot be expressed, without truncating it", async () => {
    const name = freshStubName("capacity");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug({ kind: "expressionBudget", value: 10 });

    const refused = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.failure.type).toBe("conflict");

    const status = await statusOf(name);
    expect(status.desiredRevision).toBe(1);
    expect(status.gatewayAppliedRevision).toBe(1);
    expect(await ruleNames(name)).toEqual(["clearbrowse:category#0"]);

    const diagnostics = await stub.readDiagnostics();
    expect(diagnostics.ok ? diagnostics.value.planFailure : "").toContain("4096");

    const backup = await stub.exportBackup();
    if (!backup.ok) {
      throw new Error("expected a backup");
    }
    const expanded = {
      ...backup.value.policy,
      rules: [
        {
          id: "20000000-0000-4000-8000-000000000001",
          hostname: "blocked.example.org",
          action: "block",
          scope: "domain",
          createdAt: backup.value.exportedAt,
        },
      ],
    };
    const restore = await stub.restorePolicy({
      policy: expanded,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(restore.ok).toBe(false);
    expect(restore.ok ? "" : restore.failure.type).toBe("conflict");
    expect((await statusOf(name)).desiredRevision).toBe(1);
  });

  it("refuses to create a replacement when a tracked plan rule is missing remotely", async () => {
    const name = freshStubName("missingtracked");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect((await statusOf(name)).gatewayAppliedRevision).toBe(2);
    expect((await snapshotOf(name)).simulatedRules.length).toBe(2);

    await stub.debug({ kind: "deleteRule", id: "sim-block-domain#0" });
    const reconcile = await stub.requestReconcile({
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(reconcile.ok).toBe(true);

    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("collision");

    const after = await snapshotOf(name);
    expect(after.simulatedRules.length).toBe(1);
    expect(
      after.simulatedRules.some((rule) => rule.name === "clearbrowse:block-domain#0"),
    ).toBe(false);
  });

  it("does not relocate an unknown owned occupant before reporting drift", async () => {
    const name = freshStubName("unknownoccupant");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug({
      kind: "rule",
      id: "sim-unknown",
      name: "clearbrowse:aaunknown#0",
      action: "block",
      precedence: 1000,
      traffic: 'dns.doh_subdomain == "clearbrowse-test" and dns.fqdn == "unknown.example.org"',
      enabled: 1,
    });

    const change = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(change.ok ? change.value.desiredRevision : 0).toBe(2);

    const status = await statusOf(name);
    expect(status.reconciliation).toBe("degraded");
    expect(status.lastErrorCode).toBe("drift");
    expect(status.gatewayAppliedRevision).toBeNull();

    const snapshot = await snapshotOf(name);
    const unknown = snapshot.simulatedRules.find((rule) => rule.id === "sim-unknown");
    expect(unknown?.precedence).toBe(1000);
    expect(
      snapshot.simulatedRules.some((rule) => rule.name === "clearbrowse:block-domain#0"),
    ).toBe(false);
  });

  it("converges after a relocation is persisted and the job then fails", async () => {
    const name = freshStubName("relocateresume");
    const stub = stubFor(name);
    await statusOf(name);
    expect(await ruleNames(name)).toEqual(["clearbrowse:category#0"]);

    await stub.debug(fault("upsert", "after", 1));
    await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });

    const degraded = await statusOf(name);
    expect(degraded.reconciliation).toBe("degraded");
    expect(degraded.gatewayAppliedRevision).toBe(1);

    const parked = await snapshotOf(name);
    expect(parked.simulatedRules.length).toBe(2);
    const parkedPrecedences = parked.simulatedRules.map((rule) => rule.precedence);
    expect(new Set(parkedPrecedences).size).toBe(parkedPrecedences.length);
    const parkedCategory = parked.simulatedRules.find(
      (rule) => rule.name === "clearbrowse:category#0",
    );
    expect(parkedCategory?.precedence).toBeLessThan(1000);

    await stub.debug({ kind: "advance", seconds: 5 });
    await drainAlarm(name);

    const recovered = await statusOf(name);
    expect(recovered.reconciliation).toBe("idle");
    expect(recovered.gatewayAppliedRevision).toBe(2);
    const settled = await snapshotOf(name);
    expect(settled.ownedResources.length).toBe(2);
    const settledPrecedences = settled.simulatedRules.map((rule) => rule.precedence);
    expect(new Set(settledPrecedences).size).toBe(settledPrecedences.length);
    expect(settledPrecedences.sort((left, right) => left - right)).toEqual([1000, 1001]);
  });
});
