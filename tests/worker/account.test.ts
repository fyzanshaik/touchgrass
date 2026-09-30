import { describe, expect, it } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  addRuleOperation,
  etagOf,
  freshStubName,
  snapshotOf,
  statusOf,
  stubFor,
  uniqueKey,
} from "./support.ts";

const changeBody = (operation: unknown) => ({ operation });

const revisionRows = async (name: string): Promise<readonly (readonly unknown[])[]> =>
  runInDurableObject(stubFor(name), (_instance, state) => {
    const cursor = state.storage.sql.exec(
      "SELECT revision FROM policy_revisions ORDER BY revision ASC",
    );
    return [...cursor.raw()];
  });

describe("account revisions", () => {
  it("initialises revision one and applies the default policy", async () => {
    const name = freshStubName("init");
    const status = await statusOf(name);
    expect(status.desiredRevision).toBe(1);
    expect(status.gatewayAppliedRevision).toBe(1);
    expect(status.reconciliation).toBe("idle");
    expect(status.gatewayMode).toBe("simulated");
    expect(status.relaxations).toEqual([]);

    const snapshot = await snapshotOf(name);
    expect(snapshot.simulatedRules.map((rule) => rule.name)).toEqual(["clearbrowse:category#0"]);
    expect(snapshot.simulatedRules[0]?.traffic).toContain("dns.content_category[*] in {133}");
  });

  it("commits a strengthening change immediately and records an immutable revision", async () => {
    const name = freshStubName("stronger");
    const stub = stubFor(name);
    await statusOf(name);
    const etag = await etagOf(name);

    const first = await stub.submitChange({
      operation: addRuleOperation({
        hostname: "blocked.example.org",
        action: "block",
        scope: "domain",
      }),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(first.ok).toBe(true);
    expect(first.ok ? first.value.state : "").toBe("revised");
    expect(first.ok ? first.value.desiredRevision : 0).toBe(2);
    expect(first.ok ? first.value.appliedRevision : 0).toBe(2);
    expect(first.ok ? first.value.strength : "").toBe("stronger");

    const second = await stub.submitChange({
      operation: addRuleOperation({
        hostname: "other.example.org",
        action: "block",
        scope: "host",
      }),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(second.ok ? second.value.desiredRevision : 0).toBe(3);

    expect(await revisionRows(name)).toEqual([[1], [2], [3]]);
    const diagnostics = await stub.readDiagnostics();
    expect(diagnostics.ok ? diagnostics.value.planRevision : 0).toBe(3);
    expect(etag).toBe('"p-1"');
    expect(await etagOf(name)).toBe('"p-3"');
  });

  it("keeps the earlier revision content intact", async () => {
    const name = freshStubName("immutable");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: addRuleOperation({
        hostname: "blocked.example.org",
        action: "block",
        scope: "domain",
      }),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    const rows = await runInDurableObject(stub, (_instance, state) =>
      [...state.storage.sql
        .exec("SELECT revision, policy_json FROM policy_revisions ORDER BY revision ASC")
        .raw()],
    );
    const firstRevisionJson = String(rows[0]?.[1] ?? "");
    const secondRevisionJson = String(rows[1]?.[1] ?? "");
    expect(firstRevisionJson.includes("blocked.example.org")).toBe(false);
    expect(secondRevisionJson.includes("blocked.example.org")).toBe(true);
  });

  it("replays an identical idempotent request and rejects a conflicting reuse", async () => {
    const name = freshStubName("idempotency");
    const stub = stubFor(name);
    await statusOf(name);
    const key = uniqueKey();
    const operation = addRuleOperation({
      hostname: "blocked.example.org",
      action: "block",
      scope: "domain",
    });

    const accepted = await stub.submitChange({ operation, baseRevision: 1, idempotencyKey: key });
    const replayed = await stub.submitChange({ operation, baseRevision: 1, idempotencyKey: key });
    expect(replayed).toEqual(accepted);
    expect(replayed.ok ? replayed.value.desiredRevision : 0).toBe(2);

    const conflicting = await stub.submitChange({
      operation: addRuleOperation({
        hostname: "different.example.org",
        action: "block",
        scope: "domain",
      }),
      baseRevision: 1,
      idempotencyKey: key,
    });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.ok ? "" : conflicting.failure.type).toBe("idempotency_conflict");
  });

  it("rejects a stale base revision with the observed revision", async () => {
    const name = freshStubName("stale");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: addRuleOperation({ hostname: "a.example.org", action: "block", scope: "domain" }),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    const stale = await stub.submitChange({
      operation: addRuleOperation({ hostname: "b.example.org", action: "block", scope: "domain" }),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.failure.type === "stale_revision") {
      expect(stale.failure.expected).toBe(1);
      expect(stale.failure.actual).toBe(2);
    } else {
      expect.unreachable("expected a stale revision failure");
    }
  });

  it("requires a base revision and a UUID idempotency key", async () => {
    const name = freshStubName("guards");
    const stub = stubFor(name);
    await statusOf(name);
    const noBase = await stub.submitChange({
      operation: changeBody({ type: "setEnabled", enabled: true }).operation,
      baseRevision: null,
      idempotencyKey: uniqueKey(),
    });
    expect(noBase.ok ? "" : noBase.failure.type).toBe("precondition_required");

    const badKey = await stub.submitChange({
      operation: { type: "setEnabled", enabled: true },
      baseRevision: 1,
      idempotencyKey: "not-a-uuid",
    });
    expect(badKey.ok ? "" : badKey.failure.type).toBe("invalid_request");

    const unknown = await stub.submitChange({
      operation: { type: "wipe" },
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(unknown.ok ? "" : unknown.failure.type).toBe("invalid_request");
  });

  it("reports an unchanged outcome without starting a revision", async () => {
    const name = freshStubName("unchanged");
    const stub = stubFor(name);
    await statusOf(name);
    const same = await stub.submitChange({
      operation: { type: "setEnabled", enabled: true },
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(same.ok ? same.value.state : "").toBe("unchanged");
    expect(same.ok ? same.value.desiredRevision : 0).toBe(1);
    expect(await revisionRows(name)).toEqual([[1]]);
  });

  it("rejects a rule that conflicts with an existing entry", async () => {
    const name = freshStubName("conflict");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: addRuleOperation({
        hostname: "blocked.example.org",
        action: "block",
        scope: "domain",
      }),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    const conflicting = await stub.submitChange({
      operation: addRuleOperation({
        hostname: "blocked.example.org",
        action: "allow",
        scope: "domain",
      }),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(conflicting.ok ? "" : conflicting.failure.type).toBe("conflict");
  });

  it("rejects an invalid hostname and an oversized restore", async () => {
    const name = freshStubName("invalid");
    const stub = stubFor(name);
    await statusOf(name);
    const publicSuffix = await stub.submitChange({
      operation: addRuleOperation({ hostname: "github.io", action: "block", scope: "domain" }),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(publicSuffix.ok ? "" : publicSuffix.failure.type).toBe("invalid_request");

    const policy = await stub.exportBackup();
    if (!policy.ok) {
      throw new Error("expected a backup");
    }
    const oversized = {
      ...policy.value.policy,
      rules: Array.from({ length: 1001 }, (_unused, index) => ({
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        hostname: `host${index}.example.org`,
        action: "block",
        scope: "domain",
        createdAt: policy.value.policy.updatedAt,
      })),
    };
    const restored = await stub.restorePolicy({
      policy: oversized,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(restored.ok ? "" : restored.failure.type).toBe("invalid_request");
  });

  it("denies two edits racing on the same base revision", async () => {
    const name = freshStubName("race");
    const stub = stubFor(name);
    await statusOf(name);
    const results = await Promise.all([
      stub.submitChange({
        operation: addRuleOperation({ hostname: "one.example.org", action: "block", scope: "domain" }),
        baseRevision: 1,
        idempotencyKey: uniqueKey(),
      }),
      stub.submitChange({
        operation: addRuleOperation({ hostname: "two.example.org", action: "block", scope: "domain" }),
        baseRevision: 1,
        idempotencyKey: uniqueKey(),
      }),
    ]);
    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(1);
    const failure = rejected[0];
    expect(failure !== undefined && !failure.ok ? failure.failure.type : "").toBe("stale_revision");
  });

  it("keeps state across eviction", async () => {
    const name = freshStubName("evict");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: addRuleOperation({
        hostname: "blocked.example.org",
        action: "block",
        scope: "domain",
      }),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    await evictDurableObject(stub);
    const after = await statusOf(name);
    expect(after.desiredRevision).toBe(2);
    expect(after.gatewayAppliedRevision).toBe(2);
    const snapshot = await snapshotOf(name);
    expect(snapshot.simulatedRules.length).toBe(2);
    expect(snapshot.ownedResources.length).toBe(2);
  });

  it("exports a backup and restores it without changing anything", async () => {
    const name = freshStubName("backup");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.submitChange({
      operation: addRuleOperation({
        hostname: "blocked.example.org",
        action: "block",
        scope: "domain",
      }),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    const backup = await stub.exportBackup();
    if (!backup.ok) {
      throw new Error("expected a backup");
    }
    expect(backup.value.sourceRevision).toBe(2);
    expect(backup.value.policy.rules.length).toBe(1);

    const restored = await stub.restorePolicy({
      policy: backup.value.policy,
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(restored.ok ? restored.value.state : "").toBe("unchanged");
    expect(restored.ok ? restored.value.desiredRevision : 0).toBe(2);
  });
});
