import { Schema } from "effect";

export const ServiceFailure = Schema.Union(
  Schema.Struct({ type: Schema.Literal("invalid_request"), detail: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("stale_revision"),
    expected: Schema.Number,
    actual: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("idempotency_conflict"), key: Schema.String }),
  Schema.Struct({ type: Schema.Literal("precondition_required"), header: Schema.String }),
  Schema.Struct({ type: Schema.Literal("not_found"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("conflict"), detail: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("config"),
    missing: Schema.Array(Schema.String),
    detail: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("unavailable"), code: Schema.String }),
);

export type ServiceFailure = typeof ServiceFailure.Type;

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ServiceFailure };

export const succeeded = <T>(value: T): ServiceResult<T> => ({ ok: true, value });

export const failed = <T>(failure: ServiceFailure): ServiceResult<T> => ({
  ok: false,
  failure,
});
