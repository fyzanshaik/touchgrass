import assert from "node:assert/strict";
import test from "node:test";
import {
  categoryDescription,
  categoryLabel,
  describeFailure,
  errorCodeMessages,
  gatewayModeNote,
} from "../../src/web/format/labels.ts";
import { formatDuration, formatElapsed, formatInstant, formatRemaining } from "../../src/web/format/time.ts";
import { parseBackupPolicy } from "../../src/web/state/backup.ts";
import { cooldownMaxHours, hoursFromSeconds, parseCooldownHours } from "../../src/web/state/parse.ts";
import { backupFixture, instant, policyFixture } from "./fixtures.ts";

test("formatDuration describes whole units", () => {
  assert.equal(formatDuration(0), "no delay");
  assert.equal(formatDuration(45), "under a minute");
  assert.equal(formatDuration(60), "1 minute");
  assert.equal(formatDuration(120), "2 minutes");
  assert.equal(formatDuration(3600), "1 hour");
  assert.equal(formatDuration(86400), "1 day");
  assert.equal(formatDuration(90000), "1 day 1 hour");
  assert.equal(formatDuration(172800), "2 days");
});

test("formatRemaining counts down to an instant", () => {
  const target = instant("2026-10-01T10:00:00.000Z");

  assert.equal(formatRemaining(target, Date.parse("2026-10-01T09:00:00.000Z")), "1 hour");
  assert.equal(formatRemaining(target, Date.parse("2026-10-01T11:00:00.000Z")), "now");
});

test("formatElapsed reports recent and older times", () => {
  const value = instant("2026-09-30T10:00:00.000Z");

  assert.equal(formatElapsed(value, Date.parse("2026-09-30T10:00:10.000Z")), "just now");
  assert.equal(formatElapsed(value, Date.parse("2026-09-30T10:02:00.000Z")), "2 minutes ago");
});

test("formatInstant renders a locale string", () => {
  assert.equal(typeof formatInstant(instant("2026-09-30T10:00:00.000Z")), "string");
});

test("parseCooldownHours converts hours to canonical seconds", () => {
  const day = parseCooldownHours("24");
  assert.ok(day.ok);
  assert.equal(day.value, 86400);

  const none = parseCooldownHours(" 0 ");
  assert.ok(none.ok);
  assert.equal(none.value, 0);

  const halfHour = parseCooldownHours("1.5");
  assert.ok(halfHour.ok);
  assert.equal(halfHour.value, 5400);

  const week = parseCooldownHours(String(cooldownMaxHours));
  assert.ok(week.ok);
  assert.equal(week.value, 604800);
});

test("parseCooldownHours rejects values outside the hour bounds", () => {
  assert.equal(parseCooldownHours("").ok, false);
  assert.equal(parseCooldownHours("later").ok, false);
  assert.equal(parseCooldownHours("-1").ok, false);
  assert.equal(parseCooldownHours("169").ok, false);
  assert.equal(parseCooldownHours("Infinity").ok, false);
});

test("hoursFromSeconds renders the stored cooldown back in hours", () => {
  assert.equal(hoursFromSeconds(86400), "24");
  assert.equal(hoursFromSeconds(0), "0");
  assert.equal(hoursFromSeconds(604800), "168");
  assert.equal(hoursFromSeconds(5400), "1.5");
});

test("parseBackupPolicy accepts an exported backup and a bare policy", () => {
  const backup = parseBackupPolicy(JSON.stringify(backupFixture(policyFixture(2))));
  assert.ok(backup.ok);
  assert.equal(backup.value.revision, 2);

  const bare = parseBackupPolicy(JSON.stringify(policyFixture(3)));
  assert.ok(bare.ok);
  assert.equal(bare.value.revision, 3);
});

test("parseBackupPolicy rejects junk", () => {
  const notJson = parseBackupPolicy("not json");
  assert.equal(notJson.ok, false);

  const wrongShape = parseBackupPolicy(JSON.stringify({ hello: "world" }));
  assert.equal(wrongShape.ok, false);
});

test("gatewayModeNote never reports simulated copy for a live Gateway", () => {
  const live = gatewayModeNote("live");

  assert.equal(live.tone, "info");
  assert.match(live.text, /live Gateway/);
  assert.match(live.text, /does not prove/);
  assert.match(live.text, /device/);
  assert.doesNotMatch(live.text, /simulated/i);
  assert.doesNotMatch(live.text, /no device is being filtered/i);
  assert.doesNotMatch(live.text, /local development/i);
});

test("gatewayModeNote reports simulated mode as simulated and unverified", () => {
  const simulated = gatewayModeNote("simulated");

  assert.equal(simulated.tone, "warning");
  assert.match(simulated.text, /simulated/i);
  assert.match(simulated.text, /no device is being filtered/i);
  assert.doesNotMatch(simulated.text, /connected to your live Gateway account/i);
});

test("gatewayModeNote stays honest when the mode is unknown", () => {
  const unknown = gatewayModeNote(null);

  assert.equal(unknown.tone, "info");
  assert.match(unknown.text, /has not been reported yet/);
  assert.doesNotMatch(unknown.text, /simulated/i);
  assert.doesNotMatch(unknown.text, /live Gateway account/i);
  assert.doesNotMatch(unknown.text, /is being filtered/i);
});

test("category labels and descriptions resolve for the exposed category", () => {
  assert.equal(categoryLabel("pornography"), "Pornography");
  assert.ok(categoryDescription("pornography").length > 0);
});

test("describeFailure maps offline and api failures to plain language", () => {
  assert.match(describeFailure({ kind: "offline", detail: "x" }), /could not reach/);
  assert.equal(
    describeFailure({
      kind: "api",
      status: 503,
      error: { code: "unavailable", message: "x", requestId: "11111111-1111-4111-8111-111111111111" },
    }),
    errorCodeMessages.unavailable,
  );
});
