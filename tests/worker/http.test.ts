import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { Schema } from "effect";
import {
  ApiErrorResponse,
  BackupResponse,
  ChangeResponse,
  DiagnosticsResponse,
  PolicyResponse,
  PreviewResponse,
  StatusResponse,
} from "../../src/contracts/api.ts";
import {
  API,
  OWNER_ORIGIN,
  addRuleOperation,
  apiGet,
  freshStubName,
  jsonMutation,
  rawRequest,
  statusOf,
} from "./support.ts";

const MAX_RULES = 1000;

const decodePolicyResponse = Schema.decodeUnknownSync(PolicyResponse);
const decodeChangeResponse = Schema.decodeUnknownSync(ChangeResponse);
const decodeStatusResponse = Schema.decodeUnknownSync(StatusResponse);
const decodeDiagnosticsResponse = Schema.decodeUnknownSync(DiagnosticsResponse);
const decodeBackupResponse = Schema.decodeUnknownSync(BackupResponse);
const decodePreviewResponse = Schema.decodeUnknownSync(PreviewResponse);
const decodeApiError = Schema.decodeUnknownSync(ApiErrorResponse);

const currentPolicy = async (): Promise<{ readonly etag: string; readonly revision: number }> => {
  const response = await apiGet(`${API}/policy`);
  const body = decodePolicyResponse(await response.json());
  return { etag: body.etag, revision: body.policy.revision };
};

describe("HTTP transport boundaries", () => {
  it("serves the built dashboard from the asset binding when authenticated", async () => {
    const response = await apiGet("/");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.toLowerCase()).toContain("touchgrass");
    expect(body).toContain("type=\"module\"");
  });

  it("refuses local development mode from a non-loopback host", async () => {
    const response = await exports["default"].fetch("https://app.example.com/api/v1/policy");
    expect(response.status).toBe(403);
    expect(decodeApiError(await response.json()).code).toBe("forbidden");
  });

  it("denies a 127-prefixed hostname that is not a loopback literal", async () => {
    for (const hostname of ["127.example.com", "127.evil.test"]) {
      const response = await exports["default"].fetch(`http://${hostname}/api/v1/status`);
      expect(`${hostname} -> ${String(response.status)}`).toBe(`${hostname} -> 403`);
      expect(decodeApiError(await response.json()).code).toBe("forbidden");
    }
    const literal = await exports["default"].fetch("http://127.0.0.1/api/v1/status");
    expect(literal.status).toBe(200);
  });

  it("returns a structured API error for an unknown API path instead of an asset", async () => {
    const response = await apiGet(`${API}/nonexistent`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = decodeApiError(await response.json());
    expect(body.code).toBe("not_found");
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it("rejects a mutation without an Origin header", async () => {
    const response = await rawRequest(`${API}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(decodeApiError(await response.json()).code).toBe("forbidden");
  });

  it("rejects a cross-site mutation even when otherwise well formed", async () => {
    const { etag } = await currentPolicy();
    const response = await rawRequest(`${API}/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "idempotency-key": crypto.randomUUID(),
        "if-match": etag,
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("rejects a non-JSON content type for a mutation", async () => {
    const response = await rawRequest(`${API}/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: OWNER_ORIGIN,
        "idempotency-key": crypto.randomUUID(),
      },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  it("caps a mutation body below the restore allowance", async () => {
    const { etag } = await currentPolicy();
    const response = await rawRequest(`${API}/changes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: OWNER_ORIGIN,
        "idempotency-key": crypto.randomUUID(),
        "if-match": etag,
      },
      body: JSON.stringify({
        operation: { type: "setEnabled", enabled: true },
        pad: "x".repeat(70000),
      }),
    });
    expect(response.status).toBe(413);
    expect(decodeApiError(await response.json()).code).toBe("payload_too_large");
  });

  it("rejects unknown fields and unknown operations at the transport layer", async () => {
    const { etag } = await currentPolicy();

    const cases: readonly { readonly path: string; readonly body: unknown }[] = [
      { path: `${API}/changes`, body: { operation: { type: "setEnabled", enabled: true }, surprise: true } },
      { path: `${API}/changes`, body: { operation: { type: "setEnabled", enabled: true, surprise: true } } },
      { path: `${API}/changes`, body: { operation: { type: "wipeEverything" } } },
      { path: `${API}/changes`, body: {} },
      { path: `${API}/preview`, body: { input: "example.org", scope: "domain", surprise: true } },
      { path: `${API}/preview`, body: { input: "example.org", scope: "everything" } },
      { path: `${API}/reconcile`, body: { surprise: true } },
    ];
    for (const entry of cases) {
      const response = await jsonMutation({
        path: entry.path,
        body: entry.body,
        ifMatch: etag,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(`${entry.path} ${JSON.stringify(entry.body)} -> ${String(response.status)}`).toBe(
        `${entry.path} ${JSON.stringify(entry.body)} -> 400`,
      );
    }
  });

  it("previews a hostname and explains a discarded URL path", async () => {
    const accepted = await jsonMutation({
      path: `${API}/preview`,
      body: { input: "https://www.Example.org/some/path?q=1", scope: "domain" },
      ifMatch: null,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = decodePreviewResponse(await accepted.json());
    expect(acceptedBody.accepted).toBe(true);
    expect(acceptedBody.hostname).toBe("www.example.org");
    expect(acceptedBody.message).toContain("Only the hostname is stored");

    const rejected = await jsonMutation({
      path: `${API}/preview`,
      body: { input: "github.io", scope: "domain" },
      ifMatch: null,
      idempotencyKey: crypto.randomUUID(),
    });
    const rejectedBody = decodePreviewResponse(await rejected.json());
    expect(rejectedBody.accepted).toBe(false);
    expect(rejectedBody.reason).toBe("not_registrable");
  });

  it("runs a full change flow with ETag, 304, idempotency and status", async () => {
    const name = freshStubName("flow");
    await statusOf(name);
    const start = await currentPolicy();

    const initial = await apiGet(`${API}/policy`);
    expect(initial.status).toBe(200);
    expect(initial.headers.get("etag")).toBe(start.etag);

    const notModified = await apiGet(`${API}/policy`, { "if-none-match": start.etag });
    expect(notModified.status).toBe(304);

    const key = crypto.randomUUID();
    const body = {
      operation: addRuleOperation({
        hostname: `flow-${String(start.revision)}.example.org`,
        action: "block",
        scope: "domain",
      }),
    };
    const change = await jsonMutation({
      path: `${API}/changes`,
      body,
      ifMatch: start.etag,
      idempotencyKey: key,
    });
    expect(change.status).toBe(202);
    const changeBody = decodeChangeResponse(await change.json());
    expect(changeBody.state).toBe("revised");
    expect(changeBody.desiredRevision).toBe(start.revision + 1);

    const replay = await jsonMutation({
      path: `${API}/changes`,
      body,
      ifMatch: start.etag,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(202);
    expect(decodeChangeResponse(await replay.json())).toEqual(changeBody);

    const stale = await jsonMutation({
      path: `${API}/changes`,
      body: { operation: { type: "setEnabled", enabled: false } },
      ifMatch: start.etag,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(stale.status).toBe(412);
    expect(decodeApiError(await stale.json()).code).toBe("stale_revision");

    const missingPrecondition = await jsonMutation({
      path: `${API}/changes`,
      body: { operation: { type: "setEnabled", enabled: true } },
      ifMatch: null,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(missingPrecondition.status).toBe(428);

    const status = decodeStatusResponse(await (await apiGet(`${API}/status`)).json());
    expect(status.desiredRevision).toBe(start.revision + 1);
    expect(status.gatewayAppliedRevision).toBe(start.revision + 1);
    expect(status.gatewayMode).toBe("simulated");

    const diagnostics = decodeDiagnosticsResponse(
      await (await apiGet(`${API}/diagnostics`)).json(),
    );
    expect(diagnostics.planFailure).toBeNull();
    expect(diagnostics.ownedResources.length).toBeGreaterThan(0);

    const backupResponse = await apiGet(`${API}/backup`);
    expect(backupResponse.status).toBe(200);
    expect(backupResponse.headers.get("content-disposition")).toContain("touchgrass-policy.json");
    const backup = decodeBackupResponse(await backupResponse.json());
    expect(backup.policy.rules.length).toBeGreaterThan(0);

    const now = await currentPolicy();
    const restored = await jsonMutation({
      path: `${API}/restore`,
      body: { policy: backup.policy },
      ifMatch: now.etag,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(restored.status).toBe(200);
    expect(decodeChangeResponse(await restored.json()).state).toBe("unchanged");
  });

  it("cancels a pending proposal over HTTP and refuses a later confirmation", async () => {
    const { etag } = await currentPolicy();
    const proposal = await jsonMutation({
      path: `${API}/changes`,
      body: {
        operation: addRuleOperation({
          hostname: `cancel-${crypto.randomUUID().slice(0, 8)}.example.org`,
          action: "allow",
          scope: "domain",
        }),
      },
      ifMatch: etag,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(proposal.status).toBe(202);
    const proposed = decodeChangeResponse(await proposal.json());
    expect(proposed.state).toBe("pendingRelaxation");
    const relaxationId = proposed.relaxationId;
    expect(relaxationId).not.toBeNull();

    const cancelled = await jsonMutation({
      path: `${API}/relaxations/${String(relaxationId)}/cancel`,
      body: {},
      ifMatch: etag,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(cancelled.status).toBe(200);
    const cancelledStatus = decodeStatusResponse(await cancelled.json());
    const cancelledEntry = cancelledStatus.relaxations.find(
      (entry) => entry.id === relaxationId,
    );
    expect(cancelledEntry?.state).toBe("cancelled");

    const confirmed = await jsonMutation({
      path: `${API}/relaxations/${String(relaxationId)}/confirm`,
      body: {},
      ifMatch: etag,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(confirmed.status).toBe(409);
  });

  it("round-trips a maximum legal policy through the restore allowance", async () => {
    const start = await currentPolicy();
    const policyResponse = decodePolicyResponse(await (await apiGet(`${API}/policy`)).json());
    const existing = policyResponse.policy.rules.map((rule) => ({
      id: rule.id,
      hostname: rule.hostname,
      action: rule.action,
      scope: rule.scope,
      createdAt: rule.createdAt,
    }));
    const added = Array.from({ length: MAX_RULES - existing.length }, (_unused, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      hostname: `host-${String(index)}.example.org`,
      action: "block",
      scope: "domain",
      createdAt: policyResponse.policy.updatedAt,
    }));
    const rules = [...existing, ...added];
    expect(rules.length).toBe(MAX_RULES);
    const oversized = { ...policyResponse.policy, rules };
    expect(JSON.stringify({ policy: oversized }).length).toBeGreaterThan(65536);

    const accepted = await jsonMutation({
      path: `${API}/restore`,
      body: { policy: oversized },
      ifMatch: start.etag,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(accepted.status).toBe(202);
    expect(decodeChangeResponse(await accepted.json()).state).toBe("revised");

    const backupResponse = await apiGet(`${API}/backup`);
    const backupText = await backupResponse.text();
    expect(backupText.length).toBeGreaterThan(65536);
    const backup = decodeBackupResponse(JSON.parse(backupText));
    expect(backup.policy.rules.length).toBe(MAX_RULES);

    const after = await currentPolicy();
    const roundTrip = await jsonMutation({
      path: `${API}/restore`,
      body: { policy: backup.policy },
      ifMatch: after.etag,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(roundTrip.status).toBe(200);
    expect(decodeChangeResponse(await roundTrip.json()).state).toBe("unchanged");
  });

  it("refuses malformed revision and idempotency headers", async () => {
    const badKey = await jsonMutation({
      path: `${API}/changes`,
      body: { operation: { type: "setEnabled", enabled: true } },
      ifMatch: '"p-1"',
      idempotencyKey: "not-a-uuid",
    });
    expect(badKey.status).toBe(400);

    const malformedIfMatch = await jsonMutation({
      path: `${API}/changes`,
      body: { operation: { type: "setEnabled", enabled: true } },
      ifMatch: "p-1",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(malformedIfMatch.status).toBe(400);
  });
});
