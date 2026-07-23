/**
 * quick-studio UI (Ring 2) — connections view-model tests (pure, no React/DOM).
 *
 * Covers `validateDraft` (add vs edit, name + url rules) and every reducer
 * transition (load / add / edit / remove) plus their immutability and no-op edges.
 */

import { describe, expect, test } from "bun:test";
import type { ConnectionSummary } from "../../shared/contract.ts";
import {
  applyAdded,
  applyEdited,
  applyRemoved,
  editConnectionParams,
  emptyConnections,
  emptyDraft,
  loadConnections,
  validateDraft,
  type Draft,
} from "./connections-model.ts";

const summary = (id: string, name: string, host = "h", engine = "postgres"): ConnectionSummary => ({
  id,
  name,
  host,
  engine,
});

describe("validateDraft — add", () => {
  test("empty name → name error", () => {
    const r = validateDraft({ name: "   ", url: "postgres://h/db", schema: "" }, "add");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("name");
  });

  test("missing url → url error", () => {
    const r = validateDraft({ name: "ok", url: "", schema: "" }, "add");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("url");
  });

  test("unparseable url → url error", () => {
    const r = validateDraft({ name: "ok", url: "not a url", schema: "" }, "add");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("url");
  });

  test("valid add draft → ok", () => {
    expect(validateDraft({ name: "ok", url: "postgres://u:p@h:5432/db", schema: "" }, "add").ok).toBe(true);
  });

  test("hostless url (parses but no host) → url error (P7, mirrors Core)", () => {
    for (const url of ["foo:bar", "mailto:x@example.com"]) {
      const r = validateDraft({ name: "ok", url, schema: "" }, "add");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.field).toBe("url");
        expect(r.message).toBe("url has no host");
      }
    }
  });
});

describe("validateDraft — edit", () => {
  test("empty url is allowed (rename-only) when name is present", () => {
    expect(validateDraft({ name: "renamed", url: "", schema: "" }, "edit").ok).toBe(true);
  });

  test("empty name still fails on edit", () => {
    const r = validateDraft({ name: "", url: "", schema: "" }, "edit");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("name");
  });

  test("a present-but-bad url fails on edit", () => {
    const r = validateDraft({ name: "ok", url: ":::", schema: "" }, "edit");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("url");
  });

  test("a present valid url passes on edit (repoint)", () => {
    expect(validateDraft({ name: "ok", url: "mysql://root:pw@h/db", schema: "" }, "edit").ok).toBe(true);
  });
});

describe("reducers", () => {
  test("emptyConnections / emptyDraft are empty", () => {
    expect(emptyConnections().connections).toEqual([]);
    expect(emptyDraft()).toEqual({ name: "", url: "", schema: "" });
  });

  test("loadConnections replaces the whole list (and copies it)", () => {
    const input = [summary("1", "a"), summary("2", "b")];
    const next = loadConnections(emptyConnections(), input);
    expect(next.connections).toHaveLength(2);
    expect(next.connections).not.toBe(input); // defensive copy
  });

  test("applyAdded appends without mutating the prior state", () => {
    const prev = loadConnections(emptyConnections(), [summary("1", "a")]);
    const next = applyAdded(prev, summary("2", "b"));
    expect(next.connections.map((c) => c.id)).toEqual(["1", "2"]);
    expect(prev.connections).toHaveLength(1); // immutable
  });

  test("applyEdited replaces the matching id in place, keeping order", () => {
    const prev = loadConnections(emptyConnections(), [
      summary("1", "a"),
      summary("2", "b"),
      summary("3", "c"),
    ]);
    const next = applyEdited(prev, summary("2", "renamed", "newhost", "mysql"));
    expect(next.connections.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(next.connections[1]).toEqual(summary("2", "renamed", "newhost", "mysql"));
  });

  test("applyEdited for an unknown id is a no-op on content", () => {
    const prev = loadConnections(emptyConnections(), [summary("1", "a")]);
    const next = applyEdited(prev, summary("99", "ghost"));
    expect(next.connections).toEqual(prev.connections);
  });

  test("applyRemoved drops the matching id", () => {
    const prev = loadConnections(emptyConnections(), [summary("1", "a"), summary("2", "b")]);
    const next = applyRemoved(prev, "1");
    expect(next.connections.map((c) => c.id)).toEqual(["2"]);
  });

  test("applyRemoved for an absent id leaves the list unchanged", () => {
    const prev = loadConnections(emptyConnections(), [summary("1", "a")]);
    const next = applyRemoved(prev, "nope");
    expect(next.connections.map((c) => c.id)).toEqual(["1"]);
  });
});

describe("validateDraft — optional schema field (Story 10.2)", () => {
  test("a schema value never affects validation (free text, always optional)", () => {
    for (const schema of ["", "  ", "public", "weird name; --"]) {
      expect(validateDraft({ name: "ok", url: "postgres://h/db", schema }, "add").ok).toBe(true);
      expect(validateDraft({ name: "ok", url: "", schema }, "edit").ok).toBe(true);
    }
  });

  test("a schema value cannot rescue an otherwise-invalid draft", () => {
    const r = validateDraft({ name: "", url: "postgres://h/db", schema: "public" }, "add");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("name");
  });
});

// `connections.edit` is a PARTIAL patch: an absent key means "keep". These are the rules
// that decide which keys a save actually carries — the difference between a no-op save
// and one that clobbers a pin (or a url) another window set in the meantime.
describe("editConnectionParams — which keys a save patches (Story 10.2)", () => {
  const draft = (over: Partial<Draft> = {}): Draft => ({ name: "svc", url: "", schema: "", ...over });

  test("untouched schema on an UNPINNED connection: the key is omitted entirely", () => {
    const params = editConnectionParams("c1", draft(), undefined);
    expect(params).toEqual({ id: "c1", name: "svc" });
    expect("schema" in params).toBe(false);
  });

  test("untouched schema on a PINNED connection: omitted, so the pin is kept (no lost update)", () => {
    const params = editConnectionParams("c1", draft({ schema: "reporting" }), "reporting");
    expect(params).toEqual({ id: "c1", name: "svc" });
    expect("schema" in params).toBe(false);
  });

  test("blanking a pre-filled pin sends `\"\"` — Core's explicit CLEAR signal (R1)", () => {
    const params = editConnectionParams("c1", draft({ schema: "  " }), "reporting");
    expect(params).toEqual({ id: "c1", name: "svc", schema: "" });
  });

  test("changing the pin sends the new (trimmed) value", () => {
    expect(editConnectionParams("c1", draft({ schema: " analytics " }), "reporting")).toEqual({
      id: "c1",
      name: "svc",
      schema: "analytics",
    });
    // Setting one for the first time is the same rule from the `undefined` side.
    expect(editConnectionParams("c1", draft({ schema: "reporting" }), undefined)).toEqual({
      id: "c1",
      name: "svc",
      schema: "reporting",
    });
  });

  test("re-typing the SAME pin with only padding differences is still a no-op", () => {
    const params = editConnectionParams("c1", draft({ schema: "  reporting  " }), "reporting");
    expect("schema" in params).toBe(false);
  });

  test("a blank url is OMITTED — the UI never held it, so blank means KEEP", () => {
    const params = editConnectionParams("c1", draft({ url: "   " }), undefined);
    expect(params).toEqual({ id: "c1", name: "svc" });
    expect("url" in params).toBe(false);
  });

  test("a non-blank url REPOINTS, trimmed, alongside the name", () => {
    expect(editConnectionParams("c1", draft({ url: " postgres://h/db " }), undefined)).toEqual({
      id: "c1",
      name: "svc",
      url: "postgres://h/db",
    });
  });

  test("a repoint and a re-pin travel together in one patch", () => {
    expect(
      editConnectionParams("c1", draft({ name: " renamed ", url: "postgres://h/db", schema: "s2" }), "s1"),
    ).toEqual({ id: "c1", name: "renamed", url: "postgres://h/db", schema: "s2" });
  });
});
