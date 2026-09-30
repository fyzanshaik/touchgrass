import { Schema } from "effect";
import { importJWK, jwtVerify } from "jose";
import { MAX_UPSTREAM_BYTES, readBoundedText } from "./http.ts";

export const accessFailureCodes = [
  "malformed",
  "unsupported_algorithm",
  "bad_signature",
  "expired",
  "not_yet_valid",
  "bad_issuer",
  "bad_audience",
  "jwks_unavailable",
  "unknown_key",
] as const;

export type AccessFailureCode = (typeof accessFailureCodes)[number];

export interface AccessIdentity {
  readonly email: string;
  readonly subject: string;
}

export type AccessVerification =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly code: AccessFailureCode };

export interface AccessVerifier {
  readonly verify: (token: string) => Promise<AccessVerification>;
}

const Jwk = Schema.Struct({
  kty: Schema.Literal("RSA"),
  kid: Schema.String,
  n: Schema.String,
  e: Schema.String,
});

const JwksDocument = Schema.Struct({ keys: Schema.Array(Jwk) });

const JwtHeader = Schema.Struct({ alg: Schema.String, kid: Schema.String });

const JWKS_CACHE_MILLISECONDS = 600000;
const MAX_TOKEN_LENGTH = 8192;

const fail = (code: AccessFailureCode): AccessVerification => ({ ok: false, code });

const decodeSegment = (segment: string): unknown => {
  const normalised = segment.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalised.length % 4;
  const padded = remainder === 0 ? normalised : `${normalised}${"=".repeat(4 - remainder)}`;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
};

const errorCodeOf = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }
  const code: unknown = cause.code;
  return typeof code === "string" ? code : undefined;
};

const mapVerificationFailure = (cause: unknown): AccessFailureCode => {
  switch (errorCodeOf(cause)) {
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return "bad_signature";
    case "ERR_JWT_EXPIRED":
      return "expired";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      return "not_yet_valid";
    case "ERR_JOSE_ALG_NOT_ALLOWED":
    case "ERR_JOSE_NOT_SUPPORTED":
      return "unsupported_algorithm";
    default:
      return "malformed";
  }
};

const audienceMatches = (claim: unknown, audience: string): boolean => {
  if (typeof claim === "string") {
    return claim === audience;
  }
  if (Array.isArray(claim)) {
    return claim.some((entry) => entry === audience);
  }
  return false;
};

export interface AccessVerifierInput {
  readonly teamDomain: string;
  readonly audience: string;
  readonly fetcher: (url: string) => Promise<Response>;
  readonly now: () => number;
}

export const createAccessVerifier = (input: AccessVerifierInput): AccessVerifier => {
  let cachedKeys = new Map<string, CryptoKey>();
  let cachedAt = 0;

  const loadKeys = async (): Promise<Map<string, CryptoKey> | undefined> => {
    const response = await input.fetcher(`${input.teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) {
      return undefined;
    }
    const body = await readBoundedText(response, MAX_UPSTREAM_BYTES);
    if (!body.ok) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return undefined;
    }
    const decoded = Schema.decodeUnknownEither(JwksDocument)(parsed);
    if (decoded._tag === "Left") {
      return undefined;
    }
    const keys = new Map<string, CryptoKey>();
    for (const jwk of decoded.right.keys) {
      try {
        const key = await importJWK(jwk, "RS256");
        if (!(key instanceof Uint8Array)) {
          keys.set(jwk.kid, key);
        }
      } catch {
        continue;
      }
    }
    return keys;
  };

  const keysFor = async (forceRefresh: boolean): Promise<Map<string, CryptoKey> | undefined> => {
    const stale = input.now() - cachedAt > JWKS_CACHE_MILLISECONDS;
    if (!forceRefresh && !stale && cachedKeys.size > 0) {
      return cachedKeys;
    }
    const loaded = await loadKeys();
    if (loaded === undefined) {
      return undefined;
    }
    cachedKeys = loaded;
    cachedAt = input.now();
    return cachedKeys;
  };

  const verify = async (token: string): Promise<AccessVerification> => {
    if (token.trim().length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return fail("malformed");
    }
    const segments = token.split(".");
    if (segments.length !== 3) {
      return fail("malformed");
    }
    const header = Schema.decodeUnknownEither(JwtHeader)(decodeSegment(segments[0] ?? ""));
    if (header._tag === "Left") {
      return fail("malformed");
    }
    if (header.right.alg !== "RS256") {
      return fail("unsupported_algorithm");
    }
    const initial = await keysFor(false);
    if (initial === undefined) {
      return fail("jwks_unavailable");
    }
    let key = initial.get(header.right.kid);
    if (key === undefined) {
      const refreshed = await keysFor(true);
      if (refreshed === undefined) {
        return fail("jwks_unavailable");
      }
      key = refreshed.get(header.right.kid);
    }
    if (key === undefined) {
      return fail("unknown_key");
    }
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["RS256"],
        currentDate: new Date(input.now()),
      });
      if (payload.iss !== input.teamDomain) {
        return fail("bad_issuer");
      }
      if (!audienceMatches(payload.aud, input.audience)) {
        return fail("bad_audience");
      }
      const email: unknown = payload["email"];
      if (typeof email !== "string" || email.trim().length === 0) {
        return fail("malformed");
      }
      const subject: unknown = payload.sub;
      return {
        ok: true,
        identity: {
          email: email.trim().toLowerCase(),
          subject: typeof subject === "string" ? subject : email.trim().toLowerCase(),
        },
      };
    } catch (cause) {
      return fail(mapVerificationFailure(cause));
    }
  };

  return { verify };
};
