/**
 * quick-studio UI (Ring 2) — IndexList render tests (Story 3.5).
 *
 * Pure, DOM-free render tests: the presentational {@link IndexList} is rendered to
 * static markup (no live DOM / testing-library in this project) and the resulting
 * HTML string is asserted. Covers ordered columns, the unique vs non-unique marker,
 * the PK-backing index appearing in the list, and the "0 indexes" empty state.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SchemaIndexInfo } from "../../shared/contract.ts";
import { IndexList } from "./IndexList.tsx";

const html = (indexes: ReadonlyArray<SchemaIndexInfo>): string =>
  renderToStaticMarkup(<IndexList indexes={indexes} />);

describe("IndexList", () => {
  test("lists each index with its name and columns", () => {
    const out = html([
      { name: "users_pkey", columns: ["id"], unique: true },
      { name: "ix_users_email", columns: ["email"], unique: false },
    ]);
    expect(out).toContain("users_pkey");
    expect(out).toContain("ix_users_email");
    expect(out).toContain("email");
  });

  test("renders composite columns in index order (b, a — not alphabetical)", () => {
    const out = html([{ name: "ix_ba", columns: ["b", "a"], unique: false }]);
    expect(out).toContain("b, a");
    expect(out).not.toContain("a, b");
  });

  test("a unique index carries the ⚿ unique marker; a non-unique one does not", () => {
    const uniqueOut = html([{ name: "u", columns: ["id"], unique: true }]);
    expect(uniqueOut).toContain("⚿");
    expect(uniqueOut).toContain("unique index");

    const plainOut = html([{ name: "p", columns: ["x"], unique: false }]);
    expect(plainOut).not.toContain("⚿");
    expect(plainOut).not.toContain("unique index");
  });

  test("the PK-backing index appears in the list, marked unique", () => {
    const out = html([{ name: "PRIMARY", columns: ["id"], unique: true }]);
    expect(out).toContain("PRIMARY");
    expect(out).toContain("unique index");
  });

  test("an index-less table renders the '0 indexes' empty state", () => {
    const out = html([]);
    expect(out).toContain("0 indexes");
  });
});
