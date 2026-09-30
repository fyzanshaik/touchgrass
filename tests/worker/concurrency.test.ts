import { describe, expect, it } from "vitest";
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

const weaken = (hostname: string) =>
  addRuleOperation({ hostname, action: "allow", scope: "domain" });

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const blockTraffic = async (name: string): Promise<string> => {
  const rule = (await snapshotOf(name)).simulatedRules.find(
    (entry) => entry.name === "clearbrowse:block-domain#0",
  );
  return rule === undefined ? "" : rule.traffic;
};

describe("interleaved mutations", () => {
  it("applies the newest desired revision when a slower pass is still in flight", async () => {
    const name = freshStubName("interleave");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug({ kind: "latency", value: 60 });

    const first = stub.submitChange({
      operation: strengthen("first.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    await wait(20);
    const second = stub.submitChange({
      operation: strengthen("second.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok ? secondResult.value.desiredRevision : 0).toBe(3);

    const status = await statusOf(name);
    expect(status.desiredRevision).toBe(3);
    expect(status.gatewayAppliedRevision).toBe(3);
    expect(status.reconciliation).toBe("idle");
    expect(status.lastErrorCode).toBeNull();

    const snapshot = await snapshotOf(name);
    expect(snapshot.simulatedRules.map((rule) => rule.name).sort()).toEqual([
      "clearbrowse:block-domain#0",
      "clearbrowse:category#0",
    ]);
    const traffic = await blockTraffic(name);
    expect(traffic.includes("first.example.org")).toBe(true);
    expect(traffic.includes("second.example.org")).toBe(true);
  });

  it("does not strand a newer revision behind a failed older pass", async () => {
    const name = freshStubName("stranded");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug({ kind: "latency", value: 40 });
    await stub.debug({
      kind: "fault",
      operation: "upsert",
      timing: "before",
      error: "timeout",
      count: 1,
    });

    const first = stub.submitChange({
      operation: strengthen("first.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    await wait(10);
    const second = stub.submitChange({
      operation: strengthen("second.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    await Promise.all([first, second]);

    const stranded = await statusOf(name);
    expect(stranded.desiredRevision).toBe(3);
    expect(stranded.reconciliation).not.toBe("idle");
    expect(stranded.nextRetryAt).not.toBeNull();

    await stub.debug({ kind: "advance", seconds: 60 });
    await drainAlarm(name);

    const recovered = await statusOf(name);
    expect(recovered.desiredRevision).toBe(3);
    expect(recovered.gatewayAppliedRevision).toBe(3);
    expect(recovered.reconciliation).toBe("idle");
    expect((await snapshotOf(name)).simulatedRules.length).toBe(2);
  });

  it("keeps a newer revision pending rather than marking an older one applied", async () => {
    const name = freshStubName("monotonic");
    const stub = stubFor(name);
    await statusOf(name);
    await stub.debug({ kind: "latency", value: 30 });

    const first = stub.submitChange({
      operation: strengthen("first.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    await wait(5);
    const second = stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok ? secondResult.value.state : "").toBe("pendingRelaxation");

    const status = await statusOf(name);
    expect(status.desiredRevision).toBe(2);
    expect(status.gatewayAppliedRevision).toBe(2);
    expect(status.relaxations.filter((entry) => entry.state === "pending").length).toBe(1);
  });
});
