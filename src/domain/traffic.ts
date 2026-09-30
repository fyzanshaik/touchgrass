export type TrafficValue = string | number;

export type TrafficExpression =
  | { readonly kind: "or"; readonly children: readonly TrafficExpression[] }
  | { readonly kind: "and"; readonly children: readonly TrafficExpression[] }
  | { readonly kind: "not"; readonly child: TrafficExpression }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly TrafficExpression[] }
  | {
      readonly kind: "compare";
      readonly selector: string;
      readonly operator: string;
      readonly values: readonly TrafficValue[];
    };

interface Token {
  readonly kind: "ident" | "operator" | "string" | "number" | "punctuation";
  readonly value: string;
}

const MAX_TRAFFIC_LENGTH = 4096;
const MAX_NESTING_DEPTH = 128;
const WORD_PATTERN = /[A-Za-z0-9_.]/;
const DIGIT_PATTERN = /[0-9]/;
const TWO_CHARACTER_OPERATORS = new Set(["==", "!=", ">=", "<="]);
const ONE_CHARACTER_PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ",", "*", "<", ">"]);

const tokenize = (input: string): readonly Token[] | undefined => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '"') {
      let cursor = index + 1;
      let value = "";
      let closed = false;
      while (cursor < input.length) {
        const current = input[cursor] ?? "";
        if (current === "\\") {
          const escaped = input[cursor + 1];
          if (escaped === undefined) {
            return undefined;
          }
          value += current + escaped;
          cursor += 2;
          continue;
        }
        if (current === '"') {
          closed = true;
          cursor += 1;
          break;
        }
        value += current;
        cursor += 1;
      }
      if (!closed) {
        return undefined;
      }
      tokens.push({ kind: "string", value });
      index = cursor;
      continue;
    }
    if (DIGIT_PATTERN.test(character)) {
      let cursor = index;
      while (cursor < input.length && /[0-9.]/.test(input[cursor] ?? "")) {
        cursor += 1;
      }
      const value = input.slice(index, cursor);
      if (!/^\d+(?:\.\d+)?$/.test(value)) {
        return undefined;
      }
      tokens.push({ kind: "number", value });
      index = cursor;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let cursor = index;
      while (cursor < input.length && WORD_PATTERN.test(input[cursor] ?? "")) {
        cursor += 1;
      }
      tokens.push({ kind: "ident", value: input.slice(index, cursor) });
      index = cursor;
      continue;
    }
    const twoCharacters = input.slice(index, index + 2);
    if (TWO_CHARACTER_OPERATORS.has(twoCharacters)) {
      tokens.push({ kind: "operator", value: twoCharacters });
      index += 2;
      continue;
    }
    if (ONE_CHARACTER_PUNCTUATION.has(character)) {
      tokens.push({ kind: "punctuation", value: character });
      index += 1;
      continue;
    }
    return undefined;
  }
  return tokens;
};

interface Cursor {
  readonly tokens: readonly Token[];
  position: number;
  depth: number;
}

const peek = (cursor: Cursor): Token | undefined => cursor.tokens[cursor.position];

const tokenIs = (token: Token | undefined, kind: Token["kind"], value: string): boolean =>
  token !== undefined && token.kind === kind && token.value === value;

const advance = (cursor: Cursor): void => {
  cursor.position += 1;
};

const descend = (cursor: Cursor): boolean => {
  cursor.depth += 1;
  if (cursor.depth > MAX_NESTING_DEPTH) {
    cursor.depth -= 1;
    return false;
  }
  return true;
};

const ascend = (cursor: Cursor): void => {
  cursor.depth -= 1;
};

const flatten = (
  kind: "and" | "or",
  children: readonly TrafficExpression[],
): TrafficExpression => {
  const flattened: TrafficExpression[] = [];
  for (const child of children) {
    if (child.kind === kind) {
      flattened.push(...child.children);
    } else {
      flattened.push(child);
    }
  }
  return { kind, children: flattened };
};

const parseValue = (cursor: Cursor): TrafficValue | undefined => {
  const token = peek(cursor);
  if (token === undefined) {
    return undefined;
  }
  if (token.kind === "string") {
    advance(cursor);
    return token.value;
  }
  if (token.kind === "number") {
    advance(cursor);
    const parsed = Number(token.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (token.kind === "ident" && (token.value === "true" || token.value === "false")) {
    advance(cursor);
    return token.value;
  }
  return undefined;
};

const parseValueList = (cursor: Cursor): readonly TrafficValue[] | undefined => {
  if (tokenIs(peek(cursor), "punctuation", "{")) {
    advance(cursor);
    const values: TrafficValue[] = [];
    for (;;) {
      const value = parseValue(cursor);
      if (value === undefined) {
        return undefined;
      }
      values.push(value);
      if (tokenIs(peek(cursor), "punctuation", ",")) {
        advance(cursor);
        continue;
      }
      break;
    }
    if (!tokenIs(peek(cursor), "punctuation", "}")) {
      return undefined;
    }
    advance(cursor);
    return values;
  }
  const single = parseValue(cursor);
  return single === undefined ? undefined : [single];
};

const parseOperator = (cursor: Cursor): string | undefined => {
  const token = peek(cursor);
  if (token === undefined) {
    return undefined;
  }
  if (token.kind === "operator") {
    advance(cursor);
    return token.value;
  }
  if (token.kind === "ident") {
    if (token.value === "in" || token.value === "contains" || token.value === "matches") {
      advance(cursor);
      return token.value;
    }
    if (token.value === "not" && tokenIs(cursor.tokens[cursor.position + 1], "ident", "in")) {
      advance(cursor);
      advance(cursor);
      return "not in";
    }
  }
  return undefined;
};

const parseSelector = (cursor: Cursor): string | undefined => {
  const token = peek(cursor);
  if (token === undefined || token.kind !== "ident") {
    return undefined;
  }
  let selector = token.value;
  advance(cursor);
  for (;;) {
    if (tokenIs(peek(cursor), "punctuation", "[")) {
      const inner = cursor.tokens[cursor.position + 1];
      const closing = cursor.tokens[cursor.position + 2];
      if (
        (inner !== undefined &&
          tokenIs(inner, "punctuation", "*") &&
          tokenIs(closing, "punctuation", "]")) ||
        (inner !== undefined && inner.kind === "number" && tokenIs(closing, "punctuation", "]"))
      ) {
        selector += `[${inner.value}]`;
        advance(cursor);
        advance(cursor);
        advance(cursor);
        continue;
      }
      return undefined;
    }
    return selector;
  }
};

const parseComparison = (cursor: Cursor): TrafficExpression | undefined => {
  const selector = parseSelector(cursor);
  if (selector === undefined) {
    return undefined;
  }
  const operator = parseOperator(cursor);
  if (operator === undefined) {
    return undefined;
  }
  const values = parseValueList(cursor);
  return values === undefined ? undefined : { kind: "compare", selector, operator, values };
};

const parsePrimary = (cursor: Cursor): TrafficExpression | undefined => {
  const token = peek(cursor);
  if (token === undefined) {
    return undefined;
  }
  if (tokenIs(token, "punctuation", "(")) {
    if (!descend(cursor)) {
      return undefined;
    }
    advance(cursor);
    const inner = parseOrExpression(cursor);
    ascend(cursor);
    if (inner === undefined || !tokenIs(peek(cursor), "punctuation", ")")) {
      return undefined;
    }
    advance(cursor);
    return inner;
  }
  if (token.kind === "ident" && tokenIs(cursor.tokens[cursor.position + 1], "punctuation", "(")) {
    const name = token.value;
    if (!descend(cursor)) {
      return undefined;
    }
    advance(cursor);
    advance(cursor);
    const args: TrafficExpression[] = [];
    if (!tokenIs(peek(cursor), "punctuation", ")")) {
      for (;;) {
        const argument = parseOrExpression(cursor);
        if (argument === undefined) {
          ascend(cursor);
          return undefined;
        }
        args.push(argument);
        if (tokenIs(peek(cursor), "punctuation", ",")) {
          advance(cursor);
          continue;
        }
        break;
      }
    }
    if (!tokenIs(peek(cursor), "punctuation", ")")) {
      return undefined;
    }
    ascend(cursor);
    advance(cursor);
    return { kind: "call", name, args };
  }
  return parseComparison(cursor);
};

const parseUnary = (cursor: Cursor): TrafficExpression | undefined => {
  if (tokenIs(peek(cursor), "ident", "not")) {
    if (!descend(cursor)) {
      return undefined;
    }
    advance(cursor);
    const child = parseUnary(cursor);
    ascend(cursor);
    return child === undefined ? undefined : { kind: "not", child };
  }
  return parsePrimary(cursor);
};

const parseAndExpression = (cursor: Cursor): TrafficExpression | undefined => {
  const first = parseUnary(cursor);
  if (first === undefined) {
    return undefined;
  }
  const children: TrafficExpression[] = [first];
  while (tokenIs(peek(cursor), "ident", "and")) {
    advance(cursor);
    const next = parseUnary(cursor);
    if (next === undefined) {
      return undefined;
    }
    children.push(next);
  }
  return children.length === 1 ? first : flatten("and", children);
};

const parseOrExpression = (cursor: Cursor): TrafficExpression | undefined => {
  const first = parseAndExpression(cursor);
  if (first === undefined) {
    return undefined;
  }
  const children: TrafficExpression[] = [first];
  while (tokenIs(peek(cursor), "ident", "or")) {
    advance(cursor);
    const next = parseAndExpression(cursor);
    if (next === undefined) {
      return undefined;
    }
    children.push(next);
  }
  return children.length === 1 ? first : flatten("or", children);
};

export const parseTraffic = (traffic: string): TrafficExpression | undefined => {
  if (traffic.length === 0 || traffic.length > MAX_TRAFFIC_LENGTH) {
    return undefined;
  }
  const tokens = tokenize(traffic);
  if (tokens === undefined || tokens.length === 0) {
    return undefined;
  }
  const cursor: Cursor = { tokens, position: 0, depth: 0 };
  const expression = parseOrExpression(cursor);
  if (expression === undefined || cursor.position !== tokens.length) {
    return undefined;
  }
  return expression;
};

const canonicalValue = (value: TrafficValue): string =>
  typeof value === "number" ? String(value) : JSON.stringify(value);

const canonicalChildren = (children: readonly TrafficExpression[]): string => {
  const rendered = children.map(canonicalExpression);
  return [...new Set(rendered)].sort().join(",");
};

export const canonicalExpression = (expression: TrafficExpression): string => {
  switch (expression.kind) {
    case "or":
      return `or(${canonicalChildren(expression.children)})`;
    case "and":
      return `and(${canonicalChildren(expression.children)})`;
    case "not":
      return `not(${canonicalExpression(expression.child)})`;
    case "call":
      return `${expression.name}(${expression.args.map(canonicalExpression).join(",")})`;
    case "compare":
      return `${expression.selector}${expression.operator}[${[...new Set(expression.values.map(canonicalValue))].sort().join(",")}]`;
  }
};

export const canonicalTraffic = (traffic: string): string | undefined => {
  const expression = parseTraffic(traffic);
  return expression === undefined ? undefined : canonicalExpression(expression);
};

export const trafficEquivalent = (left: string, right: string): boolean => {
  const leftCanonical = canonicalTraffic(left);
  if (leftCanonical === undefined) {
    return false;
  }
  return leftCanonical === canonicalTraffic(right);
};
