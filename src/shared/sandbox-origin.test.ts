/**
 * The shared sandbox-origin rule (DW-2 review): ONE usability gate, imported by all
 * three consumers of `window.__QS_SANDBOX_ORIGIN__` — `shellCspHeaders` (Ring 1,
 * `frame-src` source), `renderIndexHtml` (Ring 1, the injected global) and
 * `buildSandboxIframeAttrs` (Ring 2, iframe `src`).
 *
 * This file is the authoritative matrix. Each ring's own test then asserts that its
 * consumer agrees with the verdict here, which is what makes "the header, the global and
 * the frame can never disagree" a tested property instead of a comment. It replaces two
 * states earlier passes found: first `server.ts` gating on `^https?://[^/]` while
 * `sandbox-host.ts` gated on `^https?://`; then a shared gate reached through a
 * character FILTER on one side and the raw value on the other, which additionally let a
 * hostile string be repaired into a valid origin all three sides then agreed on.
 */

import { describe, expect, test } from "bun:test";
import { isUsableSandboxOrigin } from "./sandbox-origin.ts";
import {
  REPAIRABLE_HOSTILE_SANDBOX_ORIGINS,
  UNUSABLE_SANDBOX_ORIGINS,
  USABLE_SANDBOX_ORIGINS,
} from "./sandbox-origin.fixtures.ts";

describe("isUsableSandboxOrigin", () => {
  test("admits scheme://host[:port], including bracketed IPv6", () => {
    for (const origin of USABLE_SANDBOX_ORIGINS) {
      expect(isUsableSandboxOrigin(origin)).toBe(true);
    }
  });

  test("rejects everything without a real host — the unparseable-source class", () => {
    for (const origin of UNUSABLE_SANDBOX_ORIGINS) {
      expect(isUsableSandboxOrigin(origin)).toBe(false);
    }
  });

  test("rejects a hostile origin whole, never repairing it into a valid one", () => {
    // The whole reason there is no companion sanitizer. Each of these differs from a
    // real origin only by characters a strip-and-keep filter removes, and three of them
    // filter down to an origin naming a host or port the input never denoted. The gate
    // must refuse the RAW value rather than the residue.
    for (const hostile of REPAIRABLE_HOSTILE_SANDBOX_ORIGINS) {
      expect(isUsableSandboxOrigin(hostile)).toBe(false);
    }
  });

  test("an accepted origin carries no CSP- or HTML-significant character", () => {
    // What makes the removed filter provably redundant rather than merely gone: the
    // accepted charset cannot split `frame-src` into a forged directive, and cannot
    // break out of the `<script>` context the value is injected into.
    for (const origin of USABLE_SANDBOX_ORIGINS) {
      for (const dangerous of [";", " ", "'", '"', "<", ">", "\r", "\n", "*", "\\"]) {
        expect(origin).not.toContain(dangerous);
      }
    }
    // And the gate agrees for any value that does carry one.
    for (const dangerous of [";", " ", "'", '"', "<", ">", "\r", "\n", "*", "\\"]) {
      expect(isUsableSandboxOrigin(`http://127.0.0.1${dangerous}:6789`)).toBe(false);
    }
  });
});
