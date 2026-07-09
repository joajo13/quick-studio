/**
 * quick-studio UI (Ring 2) — result grid (DataGrid).
 *
 * A thin, presentational view over a {@link FrozenData} page (Story 3.2). It owns
 * no pagination/selection logic — that lives in the pure `data-grid-state` module;
 * the grid just renders. Per DESIGN.md: sticky mono type-colored headers with a PK
 * key-icon, single-select rows with an inset coral left-marker, hover tint,
 * tabular-nums numeric cells, and a "0 rows" empty state (headers still shown).
 */

import type { FrozenCell, FrozenColumn, FrozenData } from "../../shared/contract.ts";

/** Map a neutral column type to its DESIGN.md `t-*` color var + a short SQL-ish label. */
function typeMeta(type: FrozenColumn["type"]): { readonly color: string; readonly label: string } {
  switch (type) {
    case "number":
      return { color: "var(--t-int)", label: "num" };
    case "date":
      return { color: "var(--t-time)", label: "time" };
    case "boolean":
      return { color: "var(--t-bool)", label: "bool" };
    default:
      return { color: "var(--t-text)", label: "text" };
  }
}

/** Render one tagged cell. Numeric right-aligned tabular; NULL faint italic. */
function Cell({ cell, numeric }: { cell: FrozenCell; numeric: boolean }): React.JSX.Element {
  if (cell.kind === "null") {
    return <span className="italic text-[color:var(--t-text)] opacity-60">null</span>;
  }
  if (cell.kind === "number") {
    return <span className="tabular-nums text-[color:var(--t-int)]">{cell.value}</span>;
  }
  if (cell.kind === "boolean") {
    return <span className="text-[color:var(--t-bool)]">{cell.value ? "true" : "false"}</span>;
  }
  if (cell.kind === "date") {
    return <span className="text-[color:var(--t-time)]">{cell.iso}</span>;
  }
  return <span className={numeric ? "tabular-nums" : undefined}>{cell.value}</span>;
}

export function DataGrid({
  data,
  primaryKeys,
  selectedRow,
  onSelectRow,
}: {
  data: FrozenData;
  primaryKeys: ReadonlyArray<string>;
  selectedRow: number | null;
  onSelectRow: (index: number) => void;
}): React.JSX.Element {
  const pkSet = new Set(primaryKeys);

  return (
    <div className="min-h-0 flex-1 overflow-auto" style={{ fontFamily: "var(--font-mono)" }}>
      <table className="w-full border-collapse text-left" style={{ fontSize: "var(--data-cell-size)" }}>
        <thead className="sticky top-0 z-10">
          <tr className="bg-[var(--muted)]" style={{ borderBottom: "1px solid var(--border)" }}>
            {data.columns.map((col) => {
              const meta = typeMeta(col.type);
              const isPk = pkSet.has(col.name);
              const numeric = col.type === "number";
              return (
                <th
                  key={col.name}
                  scope="col"
                  className={`whitespace-nowrap px-3 py-1.5 align-bottom font-normal ${numeric ? "text-right" : "text-left"}`}
                >
                  <div className={`flex items-center gap-1.5 ${numeric ? "justify-end" : ""}`}>
                    {isPk ? (
                      <span aria-label="primary key" title="primary key" style={{ color: "var(--t-key)" }}>
                        ⚿
                      </span>
                    ) : null}
                    <span className="text-[var(--foreground)]">{col.name}</span>
                  </div>
                  <div
                    className="uppercase"
                    style={{ color: meta.color, fontSize: "var(--label-size)", letterSpacing: "0.08em" }}
                  >
                    {meta.label}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, r) => {
            const selected = selectedRow === r;
            return (
              <tr
                key={r}
                onClick={() => onSelectRow(r)}
                className="cursor-pointer transition-colors"
                style={{
                  backgroundColor: selected ? "var(--coral-soft)" : undefined,
                  boxShadow: selected ? "inset 2px 0 0 var(--coral)" : undefined,
                  borderBottom: "1px solid var(--border)",
                }}
                onMouseEnter={(e) => {
                  if (!selected) e.currentTarget.style.backgroundColor = "var(--coral-soft)";
                }}
                onMouseLeave={(e) => {
                  if (!selected) e.currentTarget.style.backgroundColor = "";
                }}
              >
                {row.map((cell, c) => {
                  const numeric = data.columns[c]?.type === "number";
                  return (
                    <td
                      key={c}
                      className={`whitespace-nowrap px-3 py-1 text-[var(--foreground)] ${numeric ? "text-right" : "text-left"}`}
                    >
                      <Cell cell={cell} numeric={numeric} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {data.rows.length === 0 ? (
        <div
          className="flex items-center justify-center px-3 py-6 lowercase text-[var(--muted-foreground)]"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--data-cell-size)" }}
        >
          0 rows
        </div>
      ) : null}
    </div>
  );
}
