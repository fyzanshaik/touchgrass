import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "positive" | "warning" | "danger";

export const Badge = ({ tone, children }: { readonly tone: BadgeTone; readonly children: ReactNode }) => (
  <span className={`badge badge--${tone}`}>{children}</span>
);

export const SimulatedBadge = ({ mode }: { readonly mode: "live" | "simulated" | null }) => {
  if (mode === null) {
    return null;
  }
  return mode === "simulated" ? (
    <Badge tone="warning">Simulated Gateway - local only</Badge>
  ) : (
    <Badge tone="positive">Live Gateway</Badge>
  );
};

export const UnverifiedBadge = () => (
  <Badge tone="warning">Browser verification unverified</Badge>
);

export const ReconciliationBadge = ({
  reconciliation,
}: {
  readonly reconciliation: "idle" | "applying" | "degraded" | null;
}) => {
  switch (reconciliation) {
    case null:
      return <Badge tone="neutral">Gateway state unknown</Badge>;
    case "idle":
      return <Badge tone="positive">Gateway up to date</Badge>;
    case "applying":
      return <Badge tone="warning">Applying to Gateway</Badge>;
    case "degraded":
      return <Badge tone="danger">Gateway needs attention</Badge>;
  }
};
