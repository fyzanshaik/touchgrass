import { useEffect, useState } from "react";
import type { CategoryName } from "../../domain/policy.ts";
import { Button, CheckboxField, SubHeading, SwitchField, TextField } from "../components/controls.tsx";
import { Card, DefinitionRow, EmptyState } from "../components/feedback.tsx";
import {
  categoryDescription,
  categoryLabel,
  categoryOrder,
  gatewayModeNote,
  protectionEnabledHint,
} from "../format/labels.ts";
import { formatDuration, formatElapsed, formatInstant } from "../format/time.ts";
import type { DashboardState, DashboardStore } from "../state/dashboard-store.ts";
import { cooldownDefaultHours, cooldownMaxHours, hoursFromSeconds, parseCooldownHours } from "../state/parse.ts";
import { pendingRelaxations, relaxationWindow, summariseProtection } from "../state/selectors.ts";
import type { GatewayStanding } from "../state/selectors.ts";

const standingMessage = (standing: GatewayStanding): string => {
  switch (standing) {
    case "applied":
      return "Gateway has applied the desired revision.";
    case "applying":
      return "Gateway is applying the desired revision now.";
    case "drift":
      return "The desired revision is not applied yet. Retry reconciliation from Diagnostics.";
    case "untrusted":
      return "The revisions match, but the last management check reported a problem, so Gateway is not confirmed up to date.";
    case "unknown":
      return "Waiting for the first status reading from Gateway.";
  }
};

export const OverviewScreen = ({
  store,
  state,
}: {
  readonly store: DashboardStore;
  readonly state: DashboardState;
}) => {
  const policy = state.policy;
  const protection = summariseProtection(policy, state.status);
  const currentCooldown = policy === null ? null : policy.cooldownSeconds;
  const [cooldownInput, setCooldownInput] = useState<string>("");

  useEffect(() => {
    setCooldownInput(currentCooldown === null ? "" : hoursFromSeconds(currentCooldown));
  }, [currentCooldown]);

  if (policy === null) {
    return (
      <EmptyState
        title="Protection settings are not available yet"
        detail="The dashboard could not load your saved policy. Refresh once the service is reachable."
      />
    );
  }

  const now = Date.now();
  const pending = pendingRelaxations(state.status);
  const busy = state.mutation.phase === "sending";

  const toggleCategory = (name: CategoryName, checked: boolean): void => {
    const selected = new Set<CategoryName>(policy.categories);
    if (checked) {
      selected.add(name);
    } else {
      selected.delete(name);
    }
    void store.applyChange({
      type: "setCategories",
      categories: categoryOrder.filter((entry) => selected.has(entry)),
    });
  };

  const applyCooldown = (): void => {
    const parsed = parseCooldownHours(cooldownInput);
    if (!parsed.ok) {
      return;
    }
    void store.applyChange({ type: "setCooldown", cooldownSeconds: parsed.value });
  };

  const cooldownPreview = parseCooldownHours(cooldownInput);
  const cooldownStrength =
    cooldownPreview.ok && currentCooldown !== null
      ? cooldownPreview.value === currentCooldown
        ? "unchanged"
        : cooldownPreview.value > currentCooldown
          ? "stronger"
          : "weaker"
      : null;
  const gatewayNote = gatewayModeNote(protection.gatewayMode);

  return (
    <div className="stack">
      <Card
        title="Protection settings"
        description="These are the settings you want applied. Weakening changes need a pending confirmation."
      >
        <SwitchField
          id="protection-enabled"
          label="Adult-site protection"
          description={protectionEnabledHint}
          checked={policy.enabled}
          disabled={busy}
          onChange={(checked) => {
            void store.applyChange({ type: "setEnabled", enabled: checked });
          }}
        />

        <SubHeading>Adult-content category</SubHeading>
        <p className="muted">
          The category comes from Cloudflare Gateway and can be inaccurate in both directions.
          Exceptions on the Rules screen correct false positives without turning protection off.
        </p>
        {categoryOrder.map((name) => (
          <CheckboxField
            key={name}
            id={`category-${name}`}
            label={categoryLabel(name)}
            description={categoryDescription(name)}
            checked={policy.categories.includes(name)}
            disabled={busy}
            onChange={(checked) => toggleCategory(name, checked)}
          />
        ))}

        <SubHeading>Cooldown before a weakening change applies</SubHeading>
        <p className="muted">
          Currently {formatDuration(policy.cooldownSeconds)}. Increasing the cooldown is immediate;
          shortening it is a weakening change that needs confirmation.
        </p>
        <TextField
          id="cooldown-hours"
          label="Cooldown in hours"
          hint={`Between 0 and ${cooldownMaxHours} hours. The default is ${cooldownDefaultHours} hours.`}
          value={cooldownInput}
          onInput={setCooldownInput}
          type="number"
          inputMode="numeric"
          placeholder={null}
          disabled={busy}
        />
        {cooldownPreview.ok ? (
          <p className="muted">
            Saved as {formatDuration(cooldownPreview.value)} of cooldown.
          </p>
        ) : null}
        {cooldownStrength === "weaker" ? (
          <p className="hint hint--warning">
            This is a weakening change and will be held until you confirm it.
          </p>
        ) : null}
        {cooldownStrength === "stronger" ? (
          <p className="hint">This is a strengthening change and applies immediately.</p>
        ) : null}
        {cooldownPreview.ok ? null : (
          <p className="hint hint--danger">{cooldownPreview.message}</p>
        )}
        <div className="actions">
          <Button
            label="Save cooldown"
            type="button"
            tone="primary"
            busy={busy}
            disabled={cooldownStrength === null || cooldownStrength === "unchanged"}
            onClick={applyCooldown}
          />
        </div>
      </Card>

      <Card
        title="Gateway application state"
        description="Desired settings and what Gateway has actually applied are tracked separately."
      >
        <dl className="definitions">
          <DefinitionRow term="Desired revision">
            {protection.desiredRevision === null ? "unknown" : `#${protection.desiredRevision}`}
          </DefinitionRow>
          <DefinitionRow term="Gateway applied revision">
            {protection.appliedRevision === null
              ? "Not applied yet"
              : `#${protection.appliedRevision}`}
          </DefinitionRow>
          <DefinitionRow term="Last status update">
            {state.loadedAt === null ? "unknown" : formatElapsed(state.loadedAt, now)}
          </DefinitionRow>
          <DefinitionRow term="Next retry">
            {protection.nextRetryAt === null
              ? "none scheduled"
              : formatInstant(protection.nextRetryAt)}
          </DefinitionRow>
        </dl>
        <p className={protection.standing === "applied" ? "hint" : "hint hint--warning"}>
          {standingMessage(protection.standing)}
        </p>
        <p className={gatewayNote.tone === "warning" ? "hint hint--warning" : "muted"}>
          {gatewayNote.text}
        </p>
      </Card>

      <Card
        title="Pending changes"
        description="Weakening changes stay pending until you confirm them after the cooldown."
      >
        {pending.length === 0 ? (
          <p className="muted">No changes are waiting for confirmation.</p>
        ) : (
          <ul className="list">
            {pending.map((entry) => {
              const window = relaxationWindow(entry, now);
              return (
                <li key={entry.id} className="list__item">
                  <span>{window.waitingLabel}</span>
                  <span className="muted">Expires {window.expiresLabel}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
};
