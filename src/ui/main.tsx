/**
 * quick-studio UI (Ring 2) — browser entry point.
 *
 * Mounts the React 19 app into #root. This module is bundled by the Core at
 * boot (Bun.build) and served at `/app.js`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("quick-studio: #root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
