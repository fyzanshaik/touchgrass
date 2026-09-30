import { Hono } from "hono";
import type { Context } from "hono";
import { Schema } from "effect";
import {
  ApiErrorResponse,
  BackupResponse,
  ChangeResponse,
  DiagnosticsResponse,
  PolicyResponse,
  PreviewResponse,
  StatusResponse,
  decodeChangeRequest,
  decodeEmptyBody,
  decodePreviewRequest,
  decodeRestoreRequest,
  type ApiErrorCode,
} from "../contracts/api.ts";
import type { RuleScope } from "../domain/policy.ts";
import { normalizeHostnameInput } from "../domain/hostname.ts";
import { createAccessVerifier, type AccessVerifier } from "./access.ts";
import { authenticate, checkMutationOrigin } from "./auth.ts";
import { decodeConfig, type AppConfig } from "./config.ts";
import {
  DEFAULT_MAX_BODY_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESTORE_BODY_BYTES,
  readBoundedRequestBody,
} from "./http.ts";
import { OWNER_OBJECT_NAME, type AccountDurableObject } from "./account.ts";
import type { ServiceFailure } from "./service-result.ts";

export const API_PREFIX = "/api/v1";

type Variables = {
  readonly requestId: string;
  readonly config: AppConfig;
};

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const verifierCache = new Map<string, AccessVerifier>();

const verifierFor = (config: AppConfig): AccessVerifier => {
  const key = `${config.accessTeamDomain}|${config.accessAudience}`;
  const existing = verifierCache.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = createAccessVerifier({
    teamDomain: config.accessTeamDomain,
    audience: config.accessAudience,
    fetcher: (url) => fetch(url),
    now: () => Date.now(),
  });
  verifierCache.set(key, created);
  return created;
};

const jsonResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  value: A,
  status: number,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(Schema.encodeSync(schema)(value)), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

const failureStatus = (
  failure: ServiceFailure,
): { readonly status: number; readonly code: ApiErrorCode; readonly message: string } => {
  switch (failure.type) {
    case "invalid_request":
      return { status: 400, code: "invalid_request", message: failure.detail };
    case "precondition_required":
      return {
        status: 428,
        code: "precondition_required",
        message: `${failure.header} is required.`,
      };
    case "stale_revision":
      return {
        status: 412,
        code: "stale_revision",
        message: `Expected revision ${failure.expected} but the policy is at ${failure.actual}.`,
      };
    case "idempotency_conflict":
      return {
        status: 409,
        code: "conflict",
        message: "The idempotency key was already used for a different request.",
      };
    case "not_found":
      return { status: 404, code: "not_found", message: "The requested record does not exist." };
    case "conflict":
      return { status: 409, code: "conflict", message: failure.detail };
    case "config":
      return {
        status: 503,
        code: "unavailable",
        message: `${failure.detail} Missing settings: ${failure.missing.join(", ") || "none"}.`,
      };
    case "unavailable":
      return {
        status: 503,
        code: "unavailable",
        message: `The service is unavailable (${failure.code}).`,
      };
  }
};

const errorResponse = (
  requestId: string,
  status: number,
  code: ApiErrorCode,
  message: string,
): Response => jsonResponse(ApiErrorResponse, { code, message, requestId }, status);

const withFailure = (c: AppContext, failure: ServiceFailure): Response => {
  const mapped = failureStatus(failure);
  return errorResponse(c.get("requestId"), mapped.status, mapped.code, mapped.message);
};

const invalidRequest = (c: AppContext, detail: string): Response =>
  errorResponse(c.get("requestId"), 400, "invalid_request", detail);

const parseIfMatch = (
  value: string | null,
):
  | { readonly kind: "ok"; readonly revision: number }
  | { readonly kind: "missing" | "malformed" } => {
  if (value === null) {
    return { kind: "missing" };
  }
  const match = /^"p-(\d+)"$/.exec(value.trim());
  if (match === null) {
    return { kind: "malformed" };
  }
  const revision = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(revision) && revision >= 1
    ? { kind: "ok", revision }
    : { kind: "malformed" };
};

interface MutationInput {
  readonly baseRevision: number | null;
  readonly idempotencyKey: string;
  readonly body: unknown;
}

const readMutation = async (
  c: AppContext,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly input: MutationInput } | { readonly ok: false; readonly response: Response }> => {
  const ifMatch = parseIfMatch(c.req.header("if-match") ?? null);
  if (ifMatch.kind === "malformed") {
    return { ok: false, response: invalidRequest(c, 'If-Match must look like "p-3".') };
  }
  const raw = await readBoundedRequestBody(c.req.raw, maxBytes);
  if (!raw.ok) {
    return {
      ok: false,
      response: errorResponse(
        c.get("requestId"),
        413,
        "payload_too_large",
        "The request body is too large.",
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { ok: false, response: invalidRequest(c, "The body is not valid JSON.") };
  }
  return {
    ok: true,
    input: {
      baseRevision: ifMatch.kind === "ok" ? ifMatch.revision : null,
      idempotencyKey: c.req.header("idempotency-key") ?? "",
      body: parsed,
    },
  };
};

const previewMessage = (reason: string | null, source: "hostname" | "url" | null): string => {
  if (reason !== null) {
    return `The entry was rejected (${reason}). DNS rules cannot express scheme, port, path or query, and cannot target wildcards, credentials, IP literals or a public suffix.`;
  }
  if (source === "url") {
    return "Only the hostname is stored; scheme, path and query are discarded. DNS rules cannot target ports.";
  }
  return "The hostname is stored for the selected scope.";
};

export const createApp = (): Hono<{ Bindings: Env; Variables: Variables }> => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    const decoded = decodeConfig(c.env);
    if (!decoded.ok) {
      return errorResponse(
        requestId,
        503,
        "unavailable",
        `${decoded.rejection.detail} Missing settings: ${decoded.rejection.missing.join(", ") || "none"}.`,
      );
    }
    const config = decoded.config;
    c.set("config", config);
    const authenticated = await authenticate({
      request: c.req.raw,
      config,
      verifier: verifierFor(config),
    });
    if (!authenticated.ok) {
      switch (authenticated.failure.type) {
        case "missing_token":
          return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
        case "invalid_token":
          return errorResponse(
            requestId,
            401,
            "unauthorized",
            `Authentication failed (${authenticated.failure.code}).`,
          );
        case "not_owner":
          return errorResponse(requestId, 403, "forbidden", "This account is not authorised.");
        case "local_mode_requires_loopback":
          return errorResponse(
            requestId,
            403,
            "forbidden",
            "Local development mode only accepts loopback requests.",
          );
        case "unavailable":
          return errorResponse(
            requestId,
            503,
            "unavailable",
            `Authentication is unavailable (${authenticated.failure.code}).`,
          );
      }
    }
    const originFailure = checkMutationOrigin(c.req.raw);
    if (originFailure !== undefined) {
      return originFailure.type === "unsupported_content_type"
        ? errorResponse(requestId, 400, "invalid_request", originFailure.detail)
        : errorResponse(requestId, 403, "forbidden", originFailure.detail);
    }
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const declared = c.req.header("content-length");
      if (declared !== undefined) {
        const parsed = Number.parseInt(declared, 10);
        if (Number.isSafeInteger(parsed) && parsed > MAX_REQUEST_BODY_BYTES) {
          return errorResponse(
            requestId,
            413,
            "payload_too_large",
            "The request body is too large.",
          );
        }
      }
    }
    await next();
    return undefined;
  });

  const accountStub = (env: Env): DurableObjectStub<AccountDurableObject> =>
    env.ACCOUNT.getByName(OWNER_OBJECT_NAME);

  app.get(`${API_PREFIX}/policy`, async (c) => {
    const result = await accountStub(c.env).readPolicy({
      ifNoneMatch: c.req.header("if-none-match") ?? null,
    });
    if (!result.ok) {
      return withFailure(c, result.failure);
    }
    if (result.value.notModified) {
      return new Response(null, { status: 304, headers: { etag: result.value.etag } });
    }
    return jsonResponse(
      PolicyResponse,
      { policy: result.value.policy, etag: result.value.etag },
      200,
      { etag: result.value.etag },
    );
  });

  app.get(`${API_PREFIX}/status`, async (c) => {
    const result = await accountStub(c.env).readStatus();
    return result.ok
      ? jsonResponse(StatusResponse, result.value, 200)
      : withFailure(c, result.failure);
  });

  app.get(`${API_PREFIX}/diagnostics`, async (c) => {
    const result = await accountStub(c.env).readDiagnostics();
    return result.ok
      ? jsonResponse(DiagnosticsResponse, result.value, 200)
      : withFailure(c, result.failure);
  });

  app.get(`${API_PREFIX}/backup`, async (c) => {
    const result = await accountStub(c.env).exportBackup();
    return result.ok
      ? jsonResponse(BackupResponse, result.value, 200, {
          "content-disposition": 'attachment; filename="touchgrass-policy.json"',
        })
      : withFailure(c, result.failure);
  });

  app.post(`${API_PREFIX}/preview`, async (c) => {
    const raw = await readBoundedRequestBody(c.req.raw, DEFAULT_MAX_BODY_BYTES);
    if (!raw.ok) {
      return errorResponse(
        c.get("requestId"),
        413,
        "payload_too_large",
        "The request body is too large.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.text);
    } catch {
      return invalidRequest(c, "The body is not valid JSON.");
    }
    const decoded = decodePreviewRequest(parsed);
    if (decoded._tag === "Left") {
      return invalidRequest(c, "Provide an input string and a scope of host or domain.");
    }
    const scope: RuleScope = decoded.right.scope;
    const normalized = normalizeHostnameInput(decoded.right.input);
    const value = normalized.ok
      ? {
          accepted: true,
          hostname: normalized.hostname,
          reason: null,
          source: normalized.source,
          scope,
          message: previewMessage(null, normalized.source),
        }
      : {
          accepted: false,
          hostname: null,
          reason: normalized.reason,
          source: null,
          scope,
          message: previewMessage(normalized.reason, null),
        };
    return jsonResponse(PreviewResponse, value, 200);
  });

  app.post(`${API_PREFIX}/changes`, async (c) => {
    const mutation = await readMutation(c, DEFAULT_MAX_BODY_BYTES);
    if (!mutation.ok) {
      return mutation.response;
    }
    const decoded = decodeChangeRequest(mutation.input.body);
    if (decoded._tag === "Left") {
      return invalidRequest(c, "The change request is not a recognised operation.");
    }
    const result = await accountStub(c.env).submitChange({
      operation: decoded.right.operation,
      baseRevision: mutation.input.baseRevision,
      idempotencyKey: mutation.input.idempotencyKey,
    });
    return result.ok
      ? jsonResponse(ChangeResponse, result.value, result.value.state === "unchanged" ? 200 : 202)
      : withFailure(c, result.failure);
  });

  app.post(`${API_PREFIX}/restore`, async (c) => {
    const mutation = await readMutation(c, MAX_RESTORE_BODY_BYTES);
    if (!mutation.ok) {
      return mutation.response;
    }
    const decoded = decodeRestoreRequest(mutation.input.body);
    if (decoded._tag === "Left") {
      return invalidRequest(c, "The restore request is not a valid policy backup.");
    }
    const result = await accountStub(c.env).restorePolicy({
      policy: decoded.right.policy,
      baseRevision: mutation.input.baseRevision,
      idempotencyKey: mutation.input.idempotencyKey,
    });
    return result.ok
      ? jsonResponse(ChangeResponse, result.value, result.value.state === "unchanged" ? 200 : 202)
      : withFailure(c, result.failure);
  });

  app.post(`${API_PREFIX}/relaxations/:id/confirm`, async (c) => {
    const mutation = await readMutation(c, DEFAULT_MAX_BODY_BYTES);
    if (!mutation.ok) {
      return mutation.response;
    }
    if (decodeEmptyBody(mutation.input.body)._tag === "Left") {
      return invalidRequest(c, "This operation accepts no request fields.");
    }
    const result = await accountStub(c.env).confirmRelaxation({
      relaxationId: c.req.param("id"),
      baseRevision: mutation.input.baseRevision,
      idempotencyKey: mutation.input.idempotencyKey,
    });
    return result.ok
      ? jsonResponse(ChangeResponse, result.value, 202)
      : withFailure(c, result.failure);
  });

  app.post(`${API_PREFIX}/relaxations/:id/cancel`, async (c) => {
    const mutation = await readMutation(c, DEFAULT_MAX_BODY_BYTES);
    if (!mutation.ok) {
      return mutation.response;
    }
    if (decodeEmptyBody(mutation.input.body)._tag === "Left") {
      return invalidRequest(c, "This operation accepts no request fields.");
    }
    const result = await accountStub(c.env).cancelRelaxation({
      relaxationId: c.req.param("id"),
      baseRevision: mutation.input.baseRevision,
      idempotencyKey: mutation.input.idempotencyKey,
    });
    return result.ok
      ? jsonResponse(StatusResponse, result.value, 200)
      : withFailure(c, result.failure);
  });

  app.post(`${API_PREFIX}/reconcile`, async (c) => {
    const mutation = await readMutation(c, DEFAULT_MAX_BODY_BYTES);
    if (!mutation.ok) {
      return mutation.response;
    }
    if (decodeEmptyBody(mutation.input.body)._tag === "Left") {
      return invalidRequest(c, "This operation accepts no request fields.");
    }
    const result = await accountStub(c.env).requestReconcile({
      baseRevision: mutation.input.baseRevision,
      idempotencyKey: mutation.input.idempotencyKey,
    });
    return result.ok
      ? jsonResponse(StatusResponse, result.value, 200)
      : withFailure(c, result.failure);
  });

  app.all(`${API_PREFIX}/*`, (c) =>
    errorResponse(c.get("requestId"), 404, "not_found", "No such API resource."),
  );

  app.all("/api/*", (c) =>
    errorResponse(c.get("requestId"), 404, "not_found", "No such API resource."),
  );

  app.all("*", async (c) => {
    const assets = c.env.ASSETS;
    const method = c.req.method.toUpperCase();
    if (assets === undefined || (method !== "GET" && method !== "HEAD")) {
      return errorResponse(c.get("requestId"), 404, "not_found", "No such resource.");
    }
    return assets.fetch(c.req.raw);
  });

  return app;
};
