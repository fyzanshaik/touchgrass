import { env, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { AccountDurableObject, DebugSnapshot } from "../../src/worker/account.ts";

export const OWNER_ORIGIN = "http://localhost";
export const OWNER_NAME = "owner";
export const API = "/api/v1";

type IsAny<T> = 0 extends 1 & T ? true : false;

export const accountBindingIsTyped: IsAny<typeof env.ACCOUNT> = false;

export const stubFor = (name: string): DurableObjectStub<AccountDurableObject> =>
  env.ACCOUNT.getByName(name);

export const fetchLocal = (path: string, init?: RequestInit): Promise<Response> =>
  exports["default"].fetch(`${OWNER_ORIGIN}${path}`, init);

export const jsonMutation = (input: {
  readonly path: string;
  readonly body: unknown;
  readonly ifMatch: string | null;
  readonly idempotencyKey: string;
  readonly method?: string;
}): Promise<Response> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: OWNER_ORIGIN,
    "idempotency-key": input.idempotencyKey,
  };
  if (input.ifMatch !== null) {
    headers["if-match"] = input.ifMatch;
  }
  return fetchLocal(input.path, {
    method: input.method ?? "POST",
    headers,
    body: JSON.stringify(input.body),
  });
};

export const apiGet = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetchLocal(path, { headers });

export const rawRequest = (path: string, init: RequestInit): Promise<Response> =>
  fetchLocal(path, init);

export interface StatusBody {
  readonly desiredRevision: number;
  readonly gatewayAppliedRevision: number | null;
  readonly reconciliation: string;
  readonly gatewayMode: string;
  readonly lastErrorCode: string | null;
  readonly nextRetryAt: string | null;
  readonly serverTime: string;
  readonly relaxations: readonly {
    readonly id: string;
    readonly state: string;
    readonly eligibleAt: string;
    readonly expiresAt: string;
    readonly resultingRevision: number | null;
    readonly canConfirm: boolean;
    readonly operation: { readonly type: string };
  }[];
}

export const statusOf = async (name: string): Promise<StatusBody> => {
  const result = await stubFor(name).readStatus();
  if (!result.ok) {
    throw new Error(`status failed: ${result.failure.type}`);
  }
  return result.value;
};

export const etagOf = async (name: string): Promise<string> => {
  const result = await stubFor(name).readPolicy({ ifNoneMatch: null });
  if (!result.ok) {
    throw new Error(`policy failed: ${result.failure.type}`);
  }
  return result.value.etag;
};

export const snapshotOf = async (name: string): Promise<DebugSnapshot> => {
  const result = await stubFor(name).debug({ kind: "snapshot" });
  if (!result.ok) {
    throw new Error(`snapshot failed: ${result.failure.type}`);
  }
  return result.value;
};

export const uniqueKey = (): string => crypto.randomUUID();

let nameCounter = 0;

export const freshStubName = (label: string): string => {
  nameCounter += 1;
  return `${label}-${String(nameCounter)}`;
};

export const addRuleOperation = (input: {
  readonly hostname: string;
  readonly action: "block" | "allow";
  readonly scope: "host" | "domain";
}) => ({ type: "addRule", rule: input }) as const;

export const drainAlarm = (name: string): Promise<boolean> =>
  runDurableObjectAlarm(stubFor(name));
