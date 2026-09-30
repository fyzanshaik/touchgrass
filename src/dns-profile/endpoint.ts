import { ParseResult, Schema } from "effect";

const GATEWAY_HOST_SUFFIX = ".cloudflare-gateway.com";
const GATEWAY_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DNS_QUERY_PATH = "/dns-query";
const PROFILE_EXTENSION = ".mobileconfig";

export const endpointMessage =
  "Provide a valid Gateway DoH URL of the form https://<location>.cloudflare-gateway.com/dns-query, without credentials, query, fragment, or a custom port.";

export const outputPathMessage = "Output must end in .mobileconfig.";

const isGatewayHostname = (hostname: string): boolean => {
  if (!hostname.endsWith(GATEWAY_HOST_SUFFIX)) {
    return false;
  }
  return GATEWAY_HOST_LABEL.test(hostname.slice(0, -GATEWAY_HOST_SUFFIX.length));
};

const hasGatewayEndpointShape = (parsed: URL): boolean =>
  parsed.protocol === "https:" &&
  isGatewayHostname(parsed.hostname) &&
  parsed.pathname === DNS_QUERY_PATH &&
  parsed.username === "" &&
  parsed.password === "" &&
  parsed.port === "" &&
  parsed.search === "" &&
  parsed.hash === "";

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

export const GatewayEndpoint = Schema.transformOrFail(
  Schema.String,
  Schema.String.pipe(Schema.brand("GatewayEndpoint")),
  {
    strict: true,
    decode: (value, _options, ast) => {
      const parsed = parseUrl(value);
      if (parsed === undefined || !hasGatewayEndpointShape(parsed)) {
        return ParseResult.fail(new ParseResult.Type(ast, value, endpointMessage));
      }
      return ParseResult.succeed(parsed.href);
    },
    encode: (value) => ParseResult.succeed(value),
  },
);

export type GatewayEndpoint = typeof GatewayEndpoint.Type;

export const OutputPath = Schema.String.pipe(
  Schema.endsWith(PROFILE_EXTENSION, { message: () => outputPathMessage }),
  Schema.brand("OutputPath"),
);

export type OutputPath = typeof OutputPath.Type;
