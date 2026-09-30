import { Schema } from "effect";

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const Instant = Schema.String.pipe(
  Schema.pattern(INSTANT_PATTERN, {
    message: () => "Expected a UTC instant formatted as YYYY-MM-DDTHH:mm:ss.sssZ.",
  }),
  Schema.brand("Instant"),
);

export type Instant = typeof Instant.Type;

export const decodeInstant = Schema.decodeSync(Instant);

export const instantFromMilliseconds = (milliseconds: number): Instant =>
  decodeInstant(new Date(milliseconds).toISOString());

export const instantToMilliseconds = (value: Instant): number => Date.parse(value);

export const instantPlusSeconds = (value: Instant, seconds: number): Instant =>
  instantFromMilliseconds(instantToMilliseconds(value) + seconds * 1000);

export const compareInstants = (left: Instant, right: Instant): number =>
  instantToMilliseconds(left) - instantToMilliseconds(right);
