import { useState } from "react";
import { Badge, type BadgeTone } from "../components/badges.tsx";
import { Button } from "../components/controls.tsx";
import { Card } from "../components/feedback.tsx";
import { relaxationStateLabels, strengthLabels } from "../format/labels.ts";
import { formatInstant } from "../format/time.ts";
import type { DashboardState, DashboardStore } from "../state/dashboard-store.ts";
import { describeRelaxation, pendingRelaxations, relaxationWindow, settledRelaxations } from "../state/selectors.ts";
import type { RelaxationState } from "../../contracts/api.ts";

const stateTone = (value: RelaxationState): BadgeTone => {
  switch (value) {
    case "pending":
      return "warning";
    case "confirmed":
      return "positive";
    case "cancelled":
      return "neutral";
    case "expired":
      return "danger";
  }
};

export const PendingScreen = ({
  store,
  state,
}: {
  readonly store: DashboardStore;
  readonly state: DashboardState;
}) => {
  const policy = state.policy;
  const [refreshing, setRefreshing] = useState(false);
  const now = Date.now();
  const busy = state.mutation.phase === "sending";
  const pending = pendingRelaxations(state.status);
  const settled = settledRelaxations(state.status);

  return (
    <div className="stack">
      <Card
        title="Pending weakening changes"
        description="A weakening change is held until you confirm it after the cooldown. Reaching the deadline never applies it on its own."
      >
        <div className="actions">
          <Button
            label="Refresh server state"
            type="button"
            tone="neutral"
            busy={refreshing}
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void store.refresh().finally(() => {
                setRefreshing(false);
              });
            }}
          />
        </div>
        {pending.length === 0 ? (
          <p className="muted">Nothing is waiting for confirmation.</p>
        ) : (
          <ul className="list">
            {pending.map((entry) => {
              const window = relaxationWindow(entry, now);
              const confirmDisabled = !window.eligible || busy;
              return (
                <li key={entry.id} className="list__item list__item--pending">
                  <div className="list__main">
                    <span className="pending__title">
                      {describeRelaxation(entry, policy)}
                    </span>
                    <span className="rule__meta">
                      <Badge tone={stateTone(entry.state)}>
                        {relaxationStateLabels[entry.state]}
                      </Badge>
                      <span className="muted">
                        {strengthLabels[entry.strength]} change
                      </span>
                    </span>
                    <dl className="definitions definitions--compact">
                      <div className="definition">
                        <dt>Requested</dt>
                        <dd>{formatInstant(entry.requestedAt)}</dd>
                      </div>
                      <div className="definition">
                        <dt>Eligible</dt>
                        <dd>{window.eligibleLabel}</dd>
                      </div>
                      <div className="definition">
                        <dt>Expires</dt>
                        <dd>{window.expiresLabel}</dd>
                      </div>
                    </dl>
                    <p className="hint">
                      {window.eligible
                        ? "Eligible now. Confirming applies this change to Gateway."
                        : window.expired
                          ? "This request has expired. Create it again to make the change."
                          : `${window.waitingLabel}. The deadline does not apply it automatically.`}
                    </p>
                  </div>
                  <div className="actions actions--inline">
                    <Button
                      label="Confirm now"
                      type="button"
                      tone="danger"
                      busy={busy}
                      disabled={confirmDisabled}
                      onClick={() => {
                        void store.confirmChange(entry.id);
                      }}
                    />
                    <Button
                      label="Cancel request"
                      type="button"
                      tone="neutral"
                      busy={busy}
                      disabled={busy}
                      onClick={() => {
                        void store.cancelChange(entry.id);
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title="Recent outcomes"
        description="Cancelled, expired and confirmed requests are kept so you can see what happened."
      >
        {settled.length === 0 ? (
          <p className="muted">No cancelled, expired or confirmed requests yet.</p>
        ) : (
          <ul className="list">
            {settled.map((entry) => (
              <li key={entry.id} className="list__item">
                <div className="list__main">
                  <span>{describeRelaxation(entry, policy)}</span>
                  <span className="rule__meta">
                    <Badge tone={stateTone(entry.state)}>
                      {relaxationStateLabels[entry.state]}
                    </Badge>
                    <span className="muted">
                      {entry.resultingRevision === null
                        ? "No revision change"
                        : `Now revision #${entry.resultingRevision}`}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};
