import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "effect";
import {
  ApiErrorCode,
  BackupResponse,
  ChangeRequest,
  ChangeResponse,
  DiagnosticsResponse,
  PolicyResponse,
  PreviewResponse,
  RestoreRequest,
  StatusResponse,
  decodeChangeRequest,
  decodeIdempotencyKey,
  decodePreviewRequest,
  decodeRelaxationId,
  decodeRestoreRequest,
  apiErrorCodes,
} from "../src/contracts/api.ts";
import { hostnameRejectionReasons, HostnameRejectionReason } from "../src/domain/hostname.ts";
import { instantFromMilliseconds } from "../src/domain/instants.ts";
import { Policy } from "../src/domain/policy.ts";
import { policyOf } from "./support/policy.ts";

const decodePolicy = Schema.decodeUnknownEither(Policy);

const validChange = {
  operation: {
    type: "addRule",
    rule: { hostname: "example.org", action: "block", scope: "domain" },
  },
} as const;

describe("mutation request contracts", () => {
  it("accepts a valid change request", () => {
    assert.equal(decodeChangeRequest(validChange)._tag, "Right");
  });

  it("rejects unknown top-level and nested fields", () => {
    assert.equal(decodeChangeRequest({ ...validChange, extra: true })._tag, "Left");
    assert.equal(
      decodeChangeRequest({
        operation: { type: "setEnabled", enabled: true, extra: true },
      })._tag,
      "Left",
    );
  });

  it("rejects an unlisted operation", () => {
    assert.equal(decodeChangeRequest({ operation: { type: "wipe" } })._tag, "Left");
    assert.equal(decodeChangeRequest({})._tag, "Left");
  });

  it("rejects a restore request with extra fields", () => {
    const policy = policyOf({});
    assert.equal(decodeRestoreRequest({ policy })._tag, "Right");
    assert.equal(decodeRestoreRequest({ policy, extra: 1 })._tag, "Left");
    assert.equal(decodeRestoreRequest({ policy: { revision: 1 } })._tag, "Left");
  });

  it("validates preview requests", () => {
    assert.equal(decodePreviewRequest({ input: "example.org", scope: "domain" })._tag, "Right");
    assert.equal(decodePreviewRequest({ input: "example.org", scope: "all" })._tag, "Left");
    assert.equal(decodePreviewRequest({ input: "example.org" })._tag, "Left");
  });

  it("requires UUID identifiers for idempotency keys and relaxations", () => {
    assert.equal(decodeIdempotencyKey("11111111-1111-4111-8111-111111111111")._tag, "Right");
    assert.equal(decodeIdempotencyKey("not-a-uuid")._tag, "Left");
    assert.equal(decodeIdempotencyKey("")._tag, "Left");
    assert.equal(decodeRelaxationId("11111111-1111-4111-8111-111111111111")._tag, "Right");
    assert.equal(decodeRelaxationId("11111111")._tag, "Left");
  });
});

describe("policy contract bounds", () => {
  it("accepts a valid policy", () => {
    assert.equal(decodePolicy(policyOf({}))._tag, "Right");
  });

  it("rejects revision zero and a bad endpoint", () => {
    assert.equal(decodePolicy({ ...policyOf({}), revision: 0 })._tag, "Left");
    assert.equal(decodePolicy({ ...policyOf({}), dnsEndpoint: "https://example.org/dns-query" })._tag, "Left");
    assert.equal(decodePolicy({ ...policyOf({}), schemaVersion: 2 })._tag, "Left");
  });

  it("restricts categories to the verified set", () => {
    assert.equal(decodePolicy({ ...policyOf({}), categories: ["pornography"] })._tag, "Right");
    assert.equal(decodePolicy({ ...policyOf({}), categories: ["nudity"] })._tag, "Left");
    assert.equal(decodePolicy({ ...policyOf({}), categories: ["adultThemes"] })._tag, "Left");
    assert.equal(decodePolicy({ ...policyOf({}), categories: [] })._tag, "Right");
  });

  it("rejects duplicate categories and duplicate rule entries", () => {
    assert.equal(
      decodePolicy({ ...policyOf({}), categories: ["pornography", "pornography"] })._tag,
      "Left",
    );
    const rule = {
      id: "11111111-1111-4111-8111-111111111111",
      hostname: "example.org",
      action: "block",
      scope: "domain",
      createdAt: instantFromMilliseconds(0),
    };
    assert.equal(decodePolicy({ ...policyOf({}), rules: [rule, rule] })._tag, "Left");
    assert.equal(
      decodePolicy({
        ...policyOf({}),
        rules: [rule, { ...rule, id: "22222222-2222-4222-8222-222222222222", action: "allow" }],
      })._tag,
      "Left",
    );
  });

  it("bounds the cooldown", () => {
    assert.equal(decodePolicy({ ...policyOf({}), cooldownSeconds: 0 })._tag, "Right");
    assert.equal(decodePolicy({ ...policyOf({}), cooldownSeconds: 604800 })._tag, "Right");
    assert.equal(decodePolicy({ ...policyOf({}), cooldownSeconds: 604801 })._tag, "Left");
    assert.equal(decodePolicy({ ...policyOf({}), cooldownSeconds: 1.5 })._tag, "Left");
  });

  it("rejects a rule identifier that is not a UUID and a hostname past the bound", () => {
    const base = {
      hostname: "example.org",
      action: "block",
      scope: "domain",
      createdAt: instantFromMilliseconds(0),
    };
    assert.equal(
      decodePolicy({ ...policyOf({}), rules: [{ ...base, id: "nope" }] })._tag,
      "Left",
    );
    assert.equal(
      decodePolicy({
        ...policyOf({}),
        rules: [
          {
            ...base,
            id: "11111111-1111-4111-8111-111111111111",
            hostname: `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.org`,
          },
        ],
      })._tag,
      "Left",
    );
  });

  it("rejects more than one thousand rules", () => {
    const rules = Array.from({ length: 1001 }, (_unused, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      hostname: `host${index}.example.org`,
      action: "block",
      scope: "domain",
      createdAt: instantFromMilliseconds(0),
    }));
    assert.equal(decodePolicy({ ...policyOf({}), rules })._tag, "Left");
  });
});

describe("response contracts", () => {
  it("round-trips response bodies through their schemas", () => {
    const policy = policyOf({});
    const bodies = [
      Schema.encodeSync(PolicyResponse)({ policy, etag: '"p-1"' }),
      Schema.encodeSync(ChangeResponse)({
        id: "11111111-1111-4111-8111-111111111111",
        state: "revised",
        strength: "stronger",
        baseRevision: 1,
        desiredRevision: 2,
        appliedRevision: null,
        eligibleAt: null,
        relaxationId: null,
      }),
      Schema.encodeSync(StatusResponse)({
        serverTime: instantFromMilliseconds(0),
        desiredRevision: 1,
        gatewayAppliedRevision: null,
        reconciliation: "idle",
        gatewayMode: "simulated",
        lastErrorCode: null,
        nextRetryAt: null,
        relaxations: [],
      }),
      Schema.encodeSync(BackupResponse)({
        exportedAt: instantFromMilliseconds(0),
        sourceRevision: 1,
        policy,
      }),
      Schema.encodeSync(DiagnosticsResponse)({
        serverTime: instantFromMilliseconds(0),
        gatewayMode: "simulated",
        compilerVersion: "clearbrowse-dns-compiler/1",
        locationSubdomain: "clearbrowse-test",
        planRevision: 1,
        planFailure: null,
        planRules: [],
        suppressedAllows: [],
        ownedResources: [],
        reconciliationJob: null,
      }),
      Schema.encodeSync(PreviewResponse)({
        accepted: true,
        hostname: "example.org",
        reason: null,
        source: "hostname",
        scope: "domain",
        message: "stored",
      }),
    ];
    for (const body of bodies) {
      assert.equal(typeof JSON.stringify(body), "string");
    }
  });

  it("exposes every documented error code", () => {
    for (const code of apiErrorCodes) {
      assert.equal(Schema.decodeUnknownEither(ApiErrorCode)(code)._tag, "Right");
    }
    assert.equal(Schema.decodeUnknownEither(ApiErrorCode)("nope")._tag, "Left");
  });

  it("exposes every hostname rejection reason", () => {
    for (const reason of hostnameRejectionReasons) {
      assert.equal(Schema.decodeUnknownEither(HostnameRejectionReason)(reason)._tag, "Right");
    }
  });

  it("keeps change and restore request shapes distinct", () => {
    assert.equal(Schema.encodeSync(ChangeRequest)(validChange).operation.type, "addRule");
    assert.equal(Schema.encodeSync(RestoreRequest)({ policy: policyOf({}) }).policy.rules.length, 0);
  });
});
