/**
 * quick-studio UI (Ring 2) — ProvidersPanel run-mode signal tests (Story 9.6).
 *
 * Following the repo convention (no jsdom/testing-library): `renderToStaticMarkup`
 * checks the static structure. The panel calls `rpc("providers.list")` on mount, so
 * the RPC client is stubbed BEFORE the module under test is imported — under SSR the
 * effect never fires anyway, but the stub keeps the import inert and deterministic.
 *
 * The only thing under test here is the run-mode discoverability line: it appears
 * ONLY for `mode="ephemeral"`, and it is a plain informational line — NOT an
 * `role="alert"` envelope (that role is reserved for RPC error surfacing).
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { okReply, type ListProvidersResult, type RpcReply } from "../../shared/contract.ts";

// Stub the RPC client BEFORE importing the panel: the mount `providers.list` resolves
// to an empty, secret-free `ok` result so no live Core is needed.
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<ListProvidersResult>> =>
    okReply({ providers: [] }),
);
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));

const { ProvidersPanel } = await import("./ProvidersPanel.tsx");

const EPHEMERAL_NOTE = "not remembered after restart";

describe("ProvidersPanel — run-mode signal", () => {
  test("ephemeral mode renders the terse note as a plain <p>, NOT a role=alert error envelope", () => {
    const html = renderToStaticMarkup(<ProvidersPanel mode="ephemeral" />);
    expect(html).toContain(EPHEMERAL_NOTE);
    expect(html).toContain("ephemeral session");
    // Positively assert the note is a plain paragraph (the "plain line" constraint),
    // not merely that the document happens to contain no alert.
    expect(html).toMatch(/<p\b[^>]*>[^<]*ephemeral session/);
    // And it is NOT the role=alert error envelope (bg-err-soft), reserved for RPC errors.
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("bg-err-soft");
  });

  test("persistent mode renders NO ephemeral note", () => {
    const html = renderToStaticMarkup(<ProvidersPanel mode="persistent" />);
    expect(html).not.toContain(EPHEMERAL_NOTE);
    expect(html).not.toContain("ephemeral session");
  });

  test("absent mode (undefined) renders NO ephemeral note", () => {
    const html = renderToStaticMarkup(<ProvidersPanel />);
    expect(html).not.toContain(EPHEMERAL_NOTE);
    expect(html).not.toContain("ephemeral session");
  });
});
