import { describe, expect, it } from "vitest";
import { exportJWK, SignJWT } from "jose";
import { createAccessVerifier, type AccessFailureCode } from "../../src/worker/access.ts";
import { authenticate, checkMutationOrigin } from "../../src/worker/auth.ts";
import { decodeConfig, isLoopbackHostname, type AppConfig } from "../../src/worker/config.ts";

const TEAM_DOMAIN = "https://clearbrowse-test.cloudflareaccess.com";
const AUDIENCE = "test-audience-tag";
const OWNER = "owner@example.com";
const NOW = 1_800_000_000_000;
const KID = "test-signing-key";

const productionSource = {
  ENVIRONMENT: "production",
  GATEWAY_MODE: "live",
  GATEWAY_PRECEDENCE_BASE: "1000",
  GATEWAY_DOH_ENDPOINT: "https://clearbrowse-test.cloudflare-gateway.com/dns-query",
  CLOUDFLARE_ACCOUNT_ID: "account-id-value",
  CLOUDFLARE_API_TOKEN: "super-secret-token",
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: AUDIENCE,
  OWNER_EMAIL: OWNER,
  LOCAL_AUTH_ENABLED: "false",
  LOCAL_AUTH_EMAIL: "",
} as const;

const localSource = {
  ...productionSource,
  ENVIRONMENT: "local",
  GATEWAY_MODE: "simulated",
  CLOUDFLARE_API_TOKEN: "",
  LOCAL_AUTH_ENABLED: "true",
  LOCAL_AUTH_EMAIL: OWNER,
} as const;

const configOf = (source: unknown): AppConfig => {
  const decoded = decodeConfig(source);
  if (!decoded.ok) {
    throw new Error(`expected a valid config, missing ${decoded.rejection.missing.join(",")}`);
  }
  return decoded.config;
};

interface Keys {
  readonly privateKey: CryptoKey;
  readonly publicJwk: Record<string, unknown>;
}

const makeKeys = async (): Promise<Keys> => {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in generated)) {
    throw new Error("expected an RSA key pair");
  }
  const publicJwk = await exportJWK(generated.publicKey);
  return { privateKey: generated.privateKey, publicJwk };
};

const token = async (input: {
  readonly privateKey: CryptoKey;
  readonly kid: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly email?: string | null;
  readonly expiresAt?: number;
  readonly algorithm?: string;
}): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (input.email !== null) {
    claims["email"] = input.email ?? OWNER;
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: input.algorithm ?? "RS256", kid: input.kid })
    .setIssuer(input.issuer ?? TEAM_DOMAIN)
    .setAudience(input.audience ?? AUDIENCE)
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(input.expiresAt ?? Math.floor(NOW / 1000) + 600)
    .sign(input.privateKey);
};

describe("configuration fail-closed rules", () => {
  it("accepts a complete production configuration and derives the location", () => {
    const config = configOf(productionSource);
    expect(config.environment).toBe("production");
    expect(config.locationSubdomain).toBe("clearbrowse-test");
    expect(config.ownerEmail).toBe(OWNER);
  });

  it("accepts an explicit local configuration", () => {
    const config = configOf(localSource);
    expect(config.environment).toBe("local");
    expect(config.gatewayMode).toBe("simulated");
  });

  it("refuses simulated Gateway mode in production", () => {
    const decoded = decodeConfig({ ...productionSource, GATEWAY_MODE: "simulated" });
    expect(decoded.ok).toBe(false);
    expect(decoded.ok ? [] : decoded.rejection.missing).toContain("GATEWAY_MODE");
  });

  it("refuses local authentication in production", () => {
    const decoded = decodeConfig({ ...productionSource, LOCAL_AUTH_ENABLED: "true" });
    expect(decoded.ok).toBe(false);
    expect(decoded.ok ? [] : decoded.rejection.missing).toContain("LOCAL_AUTH_ENABLED");
  });

  it("refuses a production deployment with missing or partial Access settings", () => {
    for (const key of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL"] as const) {
      const decoded = decodeConfig({ ...productionSource, [key]: "" });
      expect(decoded.ok).toBe(false);
      expect(decoded.ok ? [] : decoded.rejection.missing).toContain(key);
    }
    const all = decodeConfig({
      ...productionSource,
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_AUD: "",
      OWNER_EMAIL: "",
    });
    expect(all.ok).toBe(false);
    expect(all.ok ? [] : all.rejection.missing).toEqual([
      "ACCESS_TEAM_DOMAIN",
      "ACCESS_AUD",
      "OWNER_EMAIL",
    ]);
  });

  it("refuses live mode without Gateway credentials", () => {
    const decoded = decodeConfig({ ...productionSource, CLOUDFLARE_API_TOKEN: "" });
    expect(decoded.ok).toBe(false);
    expect(decoded.ok ? [] : decoded.rejection.missing).toContain("CLOUDFLARE_API_TOKEN");
    const noAccount = decodeConfig({ ...productionSource, CLOUDFLARE_ACCOUNT_ID: "" });
    expect(noAccount.ok ? [] : noAccount.rejection.missing).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("refuses local mode without local authentication enabled", () => {
    const decoded = decodeConfig({ ...localSource, LOCAL_AUTH_ENABLED: "false" });
    expect(decoded.ok).toBe(false);
    expect(decoded.ok ? [] : decoded.rejection.missing).toContain("LOCAL_AUTH_ENABLED");
    const noEmail = decodeConfig({ ...localSource, LOCAL_AUTH_EMAIL: "" });
    expect(noEmail.ok ? [] : noEmail.rejection.missing).toContain("LOCAL_AUTH_EMAIL");
  });

  it("refuses a malformed endpoint or precedence base", () => {
    expect(decodeConfig({ ...productionSource, GATEWAY_DOH_ENDPOINT: "" }).ok).toBe(false);
    expect(
      decodeConfig({ ...productionSource, GATEWAY_DOH_ENDPOINT: "https://example.org/dns-query" })
        .ok,
    ).toBe(false);
    expect(decodeConfig({ ...productionSource, GATEWAY_PRECEDENCE_BASE: "0" }).ok).toBe(false);
    expect(decodeConfig({ ...productionSource, GATEWAY_PRECEDENCE_BASE: "abc" }).ok).toBe(false);
  });

  it("never echoes secret values in a rejection", () => {
    const decoded = decodeConfig({
      ...productionSource,
      ACCESS_AUD: "",
      CLOUDFLARE_API_TOKEN: "",
    });
    expect(decoded.ok).toBe(false);
    const rendered = JSON.stringify(decoded.ok ? {} : decoded.rejection);
    expect(rendered.includes("super-secret-token")).toBe(false);
    expect(rendered.includes(TEAM_DOMAIN)).toBe(false);
  });

  it("rejects an unknown environment or gateway mode", () => {
    expect(decodeConfig({ ...productionSource, ENVIRONMENT: "staging" }).ok).toBe(false);
    expect(decodeConfig({ ...productionSource, GATEWAY_MODE: "pretend" }).ok).toBe(false);
  });
});

describe("Cloudflare Access JWT verification", () => {
  const build = async (options?: { readonly jwksFails?: boolean; readonly jwksBody?: unknown }) => {
    const keys = await makeKeys();
    const wrong = await makeKeys();
    let fetches = 0;
    const verifier = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      now: () => NOW,
      fetcher: async () => {
        fetches += 1;
        if (options?.jwksFails === true) {
          return new Response("upstream unavailable", { status: 500 });
        }
        if (options?.jwksBody !== undefined) {
          return Response.json(options.jwksBody);
        }
        return Response.json({
          keys: [{ ...keys.publicJwk, kid: KID, alg: "RS256", use: "sig" }],
        });
      },
    });
    return {
      keys,
      wrong,
      verifier,
      fetchCount: () => fetches,
    };
  };

  const expectCode = async (
    result: Awaited<ReturnType<Awaited<ReturnType<typeof build>>["verifier"]["verify"]>>,
    code: AccessFailureCode,
  ): Promise<void> => {
    expect(result.ok).toBe(false);
    expect(result.ok ? "ok" : result.code).toBe(code);
  };

  it("accepts a well-formed owner token", async () => {
    const { keys, verifier } = await build();
    const result = await verifier.verify(await token({ privateKey: keys.privateKey, kid: KID }));
    expect(result.ok).toBe(true);
    expect(result.ok ? result.identity.email : "").toBe(OWNER);
  });

  it("rejects a token signed by a different key", async () => {
    const { wrong, verifier, keys } = await build();
    const forged = await token({ privateKey: wrong.privateKey, kid: KID });
    await expectCode(await verifier.verify(forged), "bad_signature");
    expect(keys.privateKey).toBeDefined();
  });

  it("rejects an HS256 token even with a registered key id", async () => {
    const { verifier } = await build();
    const secret = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("shared-secret-value"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const hs = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(NOW / 1000) + 600)
      .sign(secret);
    await expectCode(await verifier.verify(hs), "unsupported_algorithm");
  });

  it("rejects an expired token", async () => {
    const { keys, verifier } = await build();
    const expired = await token({
      privateKey: keys.privateKey,
      kid: KID,
      expiresAt: Math.floor(NOW / 1000) - 60,
    });
    await expectCode(await verifier.verify(expired), "expired");
  });

  it("rejects a wrong issuer and a wrong audience", async () => {
    const { keys, verifier } = await build();
    await expectCode(
      await verifier.verify(
        await token({ privateKey: keys.privateKey, kid: KID, issuer: "https://evil.example" }),
      ),
      "bad_issuer",
    );
    await expectCode(
      await verifier.verify(
        await token({ privateKey: keys.privateKey, kid: KID, audience: "other-audience" }),
      ),
      "bad_audience",
    );
  });

  it("rejects a token without an email claim", async () => {
    const { keys, verifier } = await build();
    await expectCode(
      await verifier.verify(await token({ privateKey: keys.privateKey, kid: KID, email: null })),
      "malformed",
    );
  });

  it("rejects an unknown key id and an unusable JWKS document", async () => {
    const unknown = await build();
    await expectCode(
      await unknown.verifier.verify(
        await token({ privateKey: unknown.keys.privateKey, kid: "other-kid" }),
      ),
      "unknown_key",
    );

    const failing = await build({ jwksFails: true });
    await expectCode(
      await failing.verifier.verify(await token({ privateKey: failing.keys.privateKey, kid: KID })),
      "jwks_unavailable",
    );

    const garbage = await build({ jwksBody: { keys: "not-an-array" } });
    await expectCode(
      await garbage.verifier.verify(await token({ privateKey: garbage.keys.privateKey, kid: KID })),
      "jwks_unavailable",
    );
  });

  it("rejects an empty or oversized token without contacting the JWKS", async () => {
    const { verifier, fetchCount } = await build();
    await expectCode(await verifier.verify(""), "malformed");
    await expectCode(await verifier.verify("a".repeat(9000)), "malformed");
    expect(fetchCount()).toBe(0);
  });

  it("caches the JWKS across verifications", async () => {
    const { keys, verifier, fetchCount } = await build();
    const signed = await token({ privateKey: keys.privateKey, kid: KID });
    expect((await verifier.verify(signed)).ok).toBe(true);
    expect((await verifier.verify(signed)).ok).toBe(true);
    expect(fetchCount()).toBe(1);
  });
});

describe("request authentication", () => {
  const requestOf = (input: {
    readonly url: string;
    readonly token?: string;
    readonly method?: string;
  }): Request =>
    new Request(input.url, {
      method: input.method ?? "GET",
      headers: input.token === undefined ? {} : { "cf-access-jwt-assertion": input.token },
    });

  it("denies a production request without a token", async () => {
    const config = configOf(productionSource);
    const verifier = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      now: () => NOW,
      fetcher: async () => Response.json({ keys: [] }),
    });
    const outcome = await authenticate({
      request: requestOf({ url: "https://app.example.com/api/v1/policy" }),
      config,
      verifier,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.failure.type).toBe("missing_token");
  });

  it("denies a verified identity that is not the configured owner", async () => {
    const config = configOf(productionSource);
    const keys = await makeKeys();
    const verifier = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      now: () => NOW,
      fetcher: async () => Response.json({ keys: [{ ...keys.publicJwk, kid: KID }] }),
    });
    const outcome = await authenticate({
      request: requestOf({
        url: "https://app.example.com/api/v1/policy",
        token: await token({ privateKey: keys.privateKey, kid: KID, email: "someone@example.com" }),
      }),
      config,
      verifier,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.failure.type).toBe("not_owner");
  });

  it("accepts the configured owner", async () => {
    const config = configOf(productionSource);
    const keys = await makeKeys();
    const verifier = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      now: () => NOW,
      fetcher: async () => Response.json({ keys: [{ ...keys.publicJwk, kid: KID }] }),
    });
    const outcome = await authenticate({
      request: requestOf({
        url: "https://app.example.com/api/v1/policy",
        token: await token({ privateKey: keys.privateKey, kid: KID }),
      }),
      config,
      verifier,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.identity.source : "none").toBe("access");
  });

  it("accepts only loopback requests in local mode", async () => {
    const config = configOf(localSource);
    const verifier = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      now: () => NOW,
      fetcher: async () => Response.json({ keys: [] }),
    });
    const loopback = await authenticate({
      request: requestOf({ url: "http://localhost/api/v1/policy" }),
      config,
      verifier,
    });
    expect(loopback.ok).toBe(true);
    expect(loopback.ok ? loopback.identity.source : "none").toBe("local");

    const remote = await authenticate({
      request: requestOf({ url: "https://app.example.com/api/v1/policy" }),
      config,
      verifier,
    });
    expect(remote.ok).toBe(false);
    expect(remote.ok ? "" : remote.failure.type).toBe("local_mode_requires_loopback");

    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      const allowed = await authenticate({
        request: requestOf({ url: `http://${hostname}/api/v1/policy` }),
        config,
        verifier,
      });
      expect(allowed.ok).toBe(true);
    }
  });
});

describe("cross-site mutation protection", () => {
  const mutation = (init: {
    readonly origin?: string | null;
    readonly referer?: string | null;
    readonly fetchSite?: string | null;
    readonly contentType?: string | null;
    readonly method?: string;
  }): Request => {
    const headers = new Headers();
    if (init.origin !== null && init.origin !== undefined) {
      headers.set("origin", init.origin);
    }
    if (init.referer !== null && init.referer !== undefined) {
      headers.set("referer", init.referer);
    }
    if (init.fetchSite !== null && init.fetchSite !== undefined) {
      headers.set("sec-fetch-site", init.fetchSite);
    }
    if (init.contentType !== null) {
      headers.set("content-type", init.contentType ?? "application/json");
    }
    const method = init.method ?? "POST";
    return new Request("https://app.example.com/api/v1/changes", {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
    });
  };

  it("requires an origin for a JSON mutation", () => {
    expect(checkMutationOrigin(mutation({ origin: null }))?.type).toBe("missing_origin");
  });

  it("rejects a cross-site origin even when the request is authenticated", () => {
    expect(checkMutationOrigin(mutation({ origin: "https://evil.example" }))?.type).toBe(
      "cross_site",
    );
    expect(
      checkMutationOrigin(mutation({ origin: null, referer: "https://evil.example/page" }))?.type,
    ).toBe("cross_site");
    expect(checkMutationOrigin(mutation({ origin: "https://app.example.com", fetchSite: "cross-site" }))?.type).toBe(
      "cross_site",
    );
  });

  it("accepts a same-origin JSON mutation via origin or referer", () => {
    expect(checkMutationOrigin(mutation({ origin: "https://app.example.com" }))).toBeUndefined();
    expect(
      checkMutationOrigin(mutation({ origin: null, referer: "https://app.example.com/page" })),
    ).toBeUndefined();
    expect(checkMutationOrigin(mutation({ origin: "https://app.example.com", fetchSite: "same-origin" }))).toBeUndefined();
  });

  it("ignores read requests", () => {
    expect(checkMutationOrigin(mutation({ origin: null, method: "GET" }))).toBeUndefined();
  });

  it("rejects a non-JSON content type", () => {
    expect(
      checkMutationOrigin(mutation({ origin: "https://app.example.com", contentType: "text/plain" }))
        ?.type,
    ).toBe("unsupported_content_type");
    expect(
      checkMutationOrigin(mutation({ origin: "https://app.example.com", contentType: null }))?.type,
    ).toBe("unsupported_content_type");
    expect(
      checkMutationOrigin(
        mutation({ origin: "https://app.example.com", contentType: "application/json; charset=utf-8" }),
      ),
    ).toBeUndefined();
  });
});

describe("loopback classification", () => {
  const localVerifier = () =>
    createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      now: () => NOW,
      fetcher: async () => Response.json({ keys: [] }),
    });

  it("accepts only real loopback literals", () => {
    for (const hostname of ["localhost", "127.0.0.1", "127.1.2.3", "127.0.0.255", "::1", "[::1]"]) {
      expect(isLoopbackHostname(hostname)).toBe(true);
    }
    for (const hostname of [
      "127.example.com",
      "127.evil.test",
      "127.0.0.1.evil.test",
      "localhost.evil.test",
      "1270.0.1",
      "127.0.0.256",
      "127.0.0",
      "127",
      "128.0.0.1",
      "0.0.0.0",
      "",
    ]) {
      expect(isLoopbackHostname(hostname)).toBe(false);
    }
  });

  it("denies local mode for a hostname that merely starts with 127", async () => {
    const config = configOf(localSource);
    for (const hostname of ["127.example.com", "127.evil.test", "127.0.0.1.evil.test"]) {
      const outcome = await authenticate({
        request: new Request(`http://${hostname}/api/v1/policy`),
        config,
        verifier: localVerifier(),
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.failure.type).toBe("local_mode_requires_loopback");
    }
    const literal = await authenticate({
      request: new Request("http://127.0.0.1/api/v1/policy"),
      config,
      verifier: localVerifier(),
    });
    expect(literal.ok).toBe(true);
  });
});
