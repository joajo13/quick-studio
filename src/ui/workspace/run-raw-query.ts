/**
 * quick-studio UI (Ring 2) — shared raw-`execute` run seam (Story 3.6, extracted in
 * Story 5.3).
 *
 * The single execution seam both `QueryTabView` and `ChatTabView` drive: run SQL
 * verbatim through the Story 3.1 guarded `execute` RAW path. The UI never parses,
 * splits, classifies, or composes SQL (AR-3) — the typed/generated text is sent
 * verbatim as `{shape:"raw", sql}` and the Core is the sole risk gate. Pass
 * `confirmed:true` to re-issue the IDENTICAL request after a `confirmation_required`
 * preview is accepted.
 *
 * Exported as a standalone, DOM-free async function (mocking `rpc` is enough to
 * exercise every outcome) so the round-trip logic is unit-testable without a live
 * DOM — this repo has no jsdom/testing-library, only `bun:test` + `react-dom/server`
 * for presentational components.
 */

import type { ExecuteResult, FrozenData } from "../../shared/contract.ts";
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";

/**
 * The outcome of one raw `execute` round-trip, decoupled from React state so the
 * Run/confirm flow is unit-testable by mocking `rpc` and calling `runRawQuery`
 * directly (no rendering / no DOM required).
 */
export type RunOutcome =
  | { readonly kind: "rows"; readonly data: FrozenData; readonly truncated: boolean }
  | { readonly kind: "ok"; readonly rowsAffected: number }
  | { readonly kind: "confirm"; readonly sql: string; readonly risk: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Run `sql` verbatim through the raw `execute` path. The UI never parses,
 * splits, classifies, or composes SQL — the Core guarded executor is the sole
 * gate (AR-3). Pass `confirmed:true` to re-issue the IDENTICAL request after an
 * inline confirm accepts a `confirmation_required` preview.
 *
 * `connectionId` (Story 6.2) is the Report re-target: a saved-connection **id** the
 * Core resolves to a live connection in-Ring-1 (the url/credential never crosses this
 * boundary, AR-12). It is forwarded inside `params` ONLY when set — an absent/`null`
 * id omits the key entirely, so every existing (2-arg) caller and the default target
 * stay byte-identical, running against the boot connection.
 */
export async function runRawQuery(
  sql: string,
  confirmed?: boolean,
  connectionId?: string | null,
): Promise<RunOutcome> {
  const base = confirmed ? { shape: "raw", sql, confirmed: true } : { shape: "raw", sql };
  const reply = await rpc<ExecuteResult>(
    "execute",
    connectionId != null ? { ...base, connectionId } : base,
  );
  if (!reply.ok) return { kind: "error", message: envelopeText(reply.error) };
  const result = reply.result;
  switch (result.status) {
    case "rows":
      return { kind: "rows", data: result.data, truncated: result.truncated };
    case "ok":
      return { kind: "ok", rowsAffected: result.rowsAffected };
    case "confirmation_required":
      return { kind: "confirm", sql: result.preview.sql, risk: result.preview.risk };
    default: {
      // Exhaustiveness guard: if `ExecuteResult` ever gains a new status, this is a
      // compile error rather than a silent mislabel-as-confirm (which would then
      // dereference a missing `.preview`). Caught by the caller's try/catch.
      const unexpected: never = result;
      throw new Error(`unexpected execute status: ${JSON.stringify(unexpected)}`);
    }
  }
}
