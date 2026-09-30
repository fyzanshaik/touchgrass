import { Schema } from "effect";
import { GatewayEndpoint } from "../../src/dns-profile/endpoint.ts";
import { RuleHostname } from "../../src/domain/hostname.ts";
import { instantFromMilliseconds } from "../../src/domain/instants.ts";
import {
  initialPolicy,
  makeRuleId,
  type CategoryName,
  type Policy,
  type Rule,
  type RuleAction,
  type RuleScope,
} from "../../src/domain/policy.ts";

export const endpoint = Schema.decodeSync(GatewayEndpoint)(
  "https://clearbrowse-test.cloudflare-gateway.com/dns-query",
);

export const atEpoch = instantFromMilliseconds(0);

const decodeHostname = Schema.decodeSync(RuleHostname);

export const ruleOf = (input: {
  readonly id: string;
  readonly hostname: string;
  readonly action: RuleAction;
  readonly scope: RuleScope;
}): Rule => ({
  id: makeRuleId(input.id),
  hostname: decodeHostname(input.hostname),
  action: input.action,
  scope: input.scope,
  createdAt: atEpoch,
});

export const policyOf = (overrides: {
  readonly enabled?: boolean;
  readonly categories?: readonly CategoryName[];
  readonly cooldownSeconds?: number;
  readonly rules?: readonly Rule[];
}): Policy => {
  const base = initialPolicy({ dnsEndpoint: endpoint, now: atEpoch });
  return {
    ...base,
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
    ...(overrides.categories === undefined ? {} : { categories: [...overrides.categories] }),
    ...(overrides.cooldownSeconds === undefined
      ? {}
      : { cooldownSeconds: overrides.cooldownSeconds }),
    ...(overrides.rules === undefined ? {} : { rules: [...overrides.rules] }),
  };
};
