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
  emptyConnections,
  emptyDraft,
  loadConnections,
  validateDraft,
} from "./connections-model.ts";

const summary = (id: string, name: string, host = "h", engine = "postgres"): ConnectionSummary => ({
  id,
  name,
  host,
  engine,
});

describe("validateDraft — add", () => {
  test("empty name → name error", () => {
    const r = validateDraft({ name: "   ", url: "postgres://h/db" }, "add");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("name");
  });

  test("missing url → url error", () => {
    const r = validateDraft({ name: "ok", url: "" }, "add");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("url");
  });

  test("unparseable url → url error", () => {
    const r = validateDraft({ name: "ok", url: "not a url" }, "add");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("url");
  });

  test("valid add draft → ok", () => {
    expect(validateDraft({ name: "ok", url: "postgres://u:p@h:5432/db" }, "add").ok).toBe(true);
  });

  test("hostless url (parses but no host) → url error (P7, mirrors Core)", () => {
    for (const url of ["foo:bar", "mailto:x@example.com"]) {
      const r = validateDraft({ name: "ok", url }, "add");
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
    expect(validateDraft({ name: "renamed", url: "" }, "edit").ok).toBe(true);
  });

  test("empty name still fails on edit", () => {
    const r = validateDraft({ name: "", url: "" }, "edit");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("name");
  });

  test("a present-but-bad url fails on edit", () => {
    const r = validateDraft({ name: "ok", url: ":::" }, "edit");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("url");
  });

  test("a present valid url passes on edit (repoint)", () => {
    expect(validateDraft({ name: "ok", url: "mysql://root:pw@h/db" }, "edit").ok).toBe(true);
  });
});

describe("reducers", () => {
  test("emptyConnections / emptyDraft are empty", () => {
    expect(emptyConnections().connections).toEqual([]);
    expect(emptyDraft()).toEqual({ name: "", url: "" });
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
