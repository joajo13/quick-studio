/**
 * quick-studio UI (Ring 2) — shared destructive-run confirm dialog (Story 3.6,
 * extracted in Story 5.3).
 *
 * Purely presentational — mirrors `DataGrid`'s delete confirm / `SettingsPanel`'s
 * remove-connection confirm (no modal framework): an inline amber panel with the
 * preview `risk` + `sql`, a confirm button and a cancel button (Esc also cancels).
 * The caller owns ALL state (which SQL is pending, `busy`, re-entrancy) and the gate
 * — this component never calls `execute` itself, it only reports the two intents.
 */

export function ConfirmRun({
  sql,
  risk,
  busy,
  onConfirm,
  onCancel,
}: {
  /** The exact SQL that was sent and is awaiting confirmation (frozen, not the draft). */
  sql: string;
  /** The Core's human-readable risk description from the `confirmation_required` preview. */
  risk: string;
  /** A confirm/cancel round-trip is in flight — both buttons disable to avoid a double-fire. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 border-b border-amber-700 bg-amber-950/40 px-3 py-2">
      <p className="font-mono text-xs lowercase text-amber-400">{risk}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-amber-200">{sql}</pre>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="rounded-[var(--radius)] border border-red-700 bg-red-600 px-2 py-0.5 font-mono text-xs lowercase text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          confirm
        </button>
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
