import { Brand, ParseResult, Schema } from "effect";
import { parse as parseDomain } from "tldts";

const MAX_INPUT_LENGTH = 2048;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

const ASCII_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NON_ASCII = /[^\x00-\x7f]/;
const URL_PATH_CHARACTER = /[/\\?#]/;
const SUPPORTED_SCHEMES = new Set(["http:", "https:"]);

export const hostnameRejectionReasons = [
  "empty",
  "too_long",
  "wildcard",
  "url_path",
  "port",
  "credentials",
  "unsupported_scheme",
  "ip_literal",
  "invalid_label",
  "not_registrable",
] as const;

export const HostnameRejectionReason = Schema.Literal(
  "empty",
  "too_long",
  "wildcard",
  "url_path",
  "port",
  "credentials",
  "unsupported_scheme",
  "ip_literal",
  "invalid_label",
  "not_registrable",
);

export type HostnameRejectionReason = typeof HostnameRejectionReason.Type;

const RuleHostnameBranded = Schema.String.pipe(Schema.brand("RuleHostname"));

export type RuleHostname = typeof RuleHostnameBranded.Type;

const asRuleHostname = Brand.nominal<RuleHostname>();

export type HostnameNormalization =
  | { readonly ok: true; readonly hostname: RuleHostname; readonly source: "hostname" | "url" }
  | { readonly ok: false; readonly reason: HostnameRejectionReason };

export const hostnameMessage =
  "Provide a hostname or http(s) URL for one registrable domain. Wildcards, credentials, ports, paths, IP literals and public or private suffixes (for example github.io or co.uk) are not accepted.";

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const reject = (reason: HostnameRejectionReason): HostnameNormalization => ({
  ok: false,
  reason,
});

const validLabels = (hostname: string): boolean =>
  hostname
    .split(".")
    .every(
      (label) => label.length > 0 && label.length <= MAX_LABEL_LENGTH && ASCII_LABEL.test(label),
    );

const isIpLiteral = (hostname: string): boolean =>
  parseDomain(hostname, { allowPrivateDomains: false }).isIp === true;

const isRegistrable = (hostname: string): boolean => {
  const parsed = parseDomain(hostname, { allowPrivateDomains: true });
  if (parsed.isIp === true) {
    return false;
  }
  if (parsed.domain === null || parsed.publicSuffix === null) {
    return false;
  }
  return parsed.publicSuffix !== hostname;
};

const toAscii = (hostname: string): string | undefined => {
  if (!NON_ASCII.test(hostname)) {
    return hostname;
  }
  const parsed = parseUrl(`http://${hostname}`);
  return parsed === undefined ? undefined : parsed.hostname;
};

const stripTrailingDot = (hostname: string): string =>
  hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;

const extractHost = (
  input: string,
):
  | { readonly ok: true; readonly hostname: string; readonly source: "hostname" | "url" }
  | { readonly ok: false; readonly reason: HostnameRejectionReason } => {
  const parsed = parseUrl(input);
  if (parsed !== undefined) {
    if (!SUPPORTED_SCHEMES.has(parsed.protocol)) {
      return reject("unsupported_scheme");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return reject("credentials");
    }
    if (parsed.port !== "") {
      return reject("port");
    }
    if (parsed.hostname.includes("[") || parsed.hostname.includes("]")) {
      return reject("ip_literal");
    }
    if (parsed.hostname === "") {
      return reject("empty");
    }
    return { ok: true, hostname: parsed.hostname, source: "url" };
  }
  if (URL_PATH_CHARACTER.test(input)) {
    return reject("url_path");
  }
  if (input.includes("@")) {
    return reject("credentials");
  }
  if (input.includes(":")) {
    return reject("port");
  }
  if (input.includes("[") || input.includes("]")) {
    return reject("ip_literal");
  }
  if (/\s/.test(input)) {
    return reject("invalid_label");
  }
  return { ok: true, hostname: input, source: "hostname" };
};

const HOST_WITH_PORT = /^[a-z0-9.-]+:\d+$/i;

export const normalizeHostnameInput = (input: unknown): HostnameNormalization => {
  if (typeof input !== "string") {
    return reject("empty");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return reject("empty");
  }
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return reject("too_long");
  }
  if (trimmed.includes("*")) {
    return reject("wildcard");
  }
  if (HOST_WITH_PORT.test(trimmed)) {
    return reject("port");
  }
  const extracted = extractHost(trimmed);
  if (!extracted.ok) {
    return extracted;
  }
  const ascii = toAscii(stripTrailingDot(extracted.hostname).toLowerCase());
  if (ascii === undefined) {
    return reject("invalid_label");
  }
  const hostname = stripTrailingDot(ascii);
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return reject("too_long");
  }
  if (!validLabels(hostname)) {
    return reject("invalid_label");
  }
  if (isIpLiteral(hostname)) {
    return reject("ip_literal");
  }
  if (!isRegistrable(hostname)) {
    return reject("not_registrable");
  }
  return { ok: true, hostname: asRuleHostname(hostname), source: extracted.source };
};

export const RuleHostname = Schema.transformOrFail(
  Schema.String,
  RuleHostnameBranded,
  {
    strict: true,
    decode: (value, _options, ast) => {
      const normalized = normalizeHostnameInput(value);
      if (!normalized.ok) {
        return ParseResult.fail(
          new ParseResult.Type(ast, value, `${hostnameMessage} (${normalized.reason})`),
        );
      }
      return ParseResult.succeed(normalized.hostname);
    },
    encode: (value) => ParseResult.succeed(value),
  },
);
