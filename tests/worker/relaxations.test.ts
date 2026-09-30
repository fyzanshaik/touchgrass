import { describe, expect, it } from "vitest";
import {
  addRuleOperation,
  drainAlarm,
  freshStubName,
  statusOf,
  stubFor,
  uniqueKey,
} from "./support.ts";

const COOLDOWN = 86400;
const EXPIRY = 604800;

const weaken = (hostname: string) => addRuleOperation({ hostname, action: "allow", scope: "domain" });
const strengthen = (hostname: string) => addRuleOperation({ hostname, action: "block", scope: "domain" });

const advance = async (name: string, seconds: number): Promise<void> => {
  await expect(
    stubFor(name).debug({ kind: "advance", seconds }),
  ).resolves.toMatchObject({ ok: true });
};

describe("relaxation lifecycle", () => {
  it("turns a weakening change into a pending proposal instead of applying it", async () => {
    const name = freshStubName("weak");
    const stub = stubFor(name);
    await statusOf(name);
    const response = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(response.ok).toBe(true);
    if (!response.ok) {
      return;
    }
    expect(response.value.state).toBe("pendingRelaxation");
    expect(response.value.strength).toBe("weaker");
    expect(response.value.desiredRevision).toBeNull();
    expect(response.value.relaxationId).not.toBeNull();

    const status = await statusOf(name);
    expect(status.desiredRevision).toBe(1);
    expect(status.gatewayAppliedRevision).toBe(1);
    expect(status.relaxations.length).toBe(1);
    expect(status.relaxations[0]?.state).toBe("pending");
    expect(status.relaxations[0]?.canConfirm).toBe(false);

    const eligibleAt = Date.parse(status.relaxations[0]?.eligibleAt ?? "");
    const requestedAt = Date.parse(status.serverTime);
    expect(Math.abs(eligibleAt - requestedAt - COOLDOWN * 1000)).toBeLessThan(2000);
    expect(Date.parse(status.relaxations[0]?.expiresAt ?? "") - eligibleAt).toBe(EXPIRY * 1000);
  });

  it("refuses confirmation before eligibility and unlocks exactly at the deadline", async () => {
    const name = freshStubName("eligible");
    const stub = stubFor(name);
    await statusOf(name);
    const proposal = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    if (!proposal.ok || proposal.value.relaxationId === null) {
      throw new Error("expected a pending proposal");
    }
    const id = proposal.value.relaxationId;

    const early = await stub.confirmRelaxation({
      relaxationId: id,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(early.ok).toBe(false);
    expect(early.ok ? "" : early.failure.type).toBe("conflict");

    await advance(name, COOLDOWN - 1);
    const almost = await stub.confirmRelaxation({
      relaxationId: id,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(almost.ok ? "" : almost.failure.type).toBe("conflict");
    expect((await statusOf(name)).relaxations[0]?.canConfirm).toBe(false);

    await advance(name, 1);
    const eligibleStatus = await statusOf(name);
    expect(eligibleStatus.relaxations[0]?.canConfirm).toBe(true);

    const confirmed = await stub.confirmRelaxation({
      relaxationId: id,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.ok ? confirmed.value.state : "").toBe("revised");
    expect(confirmed.ok ? confirmed.value.desiredRevision : 0).toBe(2);

    const after = await statusOf(name);
    expect(after.desiredRevision).toBe(2);
    expect(after.gatewayAppliedRevision).toBe(2);
    expect(after.relaxations[0]?.state).toBe("confirmed");
    expect(after.relaxations[0]?.resultingRevision).toBe(2);
  });

  it("does not apply a proposal at the deadline without confirmation", async () => {
    const name = freshStubName("nodeadline");
    const stub = stubFor(name);
    await statusOf(name);
    const proposal = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    if (!proposal.ok) {
      throw new Error("expected a pending proposal");
    }
    await advance(name, COOLDOWN + 60);
    await drainAlarm(name);
    const status = await statusOf(name);
    expect(status.desiredRevision).toBe(1);
    expect(status.relaxations[0]?.state).toBe("pending");
    expect(status.relaxations[0]?.canConfirm).toBe(true);
  });

  it("replays a confirmation key and refuses reuse after it is resolved", async () => {
    const name = freshStubName("confirmreplay");
    const stub = stubFor(name);
    await statusOf(name);
    const proposal = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    if (!proposal.ok || proposal.value.relaxationId === null) {
      throw new Error("expected a pending proposal");
    }
    await advance(name, COOLDOWN);
    const key = uniqueKey();
    const first = await stub.confirmRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: key,
    });
    const replay = await stub.confirmRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: key,
    });
    expect(replay).toEqual(first);

    const reused = await stub.confirmRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(reused.ok).toBe(false);
    expect(reused.ok ? "" : reused.failure.type).toBe("conflict");
  });

  it("cancels a pending proposal and returns the refreshed status", async () => {
    const name = freshStubName("cancel");
    const stub = stubFor(name);
    await statusOf(name);
    const proposal = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    if (!proposal.ok || proposal.value.relaxationId === null) {
      throw new Error("expected a pending proposal");
    }
    const cancelled = await stub.cancelRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.ok ? cancelled.value.relaxations[0]?.state : "").toBe("cancelled");
    expect(cancelled.ok ? cancelled.value.relaxations[0]?.canConfirm : true).toBe(false);

    const again = await stub.cancelRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(again.ok ? "" : again.failure.type).toBe("conflict");

    const confirmed = await stub.confirmRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(confirmed.ok ? "" : confirmed.failure.type).toBe("conflict");
  });

  it("expires a proposal seven days after eligibility", async () => {
    const name = freshStubName("expiry");
    const stub = stubFor(name);
    await statusOf(name);
    const proposal = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    if (!proposal.ok || proposal.value.relaxationId === null) {
      throw new Error("expected a pending proposal");
    }
    await advance(name, COOLDOWN + EXPIRY + 60);
    const expired = await stub.confirmRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(expired.ok ? "" : expired.failure.type).toBe("conflict");
    const status = await statusOf(name);
    expect(status.relaxations[0]?.state).toBe("expired");
    expect(status.desiredRevision).toBe(1);
  });

  it("expires a proposal through the alarm", async () => {
    const name = freshStubName("alarmexpiry");
    const stub = stubFor(name);
    await statusOf(name);
    const proposal = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(proposal.ok).toBe(true);
    await advance(name, COOLDOWN + EXPIRY + 60);
    await drainAlarm(name);
    const status = await statusOf(name);
    expect(status.relaxations[0]?.state).toBe("expired");
  });

  it("rejects a proposal whose base revision moved on", async () => {
    const name = freshStubName("stalerelax");
    const stub = stubFor(name);
    await statusOf(name);
    const proposal = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    if (!proposal.ok || proposal.value.relaxationId === null) {
      throw new Error("expected a pending proposal");
    }
    const stronger = await stub.submitChange({
      operation: strengthen("blocked.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(stronger.ok ? stronger.value.desiredRevision : 0).toBe(2);

    await advance(name, COOLDOWN);
    const stale = await stub.confirmRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.failure.type === "stale_revision") {
      expect(stale.failure.expected).toBe(2);
      expect(stale.failure.actual).toBe(2);
    } else {
      expect.unreachable("expected a stale revision failure");
    }

    const wrongRevision = await stub.confirmRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(wrongRevision.ok ? "" : wrongRevision.failure.type).toBe("stale_revision");
  });

  it("refuses confirmation when server time moves behind the request", async () => {
    const name = freshStubName("rollback");
    const stub = stubFor(name);
    await statusOf(name);
    const status = await statusOf(name);
    const proposal = await stub.submitChange({
      operation: weaken("allowed.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    if (!proposal.ok || proposal.value.relaxationId === null) {
      throw new Error("expected a pending proposal");
    }
    const rolledBack = new Date(Date.parse(status.serverTime) - 3600_000).toISOString();
    await stub.debug({ kind: "clock", now: rolledBack });
    const refused = await stub.confirmRelaxation({
      relaxationId: proposal.value.relaxationId,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.failure.type).toBe("conflict");
  });

  it("gates a weakening restore behind the cooldown and applies it after confirmation", async () => {
    const name = freshStubName("restore");
    const stub = stubFor(name);
    await statusOf(name);
    const backup = await stub.exportBackup();
    if (!backup.ok) {
      throw new Error("expected a backup");
    }
    const weakened = { ...backup.value.policy, cooldownSeconds: 30 };

    const proposed = await stub.restorePolicy({
      policy: weakened,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(proposed.ok ? proposed.value.state : "").toBe("pendingRelaxation");

    const denied = await stub.confirmRelaxation({
      relaxationId: proposed.ok ? (proposed.value.relaxationId ?? "") : "",
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(denied.ok ? "" : denied.failure.type).toBe("conflict");

    await advance(name, COOLDOWN);
    const confirmed = await stub.confirmRelaxation({
      relaxationId: proposed.ok ? (proposed.value.relaxationId ?? "") : "",
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(confirmed.ok ? confirmed.value.desiredRevision : 0).toBe(2);

    const policy = await stub.readPolicy({ ifNoneMatch: null });
    expect(policy.ok ? policy.value.policy.cooldownSeconds : -1).toBe(30);
  });

  it("gates a cooldown reduction by the cooldown already in force", async () => {
    const name = freshStubName("zerocooldown");
    const stub = stubFor(name);
    await statusOf(name);
    const reduction = await stub.submitChange({
      operation: { type: "setCooldown", cooldownSeconds: 0 },
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(reduction.ok ? reduction.value.state : "").toBe("pendingRelaxation");
    if (!reduction.ok || reduction.value.eligibleAt === null) {
      throw new Error("expected a pending proposal");
    }
    const pending = await statusOf(name);
    const wait = Date.parse(reduction.value.eligibleAt) - Date.parse(pending.serverTime);
    expect(Math.abs(wait - COOLDOWN * 1000)).toBeLessThan(2000);

    const early = await stub.confirmRelaxation({
      relaxationId: reduction.value.relaxationId ?? "",
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(early.ok ? "" : early.failure.type).toBe("conflict");

    await advance(name, COOLDOWN);
    const confirmed = await stub.confirmRelaxation({
      relaxationId: reduction.value.relaxationId ?? "",
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(confirmed.ok ? confirmed.value.desiredRevision : 0).toBe(2);

    const policy = await stub.readPolicy({ ifNoneMatch: null });
    expect(policy.ok ? policy.value.policy.cooldownSeconds : -1).toBe(0);

    const immediate = await stub.submitChange({
      operation: weaken("another.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(immediate.ok ? immediate.value.state : "").toBe("pendingRelaxation");
    const instant = await stub.confirmRelaxation({
      relaxationId: immediate.ok ? (immediate.value.relaxationId ?? "") : "",
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(instant.ok ? instant.value.desiredRevision : 0).toBe(3);
  });

  it("reports a missing proposal as not found", async () => {
    const name = freshStubName("missing");
    const stub = stubFor(name);
    await statusOf(name);
    const missing = await stub.confirmRelaxation({
      relaxationId: uniqueKey(),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(missing.ok ? "" : missing.failure.type).toBe("not_found");
  });
});
