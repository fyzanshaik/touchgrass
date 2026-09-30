import type { ReactNode } from "react";
import type { DashboardState } from "../state/dashboard-store.ts";
import { summariseProtection } from "../state/selectors.ts";
import { ReconciliationBadge, SimulatedBadge, UnverifiedBadge } from "./badges.tsx";

export type ScreenId = "overview" | "rules" | "pending" | "diagnostics";

interface NavItem {
  readonly id: ScreenId;
  readonly label: string;
  readonly count: number | null;
}

const navItems = (state: DashboardState, pendingCount: number): readonly NavItem[] => [
  { id: "overview", label: "Overview", count: null },
  { id: "rules", label: "Rules", count: state.policy === null ? null : state.policy.rules.length },
  { id: "pending", label: "Pending", count: pendingCount },
  { id: "diagnostics", label: "Diagnostics", count: null },
];

export const Shell = ({
  state,
  screen,
  onSelect,
  children,
}: {
  readonly state: DashboardState;
  readonly screen: ScreenId;
  readonly onSelect: (screen: ScreenId) => void;
  readonly children: ReactNode;
}) => {
  const protection = summariseProtection(state.policy, state.status);
  const pendingCount =
    state.status === null
      ? 0
      : state.status.relaxations.filter((entry) => entry.state === "pending").length;

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__title">
          <h1>Touchgrass</h1>
          <p>Personal filtering settings for your iPhone and Mac.</p>
        </div>
        <div className="app__badges">
          <SimulatedBadge mode={protection.gatewayMode} />
          <ReconciliationBadge reconciliation={protection.reconciliation} />
          <UnverifiedBadge />
        </div>
      </header>

      <nav className="app__nav" aria-label="Dashboard sections">
        {navItems(state, pendingCount).map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === screen ? "nav__item nav__item--active" : "nav__item"}
            aria-current={item.id === screen ? "page" : undefined}
            onClick={() => onSelect(item.id)}
          >
            <span>{item.label}</span>
            {item.count === null || item.count === 0 ? null : (
              <span className="nav__count">{item.count}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="app__main">{children}</main>

      <footer className="app__footer">
        <p>
          This dashboard shows your saved policy and what Gateway has applied. It cannot see whether
          the DNS profile is active on a device, and nothing on this page proves that a browser is
          being filtered.
        </p>
      </footer>
    </div>
  );
};
