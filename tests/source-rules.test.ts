import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkSourceText,
  checkStrictJson,
  isSourceFile,
} from "../src/quality/source-rules.ts";

const sourceLines = (...lines: readonly string[]): string => lines.join("\n");

const rulesFor = (source: string): readonly string[] =>
  checkSourceText("sample.ts", source).map((violation) => violation.rule);

describe("checkSourceText type rules", () => {
  it("rejects the any type", () => {
    assert.deepEqual(rulesFor(sourceLines("let value: any = 1;")), ["any"]);
    assert.deepEqual(rulesFor(sourceLines("const fn = (input: any): any => input;")), [
      "any",
      "any",
    ]);
  });

  it("rejects assertions but allows as const and satisfies", () => {
    assert.deepEqual(rulesFor(sourceLines("const a = value as string;")), ["assertion"]);
    assert.deepEqual(rulesFor(sourceLines("const a = <string>value;")), ["assertion"]);
    assert.deepEqual(rulesFor(sourceLines("const a = [1] as const;")), []);
    assert.deepEqual(
      rulesFor(sourceLines("const a = { b: 1 } as const satisfies { b: number };")),
      [],
    );
  });

  it("rejects non-null assertions", () => {
    assert.deepEqual(rulesFor(sourceLines("const a = maybe!.value;")), ["non-null-assertion"]);
  });

  it("reports positions that point at the offending token", () => {
    const violations = checkSourceText(
      "sample.ts",
      sourceLines("const a = 1;", "const b: any = 2;"),
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.line, 2);
    assert.equal(violations[0]?.column, 10);
  });
});

describe("checkSourceText comment detection", () => {
  it("finds line, block, doc and end-of-file comments", () => {
    assert.deepEqual(rulesFor(sourceLines("const a = 1;", "// trailing note")), ["comment"]);
    assert.deepEqual(rulesFor(sourceLines("/* leading note */", "const a = 1;")), ["comment"]);
    assert.deepEqual(rulesFor(sourceLines("/** doc note */", "export const a = 1;")), ["comment"]);
    assert.deepEqual(rulesFor(sourceLines("const a = 1;", "// eof note")), ["comment"]);
  });

  it("finds a comment that follows a template literal on the same line", () => {
    assert.deepEqual(rulesFor(sourceLines("const s = `a${b}`; // trailing")), ["comment"]);
    assert.deepEqual(rulesFor(sourceLines("const s = `a${b}c${d}`; // two substitutions")), [
      "comment",
    ]);
    assert.deepEqual(rulesFor(sourceLines("const s = `a${`b${c}`}d`; // nested")), ["comment"]);
  });

  it("finds a comment that follows a template literal type", () => {
    assert.deepEqual(rulesFor(sourceLines("type T = `a${string}`; // one type")), ["comment"]);
    assert.deepEqual(
      rulesFor(sourceLines("type T = `a${string}b${number}`; // two types")),
      ["comment"],
    );
  });

  it("finds comments inside template substitutions", () => {
    assert.deepEqual(rulesFor(sourceLines("const s = `${a /* inner */}`;")), ["comment"]);
    assert.deepEqual(rulesFor(sourceLines("const s = `${a // inner", "}`;")), ["comment"]);
  });

  it("finds comments in token gaps with no child node of their own", () => {
    assert.deepEqual(rulesFor(sourceLines("if /* before paren */ (x) {", "  y();", "}")), [
      "comment",
    ]);
    assert.deepEqual(rulesFor(sourceLines("f(1 /* between args */, 2);")), ["comment"]);
    assert.deepEqual(rulesFor(sourceLines("const a = 1 /* gap */;")), ["comment"]);
  });

  it("ignores comment-like text inside regex literals", () => {
    assert.deepEqual(rulesFor(sourceLines("const re = /[//]/;", "const after = 1;")), []);
    assert.deepEqual(rulesFor(sourceLines("const re = /\\/\\*x/;")), []);
    assert.deepEqual(rulesFor(sourceLines("const r = a / b / c;")), []);
  });

  it("does not let a comment-like regex literal swallow later violations", () => {
    const violations = checkSourceText(
      "sample.ts",
      sourceLines("const re = /[//]/; let v: any = 1;"),
    );
    assert.deepEqual(violations.map((violation) => violation.rule), ["any"]);
  });

  it("ignores comment-like text inside strings, templates and template tails", () => {
    assert.deepEqual(rulesFor(sourceLines('const u = "https://x//y";')), []);
    assert.deepEqual(rulesFor(sourceLines("const s = `http://x//y`;")), []);
    assert.deepEqual(rulesFor(sourceLines("const s = `${a} /* not a comment ${b}`;")), []);
    assert.deepEqual(rulesFor(sourceLines("const s = `a", "${b}", "c // tail`;")), []);
    assert.deepEqual(rulesFor(sourceLines("const s = `${a}${b} // tail", "`;")), []);
  });

  it("reports the real comment text and position beside a masked literal", () => {
    const violations = checkSourceText("sample.ts", sourceLines("const re = /[//]/; // real note"));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.detail, "// real note");
    assert.equal(violations[0]?.column, 20);
  });

  it("classifies suppression directives", () => {
    assert.deepEqual(rulesFor(sourceLines("// @ts-expect-error boundary", "const a = 1;")), [
      "suppression",
    ]);
    assert.deepEqual(rulesFor(sourceLines("/* eslint-disable no-console */")), ["suppression"]);
    assert.deepEqual(rulesFor(sourceLines("// @ts-nocheck")), ["suppression"]);
    assert.deepEqual(rulesFor(sourceLines("// prettier-ignore")), ["suppression"]);
  });

  it("keeps source order when reporting", () => {
    const violations = checkSourceText(
      "sample.ts",
      sourceLines("const a = 1;", "// note", "const b: any = 2;"),
    );
    assert.deepEqual(violations.map((violation) => violation.rule), ["comment", "any"]);
    assert.deepEqual(violations.map((violation) => violation.line), [2, 3]);
  });

  it("does not let a masked string or template hide a later violation", () => {
    const fromString = checkSourceText(
      "sample.ts",
      sourceLines('const s = "// x"; let v: any = 1;'),
    );
    assert.deepEqual(fromString.map((violation) => violation.rule), ["any"]);
    const fromTemplate = checkSourceText(
      "sample.ts",
      sourceLines("const s = `a${b}//x`; let v: any = 1;"),
    );
    assert.deepEqual(fromTemplate.map((violation) => violation.rule), ["any"]);
  });

  it("ignores comment markers inside escaped string text", () => {
    assert.deepEqual(rulesFor(sourceLines('const s = "a\\"// b";')), []);
    assert.deepEqual(rulesFor(sourceLines('const s = "//"; // real')), ["comment"]);
  });

  it("does not classify suppression text written inside a literal", () => {
    assert.deepEqual(rulesFor(sourceLines('const s = "@ts-expect-error";')), []);
    assert.deepEqual(rulesFor(sourceLines("const s = `eslint-disable`;")), []);
  });
});

describe("checkSourceText per-extension parsing", () => {
  it("parses tsx as tsx rather than ts", () => {
    const jsx = sourceLines("const view = <div>hello</div>;");
    assert.deepEqual(checkSourceText("sample.tsx", jsx).map((v) => v.rule), []);
    assert.equal(checkSourceText("sample.ts", jsx).some((v) => v.rule === "assertion"), true);
  });

  it("ignores comment-like text in jsx text", () => {
    assert.deepEqual(checkSourceText("sample.tsx", sourceLines("<div>a // b</div>;")), []);
    assert.deepEqual(checkSourceText("sample.tsx", sourceLines("<div>/* x */</div>;")), []);
    assert.deepEqual(
      checkSourceText("sample.tsx", sourceLines("<div prop={a /* real */} />;")).map(
        (v) => v.rule,
      ),
      ["comment"],
    );
  });

  it("recognises source extensions and rejects unrelated files", () => {
    for (const fileName of [
      "a.ts",
      "a.mts",
      "a.cts",
      "a.tsx",
      "a.jsx",
      "a.js",
      "a.mjs",
      "a.cjs",
      "a.TSX",
    ]) {
      assert.equal(isSourceFile(fileName), true);
    }
    for (const fileName of [
      "a.json",
      "a.md",
      "a.yaml",
      "a.mobileconfig",
      "a.ts.bak",
      "README",
    ]) {
      assert.equal(isSourceFile(fileName), false);
    }
  });
});

describe("checkStrictJson", () => {
  it("accepts strict JSON", () => {
    assert.deepEqual(checkStrictJson('{"compilerOptions":{"strict":true}}'), []);
  });

  it("rejects JSON with comments", () => {
    const violations = checkStrictJson('{\n  // note\n  "strict": true\n}');
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.rule, "json");
  });
});
