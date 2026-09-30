import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { Schema } from "effect";
import { ApiErrorResponse } from "../../src/contracts/api.ts";

const decodeApiError = Schema.decodeUnknownSync(ApiErrorResponse);

const APP = "https://app.example.com";

const call = (path: string, init?: RequestInit): Promise<Response> =>
  exports["default"].fetch(`${APP}${path}`, init);

describe("unconfigured production deployment", () => {
  it("fails closed on every path when Access settings or credentials are absent", async () => {
    const paths: readonly string[] = ["/", "/assets/index.js", "/api/v1/policy", "/api/v1/status"];
    for (const path of paths) {
      const response = await call(path);
      expect(`${path} -> ${String(response.status)}`).toBe(`${path} -> 503`);
      const body = decodeApiError(await response.json());
      expect(body.code).toBe("unavailable");
      expect(body.message).toContain("Missing settings");
    }
  });

  it("names the missing settings without leaking values", async () => {
    const response = await call("/api/v1/policy");
    const message = decodeApiError(await response.json()).message;
    expect(message).toContain("ACCESS_TEAM_DOMAIN");
    expect(message).toContain("OWNER_EMAIL");
    expect(message).toContain("CLOUDFLARE_API_TOKEN");
    expect(message.includes("owner@example.com")).toBe(false);
  });

  it("refuses a mutation before reading its body", async () => {
    const response = await call("/api/v1/changes", {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP },
      body: JSON.stringify({ operation: { type: "setEnabled", enabled: true } }),
    });
    expect(response.status).toBe(503);
  });
});
