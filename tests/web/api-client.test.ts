import assert from "node:assert/strict";
import test from "node:test";
import type { Fetcher } from "../../src/web/client/api-client.ts";
import { createApiClient } from "../../src/web/client/api-client.ts";
import { RAW_RULE_ID, changeFixture, policyFixture, policyResponseFixture } from "./fixtures.ts";

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

const jsonResponse = (
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const lastRecorded = (recorded: readonly Recorded[]): Recorded => {
  const entry = recorded[recorded.length - 1];
  assert.ok(entry !== undefined);
  return entry;
};

test("readPolicy decodes a valid response and returns the etag", async () => {
  const recorded: Recorded[] = [];
  const fetcher: Fetcher = async (url, init) => {
    recorded.push({ url, init });
    return jsonResponse(policyResponseFixture(3), 200, { etag: '"p-3"' });
  };
  const client = createApiClient(fetcher);

  const result = await client.readPolicy(null);

  assert.ok(result.ok);
  assert.equal(result.value.notModified, false);
  assert.equal(result.value.etag, '"p-3"');
  if (!result.value.notModified) {
    assert.equal(result.value.policy.revision, 3);
    assert.equal(result.value.policy.dnsEndpoint, policyFixture(1).dnsEndpoint);
  }
  const entry = lastRecorded(recorded);
  assert.equal(entry.url, "/api/v1/policy");
  assert.equal(entry.init.method, "GET");
  const headers = new Headers(entry.init.headers);
  assert.equal(headers.get("if-none-match"), null);
});

test("readPolicy sends If-None-Match and reports a 304 without a body", async () => {
  const recorded: Recorded[] = [];
  const client = createApiClient(async (url, init) => {
    recorded.push({ url, init });
    return new Response(null, { status: 304, headers: { etag: '"p-3"' } });
  });

  const result = await client.readPolicy('"p-3"');

  assert.ok(result.ok);
  assert.equal(result.value.notModified, true);
  assert.equal(result.value.etag, '"p-3"');
  const headers = new Headers(lastRecorded(recorded).init.headers);
  assert.equal(headers.get("if-none-match"), '"p-3"');
});

test("readPolicy rejects a response that does not match the contract", async () => {
  const client = createApiClient(async () => jsonResponse({ policy: {}, etag: 5 }, 200));

  const result = await client.readPolicy(null);

  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "malformed");
});

test("readStatus maps an ApiErrorResponse to a typed failure", async () => {
  const client = createApiClient(async () =>
    jsonResponse(
      { code: "unavailable", message: "The service is unavailable.", requestId: RAW_RULE_ID },
      503,
    ),
  );

  const result = await client.readStatus();

  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "api");
  if (result.failure.kind === "api") {
    assert.equal(result.failure.status, 503);
    assert.equal(result.failure.error.code, "unavailable");
  }
});

test("a network error surfaces as an offline failure", async () => {
  const client = createApiClient(async () => {
    throw new Error("connection refused");
  });

  const result = await client.readStatus();

  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "offline");
});

test("an error body that does not match the contract surfaces as unexpected", async () => {
  const client = createApiClient(async () => jsonResponse({ nope: true }, 500));

  const result = await client.readStatus();

  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "unexpected");
});

test("submitChange sends If-Match and Idempotency-Key and decodes the change", async () => {
  const recorded: Recorded[] = [];
  const client = createApiClient(async (url, init) => {
    recorded.push({ url, init });
    return jsonResponse(changeFixture("revised", null), 202);
  });

  const result = await client.submitChange(
    { type: "setEnabled", enabled: false },
    { idempotencyKey: "key-1", baseRevision: policyFixture(7).revision },
  );

  assert.ok(result.ok);
  assert.equal(result.value.state, "revised");
  const entry = lastRecorded(recorded);
  assert.equal(entry.url, "/api/v1/changes");
  assert.equal(entry.init.method, "POST");
  const headers = new Headers(entry.init.headers);
  assert.equal(headers.get("idempotency-key"), "key-1");
  assert.equal(headers.get("if-match"), '"p-7"');
  assert.equal(headers.get("content-type"), "application/json");
  const body = typeof entry.init.body === "string" ? entry.init.body : "";
  assert.deepEqual(JSON.parse(body), { operation: { type: "setEnabled", enabled: false } });
});

test("preview is read-only and carries no mutation headers", async () => {
  const recorded: Recorded[] = [];
  const client = createApiClient(async (url, init) => {
    recorded.push({ url, init });
    return jsonResponse(
      {
        accepted: true,
        hostname: "example.com",
        reason: null,
        source: "url",
        scope: "domain",
        message: "Only the hostname is stored.",
      },
      200,
    );
  });

  const result = await client.preview("https://example.com/path", "domain");

  assert.ok(result.ok);
  assert.equal(result.value.hostname, "example.com");
  const entry = lastRecorded(recorded);
  assert.equal(entry.url, "/api/v1/preview");
  const headers = new Headers(entry.init.headers);
  assert.equal(headers.get("idempotency-key"), null);
  assert.equal(headers.get("if-match"), null);
});

test("confirmRelaxation encodes the relaxation id in the path", async () => {
  const recorded: Recorded[] = [];
  const client = createApiClient(async (url, init) => {
    recorded.push({ url, init });
    return jsonResponse(changeFixture("revised", 2), 202);
  });

  await client.confirmRelaxation("abc-123", {
    idempotencyKey: "key-2",
    baseRevision: policyFixture(2).revision,
  });

  assert.equal(lastRecorded(recorded).url, "/api/v1/relaxations/abc-123/confirm");
});
