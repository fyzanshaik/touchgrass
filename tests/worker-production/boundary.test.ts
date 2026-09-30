import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { Schema } from "effect";
import { ApiErrorResponse } from "../../src/contracts/api.ts";

const decodeApiError = Schema.decodeUnknownSync(ApiErrorResponse);

const APP = "https://app.example.com";
const API = "/api/v1";

const call = (path: string, init?: RequestInit): Promise<Response> =>
  exports["default"].fetch(`${APP}${path}`, init);

const jsonMutation = (path: string, token: string | null, body: unknown): Promise<Response> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: APP,
    "idempotency-key": "11111111-1111-4111-8111-111111111111",
    "if-match": '"p-1"',
  };
  if (token !== null) {
    headers["cf-access-jwt-assertion"] = token;
  }
  return call(path, { method: "POST", headers, body: JSON.stringify(body) });
};

const base64url = (value: object): string =>
  btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

describe("production boundaries", () => {
  it("denies an unauthenticated dashboard asset request", async () => {
    const response = await call("/");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(decodeApiError(await response.json()).code).toBe("unauthorized");
  });

  it("denies unauthenticated API reads, diagnostics and backups", async () => {
    for (const path of [
      `${API}/policy`,
      `${API}/status`,
      `${API}/diagnostics`,
      `${API}/backup`,
      `${API}/nonexistent`,
    ]) {
      const response = await call(path);
      expect(`${path} -> ${String(response.status)}`).toBe(`${path} -> 401`);
    }
  });

  it("denies an unauthenticated asset that is not the dashboard entry point", async () => {
    const response = await call("/assets/index.js");
    expect(response.status).toBe(401);
  });

  it("denies unauthenticated mutations", async () => {
    for (const path of [
      `${API}/changes`,
      `${API}/preview`,
      `${API}/restore`,
      `${API}/reconcile`,
      `${API}/relaxations/11111111-1111-4111-8111-111111111111/confirm`,
      `${API}/relaxations/11111111-1111-4111-8111-111111111111/cancel`,
    ]) {
      const response = await jsonMutation(path, null, {});
      expect(`${path} -> ${String(response.status)}`).toBe(`${path} -> 401`);
    }
  });

  it("denies a malformed token without contacting any identity provider", async () => {
    const notAToken = await call(`${API}/policy`, {
      headers: { "cf-access-jwt-assertion": "not-a-token" },
    });
    expect(notAToken.status).toBe(401);
    expect(decodeApiError(await notAToken.json()).message).toContain("malformed");

    const twoSegments = await call(`${API}/policy`, {
      headers: { "cf-access-jwt-assertion": "aaa.bbb" },
    });
    expect(twoSegments.status).toBe(401);

    const wrongAlgorithm = `${base64url({ alg: "HS256", kid: "key-1" })}.${base64url({
      email: "owner@example.com",
      iss: "https://clearbrowse-test.cloudflareaccess.com",
      aud: "test-audience-tag",
    })}.signature`;
    const rejected = await call(`${API}/policy`, {
      headers: { "cf-access-jwt-assertion": wrongAlgorithm },
    });
    expect(rejected.status).toBe(401);
    expect(decodeApiError(await rejected.json()).message).toContain("unsupported_algorithm");
  });

  it("never echoes credentials or upstream detail in an error", async () => {
    const response = await call(`${API}/policy`);
    const text = await response.text();
    expect(text.includes("test-token-value")).toBe(false);
    expect(text.includes("account-id")).toBe(false);
  });
});
