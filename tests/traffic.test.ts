import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalTraffic, trafficEquivalent } from "../src/domain/traffic.ts";

const LOCATION = 'dns.doh_subdomain == "local"';
const DOMAIN_ANY = 'any(dns.domains[*] == "blocked.example.org")';
const CATEGORY = 'any(dns.content_category[*] in {133})';

describe("canonical traffic equivalence accepts benign reformatting", () => {
  const pairs: readonly (readonly [string, string])[] = [
    [`${LOCATION} and ${DOMAIN_ANY}`, `dns.doh_subdomain=="local" and any(dns.domains[*]=="blocked.example.org")`],
    [`${LOCATION} and ${DOMAIN_ANY}`, `(${LOCATION}) and (${DOMAIN_ANY})`],
    [`${LOCATION} and ${DOMAIN_ANY}`, `(((${LOCATION}))) and ${DOMAIN_ANY}`],
    [`${LOCATION} and ${DOMAIN_ANY}`, `${DOMAIN_ANY} and ${LOCATION}`],
    [`${LOCATION} and ${DOMAIN_ANY}`, `${LOCATION}   and   ${DOMAIN_ANY}`],
    [`${LOCATION} and ${DOMAIN_ANY}`, `${LOCATION} and ${DOMAIN_ANY} and ${DOMAIN_ANY}`],
    [
      `${LOCATION} and (${DOMAIN_ANY} or ${CATEGORY})`,
      `${LOCATION} and (${CATEGORY} or ${DOMAIN_ANY})`,
    ],
    [`a == "x" and (b == "y" and c == "z")`, `(a == "x" and b == "y") and c == "z"`],
    [`a in {2, 1}`, `a in {1, 2}`],
    [`a in {1, 1}`, `a in {1}`],
  ];

  for (const [left, right] of pairs) {
    it(`treats ${left} as equivalent to ${right}`, () => {
      assert.equal(trafficEquivalent(left, right), true);
      assert.equal(canonicalTraffic(left), canonicalTraffic(right));
    });
  }

  it("preserves quoted string content exactly", () => {
    assert.equal(trafficEquivalent('a == "x"', 'a == "X"'), false);
    assert.equal(trafficEquivalent('a == "x y"', 'a == "x  y"'), false);
    assert.equal(trafficEquivalent('a == "x\\"y"', 'a == "x\\"y"'), true);
  });
});

describe("canonical traffic equivalence rejects semantic change", () => {
  const pairs: readonly (readonly [string, string])[] = [
    [`${LOCATION} and ${CATEGORY}`, `${LOCATION} or ${CATEGORY}`],
    [`a == "x" and b == "y"`, `a == "x" or b == "y"`],
    [`${LOCATION} and ${DOMAIN_ANY}`, `${DOMAIN_ANY}`],
    [`${DOMAIN_ANY}`, `${LOCATION} and ${DOMAIN_ANY}`],
    [`${LOCATION} and ${DOMAIN_ANY}`, `${LOCATION} and not (${DOMAIN_ANY})`],
    [`not (a == "x")`, `a == "x"`],
    [`a == "x" and (b == "y" or c == "z")`, `(a == "x" and b == "y") or c == "z"`],
    [`a == "x" and (b == "y" or c == "z")`, `a == "x" and b == "y" or c == "z"`],
    [`${LOCATION} and ${CATEGORY}`, `dns.doh_subdomain == "other" and ${CATEGORY}`],
    [`${CATEGORY}`, `any(dns.content_category[*] in {133, 125})`],
    [`a == "x"`, `a != "x"`],
    [`a == "x"`, `a > "x"`],
    [`any(dns.domains[*] == "a.example.org")`, `dns.fqdn == "a.example.org"`],
    [`a == "x"`, `b == "x"`],
  ];

  for (const [left, right] of pairs) {
    it(`rejects ${right} against ${left}`, () => {
      assert.equal(trafficEquivalent(left, right), false);
    });
  }
});

describe("canonical traffic fails closed outside the supported subset", () => {
  const unsupported: readonly string[] = [
    "",
    "   ",
    "a == ",
    "a =",
    'a = "x"',
    'a && b',
    'a == "x" | b == "y"',
    'a == "x" and',
    "(a == \"x\"",
    'a == "x")',
    "a == " + '"unterminated',
    "a ~ \"x\"",
    'a == "x" b == "y"',
    "any(",
    "any(dns.domains[*] ==",
    'dns.domains[?] == "x"',
    'a == "x" ; b == "y"',
    "x".repeat(5000),
  ];

  for (const expression of unsupported) {
    it(`fails closed for ${JSON.stringify(expression.slice(0, 40))}`, () => {
      assert.equal(canonicalTraffic(expression), undefined);
      assert.equal(trafficEquivalent('a == "x"', expression), false);
      assert.equal(trafficEquivalent(expression, 'a == "x"'), false);
    });
  }

  it("fails closed when both sides are unparseable", () => {
    assert.equal(trafficEquivalent("a && b", "c || d"), false);
  });
});

describe("canonical traffic shape", () => {
  it("encodes operators and grouping explicitly", () => {
    assert.equal(canonicalTraffic('a == "x"'), 'a==["x"]');
    assert.equal(canonicalTraffic('a != "x"'), 'a!=["x"]');
    assert.equal(canonicalTraffic("a in {1, 2}"), "ain[1,2]");
    assert.equal(canonicalTraffic('a == "x" and b == "y"'), 'and(a==["x"],b==["y"])');
    assert.equal(canonicalTraffic('a == "x" or b == "y"'), 'or(a==["x"],b==["y"])');
    assert.equal(canonicalTraffic('not (a == "x")'), 'not(a==["x"])');
    assert.equal(
      canonicalTraffic(`${LOCATION} and ${CATEGORY}`),
      'and(any(dns.content_category[*]in[133]),dns.doh_subdomain==["local"])',
    );
  });

  it("keeps grouped and flat expressions distinct", () => {
    assert.notEqual(
      canonicalTraffic('a == "x" and (b == "y" or c == "z")'),
      canonicalTraffic('(a == "x" and b == "y") or c == "z"'),
    );
  });
});

describe("canonical traffic bounds recursion instead of overflowing", () => {
  const parens = (depth: number): string =>
    `${"(".repeat(depth)}a == "x"${")".repeat(depth)}`;
  const nots = (depth: number): string => `${"not ".repeat(depth)}a == "x"`;

  it("fails closed for the reported deeply nested expression", () => {
    const expression = parens(1800);
    assert.equal(expression.length, 3608);
    assert.doesNotThrow(() => canonicalTraffic(expression));
    assert.equal(canonicalTraffic(expression), undefined);
    assert.equal(trafficEquivalent('a == "x"', expression), false);
    assert.equal(trafficEquivalent(expression, 'a == "x"'), false);
  });

  it("fails closed for a long unary chain and deep calls", () => {
    assert.equal(canonicalTraffic(nots(1000)), undefined);
    assert.equal(
      canonicalTraffic(`${"any(".repeat(200)}a == "x"${")".repeat(200)}`),
      undefined,
    );
    assert.equal(
      canonicalTraffic(`${"any(".repeat(200)}a == "x"${")".repeat(199)}`),
      undefined,
    );
  });

  it("accepts nesting up to the limit and rejects beyond it", () => {
    assert.equal(canonicalTraffic(parens(128)), 'a==["x"]');
    assert.equal(canonicalTraffic(parens(129)), undefined);
    assert.equal(canonicalTraffic(nots(128)), `${"not(".repeat(128)}a==["x"]${")".repeat(128)}`);
    assert.equal(canonicalTraffic(nots(129)), undefined);
  });

  it("keeps ordinary nesting working", () => {
    assert.equal(canonicalTraffic("((a == \"x\"))"), 'a==["x"]');
    assert.equal(
      canonicalTraffic(`${LOCATION} and (${DOMAIN_ANY} or ${CATEGORY})`),
      canonicalTraffic(`(${LOCATION}) and ((${DOMAIN_ANY}) or (${CATEGORY}))`),
    );
  });
});
