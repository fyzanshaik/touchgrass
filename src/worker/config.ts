import { Schema } from "effect";
import { GatewayEndpoint } from "../dns-profile/endpoint.ts";

const Lenient = Schema.optionalWith(Schema.String, { default: () => "" });

const RawConfig = Schema.Struct({
  ENVIRONMENT: Lenient,
  GATEWAY_MODE: Lenient,
  GATEWAY_PRECEDENCE_BASE: Lenient,
  GATEWAY_DOH_ENDPOINT: Lenient,
  CLOUDFLARE_ACCOUNT_ID: Lenient,
  CLOUDFLARE_API_TOKEN: Lenient,
  ACCESS_TEAM_DOMAIN: Lenient,
  ACCESS_AUD: Lenient,
  OWNER_EMAIL: Lenient,
  LOCAL_AUTH_ENABLED: Lenient,
  LOCAL_AUTH_EMAIL: Lenient,
});

export interface AppConfig {
  readonly environment: "production" | "local";
  readonly gatewayMode: "live" | "simulated";
  readonly precedenceBase: number;
  readonly dnsEndpoint: GatewayEndpoint;
  readonly locationSubdomain: string;
  readonly accountId: string;
  readonly apiToken: string;
  readonly accessTeamDomain: string;
  readonly accessAudience: string;
  readonly ownerEmail: string;
  readonly localAuthEmail: string;
}

export interface ConfigRejection {
  readonly missing: readonly string[];
  readonly detail: string;
}

export type ConfigDecoding =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly rejection: ConfigRejection };

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const isLoopbackIpv4 = (hostname: string): boolean => {
  if (!IPV4_LOOPBACK.test(hostname)) {
    return false;
  }
  return hostname
    .split(".")
    .every((part) => {
      const octet = Number(part);
      return Number.isInteger(octet) && octet >= 0 && octet <= 255;
    });
};

export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  isLoopbackIpv4(hostname);

const isBlank = (value: string): boolean => value.trim().length === 0;

const parsePrecedenceBase = (value: string): number | undefined => {
  if (!/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const deriveSubdomain = (endpoint: GatewayEndpoint): string | undefined => {
  const hostname = new URL(endpoint).hostname;
  const label = hostname.slice(0, hostname.indexOf("."));
  return label.length > 0 ? label : undefined;
};

const reject = (missing: readonly string[]): ConfigDecoding => ({
  ok: false,
  rejection: { missing, detail: "The deployment configuration is incomplete." },
});

export const decodeConfig = (source: unknown): ConfigDecoding => {
  const decoded = Schema.decodeUnknownEither(RawConfig)(source);
  if (decoded._tag === "Left") {
    return {
      ok: false,
      rejection: { missing: [], detail: "The deployment configuration is unreadable." },
    };
  }
  const raw = decoded.right;
  const missing: string[] = [];

  const environment = raw.ENVIRONMENT.trim();
  if (environment !== "production" && environment !== "local") {
    return reject(["ENVIRONMENT"]);
  }
  const gatewayMode = raw.GATEWAY_MODE.trim();
  if (gatewayMode !== "live" && gatewayMode !== "simulated") {
    missing.push("GATEWAY_MODE");
  }
  if (raw.LOCAL_AUTH_ENABLED.trim() !== "true" && raw.LOCAL_AUTH_ENABLED.trim() !== "false") {
    missing.push("LOCAL_AUTH_ENABLED");
  }

  if (environment === "production") {
    if (gatewayMode !== "live") {
      missing.push("GATEWAY_MODE");
    }
    if (raw.LOCAL_AUTH_ENABLED.trim() !== "false") {
      missing.push("LOCAL_AUTH_ENABLED");
    }
    if (isBlank(raw.ACCESS_TEAM_DOMAIN)) {
      missing.push("ACCESS_TEAM_DOMAIN");
    }
    if (isBlank(raw.ACCESS_AUD)) {
      missing.push("ACCESS_AUD");
    }
    if (isBlank(raw.OWNER_EMAIL)) {
      missing.push("OWNER_EMAIL");
    }
  } else {
    if (raw.LOCAL_AUTH_ENABLED.trim() !== "true") {
      missing.push("LOCAL_AUTH_ENABLED");
    }
    if (isBlank(raw.LOCAL_AUTH_EMAIL)) {
      missing.push("LOCAL_AUTH_EMAIL");
    }
  }

  if (gatewayMode === "live") {
    if (isBlank(raw.CLOUDFLARE_ACCOUNT_ID)) {
      missing.push("CLOUDFLARE_ACCOUNT_ID");
    }
    if (isBlank(raw.CLOUDFLARE_API_TOKEN)) {
      missing.push("CLOUDFLARE_API_TOKEN");
    }
  }

  const precedenceBase = parsePrecedenceBase(raw.GATEWAY_PRECEDENCE_BASE);
  if (precedenceBase === undefined) {
    missing.push("GATEWAY_PRECEDENCE_BASE");
  }

  const endpoint = Schema.decodeUnknownEither(GatewayEndpoint)(raw.GATEWAY_DOH_ENDPOINT);
  if (endpoint._tag === "Left") {
    missing.push("GATEWAY_DOH_ENDPOINT");
  }

  const distinct = [...new Set(missing)];
  if (distinct.length > 0) {
    return reject(distinct);
  }

  const dnsEndpoint = endpoint._tag === "Right" ? endpoint.right : undefined;
  const subdomain = dnsEndpoint === undefined ? undefined : deriveSubdomain(dnsEndpoint);
  if (dnsEndpoint === undefined || subdomain === undefined || precedenceBase === undefined) {
    return reject(distinct);
  }

  return {
    ok: true,
    config: {
      environment,
      gatewayMode: gatewayMode === "live" ? "live" : "simulated",
      precedenceBase,
      dnsEndpoint,
      locationSubdomain: subdomain,
      accountId: raw.CLOUDFLARE_ACCOUNT_ID.trim(),
      apiToken: raw.CLOUDFLARE_API_TOKEN.trim(),
      accessTeamDomain: raw.ACCESS_TEAM_DOMAIN.trim().replace(/\/+$/, ""),
      accessAudience: raw.ACCESS_AUD.trim(),
      ownerEmail: raw.OWNER_EMAIL.trim().toLowerCase(),
      localAuthEmail: raw.LOCAL_AUTH_EMAIL.trim().toLowerCase(),
    },
  };
};
