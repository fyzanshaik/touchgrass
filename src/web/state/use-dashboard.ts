import { useSyncExternalStore } from "react";
import type { DashboardState, DashboardStore } from "./dashboard-store.ts";

export const useDashboardState = (store: DashboardStore): DashboardState =>
  useSyncExternalStore(store.subscribe, store.getState, store.getState);
