/**
 * quick-studio UI (Ring 2) — shared destructive-run confirm dialog (Story 3.6,
 * extracted in Story 5.3, redesigned to the neutral look in Story 7.3).
 *
 * Purely presentational — a neutral scrim + `alertdialog` card ported from
 * `design-artifacts/confirm-destructive.html`. Destructive red appears ONLY on the
 * functional destructive bits: the danger icon, the affected-rows badge and the
 * statement's left border all take `--err` directly, while the filled Confirm
 * button carries an `--err` rim over an `--err-fill` body (DW-58 — `--err` under
 * white text is 3.04:1, below AA, so the darker fill carries the label at 5.65:1
 * and the lighter rim stays as the button's 1.4.11 boundary against the `--muted`
 * footer: 5.10:1 in the dark theme, which is the only one the app activates today).
 * Everything else is neutral / ink. There is NO top color line — the card reads
 * from its shadow + hairline ring alone.
 *
 * The caller owns ALL state (which SQL is pending, `busy`, re-entrancy) and the
 * gate — this component never calls `execute` itself, it only reports the two
 * intents. Confirming re-issues the IDENTICAL request with `confirmed:true`; the
 * Core guarded executor remains the sole real gate. The `busy` disable and the
 * optional type-to-confirm friction are UX only, never the gate.
 *
 * `sql`/`risk`/`busy`/`onConfirm`/`onCancel` are the base props every caller
 * (`QueryTabView`, `ChatTabView`, `ReportTabView`) passes. The three optional
 * props (`affectedRows`, `dependents`, `objectName`) have NO Core source today —
 * the `confirmation_required` preview carries only `sql` + `risk` — so each is
 * rendered ONLY when a future story supplies it, and all three callers keep
 * rendering the base modal unchanged.
 */

import { useState } from "react";

/** One foreign-key dependency line shown under the statement (only when supplied). */
export type ConfirmRunDependent = { from: string; to: string };

type ConfirmRunProps = {
  /** The exact SQL that was sent and is awaiting confirmation (frozen, not the draft). */
  sql: string;
  /** The Core's human-readable risk description from the `confirmation_required` preview. */
  risk: string;
  /** A confirm/cancel round-trip is in flight — both buttons disable to avoid a double-fire. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional preview: rows the statement destroys — renders a red badge beside "Statement". */
  affectedRows?: number;
  /** Optional preview: FK dependents — renders `from → FK → to` line(s) under the statement. */
  dependents?: readonly ConfirmRunDependent[];
  /** Optional escalated friction: the object name a user must type before Confirm enables. */
  objectName?: string;
};

/**
 * The footer button row — a plain function (NOT a component) so its `<button>`
 * elements inline directly into the returned tree, keeping the component
 * hook-free in the base case and directly invocable by the presentational tests.
 */
function footerButtons({
  busy,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  confirmDisabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-4 flex items-center gap-2.5 border-t border-[var(--border)] bg-[var(--muted)] px-5 pt-4 pb-[18px]">
      <button
        type="button"
        autoFocus
        disabled={busy}
        onClick={onCancel}
        aria-label="Cancel"
        className="inline-flex items-center gap-1.5 rounded-[20px] border border-[var(--border)] px-4 py-2 text-[12.5px] font-semibold text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Cancel
        <span className="rounded-[4px] border border-current px-1 font-mono text-[9.5px] opacity-65">Esc</span>
      </button>
      <span className="flex-1" />
      <button
        type="button"
        disabled={confirmDisabled}
        onClick={onConfirm}
        aria-label="Confirm"
        className="inline-flex items-center gap-1.5 rounded-[20px] border border-[var(--err)] bg-[var(--err-fill)] px-4 py-2 text-[12.5px] font-semibold text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Confirm</span>
      </button>
    </div>
  );
}

/**
 * The escalated type-to-confirm gate + footer. Owns its own typed-value state, so
 * it lives in a nested component: `ConfirmRun` itself stays hook-free in the base
 * case (all three callers), and this only mounts when `objectName` is supplied.
 * The match is CLIENT-SIDE friction only — the Core still authorizes execution.
 */
function TypeToConfirmSection({
  objectName,
  busy,
  onConfirm,
  onCancel,
}: {
  objectName: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState("");
  const match = typed.trim() === objectName;
  return (
    <>
      <div className="mt-3.5 px-5">
        <div className="mb-1.5 text-[12px] text-[var(--muted-foreground)]">
          Type{" "}
          <code className="rounded-[5px] bg-[var(--err-soft)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--err)]">
            {objectName}
          </code>{" "}
          to confirm.
        </div>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="object name"
          aria-label="type the object name to confirm"
          data-testid="confirm-run-ttc"
          className={`w-full rounded-[7px] border bg-[var(--muted)] px-3 py-2 font-mono text-[13px] text-[var(--foreground)] outline-none ${
            match ? "border-[var(--ok)]" : "border-[var(--border)] focus:border-[var(--err)]"
          }`}
        />
      </div>
      {footerButtons({ busy, confirmDisabled: busy || !match, onConfirm, onCancel })}
    </>
  );
}

export function ConfirmRun({
  sql,
  risk,
  busy,
  onConfirm,
  onCancel,
  affectedRows,
  dependents,
  objectName,
}: ConfirmRunProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-run-title"
        aria-describedby="confirm-run-sub"
        onKeyDown={(e) => {
          // Esc cancels from anywhere in the dialog (Cancel, Confirm, or the
          // type-to-confirm input) — but not mid-round-trip, matching the
          // `busy`-disables-Cancel behavior. Cancel executes nothing.
          if (e.key === "Escape" && !busy) onCancel();
        }}
        className="w-full max-w-[480px] overflow-hidden rounded-[12px] bg-[var(--card)] shadow-[0_24px_70px_-14px_rgba(0,0,0,0.55)] ring-1 ring-[var(--border)]"
      >
        {/* head: red danger icon + generic title + one-line risk description */}
        <div className="flex items-start gap-3 px-5 pt-[18px] pb-3.5">
          <div
            className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] bg-[var(--err-soft)] text-[var(--err)]"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className="h-[19px] w-[19px]">
              <path d="M12 3.2 1.8 20.4h20.4z" />
              <path d="M12 9.5v5" strokeLinecap="round" />
              <circle cx="12" cy="17.7" r=".2" strokeWidth={2.2} />
            </svg>
          </div>
          <div className="min-w-0">
            <div id="confirm-run-title" className="mt-px mb-1 text-[16px] font-semibold text-[var(--foreground)]">
              Confirm destructive statement
            </div>
            <div id="confirm-run-sub" className="text-[12.5px] leading-snug text-[var(--muted-foreground)]">
              {risk}
            </div>
          </div>
        </div>

        {/* body: statement label (+ optional affected badge), verbatim SQL, optional deps */}
        <div className="px-5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.11em] text-[var(--muted-foreground)]">
              Statement
            </span>
            {affectedRows !== undefined ? (
              <span
                data-testid="confirm-run-affected"
                className="inline-flex items-baseline gap-1.5 rounded-[6px] bg-[var(--err-soft)] px-2 py-0.5 font-mono text-[var(--err)]"
              >
                <span className="text-[14px] font-bold tabular-nums">{affectedRows}</span>
                <span className="text-[10.5px] opacity-85">row{affectedRows === 1 ? "" : "s"}</span>
              </span>
            ) : null}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[8px] border border-[var(--border)] border-l-2 border-l-[var(--err)] bg-[var(--background)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--foreground)]">
            {sql}
          </pre>

          {dependents !== undefined && dependents.length > 0 ? (
            <div className="mt-2.5" data-testid="confirm-run-deps">
              {dependents.map((dep, i) => (
                <div
                  key={`${dep.from}→${dep.to}#${i}`}
                  className="flex items-baseline gap-1.5 border-t border-[var(--border)] py-1 font-mono text-[12px] text-[var(--muted-foreground)] first:border-t-0"
                >
                  <span>{dep.from}</span>
                  <span className="text-[var(--muted-foreground)]">→ FK →</span>
                  <span className="text-[var(--t-int)]">{dep.to}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* footer: quiet Cancel (autofocus, Esc) + filled-red Confirm. The optional
            type-to-confirm variant owns the Confirm-disabled-until-typed friction. */}
        {objectName !== undefined
          ? <TypeToConfirmSection objectName={objectName} busy={busy} onConfirm={onConfirm} onCancel={onCancel} />
          : footerButtons({ busy, confirmDisabled: busy, onConfirm, onCancel })}
      </div>
    </div>
  );
}
