/**
 * Unit tests for the Live Report browser runtime (Story 6.4) — DOM-free, injected `LiveDeps`
 * + a fake mount host (this repo has no jsdom). Covers the pure cores (`renderResultBlock`,
 * `buildExecuteParams`, `classifyReply`) and the orchestration: no token → zero `rpc` + inert
 * fallback; `rows` → rendered; `confirm` → inert note never re-issued `confirmed:true`; a
 * block's `rpc` error → inline note while siblings still run; `connections.list` failure →
 * top-level error; a hostile returned cell/column renders inert.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  FROZEN_SCHEMA_VERSION,
  okReply,
  errorReply,
  type ConnectionSummary,
  type FrozenData,
  type RpcReply,
} from "../shared/contract.ts";
import { LIVE_REPORT_SCHEMA_VERSION, type LiveReportBlock, type LiveReportDoc } from "../shared/live-report.ts";
import {
  buildExecuteParams,
  CANNOT_REACH_BLOCK_NOTE,
  CANNOT_REACH_HTML,
  classifyReply,
  CONFIRM_NOTE,
  makeDomHost,
  NEEDS_QS_HTML,
  renderResultBlock,
  runLiveReport,
  type BlockSlot,
  type LiveDeps,
  type LiveHost,
} from "./runtime.ts";

type LiveQueryBlock = Extract<LiveReportBlock, { kind: "query" }>;

const numData: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "k", type: "number" },
    { name: "v", type: "number" },
  ],
  rows: [[{ kind: "number", value: 1 }, { kind: "number", value: 10 }]],
};

function qb(overrides: Partial<LiveQueryBlock> = {}): LiveQueryBlock {
  return { kind: "query", sql: "select k, v", view: "table", chart: null, ...overrides };
}

/** A fake slot recording everything appended (no DOM). */
type FakeSlot = BlockSlot & {
  readonly htmls: string[];
  readonly charts: unknown[];
  readonly notes: string[];
  readonly errors: string[];
  clears: number;
};
function fakeSlot(): FakeSlot {
  const htmls: string[] = [];
  const charts: unknown[] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  const slot: FakeSlot = {
    htmls,
    charts,
    notes,
    errors,
    clears: 0,
    clear: () => {
      slot.clears += 1;
    },
    appendHtml: (h) => htmls.push(h),
    appendChart: (o) => charts.push(o),
    appendNote: (t) => notes.push(t),
    appendError: (m) => errors.push(m),
  };
  return slot;
}

/** A fake host recording status + slots + the picker/refresh callbacks. */
function fakeHost() {
  const statuses: string[] = [];
  const slots: FakeSlot[] = [];
  // The picker is REPLACEABLE (DW-52): record the connections + selectedId of the LATEST render.
  let pickerConnections: ReadonlyArray<ConnectionSummary> = [];
  let pickerSelectedId: string | null = null;
  let pickerRenders = 0;
  let pick: ((id: string | null) => void) | null = null;
  let refresh: (() => void) | null = null;
  const host: LiveHost = {
    setStatus: (html) => statuses.push(html),
    renderPicker: (connections, selectedId, onPick) => {
      pickerConnections = connections;
      pickerSelectedId = selectedId;
      pickerRenders += 1;
      pick = onPick;
    },
    renderRefresh: (onRefresh) => {
      refresh = onRefresh;
    },
    addBlock: () => {
      const s = fakeSlot();
      slots.push(s);
      return s;
    },
  };
  return {
    host,
    statuses,
    slots,
    get pickerConnections() {
      return pickerConnections;
    },
    get pickerSelectedId() {
      return pickerSelectedId;
    },
    get pickerRenders() {
      return pickerRenders;
    },
    get pick() {
      return pick;
    },
    get refresh() {
      return refresh;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Pure cores
 * ------------------------------------------------------------------ */

describe("buildExecuteParams", () => {
  test("id-only, null default, carries the sql and shape raw, NO confirmed", () => {
    expect(buildExecuteParams(qb({ sql: "select 1" }), null)).toEqual({
      shape: "raw",
      sql: "select 1",
      connectionId: null,
    });
    expect(buildExecuteParams(qb({ sql: "select 1" }), "conn-b")).toEqual({
      shape: "raw",
      sql: "select 1",
      connectionId: "conn-b",
    });
  });
});

describe("classifyReply", () => {
  test("rows / confirm / ok / error", () => {
    expect(classifyReply(okReply({ status: "rows", data: numData, truncated: true }))).toEqual({
      kind: "rows",
      data: numData,
      truncated: true,
    });
    expect(classifyReply(okReply({ status: "confirmation_required", preview: { sql: "x", risk: "y" } })).kind).toBe(
      "confirm",
    );
    expect(classifyReply(okReply({ status: "ok", rowsAffected: 3 })).kind).toBe("ok");
    const err = classifyReply(errorReply("bad_request", "nope"));
    expect(err).toEqual({ kind: "error", message: "nope" });
  });
});

describe("renderResultBlock", () => {
  test("table view → escaped table html", () => {
    const r = renderResultBlock(qb({ view: "table" }), numData, false);
    expect(r.kind).toBe("html");
    if (r.kind === "html") {
      expect(r.html).toContain("<table");
      expect(r.html).not.toContain("truncated");
    }
  });

  test("truncated table → carries the truncation affordance", () => {
    const r = renderResultBlock(qb({ view: "table" }), numData, true);
    if (r.kind === "html") expect(r.html).toContain("truncated");
  });

  test("chart view + valid spec → plot options", () => {
    const r = renderResultBlock(qb({ view: "chart", chart: { mark: "line", x: "k", y: "v" } }), numData, false);
    expect(r.kind).toBe("chart");
    if (r.kind === "chart") expect(Array.isArray(r.options.marks)).toBe(true);
  });

  test("chart view + spec invalid vs live columns → table fallback", () => {
    const r = renderResultBlock(qb({ view: "chart", chart: { mark: "line", x: "gone", y: "v" } }), numData, false);
    expect(r.kind).toBe("html");
  });

  test("a hostile returned cell AND column render inert", () => {
    const hostile: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "</th><script>c</script>", type: "string" }],
      rows: [[{ kind: "string", value: "</td><script>x</script>" }]],
    };
    const r = renderResultBlock(qb({ view: "table" }), hostile, false);
    if (r.kind === "html") {
      expect(r.html).not.toContain("<script>");
      expect(r.html).toContain("&lt;/th&gt;&lt;script&gt;");
      expect(r.html).toContain("&lt;/td&gt;&lt;script&gt;");
    }
  });
});

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

const doc = (blocks: ReadonlyArray<LiveReportBlock>): LiveReportDoc => ({
  schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
  blocks,
});

describe("runLiveReport — authorization gate", () => {
  test("no token → inert 'needs a running quick-studio' state + ZERO rpc calls", async () => {
    const rpc = mock(async (): Promise<RpcReply<unknown>> => okReply(null));
    const deps: LiveDeps = { getToken: () => null, rpc };
    const f = fakeHost();
    await runLiveReport(doc([{ kind: "prose", markdown: "hi" }, qb()]), deps, f.host);
    expect(rpc).not.toHaveBeenCalled();
    expect(f.statuses).toContain(NEEDS_QS_HTML);
    // Prose still renders; the query block shows an inert note (no fetch).
    expect(f.slots[0]!.htmls.some((h) => h.includes("hi"))).toBe(true);
    expect(f.slots[1]!.notes.length).toBeGreaterThan(0);
  });

  test("no token → a throw rendering one prose block is isolated; siblings still render (still zero rpc)", async () => {
    const rpc = mock(async (): Promise<RpcReply<unknown>> => okReply(null));
    const deps: LiveDeps = { getToken: () => null, rpc };
    const slots: FakeSlot[] = [];
    let idx = 0;
    const host: LiveHost = {
      setStatus: () => {},
      renderPicker: () => {},
      renderRefresh: () => {},
      addBlock: () => {
        const s = fakeSlot();
        const wired: FakeSlot = idx++ === 0 ? { ...s, appendHtml: () => { throw new Error("render boom"); } } : s;
        slots.push(wired);
        return wired;
      },
    };
    await runLiveReport(doc([{ kind: "prose", markdown: "boom" }, { kind: "prose", markdown: "second" }]), deps, host);
    // The inert path never touches `/rpc`, and one prose throw does not drop the sibling.
    expect(rpc).not.toHaveBeenCalled();
    expect(slots[0]!.errors.some((e) => e.includes("render boom"))).toBe(true);
    expect(slots[1]!.htmls.some((h) => h.includes("second"))).toBe(true);
  });
});

describe("runLiveReport — token present", () => {
  const connOk = (result: unknown): RpcReply<unknown> => okReply(result);

  function depsFor(handlers: {
    connections?: () => RpcReply<unknown>;
    execute?: (params: unknown) => RpcReply<unknown> | Promise<RpcReply<unknown>>;
  }): { deps: LiveDeps; rpc: ReturnType<typeof mock> } {
    const rpc = mock(async (method: string, params: unknown): Promise<RpcReply<unknown>> => {
      if (method === "connections.list") return (handlers.connections ?? (() => connOk([])))();
      if (method === "execute") return (handlers.execute ?? (() => okReply({ status: "rows", data: numData, truncated: false })))(params);
      return errorReply("unknown_method", "no");
    });
    return { deps: { getToken: () => "tok", rpc }, rpc };
  }

  test("rows → the block renders the live table", async () => {
    const { deps } = depsFor({});
    const f = fakeHost();
    await runLiveReport(doc([qb({ view: "table" })]), deps, f.host);
    expect(f.slots[0]!.htmls.some((h) => h.includes("<table"))).toBe(true);
  });

  test("confirm → the inert 'not run' note, and execute is NEVER re-issued with confirmed:true", async () => {
    const executeParams: unknown[] = [];
    const { deps } = depsFor({
      execute: (params) => {
        executeParams.push(params);
        return okReply({ status: "confirmation_required", preview: { sql: "delete", risk: "destructive" } });
      },
    });
    const f = fakeHost();
    await runLiveReport(doc([qb({ sql: "delete from t" })]), deps, f.host);
    expect(f.slots[0]!.notes).toContain(CONFIRM_NOTE);
    expect(executeParams).toHaveLength(1);
    expect((executeParams[0] as { confirmed?: boolean }).confirmed).toBeUndefined();
  });

  test("a block's rpc error → inline note while sibling blocks still render", async () => {
    const { deps } = depsFor({
      execute: (params) => {
        const sql = (params as { sql: string }).sql;
        return sql.includes("boom")
          ? errorReply("internal_error", "kaboom")
          : okReply({ status: "rows", data: numData, truncated: false });
      },
    });
    const f = fakeHost();
    await runLiveReport(doc([qb({ sql: "select boom" }), qb({ sql: "select ok", view: "table" })]), deps, f.host);
    expect(f.slots[0]!.errors).toContain("kaboom");
    expect(f.slots[1]!.htmls.some((h) => h.includes("<table"))).toBe(true);
  });

  test("connections.list failure → prose STILL renders + query blocks show an inline error (Patch C — not a blank wall)", async () => {
    const { deps, rpc } = depsFor({ connections: () => errorReply("internal_error", "down") });
    const f = fakeHost();
    await runLiveReport(
      doc([{ kind: "prose", markdown: "hello world" }, qb({ sql: "select 1" })]),
      deps,
      f.host,
    );
    // Top-level note present, but the document is NOT hidden behind it.
    expect(f.statuses).toContain(CANNOT_REACH_HTML);
    // Prose block renders unconditionally.
    expect(f.slots[0]!.htmls.some((h) => h.includes("hello world"))).toBe(true);
    // The query block surfaces its own inline "cannot reach" error (no execute attempted).
    expect(f.slots[1]!.errors.some((e) => e.includes("cannot reach"))).toBe(true);
    expect(f.slots[1]!.errors).toContain(CANNOT_REACH_BLOCK_NOTE);
    // `execute` is never called when the Core is unreachable — only the failed `connections.list`.
    expect(rpc.mock.calls.every((c) => c[0] !== "execute")).toBe(true);
  });

  test("a throw while rendering a prose block is isolated — sibling query blocks still render", async () => {
    // A slot whose `appendHtml` throws simulates a render failure in the prose path (e.g. a
    // `renderMarkdownToHtml`/DOM failure). The isolation contract requires it to be caught
    // per-block, not to abort the whole report and drop the siblings.
    const { deps } = depsFor({});
    const statuses: string[] = [];
    const slots: FakeSlot[] = [];
    let idx = 0;
    const host: LiveHost = {
      setStatus: (h) => statuses.push(h),
      renderPicker: () => {},
      renderRefresh: () => {},
      addBlock: () => {
        const s = fakeSlot();
        // The FIRST (prose) block's html append throws; everything else records normally.
        const wired: FakeSlot = idx++ === 0 ? { ...s, appendHtml: () => { throw new Error("render boom"); } } : s;
        slots.push(wired);
        return wired;
      },
    };
    await runLiveReport(doc([{ kind: "prose", markdown: "boom" }, qb({ view: "table" })]), deps, host);
    // The failing prose block captured its error instead of aborting the report…
    expect(slots[0]!.errors.some((e) => e.includes("render boom"))).toBe(true);
    // …and the sibling query block still ran and rendered its live table.
    expect(slots[1]!.htmls.some((h) => h.includes("<table"))).toBe(true);
  });

  test("overlapping runs (Patch B): only the LATEST run renders; the superseded run appends nothing", async () => {
    // Deferred `execute` promises we resolve by hand, so run-1 and run-2 overlap in flight.
    const resolvers: Array<(reply: RpcReply<unknown>) => void> = [];
    const rpc = mock(async (method: string): Promise<RpcReply<unknown>> => {
      if (method === "connections.list") return okReply([]);
      return new Promise<RpcReply<unknown>>((resolve) => resolvers.push(resolve));
    });
    const deps: LiveDeps = { getToken: () => "tok", rpc };
    const f = fakeHost();
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };

    const p = runLiveReport(doc([qb({ sql: "select 1", view: "table" })]), deps, f.host);
    await flush();
    // Run 1 (the initial runAll) issued exactly one `execute`.
    expect(resolvers).toHaveLength(1);

    // Trigger an overlapping run 2 via the picker while run 1 is still in flight.
    f.pick!("conn-b");
    await flush();
    expect(resolvers).toHaveLength(2);

    const rows = (): RpcReply<unknown> => okReply({ status: "rows", data: numData, truncated: false });
    // Resolve the LATEST run (2) first — it renders.
    resolvers[1]!(rows());
    await flush();
    // Then resolve the SUPERSEDED run (1) LAST — it must append nothing.
    resolvers[0]!(rows());
    await flush();
    await p;

    const slot = f.slots[0]!;
    // Exactly ONE table html landed (run 2's), never a double-append from the superseded run.
    expect(slot.htmls.filter((h) => h.includes("<table"))).toHaveLength(1);
    // Both runs cleared the slot at their top; only the latest appended.
    expect(slot.clears).toBe(2);
  });

  test("overlapping runs at the connection-load boundary (DW-52 guard): a superseded run resolving its connections.list LAST mutates neither status nor picker", async () => {
    // Deferred `connections.list` replies we resolve by hand, so run-1 and run-2 overlap at the
    // `loadConnections` await — the exact re-entrancy boundary DW-52 added the post-await
    // `isCurrent()` guard for. A superseded FAILED run must not plant a stale banner nor a
    // Default-only picker over the newer healthy run's UI.
    const listResolvers: Array<(reply: RpcReply<unknown>) => void> = [];
    const conns: ReadonlyArray<ConnectionSummary> = [
      { id: "conn-a", name: "Alpha", host: "h", engine: "pg" },
      { id: "conn-b", name: "Bravo", host: "h", engine: "pg" },
    ];
    const rpc = mock(async (method: string): Promise<RpcReply<unknown>> => {
      if (method === "connections.list") {
        return new Promise<RpcReply<unknown>>((resolve) => listResolvers.push(resolve));
      }
      return okReply({ status: "rows", data: numData, truncated: false });
    });
    const deps: LiveDeps = { getToken: () => "tok", rpc };
    const f = fakeHost();
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };

    // Run 1 (the initial runAll) kicks off and suspends awaiting connections.list.
    const p = runLiveReport(doc([qb({ sql: "select 1", view: "table" })]), deps, f.host);
    await flush();
    expect(listResolvers).toHaveLength(1);

    // Trigger an overlapping run 2 via Refresh while run 1 is still awaiting its list.
    f.refresh!();
    await flush();
    expect(listResolvers).toHaveLength(2);

    // Resolve the LATEST run (2) FIRST — a healthy list — it renders the picker + queries the block.
    listResolvers[1]!(okReply(conns));
    await flush();
    expect(f.pickerConnections).toEqual(conns);
    expect(f.pickerRenders).toBe(1);

    // Then resolve the SUPERSEDED run (1) LAST, as a FAILURE: its late resolve hits `if (!isCurrent())
    // return` before any mutation — no stale CANNOT_REACH banner, and run 2's picker is untouched.
    listResolvers[0]!(errorReply("internal_error", "down"));
    await flush();
    await p;

    expect(f.statuses).toEqual([]); // the superseded failure never set the banner
    expect(f.pickerRenders).toBe(1); // only run 2 ever rendered the picker
    expect(f.pickerConnections).toEqual(conns); // run 2's named connections survived
  });

  test("refresh re-queries every block against the current pick", async () => {
    let executes = 0;
    const { deps } = depsFor({
      execute: () => {
        executes += 1;
        return okReply({ status: "rows", data: numData, truncated: false });
      },
    });
    const f = fakeHost();
    // Refresh now round-trips `connections.list` inside `runAll` before the executes, so drain
    // enough microtasks (mirroring the overlapping-runs flush) to observe every execute call.
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };
    await runLiveReport(doc([qb(), qb()]), deps, f.host);
    expect(executes).toBe(2);
    f.refresh!();
    await flush();
    expect(executes).toBe(4);
  });

  test("recovery via Refresh: connections.list fails then succeeds — banner set then cleared, picker gains named connections, block renders live data", async () => {
    const conns: ReadonlyArray<ConnectionSummary> = [
      { id: "conn-a", name: "Alpha", host: "h", engine: "pg" },
      { id: "conn-b", name: "Bravo", host: "h", engine: "pg" },
    ];
    let listCalls = 0;
    const { deps } = depsFor({
      connections: () => {
        listCalls += 1;
        return listCalls === 1 ? errorReply("internal_error", "down") : connOk(conns);
      },
    });
    const f = fakeHost();
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };

    await runLiveReport(doc([qb({ sql: "select 1", view: "table" })]), deps, f.host);
    // Initial run failed: ONLY the banner was set, the query slot carries the inline note, no data.
    expect(f.statuses).toEqual([CANNOT_REACH_HTML]);
    expect(f.pickerRenders).toBe(1);
    expect(f.slots[0]!.errors).toContain(CANNOT_REACH_BLOCK_NOTE);
    expect(f.slots[0]!.htmls.some((h) => h.includes("<table"))).toBe(false);

    // Core recovers; the viewer clicks Refresh.
    f.refresh!();
    await flush();

    // The banner is set THEN cleared (order matters — a stale banner must never outlive recovery),
    // the (rebuilt) picker carries the named connections, and the block renders live data.
    expect(f.statuses).toEqual([CANNOT_REACH_HTML, ""]);
    expect(f.pickerRenders).toBe(2);
    expect(f.pickerConnections).toEqual(conns);
    expect(f.slots[0]!.htmls.some((h) => h.includes("<table"))).toBe(true);
  });

  test("still-down Refresh: connections.list fails on both runs — no execute ever issued, each slot shows the note", async () => {
    const { deps, rpc } = depsFor({ connections: () => errorReply("internal_error", "down") });
    const f = fakeHost();
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };

    await runLiveReport(doc([qb({ sql: "select 1" }), qb({ sql: "select 2" })]), deps, f.host);
    f.refresh!();
    await flush();

    // No `execute` RPC is ever attempted while the Core is down (only `connections.list`).
    expect(rpc.mock.calls.every((c) => c[0] !== "execute")).toBe(true);
    // Each query slot (re-)shows the cleared "cannot reach" note.
    for (const slot of f.slots) {
      expect(slot.errors).toContain(CANNOT_REACH_BLOCK_NOTE);
    }
  });

  test("down→up preserves the named pick: pick conn-b, a failed Refresh keeps it, a successful Refresh still shows it selected", async () => {
    const conns: ReadonlyArray<ConnectionSummary> = [
      { id: "conn-a", name: "Alpha", host: "h", engine: "pg" },
      { id: "conn-b", name: "Bravo", host: "h", engine: "pg" },
    ];
    let listShouldFail = false;
    const { deps } = depsFor({
      connections: () => (listShouldFail ? errorReply("internal_error", "down") : connOk(conns)),
    });
    const f = fakeHost();
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };

    // Healthy load: picker shows Default selected.
    await runLiveReport(doc([qb({ view: "table" })]), deps, f.host);
    expect(f.pickerSelectedId).toBe(null);

    // The viewer picks a named connection.
    f.pick!("conn-b");
    await flush();
    expect(f.pickerSelectedId).toBe("conn-b");

    // Core goes down: a failed Refresh rebuilds a Default-only picker but NEVER resets `current`.
    listShouldFail = true;
    f.refresh!();
    await flush();
    expect(f.pickerSelectedId).toBe("conn-b");

    // Core back up: the successful Refresh's picker render still shows conn-b selected.
    listShouldFail = false;
    f.refresh!();
    await flush();
    expect(f.pickerSelectedId).toBe("conn-b");
    expect(f.pickerConnections).toEqual(conns);
    // The picker was rebuilt once per run: initial + pick + failed refresh + successful refresh.
    expect(f.pickerRenders).toBe(4);
  });

  test("recovery reconciles a vanished pick to Default — no phantom execute against the missing id", async () => {
    const withB: ReadonlyArray<ConnectionSummary> = [
      { id: "conn-a", name: "Alpha", host: "h", engine: "pg" },
      { id: "conn-b", name: "Bravo", host: "h", engine: "pg" },
    ];
    const withoutB: ReadonlyArray<ConnectionSummary> = [{ id: "conn-a", name: "Alpha", host: "h", engine: "pg" }];
    let listCalls = 0;
    const executeConns: Array<string | null> = [];
    const { deps } = depsFor({
      // conn-b is present for the initial load AND the pick, then vanishes before the Refresh.
      connections: () => {
        listCalls += 1;
        return connOk(listCalls <= 2 ? withB : withoutB);
      },
      execute: (params) => {
        executeConns.push((params as { connectionId: string | null }).connectionId);
        return okReply({ status: "rows", data: numData, truncated: false });
      },
    });
    const f = fakeHost();
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };

    await runLiveReport(doc([qb({ view: "table" })]), deps, f.host);
    f.pick!("conn-b");
    await flush();
    expect(f.pickerSelectedId).toBe("conn-b");

    // conn-b is gone on the next Refresh: the pick reconciles to Default rather than a phantom id.
    f.refresh!();
    await flush();
    expect(f.pickerSelectedId).toBe(null);
    expect(f.pickerConnections).toEqual(withoutB);
    // The post-recovery `execute` targeted Default (null) — the vanished "conn-b" is never queried
    // again (it was legitimately queried once by the pick, while it still existed).
    expect(executeConns.at(-1)).toBe(null);
  });

  test("empty report → an affordance, never a blank body", async () => {
    const { deps } = depsFor({});
    const f = fakeHost();
    await runLiveReport(doc([]), deps, f.host);
    expect(f.slots).toHaveLength(1);
    expect(f.slots[0]!.notes.length).toBeGreaterThan(0);
  });

  test("a hostile returned cell renders inert through the full pipe", async () => {
    const hostile: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "c", type: "string" }],
      rows: [[{ kind: "string", value: "</td><script>alert(1)</script>" }]],
    };
    const { deps } = depsFor({ execute: () => okReply({ status: "rows", data: hostile, truncated: false }) });
    const f = fakeHost();
    await runLiveReport(doc([qb({ view: "table" })]), deps, f.host);
    const html = f.slots[0]!.htmls.join("");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/td&gt;&lt;script&gt;");
  });
});

/* ------------------------------------------------------------------ *
 * DOM host (makeDomHost) — the replaceable-picker contract (DW-52)
 * ------------------------------------------------------------------ */

/**
 * A minimal fake `Document`/element (this repo has no jsdom) that models the ONE DOM behavior the
 * picker fix depends on: setting `<select>.value` to an id with no matching `<option>` leaves
 * `selectedIndex` at -1 and the value blank (the real DOM contract). Only the members `makeDomHost`
 * touches are implemented.
 */
type FakeNode = {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  readonly children: FakeNode[];
  value: string;
  selectedIndex: number;
  innerHTML: string;
  appendChild: (child: FakeNode) => FakeNode;
  addEventListener: () => void;
};
function fakeElement(tag: string): FakeNode {
  const children: FakeNode[] = [];
  let value = "";
  let html = "";
  const el = {
    tagName: tag,
    className: "",
    textContent: "",
    type: "",
    children,
    selectedIndex: -1,
    appendChild: (child: FakeNode) => {
      children.push(child);
      return child;
    },
    addEventListener: () => {},
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
      if (v === "") children.length = 0; // mirrors clearing a container
    },
    get value() {
      return value;
    },
    set value(v: string) {
      if (tag === "select") {
        // Real `<select>.value` only sticks when an <option> carries it; otherwise it blanks.
        const idx = children.findIndex((o) => o.value === v);
        el.selectedIndex = idx;
        value = idx >= 0 ? v : "";
      } else {
        value = v;
      }
    },
  };
  return el as FakeNode;
}
function fakeDoc(): Document {
  return { createElement: (tag: string) => fakeElement(tag) } as unknown as Document;
}
function pickerSelect(pickerSlot: FakeNode): FakeNode {
  // pickerSlot → <label> → <select>
  return pickerSlot.children[0]!.children[0]!;
}

describe("makeDomHost — replaceable picker", () => {
  const conns: ReadonlyArray<ConnectionSummary> = [
    { id: "conn-a", name: "Alpha", host: "h", engine: "pg" },
    { id: "conn-b", name: "Bravo", host: "h", engine: "pg" },
  ];

  function setup() {
    const doc = fakeDoc();
    const mount = fakeElement("div");
    const controls = fakeElement("div");
    const pickerSlot = fakeElement("span");
    const status = fakeElement("p");
    const host = makeDomHost(
      doc,
      mount as unknown as HTMLElement,
      controls as unknown as HTMLElement,
      pickerSlot as unknown as HTMLElement,
      status as unknown as HTMLElement,
    );
    return { host, pickerSlot };
  }

  test("reflects the current pick, and REPLACES (never stacks) the prior picker on re-render", () => {
    const { host, pickerSlot } = setup();

    host.renderPicker(conns, "conn-b", () => {});
    expect(pickerSlot.children).toHaveLength(1); // one <label>
    expect(pickerSelect(pickerSlot).value).toBe("conn-b");

    // A second render replaces rather than appends a second picker, and reflects the new pick.
    host.renderPicker(conns, null, () => {});
    expect(pickerSlot.children).toHaveLength(1);
    expect(pickerSelect(pickerSlot).value).toBe(""); // Default
  });

  test("an id with no matching option falls back to Default (never a blank control)", () => {
    const { host, pickerSlot } = setup();
    // A Default-only list (failure path) asked to reflect a still-held named pick.
    host.renderPicker([], "conn-b", () => {});
    const select = pickerSelect(pickerSlot);
    expect(select.value).toBe(""); // fell back to Default, not blank
    expect(select.selectedIndex).toBe(0); // the Default <option>
  });
});
