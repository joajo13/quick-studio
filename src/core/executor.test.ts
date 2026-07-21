/**
 * quick-studio Core — guarded executor adversarial + I/O-matrix battery (Story 3.1).
 *
 * Every case injects FAKE seams (`runQuery`/`runReadOnly` capturing `(sql, params)`,
 * a controllable `getSchema` with per-table primary-key metadata, an engine-correct
 * `quoteIdent`) so the classifier/splitter/composer are exercised WITHOUT a live DB.
 * The battery proves: path (a) cannot widen to a destructive statement, and path (b)
 * statement-splitting is not defeated by comment / string / escape / dollar-quote /
 * backtick tricks — no third-party SQL parser.
 */

import { describe, expect, test } from "bun:test";
import type { DatabaseSchema, DbEngine } from "../shared/contract.ts";
import { NoConnectionTargetError } from "./connection.ts";
import type { ConnectionSeams } from "./connection-targets.ts";
import type { DriverQueryResult } from "./driver.ts";
import {
  boundRawRead,
  createExecutor,
  firstKeyword,
  splitStatements,
  topLevelWords,
  MAX_RESULT_ROWS,
} from "./executor.ts";

/* ---- Fakes ------------------------------------------------------------- */

type Capture = { sql: string; params: readonly unknown[] };

function pgQuote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
function myQuote(ident: string): string {
  return `\`${ident.replace(/`/g, "``")}\``;
}

function schemaFor(engine: DbEngine): DatabaseSchema {
  const col = (name: string) => ({ name, dataType: "text", nullable: true });
  return {
    engine,
    tables: [
      {
        schema: "public",
        name: "users",
        columns: [col("id"), col("name"), col("status")],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
      // Composite primary key — an update/delete addressing one of its columns must reject.
      { schema: "public", name: "events", columns: [col("a"), col("b")], primaryKey: ["a", "b"], indexes: [], foreignKeys: [] },
      // No primary key at all.
      { schema: "public", name: "logs", columns: [col("msg")], primaryKey: [], indexes: [], foreignKeys: [] },
      // Same table name in two schemas — an unqualified update/delete is ambiguous.
      { schema: "s1", name: "dup", columns: [col("id")], primaryKey: ["id"], indexes: [], foreignKeys: [] },
      { schema: "s2", name: "dup", columns: [col("id")], primaryKey: ["id"], indexes: [], foreignKeys: [] },
    ],
  };
}

/** Build a captured {@link ConnectionSeams} view (records `runQuery`/`runReadOnly` calls). */
function makeSeams(opts: {
  engine?: DbEngine;
  schema?: DatabaseSchema;
  queryResult?: DriverQueryResult;
  readOnlyResult?: DriverQueryResult;
  /** When set, `runQuery` throws it — a failed mutation must NOT bust the memo. */
  queryThrows?: unknown;
} = {}) {
  const engine = opts.engine ?? "postgres";
  const schema = opts.schema ?? schemaFor(engine);
  const queryCalls: Capture[] = [];
  const readOnlyCalls: Capture[] = [];
  // DW-45: counts the schema-memo busts this seam-set received, so the invalidation
  // matrix (which branches bust, which must not) is directly observable per target.
  const invalidations = { count: 0 };
  const seams: ConnectionSeams = {
    runQuery: async (sql, params) => {
      queryCalls.push({ sql, params });
      if (opts.queryThrows) throw opts.queryThrows;
      return opts.queryResult ?? { columns: [], rows: [], rowsAffected: 1 };
    },
    runReadOnly: async (sql, params) => {
      readOnlyCalls.push({ sql, params });
      return opts.readOnlyResult ?? { columns: [{ name: "n" }], rows: [[1]], rowsAffected: 0 };
    },
    getEngine: async () => engine,
    getSchema: async () => schema,
    quoteIdent: engine === "postgres" ? pgQuote : myQuote,
    connect: async () => ({ status: "connected", schema }),
    invalidateSchema: () => {
      invalidations.count += 1;
    },
  };
  return { seams, queryCalls, readOnlyCalls, invalidations };
}

function makeExecutor(opts: {
  engine?: DbEngine;
  schema?: DatabaseSchema;
  queryResult?: DriverQueryResult;
  readOnlyResult?: DriverQueryResult;
} = {}) {
  const { seams, queryCalls, readOnlyCalls } = makeSeams(opts);
  // Default resolver: every call (id present or not) resolves the SAME boot seams, so the
  // whole pre-6.2 battery exercises the untargeted path unchanged.
  const exec = createExecutor({ resolveConnection: () => ({ ok: true, seams }) });
  return { exec, queryCalls, readOnlyCalls };
}

/* ---- Pure splitter units ---------------------------------------------- */

describe("splitStatements — top-level separator only", () => {
  const one = (sql: string, engine: DbEngine = "postgres") => splitStatements(sql, engine).length;

  test("plain multi-statement splits into two", () => {
    expect(one("SELECT 1; DROP TABLE users")).toBe(2);
  });
  test("`;` inside a string is not a separator", () => {
    expect(one("SELECT ';'")).toBe(1);
  });
  test("`;` inside a line comment is not a separator", () => {
    expect(one("SELECT 1 -- ; DROP\n")).toBe(1);
  });
  test("`;` inside a block comment is not a separator", () => {
    expect(one("SELECT /* ; */ 1")).toBe(1);
  });
  test("`;` inside a postgres dollar-quote is not a separator", () => {
    expect(one("SELECT $$;$$", "postgres")).toBe(1);
    expect(one("SELECT $tag$ a; b $tag$", "postgres")).toBe(1);
  });
  test("`;` inside a mysql backtick identifier is not a separator", () => {
    expect(one("SELECT `a;b`", "mysql")).toBe(1);
  });
  test("mysql `--<non-space>` is arithmetic, NOT a comment: a following `;` still splits", () => {
    // MySQL sees `x=1 - -3`, then `;`, then `DROP` — two statements. The bare `--3`
    // must NOT swallow the `;DROP` as a phantom line comment.
    expect(one("UPDATE t SET x=1 --3;DROP TABLE users", "mysql")).toBe(2);
  });
  test("mysql `-- ` (dashes + space) IS a line comment: the hidden `;` is not a separator", () => {
    expect(one("UPDATE t SET x=1 -- 3;DROP TABLE users\n", "mysql")).toBe(1);
  });
  test("mysql bare `--` at end-of-input is a line comment (no trailing statement)", () => {
    expect(one("SELECT 1 --", "mysql")).toBe(1);
  });
  test("postgres `--<non-space>` is ALWAYS a comment: the `;DROP` stays hidden (unchanged)", () => {
    expect(one("UPDATE t SET x=1 --3;DROP TABLE users", "postgres")).toBe(1);
  });
  test("trailing line comment after `;` is ONE statement, not two", () => {
    expect(one("SELECT 1; -- done")).toBe(1);
  });
  test("trailing block comment after `;` is ONE statement, not two", () => {
    expect(one("SELECT 1; /* ok */")).toBe(1);
  });
  test("whitespace-only and comment-only input has zero statements", () => {
    expect(one("   ")).toBe(0);
    expect(one("-- just a comment")).toBe(0);
    expect(one("/* only */")).toBe(0);
  });

  test("postgres E'\\'' does NOT close the string — the hidden `;` stays a separator", () => {
    // The exploit: without engine escape handling the splitter under-counts and the
    // `; DROP` rides inside one segment. With it, this is TWO statements.
    expect(one("UPDATE t SET c=E'\\'' ; DROP TABLE users", "postgres")).toBe(2);
  });
  test("mysql '\\'' does NOT close the string — the hidden `;` stays a separator", () => {
    expect(one("UPDATE t SET c='\\'' ; DROP TABLE users", "mysql")).toBe(2);
  });
  test("postgres standard '\\' (backslash literal) DOES close — no false merge", () => {
    // In a standard (non-E) postgres string a backslash is literal, so 'a\' closes at
    // that quote; the following `;` is a real separator → two statements.
    expect(one("SELECT 'a\\'; SELECT 2", "postgres")).toBe(2);
  });
});

describe("firstKeyword / topLevelWords", () => {
  test("firstKeyword is null for comment/whitespace only", () => {
    expect(firstKeyword("  -- x", "postgres")).toBeNull();
  });
  test("firstKeyword upper-cases the leading word", () => {
    expect(firstKeyword("sElEcT 1", "postgres")).toBe("SELECT");
  });
  test("topLevelWords skips words inside strings/comments", () => {
    expect(topLevelWords("SELECT 'INTO' /* INTO */ FROM t", "postgres")).toEqual([
      "SELECT",
      "FROM",
      "T",
    ]);
  });
});

/* ---- Raw path (b): reads --------------------------------------------- */

describe("raw path — reads run read-only", () => {
  test("SELECT dispatches via runReadOnly (NOT runQuery) and returns status:rows", async () => {
    const { exec, queryCalls, readOnlyCalls } = makeExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SELECT * FROM users" });
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result.status).toBe("rows");
    expect(readOnlyCalls.length).toBe(1);
    // The auto-run raw SELECT is bounded at the fetch (DW-36): MAX_RESULT_ROWS + 1.
    expect(readOnlyCalls[0]!.sql).toBe(`SELECT * FROM users\nLIMIT ${MAX_RESULT_ROWS + 1}`);
    expect(queryCalls.length).toBe(0);
  });

  test("SHOW is a read", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SHOW TABLES" });
    expect(reply.ok && reply.result.status).toBe("rows");
    expect(readOnlyCalls.length).toBe(1);
  });

  test("mixed-case + comment tricks still classify as one read", async () => {
    for (const sql of ["sElEcT 1 -- ; DROP", "SELECT/*x*/1", "SELECT ';'", "SELECT $$;$$", "SELECT 1; -- done"]) {
      const { exec, readOnlyCalls, queryCalls } = makeExecutor();
      const reply = await exec.execute({ shape: "raw", sql });
      expect(reply.ok && reply.result.status).toBe("rows");
      expect(readOnlyCalls.length).toBe(1);
      expect(queryCalls.length).toBe(0);
    }
  });

  test("the Core caps the result grid and sets truncated", async () => {
    const rows = Array.from({ length: MAX_RESULT_ROWS + 5 }, (_v, i) => [i]);
    const { exec } = makeExecutor({ readOnlyResult: { columns: [{ name: "n" }], rows, rowsAffected: 0 } });
    const reply = await exec.execute({ shape: "raw", sql: "SELECT n FROM big" });
    expect(reply.ok).toBe(true);
    if (reply.ok && reply.result.status === "rows") {
      expect(reply.result.data.rows.length).toBe(MAX_RESULT_ROWS);
      expect(reply.result.truncated).toBe(true);
    }
  });
});

/* ---- Raw read fetch bound (DW-36) ------------------------------------ */

describe("raw read fetch bound (DW-36)", () => {
  const BOUND = MAX_RESULT_ROWS + 1;

  test("unbounded SELECT gets a Core LIMIT appended before runReadOnly", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SELECT * FROM users" });
    expect(reply.ok && reply.result.status).toBe("rows");
    expect(readOnlyCalls[0]!.sql).toBe(`SELECT * FROM users\nLIMIT ${BOUND}`);
  });

  test("already-LIMITed SELECT is passed verbatim (user's own bound wins)", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    await exec.execute({ shape: "raw", sql: "SELECT * FROM t LIMIT 5" });
    expect(readOnlyCalls[0]!.sql).toBe("SELECT * FROM t LIMIT 5");
  });

  test("SHOW is a read but is passed verbatim (not a SELECT)", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    await exec.execute({ shape: "raw", sql: "SHOW TABLES" });
    expect(readOnlyCalls.length).toBe(1);
    expect(readOnlyCalls[0]!.sql).toBe("SHOW TABLES");
  });

  test("trailing line comment: the appended LIMIT lands on a NEW line, not inside the comment", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    await exec.execute({ shape: "raw", sql: "SELECT * FROM t -- note" });
    expect(readOnlyCalls[0]!.sql).toBe(`SELECT * FROM t -- note\nLIMIT ${BOUND}`);
  });

  test("inner-LIMIT-only SELECT is passed verbatim (a top-level LIMIT word is present)", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    await exec.execute({ shape: "raw", sql: "SELECT * FROM (SELECT a FROM t LIMIT 5) x" });
    expect(readOnlyCalls[0]!.sql).toBe("SELECT * FROM (SELECT a FROM t LIMIT 5) x");
  });

  test("row-locking SELECT ... FOR UPDATE is passed verbatim (a trailing LIMIT would be a syntax error)", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    await exec.execute({ shape: "raw", sql: "SELECT * FROM t FOR UPDATE" });
    expect(readOnlyCalls[0]!.sql).toBe("SELECT * FROM t FOR UPDATE");
  });

  test("mysql LOCK IN SHARE MODE is passed verbatim (locking tail must follow LIMIT)", async () => {
    const { exec, readOnlyCalls } = makeExecutor({ engine: "mysql" });
    await exec.execute({ shape: "raw", sql: "SELECT * FROM t LOCK IN SHARE MODE" });
    expect(readOnlyCalls[0]!.sql).toBe("SELECT * FROM t LOCK IN SHARE MODE");
  });

  test("postgres FETCH FIRST n ROWS ONLY is passed verbatim (a second row-count clause is illegal)", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    await exec.execute({ shape: "raw", sql: "SELECT * FROM t FETCH FIRST 10 ROWS ONLY" });
    expect(readOnlyCalls[0]!.sql).toBe("SELECT * FROM t FETCH FIRST 10 ROWS ONLY");
  });

  test("truncation sentinel: a MAX+1-row fetch caps to MAX rows and sets truncated", async () => {
    const rows = Array.from({ length: BOUND }, (_v, i) => [i]);
    const { exec } = makeExecutor({ readOnlyResult: { columns: [{ name: "n" }], rows, rowsAffected: 0 } });
    const reply = await exec.execute({ shape: "raw", sql: "SELECT n FROM big" });
    expect(reply.ok).toBe(true);
    if (reply.ok && reply.result.status === "rows") {
      expect(reply.result.data.rows.length).toBe(MAX_RESULT_ROWS);
      expect(reply.result.truncated).toBe(true);
    }
  });

  test("exact fit: an exactly-MAX-row fetch returns all rows, truncated false", async () => {
    const rows = Array.from({ length: MAX_RESULT_ROWS }, (_v, i) => [i]);
    const { exec } = makeExecutor({ readOnlyResult: { columns: [{ name: "n" }], rows, rowsAffected: 0 } });
    const reply = await exec.execute({ shape: "raw", sql: "SELECT n FROM big" });
    expect(reply.ok).toBe(true);
    if (reply.ok && reply.result.status === "rows") {
      expect(reply.result.data.rows.length).toBe(MAX_RESULT_ROWS);
      expect(reply.result.truncated).toBe(false);
    }
  });

  test("mutation path: a confirmed raw DELETE reaches runQuery with NO LIMIT appended", async () => {
    const { exec, queryCalls, readOnlyCalls } = makeExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "DELETE FROM users", confirmed: true });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls.length).toBe(1);
    expect(queryCalls[0]!.sql).toBe("DELETE FROM users");
    expect(readOnlyCalls.length).toBe(0);
  });

  // Direct units for the pure helper: `verb`/`words` arrive already upper-cased from
  // topLevelWords, so callers pass "SELECT" (never a lowercase verb).
  test("boundRawRead unit: SELECT with no LIMIT gets the bound; SHOW and LIMITed pass through", () => {
    expect(boundRawRead("SELECT 1", "SELECT", ["SELECT"])).toBe(`SELECT 1\nLIMIT ${BOUND}`);
    // mysql SHOW: not a SELECT → verbatim.
    expect(boundRawRead("SHOW TABLES", "SHOW", ["SHOW", "TABLES"])).toBe("SHOW TABLES");
    // Top-level LIMIT already present → verbatim.
    expect(boundRawRead("SELECT * FROM t LIMIT 5", "SELECT", ["SELECT", "FROM", "T", "LIMIT"])).toBe(
      "SELECT * FROM t LIMIT 5",
    );
    // A trailing line comment is defeated by the leading newline.
    expect(boundRawRead("SELECT 1 -- note", "SELECT", ["SELECT"])).toBe(`SELECT 1 -- note\nLIMIT ${BOUND}`);
    // A row-count or row-locking word makes a trailing LIMIT illegal → verbatim.
    expect(boundRawRead("SELECT * FROM t FETCH FIRST 5 ROWS ONLY", "SELECT", ["SELECT", "FROM", "T", "FETCH", "FIRST", "ROWS", "ONLY"])).toBe(
      "SELECT * FROM t FETCH FIRST 5 ROWS ONLY",
    );
    expect(boundRawRead("SELECT * FROM t FOR UPDATE", "SELECT", ["SELECT", "FROM", "T", "FOR", "UPDATE"])).toBe(
      "SELECT * FROM t FOR UPDATE",
    );
    expect(boundRawRead("SELECT * FROM t LOCK IN SHARE MODE", "SELECT", ["SELECT", "FROM", "T", "LOCK", "IN", "SHARE", "MODE"])).toBe(
      "SELECT * FROM t LOCK IN SHARE MODE",
    );
  });
});

/* ---- Raw path (b): multi-statement + smuggle ------------------------- */

describe("raw path — multi-statement rejection & smuggle", () => {
  test("plain multi-statement → bad_request, nothing runs", async () => {
    const { exec, queryCalls, readOnlyCalls } = makeExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SELECT 1; DROP TABLE users" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    expect(queryCalls.length + readOnlyCalls.length).toBe(0);
  });

  for (const confirmed of [false, true]) {
    test(`postgres E'\\'' smuggle behind confirmed-safe UPDATE → bad_request (confirmed=${confirmed})`, async () => {
      const { exec, queryCalls, readOnlyCalls } = makeExecutor({ engine: "postgres" });
      const reply = await exec.execute({
        shape: "raw",
        sql: "UPDATE t SET c=E'\\'' ; DROP TABLE users",
        confirmed,
      });
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("bad_request");
      expect(queryCalls.length + readOnlyCalls.length).toBe(0);
    });

    test(`mysql '\\'' smuggle behind confirmed-safe UPDATE → bad_request (confirmed=${confirmed})`, async () => {
      const { exec, queryCalls, readOnlyCalls } = makeExecutor({ engine: "mysql" });
      const reply = await exec.execute({
        shape: "raw",
        sql: "UPDATE t SET c='\\'' ; DROP TABLE users",
        confirmed,
      });
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("bad_request");
      expect(queryCalls.length + readOnlyCalls.length).toBe(0);
    });
  }

  for (const confirmed of [false, true]) {
    test(`mysql \`--\` line-comment smuggle (\`SET x=1 --3;DROP\`) → bad_request, nothing runs (confirmed=${confirmed})`, async () => {
      // On mysql `--3` is arithmetic, not a comment, so `;DROP TABLE users` is a real
      // second statement — the splitter must see TWO statements and reject.
      const { exec, queryCalls, readOnlyCalls } = makeExecutor({ engine: "mysql" });
      const reply = await exec.execute({
        shape: "raw",
        sql: "UPDATE t SET x=1 --3;DROP TABLE users",
        confirmed,
      });
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("bad_request");
      expect(queryCalls.length + readOnlyCalls.length).toBe(0);
    });
  }

  test("mysql legit `-- ` comment (with space) after a SELECT is ONE read, runs", async () => {
    const { exec, readOnlyCalls, queryCalls } = makeExecutor({ engine: "mysql" });
    const reply = await exec.execute({ shape: "raw", sql: "SELECT 1 -- 3;DROP TABLE users\n" });
    expect(reply.ok && reply.result.status).toBe("rows");
    expect(readOnlyCalls.length).toBe(1);
    expect(queryCalls.length).toBe(0);
  });

  test("mysql INSERT with an escaped-quote string that swallows `;` is ONE statement (engine-correct, not a false multi-reject)", async () => {
    // `'\'; DROP TABLE u --'` — mysql backslash-escapes the quote, so `; DROP …` is
    // string CONTENT: a single INSERT (default-deny), not a smuggle nor a false reject.
    const { exec, queryCalls } = makeExecutor({ engine: "mysql" });
    const reply = await exec.execute({
      shape: "raw",
      sql: "INSERT INTO t VALUES('\\'; DROP TABLE u --')",
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result.status).toBe("confirmation_required");
    expect(queryCalls.length).toBe(0);
  });
});

/* ---- Raw path (b): default-deny mutations + INTO --------------------- */

describe("raw path — default-deny mutations", () => {
  for (const sql of [
    "UPDATE users SET x=1",
    "DELETE FROM users",
    "DROP TABLE users",
    "TRUNCATE users",
    "ALTER TABLE users ADD c int",
    "CREATE TABLE t (id int)",
    "WITH x AS (DELETE FROM users RETURNING *) SELECT 1",
    "EXPLAIN ANALYZE SELECT 1",
    "FOOBAR",
  ]) {
    test(`'${sql.slice(0, 24)}…' unconfirmed → confirmation_required, nothing runs`, async () => {
      const { exec, queryCalls, readOnlyCalls } = makeExecutor();
      const reply = await exec.execute({ shape: "raw", sql });
      expect(reply.ok).toBe(true);
      if (reply.ok) expect(reply.result.status).toBe("confirmation_required");
      expect(queryCalls.length + readOnlyCalls.length).toBe(0);
    });
  }

  test("confirmed mutation runs via runQuery (normal path, NOT read-only) → status:ok", async () => {
    const { exec, queryCalls, readOnlyCalls } = makeExecutor({
      queryResult: { columns: [], rows: [], rowsAffected: 3 },
    });
    const reply = await exec.execute({ shape: "raw", sql: "UPDATE users SET x=1", confirmed: true });
    expect(reply.ok).toBe(true);
    if (reply.ok && reply.result.status === "ok") expect(reply.result.rowsAffected).toBe(3);
    expect(queryCalls.length).toBe(1);
    expect(readOnlyCalls.length).toBe(0);
  });

  test("empty / comment-only raw sql → bad_request", async () => {
    for (const sql of ["", "   ", "-- nothing"]) {
      const { exec } = makeExecutor();
      const reply = await exec.execute({ shape: "raw", sql });
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    }
  });
});

describe("raw path — SELECT … INTO is default-denied (not auto-run)", () => {
  test("postgres SELECT … INTO t (CTAS) → confirmation_required, never runReadOnly/runQuery", async () => {
    const { exec, queryCalls, readOnlyCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({ shape: "raw", sql: "SELECT * INTO new_t FROM users" });
    expect(reply.ok && reply.result.status).toBe("confirmation_required");
    expect(queryCalls.length + readOnlyCalls.length).toBe(0);
  });

  test("mysql SELECT … INTO OUTFILE → confirmation_required", async () => {
    const { exec, readOnlyCalls } = makeExecutor({ engine: "mysql" });
    const reply = await exec.execute({ shape: "raw", sql: "SELECT * FROM users INTO OUTFILE '/tmp/x'" });
    expect(reply.ok && reply.result.status).toBe("confirmation_required");
    expect(readOnlyCalls.length).toBe(0);
  });

  test("INTO inside a string does NOT deny — it is still a read", async () => {
    const { exec, readOnlyCalls } = makeExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SELECT 'into outfile' AS note" });
    expect(reply.ok && reply.result.status).toBe("rows");
    expect(readOnlyCalls.length).toBe(1);
  });

  test("confirmed SELECT … INTO runs via runQuery (normal path)", async () => {
    const { exec, queryCalls, readOnlyCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({ shape: "raw", sql: "SELECT * INTO new_t FROM users", confirmed: true });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls.length).toBe(1);
    expect(readOnlyCalls.length).toBe(0);
  });
});

/* ---- Structured path (a): insert ------------------------------------- */

describe("structured insert — parameterized, identifier-quoted", () => {
  test("composes a parameterized INSERT and auto-commits", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({
      shape: "structured",
      op: {
        kind: "insert",
        table: "users",
        columns: [
          { column: "id", value: 7 },
          { column: "name", value: "ada" },
        ],
      },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls.length).toBe(1);
    expect(queryCalls[0]!.sql).toBe('INSERT INTO "users" ("id", "name") VALUES ($1, $2)');
    expect(queryCalls[0]!.params).toEqual([7, "ada"]);
  });

  test("a value carrying SQL is BOUND, never spliced into the text", async () => {
    const { exec, queryCalls } = makeExecutor();
    await exec.execute({
      shape: "structured",
      op: { kind: "insert", table: "users", columns: [{ column: "name", value: 'x"; DROP TABLE users --' }] },
    });
    expect(queryCalls[0]!.sql).not.toContain("DROP");
    expect(queryCalls[0]!.params).toEqual(['x"; DROP TABLE users --']);
  });

  test("an identifier carrying SQL is quote-escaped, never raw", async () => {
    const { exec, queryCalls } = makeExecutor();
    await exec.execute({
      shape: "structured",
      op: { kind: "insert", table: 'ev"; DROP TABLE users --', columns: [{ column: "a", value: 1 }] },
    });
    // The `"` is doubled by quoteIdent; the DROP text is inert inside a quoted ident.
    expect(queryCalls[0]!.sql).toContain('"ev""; DROP TABLE users --"');
  });

  test("mysql insert uses backticks + `?` placeholders", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "mysql" });
    await exec.execute({
      shape: "structured",
      op: { kind: "insert", table: "users", columns: [{ column: "id", value: 1 }] },
    });
    expect(queryCalls[0]!.sql).toBe("INSERT INTO `users` (`id`) VALUES (?)");
  });

  test("an ABSENT value key → bad_request (never a silent NULL); explicit null binds NULL", async () => {
    const { exec, queryCalls } = makeExecutor();
    const missing = await exec.execute({
      shape: "structured",
      op: { kind: "insert", table: "users", columns: [{ column: "name" }] },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("bad_request");
    expect(queryCalls.length).toBe(0);

    const explicit = await exec.execute({
      shape: "structured",
      op: { kind: "insert", table: "users", columns: [{ column: "name", value: null }] },
    });
    expect(explicit.ok && explicit.result.status).toBe("ok");
    expect(queryCalls[0]!.params).toEqual([null]);
  });

  test("duplicate column and empty column list → bad_request", async () => {
    const { exec } = makeExecutor();
    const dup = await exec.execute({
      shape: "structured",
      op: { kind: "insert", table: "users", columns: [{ column: "a", value: 1 }, { column: "a", value: 2 }] },
    });
    expect(dup.ok).toBe(false);
    const empty = await exec.execute({ shape: "structured", op: { kind: "insert", table: "users", columns: [] } });
    expect(empty.ok).toBe(false);
  });
});

/* ---- Structured path (a): update + single-PK verification ------------ */

describe("structured update — single-column-PK verification", () => {
  test("happy path: pk IS the single primary key → composes + auto-commits", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "update", table: "users", pk: { column: "id", value: 5 }, set: [{ column: "name", value: "bo" }] },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe('UPDATE "public"."users" SET "name"=$1 WHERE "id"=$2');
    expect(queryCalls[0]!.params).toEqual(["bo", 5]);
  });

  test("pk.column is a non-PK column → bad_request, runQuery never called", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "update", table: "users", pk: { column: "status", value: "active" }, set: [{ column: "name", value: "x" }] },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    expect(queryCalls.length).toBe(0);
  });

  test("composite-PK table → bad_request", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "update", table: "events", pk: { column: "a", value: 1 }, set: [{ column: "b", value: 2 }] },
    });
    expect(reply.ok).toBe(false);
    expect(queryCalls.length).toBe(0);
  });

  test("unknown table → bad_request", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "update", table: "nope", pk: { column: "id", value: 1 }, set: [{ column: "x", value: 2 }] },
    });
    expect(reply.ok).toBe(false);
    expect(queryCalls.length).toBe(0);
  });

  test("cross-schema-ambiguous table (unqualified) → bad_request", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "update", table: "dup", pk: { column: "id", value: 1 }, set: [{ column: "id", value: 2 }] },
    });
    expect(reply.ok).toBe(false);
    expect(queryCalls.length).toBe(0);
  });

  test("qualifying the schema disambiguates and composes with the resolved identifiers", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "update", schema: "s1", table: "dup", pk: { column: "id", value: 1 }, set: [{ column: "id", value: 2 }] },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe('UPDATE "s1"."dup" SET "id"=$1 WHERE "id"=$2');
  });

  test("missing pk value key and empty set → bad_request", async () => {
    const { exec } = makeExecutor();
    const noVal = await exec.execute({
      shape: "structured",
      op: { kind: "update", table: "users", pk: { column: "id" }, set: [{ column: "name", value: "x" }] },
    });
    expect(noVal.ok).toBe(false);
    const noSet = await exec.execute({
      shape: "structured",
      op: { kind: "update", table: "users", pk: { column: "id", value: 1 }, set: [] },
    });
    expect(noSet.ok).toBe(false);
  });
});

/* ---- Structured path (a): delete ------------------------------------- */

describe("structured delete — confirmation + PK verification", () => {
  test("unconfirmed valid delete → confirmation_required, runQuery never called", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "delete", table: "users", pk: { column: "id", value: 9 } },
    });
    expect(reply.ok && reply.result.status).toBe("confirmation_required");
    expect(queryCalls.length).toBe(0);
  });

  test("confirmed valid delete → single-row DELETE runs", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "delete", table: "users", pk: { column: "id", value: 9 } },
      confirmed: true,
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe('DELETE FROM "public"."users" WHERE "id"=$1');
    expect(queryCalls[0]!.params).toEqual([9]);
  });

  test("delete on a non-PK column → bad_request even when confirmed, runQuery never called", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "delete", table: "users", pk: { column: "status", value: "x" } },
      confirmed: true,
    });
    expect(reply.ok).toBe(false);
    expect(queryCalls.length).toBe(0);
  });
});

/* ---- Structured path (a): createTable -------------------------------- */

describe("structured createTable — fixed allowlist, no raw-text fallback", () => {
  test("composes CREATE TABLE from typed defs + table-level PK, auto-commits", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({
      shape: "structured",
      op: {
        kind: "createTable",
        table: "widgets",
        columns: [
          { name: "id", type: "integer", notNull: true },
          { name: "label", type: "text" },
        ],
        primaryKey: ["id"],
      },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe(
      'CREATE TABLE "widgets" ("id" INTEGER NOT NULL, "label" TEXT, PRIMARY KEY ("id"))',
    );
    expect(queryCalls[0]!.params).toEqual([]);
  });

  test("honors a column-level primaryKey:true — composes the quote-escaped PK clause", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({
      shape: "structured",
      op: {
        kind: "createTable",
        table: "widgets",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true },
          { name: "label", type: "TEXT" },
        ],
      },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe(
      'CREATE TABLE "widgets" ("id" INTEGER, "label" TEXT, PRIMARY KEY ("id"))',
    );
  });

  test("column-level PK is quote-escaped on mysql too", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "mysql" });
    const reply = await exec.execute({
      shape: "structured",
      op: {
        kind: "createTable",
        table: "widgets",
        columns: [{ name: "id", type: "BIGINT", primaryKey: true }],
      },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe(
      "CREATE TABLE `widgets` (`id` BIGINT, PRIMARY KEY (`id`))",
    );
  });

  test("table-level + column-level PK columns union (deduped, order-preserving) into a composite PK", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({
      shape: "structured",
      op: {
        kind: "createTable",
        table: "memberships",
        columns: [
          { name: "a", type: "INTEGER", primaryKey: true },
          { name: "b", type: "INTEGER" },
          { name: "c", type: "INTEGER", primaryKey: true },
        ],
        // 'a' appears both table-level and column-level → deduped, not repeated.
        primaryKey: ["a", "b"],
      },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe(
      'CREATE TABLE "memberships" ("a" INTEGER, "b" INTEGER, "c" INTEGER, PRIMARY KEY ("a", "b", "c"))',
    );
  });

  test("a non-boolean column primaryKey → bad_request, nothing runs", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "t", columns: [{ name: "id", type: "INTEGER", primaryKey: "yes" }] },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    expect(queryCalls.length).toBe(0);
  });

  test("a column-level PK is the introspected single PK a later structured update verifies against", async () => {
    // The composed DDL now declares the PK, so the live schema reports it — and a
    // structured update addressing that column passes single-PK verification.
    const schema: DatabaseSchema = {
      engine: "postgres",
      tables: [
        { schema: "public", name: "widgets", columns: [{ name: "id", dataType: "int", nullable: false }], primaryKey: ["id"], indexes: [], foreignKeys: [] },
      ],
    };
    const { exec, queryCalls } = makeExecutor({ engine: "postgres", schema });
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "update", table: "widgets", pk: { column: "id", value: 7 }, set: [{ column: "label", value: "x" }] },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe('UPDATE "public"."widgets" SET "label"=$1 WHERE "id"=$2');
    expect(queryCalls[0]!.params).toEqual(["x", 7]);
  });

  test("an unsupported type token → bad_request, never spliced (no raw fallback)", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "t", columns: [{ name: "c", type: "int; DROP TABLE users --" }] },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    expect(queryCalls.length).toBe(0);
  });

  test("duplicate column / undefined-PK-column → bad_request", async () => {
    const { exec } = makeExecutor();
    const dup = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "t", columns: [{ name: "c", type: "text" }, { name: "c", type: "text" }] },
    });
    expect(dup.ok).toBe(false);
    const badPk = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "t", columns: [{ name: "c", type: "text" }], primaryKey: ["missing"] },
    });
    expect(badPk.ok).toBe(false);
  });

  test("mysql renders bare VARCHAR as VARCHAR(255) (length required by the engine)", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "mysql" });
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "t", columns: [{ name: "s", type: "VARCHAR" }] },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe("CREATE TABLE `t` (`s` VARCHAR(255))");
  });

  test("mysql UUID (no native type) → bad_request before any DDL runs", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "mysql" });
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "t", columns: [{ name: "id", type: "UUID" }] },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    expect(queryCalls.length).toBe(0);
  });

  test("postgres renders bare VARCHAR unchanged (unbounded)", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "t", columns: [{ name: "s", type: "VARCHAR" }] },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe('CREATE TABLE "t" ("s" VARCHAR)');
  });

  test("postgres UUID stays valid and renders UUID", async () => {
    const { exec, queryCalls } = makeExecutor({ engine: "postgres" });
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "t", columns: [{ name: "id", type: "UUID" }] },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(queryCalls[0]!.sql).toBe('CREATE TABLE "t" ("id" UUID)');
  });

  test("mysql rejects an engine-unsupported token in ANY position (not just first) → no DDL runs", async () => {
    // The reject fires per-column, so a supported column preceding an unsupported one must
    // still short-circuit BEFORE runQuery — a structurally-valid request never composes DDL
    // an engine would reject, regardless of where the offending column sits.
    const { exec, queryCalls } = makeExecutor({ engine: "mysql" });
    const reply = await exec.execute({
      shape: "structured",
      op: {
        kind: "createTable",
        table: "t",
        columns: [
          { name: "ok", type: "INTEGER" },
          { name: "id", type: "UUID" },
        ],
      },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    expect(queryCalls.length).toBe(0);
  });
});

/* ---- Path (a): un-widenable + request-shape validation --------------- */

describe("structured path cannot widen; request shape is validated first", () => {
  test("an arbitrary-DDL kind is rejected", async () => {
    const { exec, queryCalls } = makeExecutor();
    const reply = await exec.execute({ shape: "structured", op: { kind: "drop", table: "users" } });
    expect(reply.ok).toBe(false);
    expect(queryCalls.length).toBe(0);
  });

  test("missing/blank table → bad_request", async () => {
    const { exec } = makeExecutor();
    for (const op of [{ kind: "insert", columns: [{ column: "a", value: 1 }] }, { kind: "insert", table: "  ", columns: [{ column: "a", value: 1 }] }]) {
      const reply = await exec.execute({ shape: "structured", op });
      expect(reply.ok).toBe(false);
    }
  });

  test("malformed request envelope → bad_request without a connection round-trip", async () => {
    const { exec, queryCalls, readOnlyCalls } = makeExecutor();
    for (const req of [null, [], "raw", { shape: "nope" }, { shape: "raw" }, { shape: "raw", sql: 5 }, { shape: "structured" }, { shape: "raw", sql: "SELECT 1", confirmed: "yes" }, { shape: "raw", sql: "SELECT 1", connectionId: 5 }]) {
      const reply = await exec.execute(req);
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("bad_request");
    }
    expect(queryCalls.length + readOnlyCalls.length).toBe(0);
  });
});

/* ---- Story 6.2: per-request re-target routing ------------------------ */

describe("execute routes to the resolved target (Story 6.2)", () => {
  /**
   * Build an executor whose resolver routes: id null/absent → boot seams; a known id →
   * that target's seams; an unknown id → `not-found`. Each seam-set captures its OWN
   * calls so we can prove WHICH connection a request actually ran against.
   */
  function makeTargetedExecutor(opts: { engine?: DbEngine } = {}) {
    const boot = makeSeams(opts);
    const target = makeSeams(opts);
    let resolvedUnknown = false;
    const exec = createExecutor({
      resolveConnection: (id) => {
        if (id === null || id === undefined) return { ok: true, seams: boot.seams };
        if (id === "conn-b") return { ok: true, seams: target.seams };
        resolvedUnknown = true;
        return { ok: false, reason: "not-found" };
      },
    });
    return { exec, boot, target, wasUnknown: () => resolvedUnknown };
  }

  test("no connectionId → runs against the DEFAULT (boot) seams, target untouched", async () => {
    const { exec, boot, target } = makeTargetedExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SELECT * FROM users" });
    expect(reply.ok && reply.result.status).toBe("rows");
    expect(boot.readOnlyCalls.length).toBe(1);
    expect(target.readOnlyCalls.length).toBe(0);
    expect(target.queryCalls.length).toBe(0);
  });

  test("a valid connectionId (raw read) → routes to the TARGET seams, boot untouched", async () => {
    const { exec, boot, target } = makeTargetedExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SELECT * FROM users", connectionId: "conn-b" });
    expect(reply.ok && reply.result.status).toBe("rows");
    expect(target.readOnlyCalls.length).toBe(1);
    // Fetch bound (DW-36) applies on the re-targeted read too.
    expect(target.readOnlyCalls[0]!.sql).toBe(`SELECT * FROM users\nLIMIT ${MAX_RESULT_ROWS + 1}`);
    expect(boot.readOnlyCalls.length).toBe(0);
  });

  test("a valid connectionId on the STRUCTURED destructive path (confirmed delete) → runs against the TARGET", async () => {
    // The highest-risk branch: a guarded/destructive structured op must resolve + run
    // against the target seams, never the boot connection.
    const { exec, boot, target } = makeTargetedExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "delete", table: "users", pk: { column: "id", value: 9 } },
      confirmed: true,
      connectionId: "conn-b",
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(target.queryCalls.length).toBe(1);
    expect(target.queryCalls[0]!.sql).toBe('DELETE FROM "public"."users" WHERE "id"=$1');
    expect(target.queryCalls[0]!.params).toEqual([9]);
    expect(boot.queryCalls.length).toBe(0);
  });

  test("a structured insert with connectionId → composed + run against the TARGET seams", async () => {
    const { exec, boot, target } = makeTargetedExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "insert", table: "users", columns: [{ column: "id", value: 7 }] },
      connectionId: "conn-b",
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(target.queryCalls[0]!.sql).toBe('INSERT INTO "users" ("id") VALUES ($1)');
    expect(boot.queryCalls.length).toBe(0);
  });

  test("an unknown connectionId → not_found error reply, nothing runs on any target", async () => {
    const { exec, boot, target, wasUnknown } = makeTargetedExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SELECT 1", connectionId: "ghost" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("not_found");
    expect(wasUnknown()).toBe(true);
    expect(boot.readOnlyCalls.length + target.readOnlyCalls.length).toBe(0);
  });

  test("an unavailable store during resolution → internal_error (distinct from not_found)", async () => {
    const exec = createExecutor({
      resolveConnection: () => ({ ok: false, reason: "unavailable", detail: "store open failed" }),
    });
    const reply = await exec.execute({ shape: "raw", sql: "SELECT 1", connectionId: "conn-b" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("internal_error");
  });

  test("no connection target (seams throw NoConnectionTargetError) → bad_request 'no active connection', never internal_error", async () => {
    // Mirror the real read-path seams over a null-url manager: every driver seam throws
    // the typed NoConnectionTargetError. The executor must translate it into a neutral
    // bad_request — NOT let it degrade into dispatch's internal_error catch-all.
    const throwing: ConnectionSeams = {
      runQuery: async () => {
        throw new NoConnectionTargetError();
      },
      runReadOnly: async () => {
        throw new NoConnectionTargetError();
      },
      getEngine: async () => {
        throw new NoConnectionTargetError();
      },
      getSchema: async () => {
        throw new NoConnectionTargetError();
      },
      quoteIdent: (ident) => `"${ident}"`,
      connect: async () => {
        throw new NoConnectionTargetError();
      },
      invalidateSchema: () => {},
    };
    const exec = createExecutor({ resolveConnection: () => ({ ok: true, seams: throwing }) });

    const reply = await exec.execute({ shape: "raw", sql: "SELECT 1" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBe("bad_request");
      expect(reply.error.code).not.toBe("internal_error");
      expect(reply.error.message).toContain("no active connection");
      // Neutral, credential-free envelope — no URL/host/user/password ever crosses.
      const serialized = JSON.stringify(reply.error);
      expect(serialized).not.toContain("postgres://");
      expect(serialized).not.toContain("password");
    }
  });

  test("no connection target on the STRUCTURED path too → bad_request 'no active connection', never internal_error", async () => {
    // The structured path resolves the engine/schema seam (getEngine / getSchema via
    // resolveSinglePkTable) BEFORE any quoteIdent — so the typed NoConnectionTargetError
    // fires first and must be translated to bad_request, exactly like the raw path.
    // This guards the load-bearing seam ORDER: if a future refactor moved quoteIdent
    // (a generic Error) ahead of the async seam, the null-url case would regress to
    // internal_error. This test locks that ordering in.
    const throwing: ConnectionSeams = {
      runQuery: async () => {
        throw new NoConnectionTargetError();
      },
      runReadOnly: async () => {
        throw new NoConnectionTargetError();
      },
      getEngine: async () => {
        throw new NoConnectionTargetError();
      },
      getSchema: async () => {
        throw new NoConnectionTargetError();
      },
      quoteIdent: (ident) => `"${ident}"`,
      connect: async () => {
        throw new NoConnectionTargetError();
      },
      invalidateSchema: () => {},
    };
    const exec = createExecutor({ resolveConnection: () => ({ ok: true, seams: throwing }) });

    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "insert", table: "users", columns: [{ column: "name", value: "ada" }] },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBe("bad_request");
      expect(reply.error.code).not.toBe("internal_error");
      expect(reply.error.message).toContain("no active connection");
      const serialized = JSON.stringify(reply.error);
      expect(serialized).not.toContain("postgres://");
      expect(serialized).not.toContain("password");
    }
  });
});

/* ---- DW-45: schema-memo invalidation after a schema-mutating execute -- */

/**
 * The memo `connection.ts` takes at first connect is only correct until something
 * changes the catalog. The executor is the one place that knows a mutation actually
 * COMMITTED, so it fires `invalidateSchema()` on the resolved seams — and nowhere else.
 * This battery pins BOTH halves: every branch that must bust, and every branch that must
 * not (an over-eager bust would re-introspect on every read; an under-eager one is the
 * DW-45 bug — a stale "N tables" context served to the tree and the AI).
 */
describe("execute invalidates the target's schema memo (DW-45)", () => {
  /** An executor over ONE captured seam-set, exposing its invalidation counter. */
  function makeInvalidatingExecutor(opts: { engine?: DbEngine; queryThrows?: unknown } = {}) {
    const s = makeSeams(opts);
    const exec = createExecutor({ resolveConnection: () => ({ ok: true, seams: s.seams }) });
    return { exec, ...s };
  }

  test("a CONFIRMED raw mutation busts the memo exactly once", async () => {
    const { exec, invalidations } = makeInvalidatingExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "DROP TABLE users", confirmed: true });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(invalidations.count).toBe(1);
  });

  test("an auto-classified READ never busts the memo", async () => {
    const { exec, invalidations } = makeInvalidatingExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "SELECT * FROM users" });
    expect(reply.ok && reply.result.status).toBe("rows");
    expect(invalidations.count).toBe(0);
  });

  test("an UNCONFIRMED mutation (confirmation_required) never busts the memo — nothing ran", async () => {
    const { exec, invalidations } = makeInvalidatingExecutor();
    const reply = await exec.execute({ shape: "raw", sql: "DROP TABLE users" });
    expect(reply.ok && reply.result.status).toBe("confirmation_required");
    expect(invalidations.count).toBe(0);
  });

  test("a successful createTable busts the memo (the new table must appear in the next read)", async () => {
    const { exec, invalidations } = makeInvalidatingExecutor();
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "notes", columns: [{ name: "id", type: "INTEGER", primaryKey: true }] },
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(invalidations.count).toBe(1);
  });

  test("a REJECTED createTable (unsupported type on this engine) never busts the memo", async () => {
    const { exec, invalidations } = makeInvalidatingExecutor({ engine: "mysql" });
    const reply = await exec.execute({
      shape: "structured",
      op: { kind: "createTable", table: "notes", columns: [{ name: "id", type: "UUID" }] },
    });
    expect(reply.ok).toBe(false);
    expect(invalidations.count).toBe(0);
  });

  test("insert / update / delete change ROWS, not the catalog — none busts the memo", async () => {
    const { exec, invalidations } = makeInvalidatingExecutor();
    const replies = [
      await exec.execute({
        shape: "structured",
        op: { kind: "insert", table: "users", columns: [{ column: "name", value: "ada" }] },
      }),
      await exec.execute({
        shape: "structured",
        op: { kind: "update", table: "users", set: [{ column: "name", value: "ada" }], pk: { column: "id", value: 1 } },
      }),
      await exec.execute({
        shape: "structured",
        op: { kind: "delete", table: "users", pk: { column: "id", value: 1 } },
        confirmed: true,
      }),
    ];
    for (const reply of replies) expect(reply.ok && reply.result.status).toBe("ok");
    expect(invalidations.count).toBe(0);
  });

  test("a mutation whose runQuery THROWS never busts the memo (nothing committed)", async () => {
    const { exec, invalidations } = makeInvalidatingExecutor({ queryThrows: new Error("deadlock detected") });
    await expect(exec.execute({ shape: "raw", sql: "DROP TABLE users", confirmed: true })).rejects.toThrow();
    expect(invalidations.count).toBe(0);
  });

  test("a TARGETED mutation busts the target's memo only — the boot memo is untouched", async () => {
    // The scoping guarantee: the executor holds one resolve's seams, so it structurally
    // cannot flush another connection's memo (nor the whole pool).
    const boot = makeSeams();
    const target = makeSeams();
    const exec = createExecutor({
      resolveConnection: (id) =>
        id === null || id === undefined
          ? { ok: true, seams: boot.seams }
          : { ok: true, seams: target.seams },
    });

    const reply = await exec.execute({
      shape: "raw",
      sql: "CREATE TABLE notes (id integer)",
      confirmed: true,
      connectionId: "conn-b",
    });
    expect(reply.ok && reply.result.status).toBe("ok");
    expect(target.invalidations.count).toBe(1);
    expect(boot.invalidations.count).toBe(0);
  });
});
