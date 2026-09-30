import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createApiClient } from "./client/api-client.ts";
import { createDashboardStore } from "./state/dashboard-store.ts";
import "./styles.css";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("The dashboard root element is missing from the page.");
}

const client = createApiClient((input, init) => fetch(input, init));
const store = createDashboardStore(client);

createRoot(container).render(<App store={store} />);
