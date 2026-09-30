import type { ApiErrorResponse } from "../../contracts/api.ts";

export type ClientFailure =
  | { readonly kind: "offline"; readonly detail: string }
  | { readonly kind: "api"; readonly status: number; readonly error: ApiErrorResponse }
  | { readonly kind: "malformed"; readonly status: number; readonly detail: string }
  | { readonly kind: "unexpected"; readonly status: number; readonly detail: string };

export type Result<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: ClientFailure };

export const isOffline = (failure: ClientFailure): boolean => failure.kind === "offline";

export const isStaleRevision = (failure: ClientFailure): boolean =>
  failure.kind === "api" && failure.error.code === "stale_revision";

export const isRetryable = (failure: ClientFailure): boolean => {
  switch (failure.kind) {
    case "offline":
      return true;
    case "malformed":
      return true;
    case "unexpected":
      return true;
    case "api":
      return failure.status >= 500;
  }
};
