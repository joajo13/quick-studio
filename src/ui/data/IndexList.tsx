/**
 * quick-studio UI (Ring 2) — index list (IndexList).
 *
 * A thin, presentational read-only view over a table's introspected indexes
 * (Story 3.5). It renders one row per {@link SchemaIndexInfo}: the index name, its
 * columns in index order (`columns.join(", ")`), and a unique marker (the `⚿`
 * key glyph in `--t-key`) on unique indexes. It issues NO rpc and composes NO SQL —
 * the indexes arrive as a prop (already in the memoized `connect`/schema payload).
 *
 * It deliberately reuses `DataGrid`'s idioms: the mono font, the sticky header, the
 * `--coral-soft` hover, the `⚿`/`--t-key` marker, and the "0 rows"-style empty state
 * ("0 indexes"). The PK-backing index (`<table>_pkey` / `PRIMARY`) legitimately
 * appears here, marked unique — it is not filtered out.
 */

import type { SchemaIndexInfo } from "../../shared/contract.ts";

export function IndexList({
  indexes,
}: {
  /** The active table's introspected indexes (from its resolved SchemaTableInfo). */
  indexes: ReadonlyArray<SchemaIndexInfo>;
}): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto" style={{ fontFamily: "var(--font-mono)" }}>
      <table className="w-full border-collapse text-left" style={{ fontSize: "var(--data-cell-size)" }}>
        <thead className="sticky top-0 z-10">
          <tr className="bg-[var(--muted)]" style={{ borderBottom: "1px solid var(--border)" }}>
            <th scope="col" className="whitespace-nowrap px-3 py-1.5 align-bottom font-normal text-left">
              <span className="text-[var(--foreground)]">index</span>
            </th>
            <th scope="col" className="whitespace-nowrap px-3 py-1.5 align-bottom font-normal text-left">
              <span className="text-[var(--foreground)]">columns</span>
            </th>
            <th scope="col" className="whitespace-nowrap px-3 py-1.5 align-bottom font-normal text-left">
              <span className="text-[var(--foreground)]">unique</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {indexes.map((ix) => (
            <tr
              key={ix.name}
              className="transition-colors"
              style={{ borderBottom: "1px solid var(--border)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "var(--coral-soft)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "";
              }}
            >
              <td className="whitespace-nowrap px-3 py-1 text-[var(--foreground)]">
                <span className="flex items-center gap-1.5">
                  {ix.unique ? (
                    <span aria-label="unique index" title="unique index" style={{ color: "var(--t-key)" }}>
                      ⚿
                    </span>
                  ) : null}
                  <span>{ix.name}</span>
                </span>
              </td>
              <td className="whitespace-nowrap px-3 py-1 text-[var(--foreground)]">{ix.columns.join(", ")}</td>
              <td className="whitespace-nowrap px-3 py-1 text-[var(--muted-foreground)]">
                {ix.unique ? "unique" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {indexes.length === 0 ? (
        <div
          className="flex items-center justify-center px-3 py-6 lowercase text-[var(--muted-foreground)]"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--data-cell-size)" }}
        >
          0 indexes
        </div>
      ) : null}
    </div>
  );
}
