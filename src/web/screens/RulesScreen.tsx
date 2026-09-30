import { useState } from "react";
import type { Result } from "../client/result.ts";
import type { PreviewResponse } from "../../contracts/api.ts";
import type { RuleAction, RuleScope } from "../../domain/policy.ts";
import { Button, SelectField, SubHeading, TextField } from "../components/controls.tsx";
import { Badge, type BadgeTone } from "../components/badges.tsx";
import { Card, EmptyState } from "../components/feedback.tsx";
import {
  actionLabels,
  hostnameInputHint,
  ruleRemovalHint,
  scopeDescriptions,
  scopeLabels,
} from "../format/labels.ts";
import { formatInstant } from "../format/time.ts";
import type { DashboardState, DashboardStore } from "../state/dashboard-store.ts";
import { countRules, filterRules } from "../state/selectors.ts";

const actionTone = (action: RuleAction): BadgeTone => (action === "block" ? "danger" : "positive");

export const RulesScreen = ({
  store,
  state,
}: {
  readonly store: DashboardStore;
  readonly state: DashboardState;
}) => {
  const policy = state.policy;
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [scope, setScope] = useState<RuleScope>("domain");
  const [action, setAction] = useState<RuleAction>("block");
  const [preview, setPreview] = useState<Result<PreviewResponse> | null>(null);
  const [previewing, setPreviewing] = useState(false);

  if (policy === null) {
    return (
      <EmptyState
        title="Rules are not available yet"
        detail="The dashboard could not load your saved policy. Refresh once the service is reachable."
      />
    );
  }

  const busy = state.mutation.phase === "sending";
  const rules = filterRules(policy.rules, query);
  const counts = countRules(policy.rules);
  const accepted = preview !== null && preview.ok && preview.value.accepted && preview.value.hostname !== null;

  const runPreview = async (): Promise<void> => {
    if (input.trim() === "") {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    const result = await store.preview(input, scope);
    setPreview(result);
    setPreviewing(false);
  };

  const submitRule = (): void => {
    if (preview === null || !preview.ok || preview.value.hostname === null) {
      return;
    }
    const hostname = preview.value.hostname;
    void store
      .applyChange({ type: "addRule", rule: { hostname, action, scope } })
      .then((outcome) => {
        if (outcome.ok) {
          setInput("");
          setPreview(null);
        }
      });
  };

  const previewTone: BadgeTone | null =
    preview === null ? null : preview.ok && preview.value.accepted ? "positive" : "danger";

  return (
    <div className="stack">
      <Card
        title="Add a rule"
        description="Blocks and allows are stored as hostnames. A block for a domain also covers its subdomains when you choose that scope."
      >
        <TextField
          id="rule-input"
          label="Hostname or URL"
          hint={hostnameInputHint}
          value={input}
          onInput={(value) => {
            setInput(value);
            setPreview(null);
          }}
          type="text"
          inputMode="text"
          placeholder="example.com"
          disabled={busy}
        />
        <div className="grid grid--two">
          <SelectField
            id="rule-scope"
            label="Scope"
            hint={scopeDescriptions[scope]}
            value={scope}
            options={[
              { value: "domain", label: scopeLabels.domain },
              { value: "host", label: scopeLabels.host },
            ]}
            disabled={busy}
            onChange={(value) => {
              setScope(value === "host" ? "host" : "domain");
              setPreview(null);
            }}
          />
          <SelectField
            id="rule-action"
            label="Action"
            hint={
              action === "block"
                ? "Blocks matching lookups. Applies immediately."
                : "Allows a false positive. Adding an exception is a weakening change and needs confirmation."
            }
            value={action}
            options={[
              { value: "block", label: actionLabels.block },
              { value: "allow", label: actionLabels.allow },
            ]}
            disabled={busy}
            onChange={(value) => {
              setAction(value === "allow" ? "allow" : "block");
              setPreview(null);
            }}
          />
        </div>
        <div className="actions">
          <Button
            label="Preview hostname"
            type="button"
            tone="neutral"
            busy={previewing}
            disabled={busy || input.trim() === ""}
            onClick={() => {
              void runPreview();
            }}
          />
          <Button
            label={action === "block" ? "Add block" : "Request exception"}
            type="button"
            tone="primary"
            busy={busy}
            disabled={!accepted}
            onClick={submitRule}
          />
        </div>
        {preview === null ? null : (
          <div className="preview">
            <Badge tone={previewTone ?? "neutral"}>
              {preview.ok && preview.value.accepted ? "Accepted" : "Rejected"}
            </Badge>
            {preview.ok ? (
              <>
                <p className="preview__hostname">
                  {preview.value.hostname === null ? "No hostname" : preview.value.hostname}
                </p>
                <p className="muted">{preview.value.message}</p>
                <p className="muted">
                  Stored as {scopeLabels[preview.value.scope].toLowerCase()}.
                </p>
              </>
            ) : (
              <p className="hint hint--danger">
                {preview.failure.kind === "api"
                  ? preview.failure.error.message
                  : "The preview could not be completed. Try again."}
              </p>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Current rules"
        description={`${counts.total} rules: ${counts.blocks} blocks and ${counts.allows} exceptions.`}
      >
        <TextField
          id="rule-search"
          label="Search rules"
          hint={null}
          value={query}
          onInput={setQuery}
          type="search"
          inputMode="search"
          placeholder="Filter by hostname"
          disabled={false}
        />
        {rules.length === 0 ? (
          <p className="muted">
            {policy.rules.length === 0 ? "No rules have been added yet." : "No rules match that search."}
          </p>
        ) : (
          <ul className="list">
            {rules.map((rule) => (
              <li key={rule.id} className="list__item list__item--rule">
                <div className="list__main">
                  <span className="rule__hostname">{rule.hostname}</span>
                  <span className="rule__meta">
                    <Badge tone={actionTone(rule.action)}>{actionLabels[rule.action]}</Badge>
                    <span className="muted">{scopeLabels[rule.scope]}</span>
                    <span className="muted">Added {formatInstant(rule.createdAt)}</span>
                  </span>
                </div>
                <Button
                  label="Remove"
                  type="button"
                  tone="quiet"
                  busy={busy}
                  disabled={busy}
                  onClick={() => {
                    void store.applyChange({ type: "removeRule", ruleId: rule.id });
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="muted">{ruleRemovalHint}</p>
        <SubHeading>How rules combine</SubHeading>
        <p className="muted">
          A block always wins over an exception for the same name. Exceptions override category
          filtering so you can correct a false positive without turning protection off.
        </p>
      </Card>
    </div>
  );
};
