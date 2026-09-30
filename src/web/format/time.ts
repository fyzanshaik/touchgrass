import { instantToMilliseconds } from "../../domain/instants.ts";
import type { Instant } from "../../domain/instants.ts";

const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export const formatInstant = (value: Instant): string =>
  absoluteFormatter.format(new Date(instantToMilliseconds(value)));

const plural = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

export const formatDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  if (safe === 0) {
    return "no delay";
  }
  const days = Math.floor(safe / 86400);
  const hours = Math.floor((safe % 86400) / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(plural(days, "day"));
  }
  if (hours > 0) {
    parts.push(plural(hours, "hour"));
  }
  if (minutes > 0 && days === 0) {
    parts.push(plural(minutes, "minute"));
  }
  return parts.length === 0 ? "under a minute" : parts.join(" ");
};

export const formatRemaining = (target: Instant, now: number): string => {
  const delta = instantToMilliseconds(target) - now;
  return delta <= 0 ? "now" : formatDuration(delta / 1000);
};

export const formatElapsed = (value: Instant, now: number): string => {
  const delta = now - instantToMilliseconds(value);
  return delta < 45000 ? "just now" : `${formatDuration(delta / 1000)} ago`;
};

export const toEpochMilliseconds = (value: Instant): number => instantToMilliseconds(value);
