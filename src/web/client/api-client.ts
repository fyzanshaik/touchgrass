import { Either, Schema } from "effect";
import {
  ApiErrorResponse,
  BackupResponse,
  ChangeResponse,
  DiagnosticsResponse,
  PolicyResponse,
  PreviewResponse,
  StatusResponse,
} from "../../contracts/api.ts";
import type { ChangeRequest, PreviewRequest, RestoreRequest } from "../../contracts/api.ts";
import type { Operation } from "../../domain/operations.ts";
import type { Policy, Revision, RuleScope } from "../../domain/policy.ts";
import type { ClientFailure, Result } from "./result.ts";

export const API_BASE = "/api/v1";

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface MutationHeaders {
  readonly idempotencyKey: string;
  readonly baseRevision: Revision;
}

export type PolicyRead =
  | { readonly notModified: true; readonly etag: string }
  | { readonly notModified: false; readonly etag: string; readonly policy: Policy };

export interface ApiClient {
  readonly readPolicy: (ifNoneMatch: string | null) => Promise<Result<PolicyRead>>;
  readonly readStatus: () => Promise<Result<StatusResponse>>;
  readonly readDiagnostics: () => Promise<Result<DiagnosticsResponse>>;
  readonly readBackup: () => Promise<Result<BackupResponse>>;
  readonly preview: (input: string, scope: RuleScope) => Promise<Result<PreviewResponse>>;
  readonly submitChange: (operation: Operation, headers: MutationHeaders) => Promise<Result<ChangeResponse>>;
  readonly confirmRelaxation: (relaxationId: string, headers: MutationHeaders) => Promise<Result<ChangeResponse>>;
  readonly cancelRelaxation: (relaxationId: string, headers: MutationHeaders) => Promise<Result<StatusResponse>>;
  readonly reconcile: (headers: MutationHeaders) => Promise<Result<StatusResponse>>;
  readonly restore: (request: RestoreRequest, headers: MutationHeaders) => Promise<Result<ChangeResponse>>;
}

const malformed = (status: number, detail: string): ClientFailure => ({
  kind: "malformed",
  status,
  detail,
});

const decodeWith = <A, I>(schema: Schema.Schema<A, I>, status: number, input: unknown): Result<A> => {
  const decoded = Schema.decodeUnknownEither(schema)(input);
  if (Either.isRight(decoded)) {
    return { ok: true, value: decoded.right };
  }
  return {
    ok: false,
    failure: malformed(status, "The service response did not match the shared contract."),
  };
};

const send = async (fetcher: Fetcher, path: string, init: RequestInit): Promise<Result<Response>> => {
  try {
    const response = await fetcher(`${API_BASE}${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
    return { ok: true, value: response };
  } catch (cause) {
    return {
      ok: false,
      failure: {
        kind: "offline",
        detail: cause instanceof Error ? cause.message : "The network request failed.",
      },
    };
  }
};

const readJson = async (response: Response): Promise<Result<unknown>> => {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, failure: malformed(response.status, "The response body could not be read.") };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, failure: malformed(response.status, "The response body was not valid JSON.") };
  }
};

const readSuccess = async <A, I>(response: Response, schema: Schema.Schema<A, I>): Promise<Result<A>> => {
  const body = await readJson(response);
  if (!body.ok) {
    return { ok: false, failure: body.failure };
  }
  return decodeWith(schema, response.status, body.value);
};

const readFailure = async (response: Response): Promise<Result<never>> => {
  const body = await readJson(response);
  if (!body.ok) {
    return { ok: false, failure: body.failure };
  }
  const decoded = decodeWith(ApiErrorResponse, response.status, body.value);
  if (!decoded.ok) {
    return {
      ok: false,
      failure: {
        kind: "unexpected",
        status: response.status,
        detail: "The service returned an error the dashboard could not read.",
      },
    };
  }
  return { ok: false, failure: { kind: "api", status: response.status, error: decoded.value } };
};

const expectSuccess = async <A, I>(response: Response, schema: Schema.Schema<A, I>): Promise<Result<A>> =>
  response.ok ? readSuccess(response, schema) : readFailure(response);

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(body),
});

const mutationRequest = (
  path: string,
  headers: MutationHeaders,
  body: unknown,
): { readonly path: string; readonly init: RequestInit } => ({
  path,
  init: {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "idempotency-key": headers.idempotencyKey,
      "if-match": `"p-${headers.baseRevision}"`,
    },
    body: JSON.stringify(body),
  },
});

export const createApiClient = (fetcher: Fetcher): ApiClient => {
  const post = async <A, I>(
    target: { readonly path: string; readonly init: RequestInit },
    schema: Schema.Schema<A, I>,
  ): Promise<Result<A>> => {
    const response = await send(fetcher, target.path, target.init);
    return response.ok ? expectSuccess(response.value, schema) : response;
  };

  return {
    readPolicy: async (ifNoneMatch) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (ifNoneMatch !== null) {
        headers["if-none-match"] = ifNoneMatch;
      }
      const response = await send(fetcher, "/policy", { method: "GET", headers });
      if (!response.ok) {
        return response;
      }
      if (response.value.status === 304) {
        return {
          ok: true,
          value: {
            notModified: true,
            etag: response.value.headers.get("etag") ?? ifNoneMatch ?? "",
          },
        };
      }
      const decoded = await expectSuccess(response.value, PolicyResponse);
      if (!decoded.ok) {
        return decoded;
      }
      return {
        ok: true,
        value: { notModified: false, etag: decoded.value.etag, policy: decoded.value.policy },
      };
    },

    readStatus: async () => {
      const response = await send(fetcher, "/status", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      return response.ok ? expectSuccess(response.value, StatusResponse) : response;
    },

    readDiagnostics: async () => {
      const response = await send(fetcher, "/diagnostics", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      return response.ok ? expectSuccess(response.value, DiagnosticsResponse) : response;
    },

    readBackup: async () => {
      const response = await send(fetcher, "/backup", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      return response.ok ? expectSuccess(response.value, BackupResponse) : response;
    },

    preview: async (input, scope) => {
      const request: PreviewRequest = { input, scope };
      return post({ path: "/preview", init: jsonRequest("POST", request) }, PreviewResponse);
    },

    submitChange: async (operation, headers) => {
      const request: ChangeRequest = { operation };
      return post(mutationRequest("/changes", headers, request), ChangeResponse);
    },

    confirmRelaxation: async (relaxationId, headers) =>
      post(
        mutationRequest(`/relaxations/${encodeURIComponent(relaxationId)}/confirm`, headers, {}),
        ChangeResponse,
      ),

    cancelRelaxation: async (relaxationId, headers) =>
      post(
        mutationRequest(`/relaxations/${encodeURIComponent(relaxationId)}/cancel`, headers, {}),
        StatusResponse,
      ),

    reconcile: async (headers) => post(mutationRequest("/reconcile", headers, {}), StatusResponse),

    restore: async (request, headers) =>
      post(mutationRequest("/restore", headers, request), ChangeResponse),
  };
};
