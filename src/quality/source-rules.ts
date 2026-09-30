import path from "node:path";
import ts from "typescript";

export interface SourceRuleViolation {
  readonly rule: string;
  readonly detail: string;
  readonly line: number;
  readonly column: number;
}

const SCRIPT_KIND_BY_EXTENSION = new Map<string, ts.ScriptKind>([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".jsx", ts.ScriptKind.JSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
]);

const COMMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);

const SUPPRESSION_PATTERN =
  /@ts-(?:ignore|expect-error|nocheck|check)|eslint-disable|prettier-ignore/;

const extensionOf = (fileName: string): string => path.extname(fileName).toLowerCase();

export const isSourceFile = (fileName: string): boolean =>
  SCRIPT_KIND_BY_EXTENSION.has(extensionOf(fileName));

const scriptKindFor = (fileName: string): ts.ScriptKind =>
  SCRIPT_KIND_BY_EXTENSION.get(extensionOf(fileName)) ?? ts.ScriptKind.TS;

const isContextDependentToken = (node: ts.Node): boolean =>
  ts.isRegularExpressionLiteral(node) ||
  ts.isTemplateMiddleOrTemplateTail(node) ||
  ts.isJsxText(node);

const maskContextDependentTokens = (sourceFile: ts.SourceFile, text: string): string => {
  const characters = text.split("");
  const mask = (node: ts.Node): void => {
    if (isContextDependentToken(node)) {
      for (let index = node.getStart(sourceFile); index < node.getEnd(); index += 1) {
        if (characters[index] !== "\n") {
          characters[index] = " ";
        }
      }
    }
    ts.forEachChild(node, mask);
  };
  mask(sourceFile);
  return characters.join("");
};

const isConstAssertion = (node: ts.AsExpression): boolean =>
  ts.isTypeReferenceNode(node.type) &&
  ts.isIdentifier(node.type.typeName) &&
  node.type.typeName.text === "const";

export const checkSourceText = (
  filePath: string,
  text: string,
): readonly SourceRuleViolation[] => {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const violations: SourceRuleViolation[] = [];
  const report = (rule: string, detail: string, position: number): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
    violations.push({
      rule,
      detail,
      line: line + 1,
      column: character + 1,
    });
  };

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    maskContextDependentTokens(sourceFile, text),
  );
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    if (!COMMENT_KINDS.has(kind)) {
      continue;
    }
    const start = scanner.getTokenPos();
    const commentText = text.slice(start, scanner.getTextPos()).trim().slice(0, 80);
    report(
      SUPPRESSION_PATTERN.test(commentText) ? "suppression" : "comment",
      commentText,
      start,
    );
  }

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      report("any", "any type annotation", node.getStart(sourceFile));
    }
    if (ts.isAsExpression(node) && !isConstAssertion(node)) {
      report("assertion", "as type assertion", node.getStart(sourceFile));
    }
    if (ts.isTypeAssertionExpression(node)) {
      report("assertion", "angle-bracket type assertion", node.getStart(sourceFile));
    }
    if (ts.isNonNullExpression(node)) {
      report("non-null-assertion", "non-null assertion", node.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

export const checkStrictJson = (text: string): readonly SourceRuleViolation[] => {
  try {
    JSON.parse(text);
    return [];
  } catch (cause) {
    return [
      {
        rule: "json",
        detail:
          cause instanceof Error
            ? `not strict JSON: ${cause.message}`
            : "not strict JSON",
        line: 1,
        column: 1,
      },
    ];
  }
};
