import { Data, Duration, Effect, Schema } from "effect";
import type { RuleAction } from "../domain/policy.ts";
import { trafficEquivalent } from "../domain/traffic.ts";
import { MAX_UPSTREAM_BYTES, readBoundedText } from "./http.ts";
import type { DbRow } from "./sql.ts";

export const gatewayErrorCodes = [
  "timeout",
  "rate_limited",
  "unauthorized",
  "forbidden",
  "unavailable",
  "invalid_response",
  "collision",
  "drift",
  "precedence_taken",
] as const;

export type GatewayErrorCode = (typeof gatewayErrorCodes)[number];

export const permanentErrorCodes = [
  "collision",
  "drift",
  "invalid_response",
  "precedence_taken",
] as const;

export const isPermanentErrorCode = (code: string): boolean =>
  permanentErrorCodes.some((entry) => entry === code);

export class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
}> {}

export interface RemoteRule {
  readonly id: string;
  readonly name: string;
  readonly action: RuleAction;
  readonly precedence: number;
  readonly traffic: string;
  readonly enabled: boolean;
}

export interface RuleUpsert {
  readonly logicalName: string;
  readonly action: RuleAction;
  readonly precedence: number;
  readonly traffic: string;
}

export type GatewayFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface GatewayAdapter {
  readonly listOwnedRules: () => Effect.Effect<readonly RemoteRule[], GatewayError>;
  readonly upsertRule: (input: RuleUpsert) => Effect.Effect<RemoteRule, GatewayError>;
  readonly deleteRule: (cloudflareId: string) => Effect.Effect<void, GatewayError>;
}

export const OWNED_RULE_PREFIX = "clearbrowse:";
export const ADAPTER_TIMEOUT_SECONDS = 10;

export const ruleNameFor = (logicalName: string): string => `${OWNED_RULE_PREFIX}${logicalName}`;

export const logicalNameFor = (ruleName: string): string | undefined =>
  ruleName.startsWith(OWNED_RULE_PREFIX) ? ruleName.slice(OWNED_RULE_PREFIX.length) : undefined;

export const remoteRuleCanonical = (logicalName: string, rule: RemoteRule): string =>
  JSON.stringify({
    logicalName,
    action: rule.action,
    precedence: rule.precedence,
    traffic: rule.traffic,
    enabled: rule.enabled,
  });

export type SimulatedFormatter = "whitespace" | "widen";

export const formatGatewayTraffic = (
  traffic: string,
  formatter: SimulatedFormatter,
): string => {
  const compact = traffic.replace(/\s*==\s*/g, "==").replace(/\s{2,}/g, " ");
  return formatter === "widen" ? compact.replace(/\band\b/g, "or") : compact;
};

export const asSimulatedFormatter = (value: string): SimulatedFormatter =>
  value === "widen" ? "widen" : "whitespace";

const gatewayError = (code: GatewayErrorCode): GatewayError =>
  new GatewayError({ code, retryable: !isPermanentErrorCode(code) });

export const asGatewayErrorCode = (value: string): GatewayErrorCode => {
  for (const code of gatewayErrorCodes) {
    if (code === value) {
      return code;
    }
  }
  return "unavailable";
};

const withTimeout = <A>(effect: Effect.Effect<A, GatewayError>): Effect.Effect<A, GatewayError> =>
  effect.pipe(
    Effect.timeout(Duration.seconds(ADAPTER_TIMEOUT_SECONDS)),
    Effect.catchTag("TimeoutException", () => Effect.fail(gatewayError("timeout"))),
  );

const toGatewayError = (cause: unknown): GatewayError =>
  cause instanceof GatewayError ? cause : gatewayError("unavailable");

const attemptSync = <A>(run: () => A): Effect.Effect<A, GatewayError> =>
  Effect.try({ try: run, catch: toGatewayError });

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, GatewayError> =>
  Effect.tryPromise({ try: run, catch: toGatewayError });

const GatewayRule = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  action: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  precedence: Schema.optional(Schema.Number),
  traffic: Schema.optional(Schema.String),
  filters: Schema.optional(Schema.Array(Schema.String)),
  description: Schema.optional(Schema.String),
});

const ApiInfo = Schema.Struct({ code: Schema.Number, message: Schema.String });

const RuleEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: GatewayRule,
  errors: Schema.Array(ApiInfo),
});

const ResultInfo = Schema.Struct({
  page: Schema.Number,
  per_page: Schema.Number,
  count: Schema.Number,
  total_count: Schema.Number,
});

const RuleListEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Array(GatewayRule),
  errors: Schema.Array(ApiInfo),
  result_info: Schema.optional(ResultInfo),
});

const actionOf = (value: string): RuleAction | undefined =>
  value === "block" || value === "allow" ? value : undefined;

const toRemoteRule = (rule: typeof GatewayRule.Type): RemoteRule | undefined => {
  const action = actionOf(rule.action);
  if (action === undefined) {
    return undefined;
  }
  return {
    id: rule.id,
    name: rule.name,
    action,
    precedence: rule.precedence ?? 0,
    traffic: rule.traffic ?? "",
    enabled: rule.enabled ?? true,
  };
};

const decodeJson = async (response: Response): Promise<unknown | undefined> => {
  const body = await readBoundedText(response, MAX_UPSTREAM_BYTES);
  if (!body.ok) {
    return undefined;
  }
  try {
    return JSON.parse(body.text);
  } catch {
    return undefined;
  }
};

const statusError = (status: number): GatewayError => {
  if (status === 401 || status === 403) {
    return gatewayError("unauthorized");
  }
  if (status === 429) {
    return gatewayError("rate_limited");
  }
  if (status === 409) {
    return gatewayError("precedence_taken");
  }
  return gatewayError("unavailable");
};

export interface LiveGatewayInput {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetcher: GatewayFetcher;
  readonly maxPages?: number;
}

const PER_PAGE = 100;

interface OwnedRuleEntry {
  readonly remote: RemoteRule;
  readonly filters: readonly string[];
  readonly description: string | null;
}

interface FetchedRulePage {
  readonly entries: readonly OwnedRuleEntry[];
  readonly rawCount: number;
  readonly totalCount: number | null;
  readonly precedences: readonly number[];
}

interface RuleDiscovery {
  readonly owned: readonly RemoteRule[];
  readonly entries: readonly OwnedRuleEntry[];
  readonly occupied: ReadonlySet<number>;
}

const PARKING_SEARCH_LIMIT = 1000;
const PARKING_FLOOR = 1;

const freeSlotBelow = (occupied: ReadonlySet<number>, from: number): number | undefined => {
  const lowest = Math.max(PARKING_FLOOR, from - PARKING_SEARCH_LIMIT);
  for (let candidate = from - 1; candidate >= lowest; candidate -= 1) {
    if (!occupied.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const freeSlotAbove = (occupied: ReadonlySet<number>, from: number): number | undefined => {
  const highest = Math.min(Number.MAX_SAFE_INTEGER, from + PARKING_SEARCH_LIMIT);
  for (let candidate = from + 1; candidate <= highest; candidate += 1) {
    if (!occupied.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

export const createLiveGateway = (input: LiveGatewayInput): GatewayAdapter => {
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/gateway/rules`;
  const maxPages = input.maxPages ?? 10;

  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${input.apiToken}`,
    "content-type": "application/json",
  });

  const fetchPage = async (page: number): Promise<FetchedRulePage> => {
    const response = await input.fetcher(`${base}?per_page=${String(PER_PAGE)}&page=${String(page)}`, {
      method: "GET",
      headers: headers(),
    });
    if (!response.ok) {
      throw statusError(response.status);
    }
    const parsed = await decodeJson(response);
    const decoded = Schema.decodeUnknownEither(RuleListEnvelope)(parsed);
    if (decoded._tag === "Left" || !decoded.right.success) {
      throw gatewayError("invalid_response");
    }
    const entries: OwnedRuleEntry[] = [];
    const precedences: number[] = [];
    for (const rule of decoded.right.result) {
      const precedence = rule.precedence ?? 0;
      if (!Number.isSafeInteger(precedence) || precedence < 0) {
        throw gatewayError("invalid_response");
      }
      precedences.push(precedence);
      const mapped = toRemoteRule(rule);
      if (mapped === undefined) {
        if (logicalNameFor(rule.name) !== undefined) {
          throw gatewayError("drift");
        }
        continue;
      }
      if (logicalNameFor(mapped.name) !== undefined) {
        entries.push({
          remote: mapped,
          filters: rule.filters ?? ["dns"],
          description: rule.description ?? null,
        });
      }
    }
    const info = decoded.right.result_info;
    return {
      entries,
      rawCount: decoded.right.result.length,
      totalCount: info === undefined ? null : info.total_count,
      precedences,
    };
  };

  const discoverRules = async (): Promise<RuleDiscovery> => {
    const entries: OwnedRuleEntry[] = [];
    const occupied = new Set<number>();
    let page = 1;
    for (;;) {
      const fetched = await fetchPage(page);
      entries.push(...fetched.entries);
      for (const precedence of fetched.precedences) {
        occupied.add(precedence);
      }
      const hasMore =
        fetched.totalCount === null
          ? fetched.rawCount >= PER_PAGE
          : page * PER_PAGE < fetched.totalCount;
      if (!hasMore) {
        return { owned: entries.map((entry) => entry.remote), entries, occupied };
      }
      if (page >= maxPages) {
        throw gatewayError("invalid_response");
      }
      page += 1;
    }
  };

  const moveRule = async (entry: OwnedRuleEntry, precedence: number): Promise<void> => {
    const response = await input.fetcher(`${base}/${entry.remote.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({
        name: entry.remote.name,
        enabled: entry.remote.enabled,
        action: entry.remote.action,
        filters: entry.filters,
        traffic: entry.remote.traffic,
        precedence,
        ...(entry.description === null ? {} : { description: entry.description }),
      }),
    });
    if (!response.ok) {
      throw statusError(response.status);
    }
    const parsed = await decodeJson(response);
    const decoded = Schema.decodeUnknownEither(RuleEnvelope)(parsed);
    if (decoded._tag === "Left" || !decoded.right.success) {
      throw gatewayError("invalid_response");
    }
    const raw = decoded.right.result;
    const moved = toRemoteRule(raw);
    if (
      moved === undefined ||
      moved.id !== entry.remote.id ||
      moved.name !== entry.remote.name ||
      moved.action !== entry.remote.action ||
      moved.enabled !== entry.remote.enabled ||
      moved.precedence !== precedence ||
      !trafficEquivalent(moved.traffic, entry.remote.traffic) ||
      (raw.filters ?? ["dns"]).join(" ") !== entry.filters.join(" ")
    ) {
      throw gatewayError("invalid_response");
    }
  };

  return {
    listOwnedRules: () => withTimeout(attempt(async () => (await discoverRules()).owned)),
    upsertRule: (upsert) =>
      withTimeout(
        attempt(async () => {
          const name = ruleNameFor(upsert.logicalName);
          const discovery = await discoverRules();
          const found = discovery.entries.find((entry) => entry.remote.name === name);
          const occupant = discovery.entries.find(
            (entry) => entry.remote.precedence === upsert.precedence && entry.remote.name !== name,
          );
          if (occupant !== undefined) {
            const slot =
              occupant.remote.action === "block"
                ? freeSlotBelow(discovery.occupied, occupant.remote.precedence)
                : freeSlotAbove(discovery.occupied, occupant.remote.precedence);
            if (slot === undefined) {
              throw gatewayError("precedence_taken");
            }
            await moveRule(occupant, slot);
          }
          const body = JSON.stringify({
            name,
            enabled: true,
            action: upsert.action,
            filters: ["dns"],
            traffic: upsert.traffic,
            precedence: upsert.precedence,
            description: "Managed by ClearBrowse. Changes are overwritten by the reconciler.",
          });
          const response =
            found === undefined
              ? await input.fetcher(base, { method: "POST", headers: headers(), body })
              : await input.fetcher(`${base}/${found.remote.id}`, {
                  method: "PUT",
                  headers: headers(),
                  body,
                });
          if (!response.ok) {
            throw statusError(response.status);
          }
          const parsed = await decodeJson(response);
          const decoded = Schema.decodeUnknownEither(RuleEnvelope)(parsed);
          if (decoded._tag === "Left" || !decoded.right.success) {
            throw gatewayError("invalid_response");
          }
          const mapped = toRemoteRule(decoded.right.result);
          if (mapped === undefined || mapped.name !== name) {
            throw gatewayError("drift");
          }
          return mapped;
        }),
      ),
    deleteRule: (cloudflareId) =>
      withTimeout(
        attempt(async () => {
          const response = await input.fetcher(`${base}/${cloudflareId}`, {
            method: "DELETE",
            headers: headers(),
          });
          if (!response.ok && response.status !== 404) {
            throw statusError(response.status);
          }
        }),
      ),
  };
};

interface SimulatedFaultRow {
  readonly id: number;
  readonly timing: string;
  readonly error: string;
  readonly remaining: number;
}

interface SimulatedRuleRow {
  readonly id: string;
  readonly name: string;
  readonly action: string;
  readonly precedence: number;
  readonly traffic: string;
  readonly enabled: number;
}

interface SimulatedOccupantRow {
  readonly id: string;
  readonly name: string;
  readonly action: string;
  readonly precedence: number;
}

export interface SimulatedGatewayInput {
  readonly sql: SqlStorage;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const createSimulatedGateway = (input: SimulatedGatewayInput): GatewayAdapter => {
  const { sql } = input;

  const consumeFault = (
    operation: string,
  ): { timing: "before" | "after" | "ignore"; code: GatewayErrorCode } | undefined => {
    const row = sql
      .exec<DbRow<SimulatedFaultRow>>(
        "SELECT id, timing, error, remaining FROM gateway_simulated_faults WHERE operation = ? AND remaining > 0 ORDER BY id ASC LIMIT 1",
        operation,
      )
      .toArray()[0];
    if (row === undefined) {
      return undefined;
    }
    if (row.remaining <= 1) {
      sql.exec("DELETE FROM gateway_simulated_faults WHERE id = ?", row.id);
    } else {
      sql.exec(
        "UPDATE gateway_simulated_faults SET remaining = remaining - 1 WHERE id = ?",
        row.id,
      );
    }
    const timing = row.timing === "after" ? "after" : row.timing === "ignore" ? "ignore" : "before";
    return { timing, code: asGatewayErrorCode(row.error) };
  };

  const setting = (key: string): string | undefined =>
    sql
      .exec<DbRow<{ value: string }>>(
        "SELECT value FROM gateway_simulated_settings WHERE key = ?",
        key,
      )
      .toArray()[0]?.value;

  const latencyMilliseconds = (): number => {
    const parsed = Number.parseInt(setting("latency") ?? "", 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  };

  const formatter = (): SimulatedFormatter => asSimulatedFormatter(setting("formatter") ?? "");

  const readAll = (): readonly RemoteRule[] => {
    const rows = sql
      .exec<DbRow<SimulatedRuleRow>>(
        "SELECT id, name, action, precedence, traffic, enabled FROM gateway_simulated_rules ORDER BY precedence ASC, name ASC",
      )
      .toArray();
    const rules: RemoteRule[] = [];
    for (const row of rows) {
      const action = actionOf(row.action);
      if (action === undefined) {
        continue;
      }
      rules.push({
        id: row.id,
        name: row.name,
        action,
        precedence: row.precedence,
        traffic: row.traffic,
        enabled: row.enabled === 1,
      });
    }
    return rules;
  };

  return {
    listOwnedRules: () =>
      withTimeout(
        attemptSync(() => {
          const fault = consumeFault("list");
          if (fault !== undefined && fault.timing === "before") {
            throw gatewayError(fault.code);
          }
          const rules = readAll().filter((rule) => logicalNameFor(rule.name) !== undefined);
          if (fault !== undefined && fault.timing !== "ignore") {
            throw gatewayError(fault.code);
          }
          return rules;
        }),
      ),
    upsertRule: (upsert) =>
      withTimeout(
        attempt(async () => {
          const delay = latencyMilliseconds();
          if (delay > 0) {
            await sleep(delay);
          }
          const fault = consumeFault("upsert");
          if (fault !== undefined && fault.timing === "before") {
            throw gatewayError(fault.code);
          }
          const name = ruleNameFor(upsert.logicalName);
          const id = `sim-${upsert.logicalName}`;
          const formatted = formatGatewayTraffic(upsert.traffic, formatter());
          if (fault !== undefined && fault.timing === "ignore") {
            return {
              id,
              name,
              action: upsert.action,
              precedence: upsert.precedence,
              traffic: formatted,
              enabled: true,
            };
          }
          const occupant = sql
            .exec<DbRow<SimulatedOccupantRow>>(
              "SELECT id, name, action, precedence FROM gateway_simulated_rules WHERE precedence = ? AND name <> ? ORDER BY id ASC LIMIT 1",
              upsert.precedence,
              name,
            )
            .toArray()[0];
          if (occupant !== undefined) {
            const action =
              logicalNameFor(occupant.name) === undefined ? undefined : actionOf(occupant.action);
            if (action === undefined) {
              throw gatewayError("precedence_taken");
            }
            const occupied = new Set(
              sql
                .exec<DbRow<{ precedence: number }>>(
                  "SELECT precedence FROM gateway_simulated_rules",
                )
                .toArray()
                .map((row) => row.precedence),
            );
            const slot =
              action === "block"
                ? freeSlotBelow(occupied, occupant.precedence)
                : freeSlotAbove(occupied, occupant.precedence);
            if (slot === undefined) {
              throw gatewayError("precedence_taken");
            }
            sql.exec(
              "UPDATE gateway_simulated_rules SET precedence = ? WHERE id = ?",
              slot,
              occupant.id,
            );
          }
          const rows = sql
            .exec<DbRow<SimulatedRuleRow>>(
              "INSERT INTO gateway_simulated_rules (id, name, action, precedence, traffic, enabled) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(name) DO UPDATE SET action = excluded.action, precedence = excluded.precedence, traffic = excluded.traffic, enabled = 1 RETURNING id, name, action, precedence, traffic, enabled",
              id,
              name,
              upsert.action,
              upsert.precedence,
              formatted,
            )
            .toArray();
          const row = rows[0];
          const action = row === undefined ? undefined : actionOf(row.action);
          if (row === undefined || action === undefined) {
            throw gatewayError("invalid_response");
          }
          const rule: RemoteRule = {
            id: row.id,
            name: row.name,
            action,
            precedence: row.precedence,
            traffic: row.traffic,
            enabled: row.enabled === 1,
          };
          if (fault !== undefined && fault.timing !== "ignore") {
            throw gatewayError(fault.code);
          }
          return rule;
        }),
      ),
    deleteRule: (cloudflareId) =>
      withTimeout(
        attemptSync(() => {
          const fault = consumeFault("delete");
          if (fault !== undefined && fault.timing === "before") {
            throw gatewayError(fault.code);
          }
          if (fault === undefined || fault.timing !== "ignore") {
            sql.exec("DELETE FROM gateway_simulated_rules WHERE id = ?", cloudflareId);
          }
          if (fault !== undefined && fault.timing === "after") {
            throw gatewayError(fault.code);
          }
        }),
      ),
  };
};
