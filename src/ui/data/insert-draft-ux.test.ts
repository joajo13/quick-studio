/**
 * Unit tests for the insert-draft reveal helpers (DW-56 / DW-57). No DOM /
 * React harness — these are pure functions over an open/closed transition plus
 * a guarded `scrollIntoView` call, exercised with a hand-rolled fake element.
 */

import { describe, expect, test } from "bun:test";
import { type RevealTarget, revealInsertDraft, shouldRevealInsertDraft } from "./insert-draft-ux.ts";

describe("shouldRevealInsertDraft", () => {
  test("reveals on the closed→open edge", () => {
    expect(shouldRevealInsertDraft(false, true)).toBe(true);
  });

  test("does not repeat while the draft stays open", () => {
    expect(shouldRevealInsertDraft(true, true)).toBe(false);
  });

  test("does not reveal when the draft closes", () => {
    expect(shouldRevealInsertDraft(true, false)).toBe(false);
  });

  test("does not reveal when the draft stays closed", () => {
    expect(shouldRevealInsertDraft(false, false)).toBe(false);
  });
});

describe("revealInsertDraft", () => {
  test("scrolls a real element once with nearest block/inline", () => {
    const calls: Array<boolean | ScrollIntoViewOptions | undefined> = [];
    const el: RevealTarget = {
      scrollIntoView(arg?: boolean | ScrollIntoViewOptions): void {
        calls.push(arg);
      },
    };

    expect(revealInsertDraft(el)).toBe(true);
    expect(calls).toEqual([{ block: "nearest", inline: "nearest" }]);
  });

  test("returns false without throwing when the ref is null or undefined", () => {
    expect(revealInsertDraft(null)).toBe(false);
    expect(revealInsertDraft(undefined)).toBe(false);
  });

  // `RevealTarget` requires the method, so this shape can only arrive through a
  // cast — which is the point: the runtime guard is the net under a DOM-less or
  // otherwise non-element value that the type system was told to trust.
  test("returns false without throwing when the target has no scrollIntoView", () => {
    expect(revealInsertDraft({} as unknown as RevealTarget)).toBe(false);
  });
});
