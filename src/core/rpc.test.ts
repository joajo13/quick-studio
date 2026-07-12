import { describe, expect, test } from "bun:test";
import type {
  ConnectResult,
  ConnectionSummary,
  ExecuteResult,
  RpcReply,
  TableRowsResult,
  WorkspaceSnapshot,
} from "../shared/contract.ts";
import type { ConnectionRegistry } from "./connection-registry.ts";
import { createLiveReportRegistry } from "./live-report-registry.ts";
import { createProviderRegistry } from "./provider-registry.ts";
import { openProviderKeyStore } from "./provider-key-store.ts";
import { dispatch, methodNames, type RpcContext } from "./rpc.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

/**
 * An in-memory fake registry so dispatch tests exercise the connections handlers
 * without a real store/keychain. Records connections by id and reproduces the
 * registry's error contract (bad params → bad_request, unknown edit → not_found).
 */
function fakeRegistry(): ConnectionRegistry {
  const byId = new Map<string, { name: string; url: string }>();
  let counter = 0;
  const summary = (id: string): ConnectionSummary => {
    const rec = byId.get(id)!;
    const u = new URL(rec.url);
    return { id, name: rec.name, host: u.host, engine: u.protocol.replace(/:$/, "") };
  };
  return {
    list: () => ({ ok: true, value: [...byId.keys()].map(summary) }),
    add: (params) => {
      if (params.name.trim().length === 0) {
        return { ok: false, code: "bad_request", message: "name empty", detail: "field=name" };
      }
      const id = `id-${++counter}`;
      byId.set(id, { name: params.name.trim(), url: params.url });
      return { ok: true, value: summary(id) };
    },
    edit: (params) => {
      const rec = byId.get(params.id);
      if (rec === undefined) {
        return { ok: false, code: "not_found", message: "unknown id" };
      }
      if (params.name !== undefined) rec.name = params.name;
      if (params.url !== undefined) rec.url = params.url;
      return { ok: true, value: summary(params.id) };
    },
    remove: (params) => {
      byId.delete(params.id);
      return { ok: true, value: { removed: true } };
    },
    getStoredUrl: (id) => {
      const rec = byId.get(id);
      return rec === undefined ? { kind: "not-found" } : { kind: "found", url: rec.url };
    },
  };
}

/**
 * A minimal in-memory fake workspace registry so dispatch tests exercise the
 * `workspace.*` handlers without a real store. Reproduces the registry's
 * error contract just enough for wiring assertions: a params object missing the
 * `version`/`panelSizes`/`tabs`/`nextId` fields is `bad_request`; a valid-shaped
 * snapshot is accepted and echoed back by a subsequent `load`.
 */
function fakeWorkspaceRegistry(): WorkspaceRegistry {
  let stored: WorkspaceSnapshot | null = null;
  return {
    load: () => ({ ok: true, value: { snapshot: stored } }),
    save: (params) => {
      if (typeof params !== "object" || params === null) {
        return { ok: false, code: "bad_request", message: "invalid snapshot" };
      }
      const p = params as Record<string, unknown>;
      if (p.version !== 1 || !Array.isArray(p.panelSizes) || !Array.isArray(p.tabs) || typeof p.nextId !== "number") {
        return { ok: false, code: "bad_request", message: "invalid snapshot shape" };
      }
      stored = params as WorkspaceSnapshot;
      return { ok: true, value: { saved: true } };
    },
  };
}

/**
 * Stub context for dispatch tests. Counts `requestShutdown` calls and records the
 * `ConnectResult` a `connect` handler should resolve to (Story 1.3 threaded a
 * `connect` capability onto every context); Story 2.4 threads a `connections`
 * registry; Story 2.5 threads a `workspace` registry.
 */
function stubCtx(
  connectResult: ConnectResult = {
    status: "failed",
    failure: "unsupported_scheme",
    message: "no connection target configured",
  },
  tableRowsReply: RpcReply<TableRowsResult> = {
    ok: false,
    error: { code: "bad_request", message: "stub tableRows" },
  },
  executeReply: RpcReply<ExecuteResult> = {
    ok: false,
    error: { code: "bad_request", message: "stub execute" },
  },
): RpcContext & {
  calls: number;
  connectCalls: number;
  tableRowsCalls: number;
  executeCalls: number;
} {
  const ctx = {
    calls: 0,
    connectCalls: 0,
    tableRowsCalls: 0,
    executeCalls: 0,
    connections: fakeRegistry(),
    workspace: fakeWorkspaceRegistry(),
    providers: createProviderRegistry({ openStore: () => openProviderKeyStore({ mode: "ephemeral" }) }),
    requestShutdown() {
      ctx.calls++;
    },
    async connect(): Promise<ConnectResult> {
      ctx.connectCalls++;
      return connectResult;
    },
    async tableRows(): Promise<RpcReply<TableRowsResult>> {
      ctx.tableRowsCalls++;
      return tableRowsReply;
    },
    async execute(): Promise<RpcReply<ExecuteResult>> {
      ctx.executeCalls++;
      return executeReply;
    },
    liveReports: createLiveReportRegistry(),
  };
  return ctx;
}

describe("rpc dispatch", () => {
  test("health returns a typed ok result with the schema version", async () => {
    const reply = await dispatch({ method: "health" }, stubCtx());
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({ status: "ok", schemaVersion: 1 });
    }
  });

  test("an unknown method yields a typed unknown_method envelope", async () => {
    const reply = await dispatch({ method: "frobnicate" }, stubCtx());
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("unknown_method");
  });

  test("Object.prototype keys do not resolve to inherited handlers", async () => {
    // A plain-object dispatch table would resolve these to truthy prototype
    // members and dispatch them; they must all fall through to unknown_method.
    for (const method of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
      const reply = await dispatch({ method }, stubCtx());
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("unknown_method");
    }
  });

  test("methodNames lists only own registered methods", () => {
    expect(methodNames()).toEqual([
      "health",
      "shutdown",
      "connect",
      "connections.list",
      "connections.add",
      "connections.edit",
      "connections.remove",
      "workspace.load",
      "workspace.save",
      "providers.list",
      "providers.set",
      "providers.remove",
      "table.rows",
      "execute",
      "livereport.publish",
    ]);
  });

  test("shutdown returns {stopping:true} and calls ctx.requestShutdown exactly once", async () => {
    const ctx = stubCtx();
    const reply = await dispatch({ method: "shutdown" }, ctx);
    expect(reply).toEqual({ ok: true, result: { stopping: true } });
    expect(ctx.calls).toBe(1);
  });

  test("connect dispatches to ctx.connect and resolves a concrete RpcReply (not a Promise in result)", async () => {
    const schema = { engine: "postgres", tables: [] } as const;
    const ctx = stubCtx({ status: "connected", schema });
    const reply = await dispatch({ method: "connect" }, ctx);

    expect(ctx.connectCalls).toBe(1);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      // The async handler's promise is fully resolved by `dispatch`, so `result`
      // is the concrete ConnectResult — never a live Promise.
      expect(reply.result).not.toBeInstanceOf(Promise);
      expect(reply.result).toEqual({ status: "connected", schema });
    }
  });

  test("connect carries a domain failure through as an OK reply (payload, not transport error)", async () => {
    const ctx = stubCtx({ status: "failed", failure: "auth", message: "the database rejected the provided credentials" });
    const reply = await dispatch({ method: "connect" }, ctx);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({
        status: "failed",
        failure: "auth",
        message: "the database rejected the provided credentials",
      });
    }
  });
});

describe("rpc dispatch — connections CRUD", () => {
  test("connections.add with valid params returns an okReply carrying a credential-free summary", async () => {
    const reply = await dispatch(
      { method: "connections.add", params: { name: "prod", url: "postgres://u:sekret@h:5432/db" } },
      stubCtx(),
    );
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const summary = reply.result as { id: string; name: string; host: string; engine: string };
      expect(summary.name).toBe("prod");
      expect(summary.host).toBe("h:5432");
      expect(summary.engine).toBe("postgres");
      // No credentials in the wire result.
      expect(JSON.stringify(reply.result)).not.toContain("sekret");
    }
  });

  test("connections.add with missing/ill-typed params → bad_request (shape check)", async () => {
    for (const params of [undefined, {}, { name: "x" }, { url: "postgres://h/db" }, { name: 1, url: 2 }, [1, 2]]) {
      const reply = await dispatch({ method: "connections.add", params }, stubCtx());
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    }
  });

  test("connections.add with an empty name → bad_request (registry semantic check)", async () => {
    const reply = await dispatch(
      { method: "connections.add", params: { name: "   ", url: "postgres://h/db" } },
      stubCtx(),
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
  });

  test("connections.list returns the current summaries", async () => {
    const ctx = stubCtx();
    await dispatch({ method: "connections.add", params: { name: "a", url: "postgres://h/a" } }, ctx);
    const reply = await dispatch({ method: "connections.list" }, ctx);
    expect(reply.ok).toBe(true);
    if (reply.ok) expect((reply.result as unknown[]).length).toBe(1);
  });

  test("connections.edit on an unknown id → not_found", async () => {
    const reply = await dispatch(
      { method: "connections.edit", params: { id: "nope", name: "x" } },
      stubCtx(),
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("not_found");
  });

  test("connections.edit without an id → bad_request", async () => {
    const reply = await dispatch({ method: "connections.edit", params: { name: "x" } }, stubCtx());
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
  });

  test("connections.remove is an okReply {removed:true}", async () => {
    const reply = await dispatch(
      { method: "connections.remove", params: { id: "whatever" } },
      stubCtx(),
    );
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result).toEqual({ removed: true });
  });

  test("connections.remove without an id → bad_request", async () => {
    const reply = await dispatch({ method: "connections.remove", params: {} }, stubCtx());
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
  });
});

describe("rpc dispatch — workspace.load / workspace.save", () => {
  const SAMPLE_SNAPSHOT: WorkspaceSnapshot = {
    version: 1,
    panelSizes: [25, 75],
    tabs: [{ id: 1, kind: "table", title: "Table 1" }],
    activeTabId: 1,
    nextId: 2,
  };

  test("workspace.load with no prior save resolves { snapshot: null }", async () => {
    const reply = await dispatch({ method: "workspace.load" }, stubCtx());
    expect(reply).toEqual({ ok: true, result: { snapshot: null } });
  });

  test("workspace.save with a valid snapshot returns saved:true and workspace.load echoes it back", async () => {
    const ctx = stubCtx();
    const saveReply = await dispatch(
      { method: "workspace.save", params: SAMPLE_SNAPSHOT },
      ctx,
    );
    expect(saveReply).toEqual({ ok: true, result: { saved: true } });

    const loadReply = await dispatch({ method: "workspace.load" }, ctx);
    expect(loadReply).toEqual({ ok: true, result: { snapshot: SAMPLE_SNAPSHOT } });
  });

  test("workspace.save with malformed params → bad_request (delegated entirely to the registry)", async () => {
    for (const params of [undefined, {}, { version: 1 }, { version: 2, panelSizes: [], tabs: [], nextId: 1 }]) {
      const reply = await dispatch({ method: "workspace.save", params }, stubCtx());
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    }
  });
});

describe("rpc dispatch — table.rows", () => {
  const OK_RESULT: TableRowsResult = {
    data: { schemaVersion: 1, columns: [{ name: "id", type: "number" }], rows: [[{ kind: "number", value: 1 }]] },
    page: 1,
    pageSize: 100,
    total: 1,
  };

  test("dispatches to ctx.tableRows and returns its formed reply verbatim (OK)", async () => {
    const ctx = stubCtx(undefined, { ok: true, result: OK_RESULT });
    const reply = await dispatch(
      { method: "table.rows", params: { table: "users", page: 1 } },
      ctx,
    );
    expect(ctx.tableRowsCalls).toBe(1);
    expect(reply).toEqual({ ok: true, result: OK_RESULT });
  });

  test("carries the capability's error envelope through (bad_request/not_found)", async () => {
    for (const code of ["bad_request", "not_found"] as const) {
      const ctx = stubCtx(undefined, { ok: false, error: { code, message: `x ${code}` } });
      const reply = await dispatch({ method: "table.rows", params: { table: "x" } }, ctx);
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe(code);
    }
  });

  test("a capability throw (driver failure) is caught as internal_error", async () => {
    const ctx: RpcContext = {
      ...stubCtx(),
      tableRows: async () => {
        throw new Error("connection unavailable (network)");
      },
    };
    const reply = await dispatch({ method: "table.rows", params: { table: "x" } }, ctx);
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("internal_error");
  });
});

describe("rpc dispatch — execute", () => {
  const ROWS: ExecuteResult = {
    status: "rows",
    data: { schemaVersion: 1, columns: [{ name: "n", type: "number" }], rows: [[{ kind: "number", value: 1 }]] },
    truncated: false,
  };

  test("dispatches to ctx.execute and returns its formed reply verbatim (OK)", async () => {
    const ctx = stubCtx(undefined, undefined, { ok: true, result: ROWS });
    const reply = await dispatch({ method: "execute", params: { shape: "raw", sql: "SELECT 1" } }, ctx);
    expect(ctx.executeCalls).toBe(1);
    expect(reply).toEqual({ ok: true, result: ROWS });
  });

  test("carries the executor's bad_request envelope through (protocol violation)", async () => {
    const ctx = stubCtx(undefined, undefined, {
      ok: false,
      error: { code: "bad_request", message: "multiple statements are not allowed" },
    });
    const reply = await dispatch({ method: "execute", params: { shape: "raw", sql: "SELECT 1; DROP TABLE t" } }, ctx);
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
  });

  test("an executor throw (driver failure) is caught as internal_error (no raw text echoed)", async () => {
    const ctx: RpcContext = {
      ...stubCtx(),
      execute: async () => {
        throw new Error("relation \"secret\" does not exist");
      },
    };
    const reply = await dispatch({ method: "execute", params: { shape: "raw", sql: "SELECT 1" } }, ctx);
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBe("internal_error");
      expect(JSON.stringify(reply.error)).not.toContain("secret");
    }
  });
});
