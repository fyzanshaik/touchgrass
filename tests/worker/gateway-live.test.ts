import { describe, expect, it } from "vitest";
import { createLiveGateway, type GatewayFetcher, type RemoteRule } from "../../src/worker/gateway.ts";
import { Effect, Either, Schema } from "effect";

const ACCOUNT = "account-id";
const TOKEN = "super-secret-token-value";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  readonly authorization: string | null;
}

interface ApiRule {
  readonly id: string;
  readonly name: string;
  readonly action: string;
  readonly enabled: boolean;
  readonly precedence: number;
  readonly traffic: string;
}

const apiRule = (input: {
  readonly id: string;
  readonly name: string;
  readonly action?: string;
  readonly precedence?: number;
  readonly traffic?: string;
  readonly enabled?: boolean;
}): ApiRule => ({
  id: input.id,
  name: input.name,
  action: input.action ?? "block",
  enabled: input.enabled ?? true,
  precedence: input.precedence ?? 1000,
  traffic: input.traffic ?? 'dns.fqdn=="example.org"',
});

const ownedRule = apiRule({
  id: "rule-owned",
  name: "clearbrowse:block-domain#0",
  traffic: 'dns.doh_subdomain=="clearbrowse-test" and dns.fqdn=="blocked.example.org"',
});

const buildFetcher = (input: {
  readonly firstPage: readonly ApiRule[];
  readonly secondPage: readonly ApiRule[];
  readonly totalCount: number | null;
}): { readonly fetcher: GatewayFetcher; readonly requests: readonly RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  const fetcher: GatewayFetcher = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({
      method,
      url,
      body: typeof init.body === "string" ? init.body : null,
      authorization: new Headers(init.headers).get("authorization"),
    });
    const parsed = new URL(url);
    if (method === "GET") {
      const page = Number.parseInt(parsed.searchParams.get("page") ?? "1", 10);
      const result = page === 1 ? input.firstPage : input.secondPage;
      return Response.json({
        success: true,
        errors: [],
        result,
        ...(input.totalCount === null
          ? {}
          : {
              result_info: {
                page,
                per_page: 100,
                count: result.length,
                total_count: input.totalCount,
              },
            }),
      });
    }
    const posted: Record<string, unknown> =
      typeof init.body === "string" ? JSON.parse(init.body) : {};
    const name = typeof posted["name"] === "string" ? posted["name"] : ownedRule.name;
    const id = method === "POST" ? "rule-created" : "rule-owned";
    return Response.json({
      success: true,
      errors: [],
      result: { ...ownedRule, id, name },
    });
  };
  return { fetcher, requests };
};

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.either(effect));

describe("live Gateway adapter discovery", () => {
  it("discovers an owned rule that appears after a full page of unrelated rules", async () => {
    const unrelated = Array.from({ length: 100 }, (_unused, index) =>
      apiRule({ id: `other-${String(index)}`, name: `Unrelated ${String(index)}` }),
    );
    const { fetcher } = buildFetcher({
      firstPage: unrelated,
      secondPage: [ownedRule],
      totalCount: 101,
    });
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(adapter.listOwnedRules());
    if (Either.isLeft(result)) {
      throw new Error("expected owned rules");
    }
    expect(result.right.length).toBe(1);
    expect(result.right[0]?.name).toBe("clearbrowse:block-domain#0");
  });

  it("updates by id instead of creating a duplicate for a rule on a later page", async () => {
    const unrelated = Array.from({ length: 100 }, (_unused, index) =>
      apiRule({ id: `other-${String(index)}`, name: `Unrelated ${String(index)}` }),
    );
    const { fetcher, requests } = buildFetcher({
      firstPage: unrelated,
      secondPage: [ownedRule],
      totalCount: 101,
    });
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: 1000,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and dns.fqdn == "blocked.example.org"',
      }),
    );
    expect(Either.isRight(result)).toBe(true);
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes.length).toBe(1);
    expect(writes[0]?.method).toBe("PUT");
    expect(writes[0]?.url.endsWith("/rule-owned")).toBe(true);
  });

  it("creates once when no owned rule exists", async () => {
    const { fetcher, requests } = buildFetcher({ firstPage: [], secondPage: [], totalCount: 0 });
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "category#0",
        action: "block",
        precedence: 1000,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.content_category[*] in {133})',
      }),
    );
    expect(Either.isRight(result)).toBe(true);
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes.length).toBe(1);
    expect(writes[0]?.method).toBe("POST");
  });

  it("stops paging when the reported total is reached", async () => {
    const { fetcher, requests } = buildFetcher({
      firstPage: Array.from({ length: 100 }, (_unused, index) =>
        apiRule({ id: `other-${String(index)}`, name: `Unrelated ${String(index)}` }),
      ),
      secondPage: [],
      totalCount: 100,
    });
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(adapter.listOwnedRules());
    expect(Either.isRight(result)).toBe(true);
    expect(requests.length).toBe(1);
  });

  it("reports an unauthenticated upstream as a retryable error without leaking the token", async () => {
    const fetcher: GatewayFetcher = async () =>
      Response.json(
        { success: false, errors: [{ code: 1000, message: `token ${TOKEN} rejected` }], result: null },
        { status: 403 },
      );
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(adapter.listOwnedRules());
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const rendered = JSON.stringify(result.left);
      expect(rendered.includes(TOKEN)).toBe(false);
      expect(rendered.includes("token")).toBe(false);
    }
  });

  it("reports a malformed upstream payload as a permanent failure", async () => {
    const fetcher: GatewayFetcher = async () => Response.json({ surprise: true });
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(adapter.listOwnedRules());
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("invalid_response");
      expect(result.left.retryable).toBe(false);
    }
  });

  it("maps upstream status codes to bounded error codes", async () => {
    const cases: readonly { readonly status: number; readonly code: string }[] = [
      { status: 429, code: "rate_limited" },
      { status: 401, code: "unauthorized" },
      { status: 500, code: "unavailable" },
    ];
    for (const entry of cases) {
      const fetcher: GatewayFetcher = async () => new Response("upstream failure", { status: entry.status });
      const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
      const result = await run(adapter.listOwnedRules());
      if (Either.isRight(result)) {
        throw new Error("expected a failure");
      }
      expect(result.left.code).toBe(entry.code);
      expect(JSON.stringify(result.left).includes(TOKEN)).toBe(false);
    }
  });

  it("flags an owned rule with an unexpected action as drift", async () => {
    const { fetcher } = buildFetcher({
      firstPage: [apiRule({ id: "rule-odd", name: "clearbrowse:weird#0", action: "override" })],
      secondPage: [],
      totalCount: 1,
    });
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(adapter.listOwnedRules());
    if (Either.isRight(result)) {
      throw new Error("expected drift");
    }
    expect(result.left.code).toBe("drift");
    expect(result.left.retryable).toBe(false);
  });

  it("fails closed rather than acting on a truncated rule inventory", async () => {
    const page = Array.from({ length: 100 }, (_unused, index) =>
      apiRule({ id: `other-${String(index)}`, name: `Unrelated ${String(index)}` }),
    );
    const { fetcher, requests } = buildFetcher({
      firstPage: page,
      secondPage: [],
      totalCount: 500,
    });
    const adapter = createLiveGateway({
      accountId: ACCOUNT,
      apiToken: TOKEN,
      fetcher,
      maxPages: 1,
    });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: 1000,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("invalid_response");
      expect(result.left.retryable).toBe(false);
    }
    expect(requests.filter((request) => request.method !== "GET").length).toBe(0);
  });
});

interface StoredRule {
  id: string;
  name: string;
  action: string;
  enabled: boolean;
  precedence: number;
  traffic: string;
  filters: readonly string[];
  description: string;
}

const PostedRule = Schema.Struct({
  name: Schema.String,
  action: Schema.String,
  enabled: Schema.Boolean,
  precedence: Schema.Number,
  traffic: Schema.String,
  filters: Schema.Array(Schema.String),
  description: Schema.optional(Schema.String),
});

const decodePosted = Schema.decodeUnknownSync(PostedRule);

const buildStatefulFetcher = (
  initial: readonly StoredRule[],
  options: { readonly failRelocation?: boolean } = {},
): {
  readonly fetcher: GatewayFetcher;
  readonly requests: readonly RecordedRequest[];
  readonly store: StoredRule[];
} => {
  const store: StoredRule[] = initial.map((rule) => ({ ...rule }));
  const requests: RecordedRequest[] = [];
  let created = 0;
  const fetcher: GatewayFetcher = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({
      method,
      url,
      body: typeof init.body === "string" ? init.body : null,
      authorization: new Headers(init.headers).get("authorization"),
    });
    if (method === "GET") {
      return Response.json({
        success: true,
        errors: [],
        result: store,
        result_info: { page: 1, per_page: 100, count: store.length, total_count: store.length },
      });
    }
    const posted = decodePosted(typeof init.body === "string" ? JSON.parse(init.body) : {});
    const conflict = store.find(
      (rule) => rule.precedence === posted.precedence && rule.name !== posted.name,
    );
    if (conflict !== undefined) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 2011, message: "A rule with this precedence already exists." }],
          result: null,
        },
        { status: 409 },
      );
    }
    if (method === "POST") {
      created += 1;
      const rule: StoredRule = {
        id: `created-${String(created)}`,
        name: posted.name,
        action: posted.action,
        enabled: posted.enabled,
        precedence: posted.precedence,
        traffic: posted.traffic,
        filters: posted.filters,
        description: posted.description ?? "",
      };
      store.push(rule);
      return Response.json({ success: true, errors: [], result: rule });
    }
    const target = store.find((rule) => rule.name === posted.name);
    if (target === undefined) {
      return Response.json(
        { success: false, errors: [{ code: 2012, message: "Unknown rule." }], result: null },
        { status: 404 },
      );
    }
    if (options.failRelocation === true && target.precedence !== posted.precedence) {
      return Response.json(
        { success: false, errors: [{ code: 1000, message: "Upstream failure." }], result: null },
        { status: 500 },
      );
    }
    target.action = posted.action;
    target.enabled = posted.enabled;
    target.precedence = posted.precedence;
    target.traffic = posted.traffic;
    return Response.json({ success: true, errors: [], result: target });
  };
  return { fetcher, requests, store };
};

const categoryStored = (precedence: number): StoredRule => ({
  id: "rule-category",
  name: "clearbrowse:category#0",
  action: "block",
  enabled: true,
  precedence,
  traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.content_category[*] in {133})',
  filters: ["dns"],
  description: "Managed by ClearBrowse.",
});

describe("live Gateway precedence safety", () => {
  it("makes room when a new rule needs a precedence an owned rule holds", async () => {
    const { fetcher, store } = buildStatefulFetcher([categoryStored(1000)]);
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: 1000,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      }),
    );
    expect(Either.isRight(result)).toBe(true);
    const blockDomain = store.find((rule) => rule.name === "clearbrowse:block-domain#0");
    const category = store.find((rule) => rule.name === "clearbrowse:category#0");
    expect(blockDomain?.precedence).toBe(1000);
    expect(category?.precedence).not.toBe(1000);
    expect(category?.precedence).toBeLessThan(1000);
    expect(category?.traffic).toBe(categoryStored(1000).traffic);
    expect(new Set(store.map((rule) => rule.precedence)).size).toBe(store.length);
    expect(JSON.stringify(result).includes(TOKEN)).toBe(false);
  });

  it("parks an owned allow later so the move stays conservative", async () => {
    const allowStored: StoredRule = {
      id: "rule-allow",
      name: "clearbrowse:allow-domain#0",
      action: "allow",
      enabled: true,
      precedence: 1000,
      traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "allowed.example.org")',
      filters: ["dns"],
      description: "Managed by ClearBrowse.",
    };
    const { fetcher, store } = buildStatefulFetcher([allowStored]);
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: 1000,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      }),
    );
    expect(Either.isRight(result)).toBe(true);
    const allow = store.find((rule) => rule.name === "clearbrowse:allow-domain#0");
    expect(allow?.precedence).toBeGreaterThan(1000);
    expect(new Set(store.map((rule) => rule.precedence)).size).toBe(store.length);
  });

  it("reports an occupied precedence held by an unrelated rule as a permanent failure", async () => {
    const { fetcher, store } = buildStatefulFetcher([
      {
        id: "other-rule",
        name: "Unrelated policy",
        action: "block",
        enabled: true,
        precedence: 1000,
        traffic: "any(app.type.ids[*] in {16})",
        filters: ["http"],
        description: "",
      },
    ]);
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: 1000,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("precedence_taken");
      expect(result.left.retryable).toBe(false);
    }
    expect(store.length).toBe(1);
    expect(store[0]?.precedence).toBe(1000);
    expect(store.some((rule) => rule.name.startsWith("clearbrowse:"))).toBe(false);
  });

  it("rejects a relocation read-back that does not preserve the moved rule", async () => {
    const fetcher: GatewayFetcher = async (_url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return Response.json({
          success: true,
          errors: [],
          result: [categoryStored(1000)],
          result_info: { page: 1, per_page: 100, count: 1, total_count: 1 },
        });
      }
      return Response.json({
        success: true,
        errors: [],
        result: { ...categoryStored(1001), traffic: 'dns.fqdn == "wrong.example.org"' },
      });
    };
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: 1000,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("invalid_response");
    }
  });

  it("fails permanently without mutating when no earlier free slot exists for a block", async () => {
    const blockers: readonly StoredRule[] = [0, 1, 2].map((precedence) => ({
      id: `other-${String(precedence)}`,
      name: `Unrelated ${String(precedence)}`,
      action: "block",
      enabled: true,
      precedence,
      traffic: "any(app.type.ids[*] in {16})",
      filters: ["http"],
      description: "",
    }));
    const { fetcher, store } = buildStatefulFetcher([...blockers, categoryStored(3)]);
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: 3,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("precedence_taken");
      expect(result.left.retryable).toBe(false);
    }
    expect(store.length).toBe(4);
    expect(store.some((rule) => rule.name === "clearbrowse:block-domain#0")).toBe(false);
    expect(store.find((rule) => rule.name === "clearbrowse:category#0")?.precedence).toBe(3);
  });

  it("leaves the occupant and target untouched when the relocation write fails", async () => {
    const { fetcher, store } = buildStatefulFetcher([categoryStored(1000)], {
      failRelocation: true,
    });
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: 1000,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("unavailable");
      expect(result.left.retryable).toBe(true);
    }
    expect(store.length).toBe(1);
    expect(store[0]?.precedence).toBe(1000);
    expect(store.some((rule) => rule.name === "clearbrowse:block-domain#0")).toBe(false);
  });
  it("rejects a listing with an unsafe or negative precedence", async () => {
    const fetcher: GatewayFetcher = async () =>
      Response.json({
        success: true,
        errors: [],
        result: [apiRule({ id: "bad", name: "Unrelated bad", precedence: -1 })],
      });
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(adapter.listOwnedRules());
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("invalid_response");
      expect(result.left.retryable).toBe(false);
    }
  });

  it("fails permanently without stalling when an allow sits at the safe maximum", async () => {
    const allowAtMax: StoredRule = {
      id: "rule-allow-max",
      name: "clearbrowse:allow-domain#0",
      action: "allow",
      enabled: true,
      precedence: Number.MAX_SAFE_INTEGER,
      traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "allowed.example.org")',
      filters: ["dns"],
      description: "Managed by ClearBrowse.",
    };
    const { fetcher, store } = buildStatefulFetcher([allowAtMax]);
    const adapter = createLiveGateway({ accountId: ACCOUNT, apiToken: TOKEN, fetcher });
    const result = await run(
      adapter.upsertRule({
        logicalName: "block-domain#0",
        action: "block",
        precedence: Number.MAX_SAFE_INTEGER,
        traffic: 'dns.doh_subdomain == "clearbrowse-test" and any(dns.domains[*] == "blocked.example.org")',
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("precedence_taken");
      expect(result.left.retryable).toBe(false);
    }
    expect(store.length).toBe(1);
    expect(store[0]?.precedence).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("remote rule records", () => {
  it("keeps the discovered metadata intact", () => {
    const rule: RemoteRule = {
      id: "x",
      name: "clearbrowse:x",
      action: "allow",
      precedence: 5,
      traffic: "t",
      enabled: false,
    };
    expect(rule.enabled).toBe(false);
  });
});
