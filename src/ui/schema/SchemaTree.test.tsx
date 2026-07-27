/**
 * quick-studio UI (Ring 2) — multi-root SchemaTree render tests (Story 10.5).
 *
 * Project convention (no jsdom / testing-library): the RPC client is replaced via
 * `mock.module` BEFORE the module under test is dynamically imported (as in
 * `ChatTabView.test.tsx`), and structure is asserted with `renderToStaticMarkup` over
 * static fixtures (as in `ErdTabView.test.tsx`). Because `renderToStaticMarkup` never
 * runs effects, the per-root VISUAL states are asserted through the exported
 * presentational `ConnectionRoot` with explicit props — that is exactly why it is
 * exported. The decision logic behind those states lives in `schema-tree-state.test.ts`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { errorReply, type RpcReply, type SchemaRelationKind, type SchemaTableInfo } from "../../shared/contract.ts";
import type { RootDescriptor, RootState } from "./schema-tree-state.ts";
import { BOOT_ROOT_KEY, schemaKey, tableKey } from "./schema-tree-state.ts";

// Mock the RPC client BEFORE the module under test is imported — the tree calls `rpc`
// (connection.active / connections.list) from a mount EFFECT, which static rendering
// never runs; the stub is what proves that (see the zero-call assertion below).
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<unknown>> =>
    errorReply("internal_error", "unset"),
);
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));

const { ConnectionRoot, SchemaTree } = await import("./SchemaTree.tsx");

beforeEach(() => {
  rpcMock.mockClear();
});

function table(
  schema: string,
  name: string,
  columns: ReadonlyArray<{ name: string; dataType: string }> = [],
  primaryKey: ReadonlyArray<string> = [],
  kind?: SchemaRelationKind,
): SchemaTableInfo {
  return {
    schema,
    name,
    columns: columns.map((c) => ({ ...c, nullable: false })),
    primaryKey,
    indexes: [],
    foreignKeys: [],
    ...(kind === undefined ? {} : { kind }),
  };
}

const SAVED: RootDescriptor = {
  connectionId: "conn-a",
  key: "conn-a",
  name: "analytics",
  engine: "postgres",
  host: "warehouse:5432",
};

const BOOT: RootDescriptor = {
  connectionId: null,
  key: BOOT_ROOT_KEY,
  name: "shop",
  engine: "postgres",
  host: "127.0.0.1:5433",
};

const MULTI_SCHEMA: RootState = {
  kind: "ready",
  schema: {
    engine: "postgres",
    tables: [
      table("public", "events"),
      table("public", "sessions"),
      table("auth", "users"),
      table("reporting", "revenue_by_country"),
    ],
  },
};

/** Render one root with everything collapsed unless the caller says otherwise. */
function renderRoot(
  descriptor: RootDescriptor,
  state: RootState,
  opts: {
    open?: boolean;
    expandedSchemas?: ReadonlyArray<string>;
    expandedTables?: ReadonlyArray<string>;
    activeTable?: { schema: string; name: string; connectionId?: string | null } | null;
    extraTables?: ReadonlyArray<SchemaTableInfo>;
  } = {},
): string {
  return renderToStaticMarkup(
    <ul>
      <ConnectionRoot
        descriptor={descriptor}
        state={state}
        open={opts.open ?? false}
        expandedSchemas={new Set(opts.expandedSchemas ?? [])}
        expandedTables={new Set(opts.expandedTables ?? [])}
        activeTable={opts.activeTable ?? null}
        extraTables={opts.extraTables ?? []}
        onToggleRoot={() => {}}
        onToggleSchema={() => {}}
        onRetry={() => {}}
        onActivate={() => {}}
      />
    </ul>,
  );
}

describe("ConnectionRoot — collapsed idle", () => {
  test("renders the name, engine badge and host, collapsed, with a muted dot and no tables", () => {
    const out = renderRoot(SAVED, { kind: "idle" });
    expect(out).toContain("analytics");
    expect(out).toContain("postgres");
    expect(out).toContain("warehouse:5432");
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('role="button"');
    expect(out).toContain('tabindex="0"');
    // Idle = muted, never the ok/err dot.
    expect(out).toContain("bg-muted-foreground");
    expect(out).not.toContain("bg-ok");
    expect(out).not.toContain("bg-err");
    // Nothing below the header until the user expands it.
    expect(out).not.toContain("introspecting…");
    expect(out).not.toContain("Reintentar");
  });

  test("a ready-but-COLLAPSED root shows its ok dot and still renders no table markup", () => {
    const out = renderRoot(SAVED, MULTI_SCHEMA, { open: false });
    expect(out).toContain("bg-ok");
    expect(out).not.toContain("events");
    // The `default` BADGE specifically — a bare "default" substring also matches the
    // `cursor-default` utility on an expanded table's column rows.
    expect(out).not.toContain(">default</span>");
  });
});

describe("ConnectionRoot — loading", () => {
  test("renders `introspecting…` and a pulsing dot that respects prefers-reduced-motion", () => {
    const out = renderRoot(SAVED, { kind: "loading" }, { open: true });
    expect(out).toContain("introspecting…");
    expect(out).toContain("animate-pulse");
    expect(out).toContain("motion-reduce:animate-none");
    expect(out).toContain('aria-expanded="true"');
  });
});

describe("ConnectionRoot — error", () => {
  test("renders the classified message plus Reintentar, and NO schema/table nodes", () => {
    const out = renderRoot(SAVED, { kind: "error", text: "auth: password authentication failed" }, { open: true });
    expect(out).toContain("auth: password authentication failed");
    expect(out).toContain("Reintentar");
    expect(out).toContain('role="alert"');
    // The err dot + err text ride the tokens, never a raw Tailwind red.
    expect(out).toContain("bg-err");
    expect(out).toContain("text-err");
    expect(out).not.toContain(">default</span>");
    expect(out).not.toContain("no tables");
  });
});

describe("ConnectionRoot — ready", () => {
  test("a multi-schema root renders one COLLAPSED schema node per schema with its table count", () => {
    const out = renderRoot(SAVED, MULTI_SCHEMA, { open: true });
    expect(out).toContain("public");
    expect(out).toContain("auth");
    expect(out).toContain("reporting");
    // `default` tags `public` and only `public`. Matched on the badge's own markup, not a
    // bare substring — `cursor-default` on an expanded table's columns matches that too,
    // so the loose form would silently stop measuring the badge the moment a fixture grew.
    expect(out.match(/>default<\/span>/g) ?? []).toHaveLength(1);
    // Collapsed schemas render no tables.
    expect(out).not.toContain("events");
    expect(out).not.toContain("users");
    // Per-schema counts: public 2, auth 1, reporting 1.
    expect(out).toContain(">2</span>");
  });

  test("a BLANK schema name renders as `(default)` rather than a nameless node", () => {
    // The shape an optimistically-created table carries when it was created without an
    // explicit schema (the connection's default namespace). Rendered raw it produced a
    // clickable row with no label and an empty tooltip.
    const blank: RootState = {
      kind: "ready",
      schema: { engine: "postgres", tables: [table("", "drafts")] },
    };
    const out = renderRoot(BOOT, blank, { open: true });
    expect(out).toContain("(default)");
    expect(out).toContain('title="(default)"');
    // Not the `public` badge — a blank schema is unnamed, not the default-named one.
    expect(out).not.toContain(">default</span>");
  });

  test("an expanded schema renders its keyboard-operable table rows", () => {
    const out = renderRoot(SAVED, MULTI_SCHEMA, {
      open: true,
      expandedSchemas: [schemaKey("conn-a", "auth")],
    });
    expect(out).toContain("users");
    // Still collapsed, so `public`'s tables stay hidden — schema visibility is per-node.
    expect(out).not.toContain("events");
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('tabindex="0"');
  });

  test("an expanded TABLE discloses its columns with the PK in the key token", () => {
    const state: RootState = {
      kind: "ready",
      schema: {
        engine: "postgres",
        tables: [
          table("public", "orders", [
            { name: "id", dataType: "bigint" },
            { name: "placed_at", dataType: "timestamptz" },
          ], ["id"]),
        ],
      },
    };
    const out = renderRoot(SAVED, state, {
      open: true,
      expandedSchemas: [schemaKey("conn-a", "public")],
      expandedTables: [tableKey("conn-a", "public", "orders")],
    });
    expect(out).toContain("placed_at");
    expect(out).toContain("timestamptz");
    // PK column: key dot + key ink. Non-PK keeps its derived type-dot bucket.
    expect(out).toContain("bg-t-key");
    expect(out).toContain("text-t-key");
    expect(out).toContain("bg-t-time");
  });

  test("the active-row highlight is exact: the same schema.table in ANOTHER root stays off", () => {
    const state: RootState = {
      kind: "ready",
      schema: { engine: "postgres", tables: [table("public", "orders")] },
    };
    const opts = { open: true, expandedSchemas: [schemaKey("conn-a", "public")] };
    const bootOpts = { open: true, expandedSchemas: [schemaKey(BOOT_ROOT_KEY, "public")] };
    const activeHere = { schema: "public", name: "orders", connectionId: "conn-a" };
    expect(renderRoot(SAVED, state, { ...opts, activeTable: activeHere })).toContain('aria-pressed="true"');
    // Same name, other root (and the boot root, whose id is null) — not pressed.
    expect(renderRoot(BOOT, state, { ...bootOpts, activeTable: activeHere })).toContain('aria-pressed="false"');
  });

  test("a zero-table root renders the `no tables` placeholder", () => {
    const out = renderRoot(SAVED, { kind: "ready", schema: { engine: "postgres", tables: [] } }, { open: true });
    expect(out).toContain("no tables");
  });

  test("a pinned root renders the pin badge on its header", () => {
    const out = renderRoot({ ...SAVED, name: "billing", pinnedSchema: "finance" }, { kind: "idle" });
    expect(out).toContain("finance");
    expect(out).toContain("bg-coral-soft");
  });
});

describe("ConnectionRoot — extraTables scoping (DW-41)", () => {
  const READY: RootState = {
    kind: "ready",
    schema: { engine: "postgres", tables: [table("public", "orders")] },
  };
  const created = [table("public", "drafts")];

  test("optimistically-created tables merge into the BOOT root", () => {
    const out = renderRoot(BOOT, READY, {
      open: true,
      expandedSchemas: [schemaKey(BOOT_ROOT_KEY, "public")],
      extraTables: created,
    });
    expect(out).toContain("drafts");
  });

  test("…and never leak into a saved-connection root", () => {
    const out = renderRoot(SAVED, READY, {
      open: true,
      expandedSchemas: [schemaKey("conn-a", "public")],
      extraTables: created,
    });
    expect(out).toContain("orders");
    expect(out).not.toContain("drafts");
  });
});

describe("ConnectionRoot — view icon (DW-68)", () => {
  // The mockup's `viewSvg` eye path and the existing `TableIcon`'s rect — the two glyphs
  // this feature branches between.
  const VIEW_PATH = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z";
  const VIEW_PUPIL = 'cx="12" cy="12" r="2.5"';
  const TABLE_RECT = 'x="3" y="4" width="18" height="16" rx="1.5"';
  // EXACT, not a substring: an appended utility (`… text-t-json text-coral`) would still
  // satisfy a `toContain("text-t-json")`, and Tailwind's later-wins order would silently
  // turn the glyph coral. This pins the whole class attribute.
  const VIEW_ICON_CLASS = 'class="h-3.5 w-3.5 shrink-0 text-t-json"';

  function withKind(kind?: SchemaRelationKind): RootState {
    return {
      kind: "ready",
      schema: { engine: "postgres", tables: [table("public", "widgets", [], [], kind)] },
    };
  }

  /** Slice one table row out of the markup so a glyph assertion binds to THAT row. */
  function rowOf(markup: string, title: string): string {
    const start = markup.indexOf(`title="${title}"`);
    expect(start).toBeGreaterThan(-1);
    return markup.slice(start, markup.indexOf("</div>", start));
  }

  test("a view relation renders the eye glyph in text-t-json, no table rect, and `title` ends `· vista`", () => {
    const out = renderRoot(SAVED, withKind("view"), {
      open: true,
      expandedSchemas: [schemaKey("conn-a", "public")],
    });
    expect(out).toContain(VIEW_PATH);
    // The pupil is half the mockup's glyph — without this an SVG-minifying pass could
    // drop it and degrade the eye to a bare lens outline with the suite still green.
    expect(out).toContain(VIEW_PUPIL);
    expect(out).toContain(VIEW_ICON_CLASS);
    expect(out).not.toContain(TABLE_RECT);
    expect(out).toContain('title="public.widgets · vista"');
    // `title` is only a LAST-RESORT accessible name: name-from-content wins on this
    // `role="button"` row, so the tooltip alone never reaches a screen reader.
    expect(out).toContain('<span class="sr-only">vista</span>');
  });

  test("an ACTIVE view keeps its teal eye (never text-coral) while the row itself highlights", () => {
    const out = renderRoot(SAVED, withKind("view"), {
      open: true,
      expandedSchemas: [schemaKey("conn-a", "public")],
      activeTable: { schema: "public", name: "widgets", connectionId: "conn-a" },
    });
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("bg-coral-soft text-coral");
    expect(out).toContain(VIEW_PATH);
    // Unconditional teal. Asserted on the EXACT class attribute — the row itself carries
    // `text-coral`, so a bare `not.toContain("text-coral")` could never see the glyph.
    expect(out).toContain(VIEW_ICON_CLASS);
  });

  test("a base table (`kind: \"table\"`) keeps today's glyph and the bare `schema.name` title", () => {
    const out = renderRoot(SAVED, withKind("table"), {
      open: true,
      expandedSchemas: [schemaKey("conn-a", "public")],
    });
    expect(out).toContain(TABLE_RECT);
    expect(out).not.toContain(VIEW_PATH);
    expect(out).toContain('title="public.widgets"');
  });

  test("an ABSENT `kind` takes the conservative table-glyph arm, bare title", () => {
    const out = renderRoot(SAVED, withKind(undefined), {
      open: true,
      expandedSchemas: [schemaKey("conn-a", "public")],
    });
    expect(out).toContain(TABLE_RECT);
    expect(out).not.toContain(VIEW_PATH);
    expect(out).toContain('title="public.widgets"');
  });

  test("`kind: \"other\"` also keeps the table glyph — the mockup has no third glyph", () => {
    const out = renderRoot(SAVED, withKind("other"), {
      open: true,
      expandedSchemas: [schemaKey("conn-a", "public")],
    });
    expect(out).toContain(TABLE_RECT);
    expect(out).not.toContain(VIEW_PATH);
    expect(out).toContain('title="public.widgets"');
  });

  test("a mixed schema (one view, one table) renders both glyphs side by side, each exactly once", () => {
    const state: RootState = {
      kind: "ready",
      schema: {
        engine: "postgres",
        tables: [table("public", "orders", [], [], "table"), table("public", "revenue_view", [], [], "view")],
      },
    };
    const out = renderRoot(SAVED, state, { open: true, expandedSchemas: [schemaKey("conn-a", "public")] });
    expect(out.split(TABLE_RECT).length - 1).toBe(1);
    expect(out.split(VIEW_PATH).length - 1).toBe(1);
    // Counting alone survives a fully INVERTED branch (each glyph still appears once), so
    // bind each glyph to its own row.
    expect(rowOf(out, "public.orders")).toContain(TABLE_RECT);
    expect(rowOf(out, "public.orders")).not.toContain(VIEW_PATH);
    expect(rowOf(out, "public.revenue_view · vista")).toContain(VIEW_PATH);
    expect(rowOf(out, "public.revenue_view · vista")).not.toContain(TABLE_RECT);
  });
});

describe("SchemaTree", () => {
  test("renders without issuing a single RPC (every fetch lives in an effect)", () => {
    const out = renderToStaticMarkup(<SchemaTree activeTable={null} onActivate={() => {}} />);
    // The panel lists CONNECTIONS since Story 10.5 — the label tracks its visible header.
    expect(out).toContain('aria-label="Connections"');
    expect(out).toContain("connections");
    // The no-handshake-storm guarantee's render-level proxy: nothing fires at render time.
    expect(rpcMock).toHaveBeenCalledTimes(0);
  });

  test("carries no raw Tailwind red anywhere (DW-54 — the shell reds are tokenized)", () => {
    const out = renderToStaticMarkup(<SchemaTree activeTable={null} onActivate={() => {}} />);
    expect(out).not.toContain("red-400");
    expect(out).not.toContain("red-500");
    const errorRoot = renderRoot(SAVED, { kind: "error", text: "network: unreachable" }, { open: true });
    expect(errorRoot).not.toContain("red-400");
    expect(errorRoot).not.toContain("red-500");
  });
});
