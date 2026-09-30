import { Either, Schema } from "effect";
import { CooldownSeconds, MAX_COOLDOWN_SECONDS } from "../../domain/policy.ts";
import type { ParseResult } from "./parse-result.ts";

export const cooldownMaxHours = MAX_COOLDOWN_SECONDS / 3600;

export const cooldownDefaultHours = 24;

export const hoursFromSeconds = (seconds: number): string => {
  const hours = seconds / 3600;
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
};

export const parseCooldownHours = (raw: string): ParseResult<CooldownSeconds> => {
  const trimmed = raw.trim();
  const bounds = `Enter a number of hours between 0 and ${cooldownMaxHours}.`;
  if (trimmed === "") {
    return { ok: false, message: "Enter a cooldown in hours." };
  }
  const hours = Number(trimmed);
  if (!Number.isFinite(hours) || hours < 0 || hours > cooldownMaxHours) {
    return { ok: false, message: bounds };
  }
  const decoded = Schema.decodeUnknownEither(CooldownSeconds)(Math.round(hours * 3600));
  if (Either.isRight(decoded)) {
    return { ok: true, value: decoded.right };
  }
  return { ok: false, message: bounds };
};
