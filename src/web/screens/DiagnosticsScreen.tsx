import { useState } from "react";
import { downloadJson } from "../client/download.ts";
import { describeFailure } from "../format/labels.ts";
import { formatDuration, formatElapsed, formatInstant } from "../format/time.ts";
import { Button, SubHeading } from "../components/controls.tsx";
import { Card, DefinitionRow, EmptyState } from "../components/feedback.tsx";
import type { DashboardState, DashboardStore } from "../state/dashboard-store.ts";
import { parseBackupPolicy } from "../state/backup.ts";
import { summariseProtection } from "../state/selectors.ts";

type CopyState = "idle" | "copied" | "unavailable";

const PROFILE_DOCS_URL =
  "https://developers.cloudflare.com/cloudflare-one/learning-paths/secure-internet-traffic/build-dns-policies/onboard-dns/";

export const DiagnosticsScreen = ({
  store,
  state,
}: {
  readonly store: DashboardStore;
  readonly state: DashboardState;
}) => {
  const policy = state.policy;
  const diagnostics = state.diagnostics;
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  if (policy === null) {
    return (
      <EmptyState
        title="Diagnostics are not available yet"
        detail="The dashboard could not load your saved policy. Refresh once the service is reachable."
      />
    );
  }

  const protection = summariseProtection(policy, state.status);
  const busy = state.mutation.phase === "sending";
  const endpoint = policy.dnsEndpoint;
  const now = Date.now();

  const copyEndpoint = async (): Promise<void> => {
    if (typeof navigator.clipboard === "undefined") {
      setCopyState("unavailable");
      return;
    }
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopyState("copied");
    } catch {
      setCopyState("unavailable");
    }
  };

  const exportBackup = async (): Promise<void> => {
    setExporting(true);
    setExportMessage(null);
    const result = await store.exportBackup();
    setExporting(false);
    if (result.ok) {
      downloadJson("touchgrass-policy.json", result.value);
      setExportMessage("Backup downloaded.");
      return;
    }
    setExportMessage(describeFailure(result.failure));
  };

  const restoreFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const parsed = parseBackupPolicy(text);
    if (!parsed.ok) {
      setRestoreMessage(parsed.message);
      return;
    }
    setRestoreMessage(
      "Backup accepted. Restoring is checked against the same weakening rules as any other change.",
    );
    await store.restore(parsed.value);
  };

  return (
    <div className="stack">
      <Card
        title="Gateway endpoint"
        description="This is the address your devices use for encrypted DNS. It identifies a location, not a secret."
      >
        <p className="endpoint">{endpoint}</p>
        <div className="actions">
          <Button
            label={copyState === "copied" ? "Copied" : "Copy endpoint"}
            type="button"
            tone="neutral"
            busy={false}
            disabled={false}
            onClick={() => {
              void copyEndpoint();
            }}
          />
        </div>
        {copyState === "unavailable" ? (
          <p className="hint hint--warning">
            The browser blocked clipboard access. Select the address above and copy it manually.
          </p>
        ) : null}
        <p className="muted">
          If this address ever changes, the DNS profile must be reinstalled on each device. Profile
          installation and removal happen in your device settings, outside this dashboard. See the{" "}
          <a href={PROFILE_DOCS_URL} target="_blank" rel="noreferrer noopener">
            Cloudflare device setup guidance
          </a>
          .
        </p>
      </Card>

      <Card
        title="Application state"
        description="Desired settings, what Gateway applied and what the last management check found."
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
          <DefinitionRow term="Reconciliation">
            {protection.reconciliation === null ? "unknown" : protection.reconciliation}
          </DefinitionRow>
          <DefinitionRow term="Last status update">
            {state.loadedAt === null ? "unknown" : formatElapsed(state.loadedAt, now)}
          </DefinitionRow>
          <DefinitionRow term="Next retry">
            {protection.nextRetryAt === null
              ? "none scheduled"
              : formatInstant(protection.nextRetryAt)}
          </DefinitionRow>
          <DefinitionRow term="Protection switch">{policy.enabled ? "On" : "Off"}</DefinitionRow>
          <DefinitionRow term="Cooldown">
            {formatDuration(policy.cooldownSeconds)}
          </DefinitionRow>
          <DefinitionRow term="Rules">{`${policy.rules.length} stored`}</DefinitionRow>
        </dl>
        {protection.lastErrorCode === null ? null : (
          <p className="hint hint--danger">
            Gateway reported {protection.lastErrorCode}. Retry reconciliation, then check the state
            again.
          </p>
        )}
        <div className="actions">
          <Button
            label="Retry reconciliation"
            type="button"
            tone="primary"
            busy={busy}
            disabled={busy}
            onClick={() => {
              void store.reconcile();
            }}
          />
        </div>
      </Card>

      <Card
        title="Backup and restore"
        description="Export your current policy, or restore a previously exported backup."
      >
        <div className="actions">
          <Button
            label="Export policy"
            type="button"
            tone="neutral"
            busy={exporting}
            disabled={exporting}
            onClick={() => {
              void exportBackup();
            }}
          />
        </div>
        {exportMessage === null ? null : <p className="muted">{exportMessage}</p>}

        <SubHeading>Restore a backup</SubHeading>
        <p className="muted">
          A restore is compared with the current policy and follows the same weakening checks, so it
          cannot bypass a cooldown.
        </p>
        <div className="field">
          <label htmlFor="restore-file">Backup file</label>
          <input
            id="restore-file"
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file === undefined) {
                return;
              }
              void restoreFile(file);
            }}
          />
        </div>
        {restoreMessage === null ? null : <p className="muted">{restoreMessage}</p>}
      </Card>

      <Card
        title="Compiled plan"
        description="What the current policy compiles to for Gateway. Internal identifiers stay out of this view."
      >
        {diagnostics === null ? (
          <p className="muted">Diagnostics have not loaded yet.</p>
        ) : (
          <>
            <dl className="definitions">
              <DefinitionRow term="Compiler">{diagnostics.compilerVersion}</DefinitionRow>
              <DefinitionRow term="Plan revision">
                {`#${diagnostics.planRevision}`}
              </DefinitionRow>
              <DefinitionRow term="Plan build">
                {diagnostics.planFailure === null ? "Built" : "Failed"}
              </DefinitionRow>
              <DefinitionRow term="Location">{diagnostics.locationSubdomain}</DefinitionRow>
              <DefinitionRow term="Suppressed allows">
                {`${diagnostics.suppressedAllows.length}`}
              </DefinitionRow>
              <DefinitionRow term="Owned resources">
                {`${diagnostics.ownedResources.length}`}
              </DefinitionRow>
              <DefinitionRow term="Reconciliation job">
                {diagnostics.reconciliationJob === null
                  ? "none"
                  : `${diagnostics.reconciliationJob.stage} (attempt ${diagnostics.reconciliationJob.attempt})`}
              </DefinitionRow>
            </dl>
            <ul className="list">
              {diagnostics.planRules.map((rule) => (
                <li key={rule.logicalName} className="list__item">
                  <span>{rule.logicalName}</span>
                  <span className="muted">
                    {rule.action} at precedence {rule.precedence}
                  </span>
                </li>
              ))}
            </ul>
            {diagnostics.planFailure === null ? null : (
              <p className="hint hint--danger">
                One or more plan entries could not be refreshed. Retry reconciliation above.
              </p>
            )}
            <div className="actions">
              <Button
                label="Download diagnostics"
                type="button"
                tone="neutral"
                busy={false}
                disabled={false}
                onClick={() => {
                  downloadJson("touchgrass-diagnostics.json", diagnostics);
                }}
              />
            </div>
          </>
        )}
      </Card>

      <Card
        title="What is not verified"
        description="The dashboard cannot see device state, so it never claims a browser is filtered."
      >
        <ul className="list list--plain">
          <li>Whether the encrypted DNS profile is installed or active on any device.</li>
          <li>Whether a browser is using the system resolver or its own secure DNS provider.</li>
          <li>Whether Private Relay, another VPN or a proxy is bypassing filtering on a device.</li>
          <li>
            Whether any specific browser passes a block-and-allow probe. That needs a real test on
            the device.
          </li>
        </ul>
        <p className="muted">
          This is cooperative self-control software. You can always change device settings or your
          Cloudflare account.
        </p>
      </Card>
    </div>
  );
};
