/**
 * quick-studio UI (Ring 2) — SandboxFrame structural tests.
 *
 * No DOM at test runtime, so we assert the STATIC markup via `react-dom/server`
 * `renderToStaticMarkup` (effects never run there): the iframe carries
 * `sandbox="allow-scripts"`, its `src` is the injected Ring 3 origin, and the
 * containment-critical `allow-same-origin` is ABSENT from the rendered attribute.
 * `resolveSandboxOrigin` is unit-tested against the injected global.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FROZEN_SCHEMA_VERSION, type FrozenData } from "../../shared/contract.ts";
import { resolveSandboxOrigin, SandboxFrame } from "./SandboxFrame.tsx";

const fixture: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [{ name: "id", type: "number" }],
  rows: [[{ kind: "number", value: 1 }]],
};

describe("SandboxFrame static structure", () => {
  test("renders an iframe with sandbox='allow-scripts' and the injected src", () => {
    const html = renderToStaticMarkup(<SandboxFrame data={fixture} sandboxOrigin="http://127.0.0.1:5555" />);
    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('src="http://127.0.0.1:5555"');
  });

  test("NEVER renders allow-same-origin (the sacred negative)", () => {
    const html = renderToStaticMarkup(<SandboxFrame data={fixture} sandboxOrigin="http://127.0.0.1:5555" />);
    expect(html).not.toContain("allow-same-origin");
  });

  test("renders with a null data prop (empty guest) without crashing", () => {
    const html = renderToStaticMarkup(<SandboxFrame data={null} sandboxOrigin="http://127.0.0.1:6789" />);
    expect(html).toContain('src="http://127.0.0.1:6789"');
    expect(html).toContain('sandbox="allow-scripts"');
  });

  test("an empty/invalid origin renders src='about:blank' — NEVER src='' (parent-doc load)", () => {
    const html = renderToStaticMarkup(<SandboxFrame data={fixture} sandboxOrigin="" />);
    expect(html).toContain('src="about:blank"');
    // The sacred negative: `src=""` resolves to the token-bearing parent Core document.
    expect(html).not.toContain('src=""');
    // Containment is still intact — an about:blank frame stays allow-scripts only.
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
  });
});

describe("resolveSandboxOrigin", () => {
  afterEach(() => {
    delete (globalThis as { __QS_SANDBOX_ORIGIN__?: string }).__QS_SANDBOX_ORIGIN__;
  });

  test("reads the injected global, defaulting to '' when absent", () => {
    expect(resolveSandboxOrigin()).toBe("");
    (globalThis as { __QS_SANDBOX_ORIGIN__?: string }).__QS_SANDBOX_ORIGIN__ = "http://127.0.0.1:7000";
    expect(resolveSandboxOrigin()).toBe("http://127.0.0.1:7000");
  });
});
