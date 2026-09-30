import type { ApiErrorCode, ChangeState, GatewayMode, OperationStrength, ReconciliationState, RelaxationState } from "../../contracts/api.ts";
import type { CategoryName, RuleAction, RuleScope } from "../../domain/policy.ts";
import type { Operation } from "../../domain/operations.ts";
import type { ClientFailure } from "../client/result.ts";

export const categoryOrder: readonly CategoryName[] = ["pornography"];

const categoryLabelMap: Readonly<Record<string, string>> = {
  pornography: "Pornography",
};

const categoryDescriptionMap: Readonly<Record<string, string>> = {
  pornography: "Blocks dedicated adult sites in the tested browsers while Gateway is enforcing.",
};

export const categoryLabel = (name: CategoryName): string => categoryLabelMap[name] ?? name;

export const categoryDescription = (name: CategoryName): string =>
  categoryDescriptionMap[name] ?? "A Gateway content category.";

export const scopeLabels: Record<RuleScope, string> = {
  host: "Exact host",
  domain: "Domain and subdomains",
};

export const scopeDescriptions: Record<RuleScope, string> = {
  host: "Matches only the exact hostname you enter.",
  domain: "Matches the hostname you enter and everything beneath it.",
};

export const actionLabels: Record<RuleAction, string> = {
  block: "Block",
  allow: "Allow exception",
};

export const changeStateLabels: Record<ChangeState, string> = {
  revised: "Policy updated",
  pendingRelaxation: "Waiting for confirmation",
  unchanged: "No change needed",
};

export const relaxationStateLabels: Record<RelaxationState, string> = {
  pending: "Pending",
  cancelled: "Cancelled",
  confirmed: "Confirmed",
  expired: "Expired",
};

export const reconciliationLabels: Record<ReconciliationState, string> = {
  idle: "Up to date",
  applying: "Applying",
  degraded: "Needs attention",
};

export const gatewayModeLabels: Record<GatewayMode, string> = {
  live: "Live Gateway",
  simulated: "Simulated Gateway",
};

export interface GatewayModeNote {
  readonly tone: "info" | "warning";
  readonly text: string;
}

export const gatewayModeNote = (mode: GatewayMode | null): GatewayModeNote => {
  switch (mode) {
    case null:
      return {
        tone: "info",
        text: "Gateway mode has not been reported yet. Nothing here is confirmed against Gateway until a status reading arrives.",
      };
    case "simulated":
      return {
        tone: "warning",
        text: "This service is running against a simulated Gateway. Settings are saved and synced, but no live Gateway filtering is in place and no device is being filtered.",
      };
    case "live":
      return {
        tone: "info",
        text: "This service is connected to your live Gateway account. Syncing a policy shows only that the settings reached Gateway; it does not prove that any device routes DNS through Gateway or that a browser is filtered.",
      };
  }
};

export const strengthLabels: Record<OperationStrength, string> = {
  stronger: "Stronger",
  weaker: "Weaker",
  unchanged: "Unchanged",
};

export const errorCodeMessages: Record<ApiErrorCode, string> = {
  invalid_request: "The request was rejected. Check the values and try again.",
  unauthorized: "Your session is not signed in. Reload the page to sign in again.",
  forbidden: "This account is not allowed to make that change.",
  not_found: "That record no longer exists. Refresh to see the current state.",
  conflict: "That action conflicts with the current state. Refresh and review it.",
  stale_revision: "The policy changed since you loaded it. Refresh and try again.",
  precondition_required: "The request was missing required change headers.",
  payload_too_large: "The request was too large to accept.",
  unavailable: "The service is temporarily unavailable. Try again shortly.",
  internal: "The service hit an internal problem. Try again shortly.",
};

export const describeFailure = (failure: ClientFailure): string => {
  switch (failure.kind) {
    case "offline":
      return "The dashboard could not reach the service. Check your connection and try again.";
    case "api":
      return errorCodeMessages[failure.error.code];
    case "malformed":
      return "The service returned a response the dashboard could not read. Reload to try again.";
    case "unexpected":
      return "The service returned an unexpected error. Reload to try again.";
  }
};

export const describeOperation = (operation: Operation): string => {
  switch (operation.type) {
    case "addRule":
      return `${actionLabels[operation.rule.action]} ${operation.rule.hostname} (${scopeLabels[operation.rule.scope].toLowerCase()})`;
    case "removeRule":
      return "Remove a block or exception rule";
    case "setCategories":
      return operation.categories.length === 0
        ? "Turn off all adult-content categories"
        : `Set categories to ${operation.categories.map((name) => categoryLabel(name)).join(", ")}`;
    case "setEnabled":
      return operation.enabled ? "Turn protection on" : "Turn protection off";
    case "setCooldown":
      return `Set the cooldown to ${operation.cooldownSeconds} seconds`;
    case "restorePolicy":
      return "Restore an exported policy";
  }
};

export const describeChangeState = (state: ChangeState): string => changeStateLabels[state];

const HOSTNAME_INPUT_HINT =
  "Paste a hostname or an http(s) URL. Only the hostname is stored; paths, ports and queries are never saved.";

export const hostnameInputHint = HOSTNAME_INPUT_HINT;

export const protectionEnabledHint =
  "Turning protection off is a weakening change and needs confirmation. The DNS profile stays installed on your devices; only Gateway filtering is affected.";

export const ruleRemovalHint = "Removing a block weakens protection and needs confirmation; removing an exception applies immediately.";
