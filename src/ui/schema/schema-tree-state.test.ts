/**
 * quick-studio UI (Ring 2) — multi-root schema-tree state tests (Story 10.5).
 *
 * DOM-free, in the project convention (no jsdom / testing-library): every DECISION the
 * multi-root tree makes lives in `schema-tree-state.ts` precisely so it can be asserted
 * here, including this story's central guarantee — that one root's `loading → error`
 * transition leaves every other root's state REFERENCE-IDENTICAL. `renderToStaticMarkup`
 * never runs effects, so that could not be proven at the component level.
 */

import { describe, expect, test } from "bun:test";
import {
  errorReply,
  okReply,
  type ActiveConnectionInfo,
  type ConnectionSummary,
  type ConnectResult,
  type DatabaseSchema,
  type RpcReply,
  type SchemaTableInfo,
} from "../../shared/contract.ts";
import {
  autoExpandKeys,
  bootDescriptor,
  BOOT_ROOT_KEY,
  buildRoots,
  connectStateFromReply,
  groupBySchema,
  mergeTables,
  pruneByRoot,
  pruneSetByRoot,
  rootKey,
  schemaKey,
  shouldFetchOnExpand,
  tableKey,
  type RootState,
} from "./schema-tree-state.ts";

/** A minimal `SchemaTableInfo` — only the fields these assertions read actually vary. */
function table(schema: string, name: string, primaryKey: ReadonlyArray<string> = []): SchemaTableInfo {
  return { schema, name, columns: [], primaryKey, indexes: [], foreignKeys: [] };
}

function summary(id: string, name: string, extra: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return { id, name, host: `${name}.internal:5432`, engine: "postgres", ...extra };
}

const EPHEMERAL_BOOT: ActiveConnectionInfo = {
  mode: "ephemeral",
  connection: { engine: "postgres", host: "127.0.0.1:5433", database: "shop" },
  hasTarget: true,
};

const NO_BOOT: ActiveConnectionInfo = { mode: "persistent", connection: null, hasTarget: false };

/** Configured but undescribable (a hostless url) — IG-3/IG-B's one reachable case. */
const BROKEN_BOOT: ActiveConnectionInfo = {
  mode: "ephemeral",
  connection: null,
  hasTarget: true,
};

describe("buildRoots / bootDescriptor", () => {
  test("no boot target and zero saved connections yields NO roots (the empty-state trigger)", () => {
    expect(buildRoots(NO_BOOT, [])).toEqual([]);
    expect(bootDescriptor(NO_BOOT)).toBeNull();
    // A failed `connection.active` degrades to "no boot target", never to a phantom root.
    expect(bootDescriptor(null)).toBeNull();
  });

  test("no boot target and N saved connections yields N roots in registry order", () => {
    const roots = buildRoots(NO_BOOT, [summary("a", "alpha"), summary("b", "beta"), summary("c", "gamma")]);
    expect(roots.map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(roots.map((r) => r.connectionId)).toEqual(["a", "b", "c"]);
    expect(roots.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  test("a boot target is pinned FIRST, ahead of the M saved connections", () => {
    const roots = buildRoots(EPHEMERAL_BOOT, [summary("a", "alpha"), summary("b", "beta")]);
    expect(roots).toHaveLength(3);
    expect(roots[0]?.connectionId).toBeNull();
    expect(roots[0]?.key).toBe(BOOT_ROOT_KEY);
    expect(roots.slice(1).map((r) => r.connectionId)).toEqual(["a", "b"]);
  });

  test("the boot root's name falls back database → host → the sentinel", () => {
    expect(bootDescriptor(EPHEMERAL_BOOT)?.name).toBe("shop");
    const pathless: ActiveConnectionInfo = {
      mode: "ephemeral",
      connection: { engine: "mysql", host: "10.0.4.7:3306" },
      hasTarget: true,
    };
    expect(bootDescriptor(pathless)?.name).toBe("10.0.4.7:3306");
    // Configured but undescribable: still a root (that is the whole point of `hasTarget`),
    // just with no engine/host to render — its own `connect` supplies the verdict.
    const broken = bootDescriptor(BROKEN_BOOT);
    expect(broken).not.toBeNull();
    expect(broken?.engine).toBe("");
    expect(broken?.host).toBe("");
  });

  test("`pinnedSchema` is carried ONLY when the summary actually has a pin", () => {
    const roots = buildRoots(NO_BOOT, [summary("a", "alpha"), summary("b", "billing", { schema: "finance" })]);
    expect(roots[0]?.pinnedSchema).toBeUndefined();
    expect("pinnedSchema" in (roots[0] ?? {})).toBe(false);
    expect(roots[1]?.pinnedSchema).toBe("finance");
  });
});

describe("key namespacing", () => {
  test("rootKey maps the boot target onto the sentinel and a saved id onto itself", () => {
    expect(rootKey(null)).toBe(BOOT_ROOT_KEY);
    expect(rootKey("2f1c-uuid")).toBe("2f1c-uuid");
  });

  test("the SAME schema.table under two roots produces two DIFFERENT keys", () => {
    const a = tableKey(rootKey("conn-a"), "public", "orders");
    const b = tableKey(rootKey("conn-b"), "public", "orders");
    const boot = tableKey(rootKey(null), "public", "orders");
    expect(new Set([a, b, boot]).size).toBe(3);
    expect(schemaKey(rootKey("conn-a"), "public")).not.toBe(schemaKey(rootKey("conn-b"), "public"));
  });
});

describe("groupBySchema", () => {
  test("groups a multi-schema payload preserving first-seen schema and table order", () => {
    const groups = groupBySchema([
      table("public", "events"),
      table("auth", "users"),
      table("public", "sessions"),
      table("reporting", "revenue_by_country"),
      table("auth", "tokens"),
    ]);
    expect(groups.map((g) => g.schema)).toEqual(["public", "auth", "reporting"]);
    expect(groups[0]?.tables.map((t) => t.name)).toEqual(["events", "sessions"]);
    expect(groups[1]?.tables.map((t) => t.name)).toEqual(["users", "tokens"]);
  });

  test("an empty payload groups to nothing", () => {
    expect(groupBySchema([])).toEqual([]);
  });
});

describe("mergeTables (regression parity with the single-root tree)", () => {
  test("returns the SAME reference when there is nothing extra to merge", () => {
    const loaded = [table("public", "orders")];
    expect(mergeTables(loaded, [])).toBe(loaded);
  });

  test("appends only genuinely-new optimistic entries, introspection order preserved", () => {
    const loaded = [table("public", "orders"), table("public", "customers")];
    const merged = mergeTables(loaded, [table("public", "customers"), table("public", "drafts")]);
    expect(merged.map((t) => t.name)).toEqual(["orders", "customers", "drafts"]);
  });

  test("introspected truth wins over an optimistic duplicate of the same schema.name", () => {
    const loaded = [table("public", "orders", ["id"])];
    const merged = mergeTables(loaded, [table("public", "orders", [])]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.primaryKey).toEqual(["id"]);
  });

  test("a same NAME in a different SCHEMA is not a duplicate", () => {
    const merged = mergeTables([table("public", "orders")], [table("staging", "orders")]);
    expect(merged.map((t) => `${t.schema}.${t.name}`)).toEqual(["public.orders", "staging.orders"]);
  });
});

describe("connectStateFromReply", () => {
  const SCHEMA: DatabaseSchema = { engine: "postgres", tables: [table("public", "orders")] };

  test("a transport envelope becomes an error carrying the terse envelope text", () => {
    const state = connectStateFromReply(errorReply("internal_error", "request failed"));
    expect(state.kind).toBe("error");
    if (state.kind === "error") expect(state.text).toBe("internal_error: request failed");
  });

  test("every classified driver failure becomes an error — never ready, never a calm empty", () => {
    for (const failure of ["host", "auth", "network", "no-target"] as const) {
      const reply: RpcReply<ConnectResult> = okReply({
        status: "failed",
        failure,
        message: "could not reach the database",
      });
      const state = connectStateFromReply(reply);
      expect(state.kind).toBe("error");
      // A root only EXISTS because a target did, so even `no-target` is a real per-root
      // error here (the connection was removed mid-session) — not the empty-state.
      if (state.kind === "error") expect(state.text).toBe(`${failure}: could not reach the database`);
    }
  });

  test("a connected reply becomes ready carrying THAT reply's schema", () => {
    const state = connectStateFromReply(okReply<ConnectResult>({ status: "connected", schema: SCHEMA }));
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") expect(state.schema).toBe(SCHEMA);
  });
});

describe("shouldFetchOnExpand", () => {
  test("only an idle root fetches — a cached ready/error root never re-introspects", () => {
    expect(shouldFetchOnExpand({ kind: "idle" })).toBe(true);
    expect(shouldFetchOnExpand({ kind: "loading" })).toBe(false);
    expect(shouldFetchOnExpand({ kind: "ready", schema: { engine: "postgres", tables: [] } })).toBe(false);
    // No AUTOMATIC re-attempt against an unreachable host: only "Reintentar" bypasses this.
    expect(shouldFetchOnExpand({ kind: "error", text: "auth: rejected" })).toBe(false);
  });
});

describe("autoExpandKeys", () => {
  test("a single-schema root auto-expands its one schema (no forced double-click)", () => {
    const groups = groupBySchema([table("public", "orders"), table("public", "customers")]);
    expect(autoExpandKeys(BOOT_ROOT_KEY, groups)).toEqual([schemaKey(BOOT_ROOT_KEY, "public")]);
  });

  test("a pinned-schema root behaves the same — it is just a one-schema payload", () => {
    const groups = groupBySchema([table("finance", "invoices"), table("finance", "ledger")]);
    expect(autoExpandKeys("conn-b", groups)).toEqual(["conn-b::finance"]);
  });

  test("a multi-schema root stays collapsed", () => {
    const groups = groupBySchema([table("public", "events"), table("auth", "users")]);
    expect(autoExpandKeys("conn-a", groups)).toEqual([]);
  });

  test("an empty payload expands nothing", () => {
    expect(autoExpandKeys("conn-a", [])).toEqual([]);
  });
});

describe("registry-refresh reconciliation (IG-A)", () => {
  test("a removed root's cached state is dropped and every survivor is left untouched", () => {
    const readyA: RootState = { kind: "ready", schema: { engine: "postgres", tables: [] } };
    const errorB: RootState = { kind: "error", text: "auth: rejected" };
    const states = new Map<string, RootState>([
      [BOOT_ROOT_KEY, { kind: "ready", schema: { engine: "mysql", tables: [] } }],
      ["conn-a", readyA],
      ["conn-b", errorB],
    ]);
    // `conn-b` was removed in Settings; boot + `conn-a` survive.
    const pruned = pruneByRoot(states, new Set([BOOT_ROOT_KEY, "conn-a"]));
    expect(pruned.has("conn-b")).toBe(false);
    // Survivors keep the very same value — a refresh cannot re-introspect or blank them.
    expect(pruned.get("conn-a")).toBe(readyA);
    expect(pruned.size).toBe(2);
    // Adding a connection prunes nothing: the same reference comes back.
    expect(pruneByRoot(states, new Set([BOOT_ROOT_KEY, "conn-a", "conn-b", "conn-new"]))).toBe(states);
  });

  test("expansion Sets are pruned by the ROOT part of their namespaced key", () => {
    const expanded = new Set([
      BOOT_ROOT_KEY,
      "conn-a",
      schemaKey("conn-a", "public"),
      tableKey("conn-a", "public", "orders"),
      schemaKey("conn-b", "public"),
      tableKey("conn-b", "public", "orders"),
    ]);
    const live = new Set([BOOT_ROOT_KEY, "conn-a"]);
    const pruned = pruneSetByRoot(expanded, live);
    expect([...pruned].sort()).toEqual(
      [BOOT_ROOT_KEY, "conn-a", "conn-a::public", "conn-a::public.orders"].sort(),
    );
    // Nothing dead ⇒ the same reference (no needless re-render).
    expect(pruneSetByRoot(expanded, new Set([BOOT_ROOT_KEY, "conn-a", "conn-b"]))).toBe(expanded);
  });
});

describe("per-root isolation", () => {
  test("driving root A idle → loading → error leaves B and C reference-identical throughout", () => {
    const readyB: RootState = { kind: "ready", schema: { engine: "postgres", tables: [table("public", "x")] } };
    const idleC: RootState = { kind: "idle" };
    let states: ReadonlyMap<string, RootState> = new Map([
      ["conn-a", { kind: "idle" } as RootState],
      ["conn-b", readyB],
      ["conn-c", idleC],
    ]);

    // Exactly the writes the component performs: a functional update touching ONE key.
    states = new Map(states).set("conn-a", { kind: "loading" });
    expect(states.get("conn-b")).toBe(readyB);
    expect(states.get("conn-c")).toBe(idleC);

    states = new Map(states).set(
      "conn-a",
      connectStateFromReply(okReply<ConnectResult>({ status: "failed", failure: "auth", message: "rejected" })),
    );
    expect(states.get("conn-a")?.kind).toBe("error");
    // The whole point: one bad connection can never tank the tree.
    expect(states.get("conn-b")).toBe(readyB);
    expect(states.get("conn-c")).toBe(idleC);
    expect(shouldFetchOnExpand(states.get("conn-c") ?? { kind: "idle" })).toBe(true);
  });
});
