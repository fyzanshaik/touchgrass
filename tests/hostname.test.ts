import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Schema } from "effect";
import {
  normalizeHostnameInput,
  type HostnameRejectionReason,
} from "../src/domain/hostname.ts";
import { RuleScope } from "../src/domain/policy.ts";
import { hostnameMatchesRule } from "../src/domain/plan.ts";

const Fixture = Schema.Struct({
  normalization: Schema.Array(
    Schema.Struct({
      input: Schema.String,
      kind: Schema.String,
      canonical: Schema.optional(Schema.String),
      reject: Schema.optional(Schema.String),
    }),
  ),
  matching: Schema.Array(
    Schema.Struct({
      rule: Schema.String,
      scope: RuleScope,
      query: Schema.String,
      matches: Schema.Boolean,
    }),
  ),
});

const fixturePath = path.join(import.meta.dirname, "fixtures", "domain-cases.json");
const fixtureText: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
const fixture = Schema.decodeUnknownSync(Fixture)(fixtureText);

describe("hostname normalization against the project fixtures", () => {
  for (const entry of fixture.normalization) {
    if (entry.canonical === undefined) {
      it(`rejects ${JSON.stringify(entry.input)}`, () => {
        const result = normalizeHostnameInput(entry.input);
        assert.equal(result.ok, false);
      });
    } else {
      it(`accepts ${JSON.stringify(entry.input)} as ${entry.canonical}`, () => {
        const result = normalizeHostnameInput(entry.input);
        assert.equal(result.ok, true);
        assert.equal(result.ok ? result.hostname : null, entry.canonical);
      });
    }
  }

  it("keeps a URL source flag so the preview can warn about discarded parts", () => {
    const result = normalizeHostnameInput("https://www.example.org/path?q=test");
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.source : null, "url");
  });
});

describe("hostname rejection reasons", () => {
  const cases: readonly { readonly input: string; readonly reason: HostnameRejectionReason }[] = [
    { input: "   ", reason: "empty" },
    { input: "org", reason: "not_registrable" },
    { input: "co.uk", reason: "not_registrable" },
    { input: "github.io", reason: "not_registrable" },
    { input: "blogspot.com", reason: "not_registrable" },
    { input: "localhost", reason: "not_registrable" },
    { input: "*.example.org", reason: "wildcard" },
    { input: "example.org/path", reason: "url_path" },
    { input: "example.org:8443", reason: "port" },
    { input: "https://example.org:8443/", reason: "port" },
    { input: "https://user:pw@example.org/", reason: "credentials" },
    { input: "user@example.org", reason: "credentials" },
    { input: "127.0.0.1", reason: "ip_literal" },
    { input: "https://[::1]/", reason: "ip_literal" },
    { input: "javascript:alert(1)", reason: "unsupported_scheme" },
    { input: "a_b.example.org", reason: "invalid_label" },
    { input: "-lead.example.org", reason: "invalid_label" },
    { input: "trailing-.example.org", reason: "invalid_label" },
    { input: "exa mple.org", reason: "invalid_label" },
    { input: `${"x".repeat(250)}.example.org`, reason: "too_long" },
  ];

  for (const entry of cases) {
    it(`reports ${entry.reason} for ${JSON.stringify(entry.input)}`, () => {
      const result = normalizeHostnameInput(entry.input);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? null : result.reason, entry.reason);
    });
  }
});

describe("hostname acceptance and boundaries", () => {
  const accepted: readonly { readonly input: string; readonly hostname: string }[] = [
    { input: "EXAMPLE.ORG.", hostname: "example.org" },
    { input: "www.example.org", hostname: "www.example.org" },
    { input: "a.b.c.d.example.org", hostname: "a.b.c.d.example.org" },
    { input: "bücher.example", hostname: "xn--bcher-kva.example" },
    { input: "alice.github.io", hostname: "alice.github.io" },
    { input: "x.blogspot.com", hostname: "x.blogspot.com" },
    { input: "app.pages.dev", hostname: "app.pages.dev" },
    { input: "https://example.org:443/", hostname: "example.org" },
    { input: "http://example.org:80/path", hostname: "example.org" },
    { input: "https://example.org", hostname: "example.org" },
  ];

  for (const entry of accepted) {
    it(`normalizes ${JSON.stringify(entry.input)} to ${entry.hostname}`, () => {
      const result = normalizeHostnameInput(entry.input);
      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.hostname : null, entry.hostname);
    });
  }

  it("rejects a 63-character label only past the limit", () => {
    const label = "a".repeat(63);
    assert.equal(normalizeHostnameInput(`${label}.example.org`).ok, true);
    assert.equal(normalizeHostnameInput(`${label}a.example.org`).ok, false);
  });

  it("rejects values that are not strings", () => {
    for (const value of [null, 42, {}, [], true, undefined]) {
      assert.equal(normalizeHostnameInput(value).ok, false);
    }
  });

  it("rejects input past the raw length bound before parsing", () => {
    assert.equal(normalizeHostnameInput(`example.${"a".repeat(3000)}`).ok, false);
  });
});

describe("rule matching semantics", () => {
  for (const entry of fixture.matching) {
    it(`${entry.rule} (${entry.scope}) against ${entry.query} is ${entry.matches}`, () => {
      assert.equal(
        hostnameMatchesRule({ hostname: entry.rule, scope: entry.scope }, entry.query),
        entry.matches,
      );
    });
  }

  it("treats a domain rule as covering descendants but not siblings", () => {
    const rule = { hostname: "example.org", scope: "domain" } as const;
    assert.equal(hostnameMatchesRule(rule, "example.org"), true);
    assert.equal(hostnameMatchesRule(rule, "deep.a.example.org"), true);
    assert.equal(hostnameMatchesRule(rule, "notexample.org"), false);
    assert.equal(hostnameMatchesRule(rule, "example.org.evil.test"), false);
  });
});
