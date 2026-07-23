/**
 * quick-studio UI (Ring 2) — TabContent render tests (Story 10.6).
 *
 * Project convention (no jsdom / testing-library): the RPC client is replaced via
 * `mock.module` BEFORE the module under test is dynamically imported (as in
 * `SchemaTree.test.tsx` / `ChatTabView.test.tsx`), and structure is asserted with
 * `renderToStaticMarkup`. Because static rendering never runs effects, the
 * "conexión no disponible" body is asserted through the EXPORTED presentational
 * `ConnectionUnavailable` with explicit props — that is exactly why it is exported.
 * The decision that selects it (`isTabConnectionMissing`) is unit-tested in
 * `workspace-state.test.ts`, where it lives as a pure function; the WIRING between the
 * two (which body `TabContent` actually picks for a given `connections` prop) is covered
 * by the last describe here, over `TabContent` itself.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { errorReply, type ConnectionSummary, type RpcReply } from "../../shared/contract.ts";
import type { WorkspaceTab } from "./workspace-state.ts";

// Mock the RPC client BEFORE the module under test is imported — `TabContent` pulls in the
// real client transitively (table.rows / execute / settings), and nothing here should ever
// reach a real transport.
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<unknown>> =>
    errorReply("internal_error", "unset"),
);
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));

const { ConnectionUnavailable, TabContent } = await import("./TabContent.tsx");

beforeEach(() => {
  rpcMock.mockClear();
});

const ANALYTICS: ConnectionSummary = {
  id: "conn-a",
  name: "analytics",
  host: "warehouse:5432",
  engine: "postgres",
};

const SHOP: ConnectionSummary = {
  id: "conn-b",
  name: "shop",
  host: "127.0.0.1:3306",
  engine: "mysql",
};

const noop = (): void => {};

describe("ConnectionUnavailable (Story 10.6)", () => {
  test("renders the mockup copy verbatim and names the tab in its own element", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable tabTitle="orders" connections={[ANALYTICS]} onReassign={noop} />,
    );
    expect(html).toContain("conexión no disponible (fue eliminada)");
    expect(html).toContain("Reasignar conexión…");
    // The title must be the CONTENT of the identifying line — a bare `toContain("orders")`
    // would also pass on an echo in a class name or a key, which pins nothing.
    expect(html).toMatch(/<p[^>]*>tab (?:&quot;|")orders(?:&quot;|")<\/p>/);
  });

  test("does not re-case the tab title (AR-19) despite the block's lowercase styling", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable tabTitle="Orders" connections={[ANALYTICS]} onReassign={noop} />,
    );
    // The title IS the table name, which is never re-cased. The container carries
    // `lowercase`, so the line echoing it must opt back out.
    expect(html).toMatch(/<p[^>]*class="[^"]*normal-case[^"]*"[^>]*>tab (?:&quot;|")Orders/);
  });

  test("uses the semantic err token, never a raw red-/amber- utility", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable
        tabTitle="orders"
        connections={[ANALYTICS, SHOP]}
        onReassign={noop}
      />,
    );
    // Both halves matter: the absence of a literal is only meaningful next to the presence
    // of the semantic token that replaced it.
    expect(html).toContain("text-err");
    expect(html).not.toContain("red-");
    expect(html).not.toContain("amber-");
  });

  test("offers one reassign control per live connection, showing name and host only", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable
        tabTitle="orders"
        connections={[ANALYTICS, SHOP]}
        onReassign={noop}
      />,
    );
    expect(html).toContain("analytics");
    expect(html).toContain("warehouse:5432");
    expect(html).toContain("shop");
    expect(html).toContain("127.0.0.1:3306");
    // One <button> per connection, plus none for the (absent) disabled fallback and none
    // for the (absent) boot entry.
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(2);
  });

  test("never renders the opaque connection id, only the human fields (AR-12)", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable
        tabTitle="orders"
        connections={[ANALYTICS, SHOP]}
        onReassign={noop}
      />,
    );
    // The id is the ONLY thing that crosses any boundary, and it is not for humans: the
    // picker must identify a connection by `name`/`host`, never by leaking the token that
    // addresses it. (A ConnectionSummary carries no url/user/password to leak at all.)
    expect(html).not.toContain("conn-a");
    expect(html).not.toContain("conn-b");
    expect(html).toContain("analytics");
    expect(html).toContain("warehouse:5432");
  });

  test("with a boot target the picker offers the default connection ABOVE the saved ones", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable
        tabTitle="orders"
        connections={[ANALYTICS]}
        hasBootTarget
        onReassign={noop}
      />,
    );
    expect(html).toContain("conexión por defecto");
    expect(html).toContain("(boot)");
    // Above, not below: it needs no registry entry and is the last target standing when the
    // registry is empty.
    expect(html.indexOf("conexión por defecto")).toBeLessThan(html.indexOf("analytics"));
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(2);
  });

  test("a boot target alone keeps the picker LIVE even with zero saved connections", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable tabTitle="orders" connections={[]} hasBootTarget onReassign={noop} />,
    );
    // The trap this closes: saved connections all deleted, relaunched with a boot `--url`.
    // The boot connection is live and usable, so the tab must not be a dead end.
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("no hay conexiones guardadas");
    expect(html).toContain("conexión por defecto");
  });

  test("with no boot target and an empty live list the affordance is disabled", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable tabTitle="orders" connections={[]} onReassign={noop} />,
    );
    expect(html).toContain("Reasignar conexión…");
    // The real `disabled` ATTRIBUTE, not merely a `disabled:` Tailwind variant in the class.
    expect(html).toContain('disabled=""');
    expect(html).toContain("settings");
    // Exactly one control — the inert one; no picker entries exist to offer.
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
  });

  test("without an onReassign handler the control is inert, never a live no-op", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable tabTitle="orders" connections={[ANALYTICS, SHOP]} hasBootTarget />,
    );
    // `onReassign` is optional through the whole App → Workspace → TabContent chain, so a
    // dropped prop must degrade to a DISABLED control rather than buttons that silently do
    // nothing when clicked.
    expect(html).toContain('disabled=""');
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
  });

  test("hides the WebKit disclosure marker as well as the standard one", () => {
    const html = renderToStaticMarkup(
      <ConnectionUnavailable tabTitle="orders" connections={[ANALYTICS]} onReassign={noop} />,
    );
    // `list-none` is a no-op in Safari, which draws `::-webkit-details-marker` instead.
    expect(html).toContain("list-none");
    expect(html).toContain("[&amp;::-webkit-details-marker]:hidden");
  });

  test("makes no rpc call in its render body (pure presentation)", () => {
    renderToStaticMarkup(
      <ConnectionUnavailable tabTitle="orders" connections={[ANALYTICS]} onReassign={noop} />,
    );
    renderToStaticMarkup(<ConnectionUnavailable tabTitle="orders" connections={[]} />);
    // NOTE: `renderToStaticMarkup` never runs effects, so this cannot pin "no fetch on
    // mount" — it pins only that nothing is called from the RENDER body itself, which is
    // what makes the component safe to render in this harness at all.
    expect(rpcMock).toHaveBeenCalledTimes(0);
  });
});

describe("TabContent — which body a table tab gets (Story 10.6 integration)", () => {
  const boundTab: WorkspaceTab = {
    id: 3,
    kind: "table",
    title: "orders",
    connectionId: "conn-a",
  };

  test("a tab whose connectionId is absent from the live set gets the unavailable body", () => {
    const html = renderToStaticMarkup(
      <TabContent tab={boundTab} connections={[SHOP]} onReassignConnection={noop} />,
    );
    expect(html).toContain("conexión no disponible (fue eliminada)");
    expect(html).not.toContain("select a table");
  });

  test("a tab whose connectionId IS in the live set gets the normal body", () => {
    const html = renderToStaticMarkup(
      <TabContent tab={boundTab} connections={[ANALYTICS, SHOP]} onReassignConnection={noop} />,
    );
    expect(html).toContain("select a table");
    expect(html).not.toContain("conexión no disponible");
  });

  test("an UNKNOWN live set (null) never flags a tab — it gets the normal body", () => {
    const html = renderToStaticMarkup(
      <TabContent tab={boundTab} connections={null} onReassignConnection={noop} />,
    );
    // The AC: a `connections.list` read that is in flight or FAILED must never accuse a
    // restored tab of pointing at a deleted connection.
    expect(html).toContain("select a table");
    expect(html).not.toContain("conexión no disponible");
  });
});
