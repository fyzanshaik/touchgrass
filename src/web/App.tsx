import { useEffect, useState } from "react";
import { Shell, type ScreenId } from "./components/shell.tsx";
import { ErrorNotice, LoadingState, MutationNotice, StaleNotice } from "./components/feedback.tsx";
import { DiagnosticsScreen } from "./screens/DiagnosticsScreen.tsx";
import { OverviewScreen } from "./screens/OverviewScreen.tsx";
import { PendingScreen } from "./screens/PendingScreen.tsx";
import { RulesScreen } from "./screens/RulesScreen.tsx";
import type { DashboardStore, MutationStatus } from "./state/dashboard-store.ts";
import { useDashboardState } from "./state/use-dashboard.ts";

const mutationTone = (mutation: MutationStatus): "success" | "warning" | "danger" => {
  if (mutation.phase === "succeeded") {
    return "success";
  }
  return mutation.retryable ? "warning" : "danger";
};

export const App = ({ store }: { readonly store: DashboardStore }) => {
  const state = useDashboardState(store);
  const [screen, setScreen] = useState<ScreenId>("overview");

  useEffect(() => {
    void store.refresh();
  }, [store]);

  const retry = (): void => {
    void store.refresh();
  };

  if (state.policy === null) {
    if (state.phase === "idle" || state.phase === "loading") {
      return <LoadingState label="Loading your protection settings" />;
    }
    return (
      <div className="app app--bare">
        {state.failure === null ? (
          <ErrorNotice
            failure={{ kind: "unexpected", status: 0, detail: "The dashboard could not load." }}
            onRetry={retry}
          />
        ) : (
          <ErrorNotice failure={state.failure} onRetry={retry} />
        )}
      </div>
    );
  }

  const mutation = state.mutation;
  const showMutation = mutation.message !== null && mutation.phase !== "sending";

  return (
    <Shell state={state} screen={screen} onSelect={setScreen}>
      {state.stale && state.failure !== null ? (
        <StaleNotice at={state.loadedAt} failure={state.failure} />
      ) : null}
      {showMutation ? (
        <MutationNotice
          tone={mutationTone(mutation)}
          message={mutation.message ?? ""}
          onRetry={
            mutation.retryable
              ? () => {
                  void store.retryLast();
                }
              : null
          }
          onDismiss={store.clearMutationNotice}
        />
      ) : null}
      {screen === "overview" ? <OverviewScreen store={store} state={state} /> : null}
      {screen === "rules" ? <RulesScreen store={store} state={state} /> : null}
      {screen === "pending" ? <PendingScreen store={store} state={state} /> : null}
      {screen === "diagnostics" ? <DiagnosticsScreen store={store} state={state} /> : null}
    </Shell>
  );
};
