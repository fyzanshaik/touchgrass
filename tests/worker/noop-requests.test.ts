import { describe, expect, it } from "vitest";
import { addRuleOperation, freshStubName, statusOf, stubFor, uniqueKey } from "./support.ts";

const COOLDOWN = 86400;

const allowRule = (hostname: string) =>
  addRuleOperation({ hostname, action: "allow", scope: "domain" });
const blockRule = (hostname: string) =>
  addRuleOperation({ hostname, action: "block", scope: "domain" });

const advance = async (name: string, seconds: number): Promise<void> => {
  await expect(stubFor(name).debug({ kind: "advance", seconds })).resolves.toMatchObject({
    ok: true,
  });
};

describe("no-op and conflicting weakening requests", () => {
  it("does not propose a duplicate rule and refuses a conflicting one", async () => {
    const name = freshStubName("duplicate");
    const stub = stubFor(name);
    await statusOf(name);

    const added = await stub.submitChange({
      operation: allowRule("safe.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(added.ok ? added.value.state : "").toBe("pendingRelaxation");
    await advance(name, COOLDOWN);
    const confirmed = await stub.confirmRelaxation({
      relaxationId: added.ok ? (added.value.relaxationId ?? "") : "",
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(confirmed.ok ? confirmed.value.state : "").toBe("revised");
    expect(confirmed.ok ? confirmed.value.desiredRevision : 0).toBe(2);

    const duplicate = await stub.submitChange({
      operation: allowRule("safe.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.ok ? duplicate.value.state : "").toBe("unchanged");
    expect(duplicate.ok ? duplicate.value.relaxationId : "not-null").toBeNull();

    const conflicting = await stub.submitChange({
      operation: blockRule("safe.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.ok ? "" : conflicting.failure.type).toBe("conflict");

    const status = await statusOf(name);
    expect(status.desiredRevision).toBe(2);
    expect(status.relaxations.filter((entry) => entry.state === "pending").length).toBe(0);

    const pendingCount = status.relaxations.filter((entry) => entry.state === "pending").length;
    const repeat = await stub.submitChange({
      operation: allowRule("safe.example.org"),
      baseRevision: 2,
      idempotencyKey: uniqueKey(),
    });
    expect(repeat.ok ? repeat.value.state : "").toBe("unchanged");
    expect((await statusOf(name)).relaxations.filter((entry) => entry.state === "pending").length).toBe(
      pendingCount,
    );
  });

  it("stores one proposal for concurrent identical same-key requests", async () => {
    const name = freshStubName("samekey");
    const stub = stubFor(name);
    await statusOf(name);
    const key = uniqueKey();
    const operation = allowRule("safe.example.org");

    const [first, second] = await Promise.all([
      stub.submitChange({ operation, baseRevision: 1, idempotencyKey: key }),
      stub.submitChange({ operation, baseRevision: 1, idempotencyKey: key }),
    ]);
    expect(first).toEqual(second);
    expect(first.ok ? first.value.state : "").toBe("pendingRelaxation");

    const status = await statusOf(name);
    const pending = status.relaxations.filter((entry) => entry.state === "pending");
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe(first.ok ? first.value.relaxationId : "");

    const replay = await stub.submitChange({ operation, baseRevision: 1, idempotencyKey: key });
    expect(replay).toEqual(first);

    const conflict = await stub.submitChange({
      operation: allowRule("other.example.org"),
      baseRevision: 1,
      idempotencyKey: key,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.ok ? "" : conflict.failure.type).toBe("idempotency_conflict");
    expect(
      (await statusOf(name)).relaxations.filter((entry) => entry.state === "pending").length,
    ).toBe(1);
  });

  it("retires a proposal that can no longer be represented", async () => {
    const name = freshStubName("retire");
    const stub = stubFor(name);
    await statusOf(name);

    const proposal = await stub.submitChange({
      operation: allowRule("safe.example.org"),
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(proposal.ok ? proposal.value.state : "").toBe("pendingRelaxation");
    const id = proposal.ok ? (proposal.value.relaxationId ?? "") : "";

    await stub.debug({ kind: "expressionBudget", value: 10 });
    await advance(name, COOLDOWN);
    const confirmation = await stub.confirmRelaxation({
      relaxationId: id,
      baseRevision: 1,
      idempotencyKey: uniqueKey(),
    });
    expect(confirmation.ok).toBe(false);
    expect(confirmation.ok ? "" : confirmation.failure.type).toBe("conflict");

    const status = await statusOf(name);
    expect(status.desiredRevision).toBe(1);
    expect(status.relaxations[0]?.state).toBe("cancelled");
  });
});
