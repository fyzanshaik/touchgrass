import type { AccessFailureCode, AccessVerifier } from "./access.ts";
import { isLoopbackHostname, type AppConfig } from "./config.ts";

export interface Identity {
  readonly email: string;
  readonly subject: string;
  readonly source: "access" | "local";
}

export type AuthFailure =
  | { readonly type: "missing_token" }
  | { readonly type: "invalid_token"; readonly code: AccessFailureCode }
  | { readonly type: "not_owner" }
  | { readonly type: "local_mode_requires_loopback" }
  | { readonly type: "unavailable"; readonly code: string };

export type AuthOutcome =
  | { readonly ok: true; readonly identity: Identity }
  | { readonly ok: false; readonly failure: AuthFailure };

export const ACCESS_TOKEN_HEADER = "cf-access-jwt-assertion";

export const authenticate = async (input: {
  readonly request: Request;
  readonly config: AppConfig;
  readonly verifier: AccessVerifier;
}): Promise<AuthOutcome> => {
  const { request, config, verifier } = input;
  const hostname = new URL(request.url).hostname;
  if (config.environment === "local") {
    if (!isLoopbackHostname(hostname)) {
      return { ok: false, failure: { type: "local_mode_requires_loopback" } };
    }
    return {
      ok: true,
      identity: {
        email: config.localAuthEmail,
        subject: config.localAuthEmail,
        source: "local",
      },
    };
  }
  const token = request.headers.get(ACCESS_TOKEN_HEADER);
  if (token === null) {
    return { ok: false, failure: { type: "missing_token" } };
  }
  const verified = await verifier.verify(token);
  if (!verified.ok) {
    return { ok: false, failure: { type: "invalid_token", code: verified.code } };
  }
  if (verified.identity.email !== config.ownerEmail) {
    return { ok: false, failure: { type: "not_owner" } };
  }
  return {
    ok: true,
    identity: {
      email: verified.identity.email,
      subject: verified.identity.subject,
      source: "access",
    },
  };
};

export type CsrfFailure =
  | { readonly type: "cross_site"; readonly detail: string }
  | { readonly type: "missing_origin"; readonly detail: string }
  | { readonly type: "unsupported_content_type"; readonly detail: string };

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const isMutatingMethod = (method: string): boolean =>
  MUTATING_METHODS.has(method.toUpperCase());

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

export const checkMutationOrigin = (request: Request): CsrfFailure | undefined => {
  if (!isMutatingMethod(request.method)) {
    return undefined;
  }
  const contentType = request.headers.get("content-type");
  if (contentType === null || !contentType.toLowerCase().startsWith("application/json")) {
    return {
      type: "unsupported_content_type",
      detail: "Mutating requests must use application/json.",
    };
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { type: "cross_site", detail: "Cross-site requests are rejected." };
  }
  const declared = request.headers.get("origin");
  const origin = declared ?? (() => {
    const referer = request.headers.get("referer");
    return referer === null ? undefined : originOf(referer);
  })();
  if (origin === undefined) {
    return {
      type: "missing_origin",
      detail: "Mutating requests must carry an Origin or Referer header.",
    };
  }
  const expected = new URL(request.url).origin;
  if (origin !== expected) {
    return { type: "cross_site", detail: "Cross-site requests are rejected." };
  }
  return undefined;
};
