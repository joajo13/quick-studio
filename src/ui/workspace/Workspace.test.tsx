/**
 * quick-studio UI (Ring 2) — Workspace shell render tests (DW-53).
 *
 * Pins the shell half of the DW-53 testid/a11y contract: the launcher rail's
 * `data-testid="settings-toggle"` and `data-testid="create-table-toggle"` with BOTH
 * `aria-pressed` polarities, and the port-exposure banner's
 * `data-testid="exposure-banner"` + `role="alert"` + host:port copy, present only when
 * the Core actually bound a non-loopback address. Those hooks were preserved as a hard
 * constraint through the Epic-7 restyle but no render test asserted them.
 *
 * Static rendering suffices: every hook here is decided in the RENDER body from props
 * alone (`activeTab?.kind === …`, `exposure?.exposed`), never from state produced by an
 * effect — the shell's one rpc (`connections.list` / `connection.active`) lives in a
 * mount effect that `renderToStaticMarkup` never runs, which the zero-call assertion
 * below proves. The rpc client is still replaced via `mock.module` BEFORE the dynamic
 * import, per repo convention, so nothing can reach a real transport.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  errorReply,
  type ExposureInfo,
  type RpcReply,
  type SchemaIndexInfo,
  type SchemaTableInfo,
} from "../../shared/contract.ts";
import {
  activateTab,
  emptyWorkspace,
  LAUNCHER_KINDS,
  openOrFocusCreateTable,
  openOrFocusSettings,
  openTab,
  type WorkspaceState,
} from "./workspace-state.ts";

// Mock the RPC client BEFORE the module under test is imported — `Workspace` pulls in the
// real client both directly (its registry read) and transitively (schema tree, tab bodies).
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<unknown>> =>
    errorReply("internal_error", "unset"),
);
// `saveWorkspaceSync` is stubbed even though nothing here calls it, purely so this file
// registers the module's WHOLE shape and the two files that mock it agree. It is NOT a
// correctness requirement: bun's `mock.module` registry is process-global and last-write-wins,
// and a later PARTIAL factory MERGES over the previous one rather than replacing it — verified
// on bun 1.3.14 with a two-file harness (file 1 registers `{a,b}`, file 2 registers `{a}`
// only; file 2 still observes the mocked `b`, never `undefined`). That is also why the six
// pre-existing files registering just `{ rpc }` for this module — `SchemaTree.test.tsx`,
// `TabContent.test.tsx`, `ChatTabView.test.tsx`, `ReportTabView.test.tsx`,
// `ProvidersPanel.test.tsx`, `run-raw-query.test.ts` — are fine as they are and need no
// matching stub.
const saveWorkspaceSyncMock = mock((_snapshot: unknown): boolean => true);
mock.module("../rpc/client.ts", () => ({
  rpc: rpcMock,
  saveWorkspaceSync: saveWorkspaceSyncMock,
}));

const { Workspace } = await import("./Workspace.tsx");

beforeEach(() => {
  rpcMock.mockClear();
  saveWorkspaceSyncMock.mockClear();
});

/**
 * The WHOLE opening tag of the `<element>` carrying `attr` (e.g. `data-testid="…"`).
 * Assertions are made against this slice rather than the raw document so they are
 * independent of the order attributes happen to be authored in: matching
 * `/aria-pressed="true"[^>]*data-testid="settings-toggle"/` across the full markup only
 * passes while `aria-pressed` precedes `data-testid` in the JSX, and a semantically
 * identical reshuffle in `Workspace.tsx` would turn it red. `attr` is escaped before it is
 * interpolated: an unescaped `.` or `/` in a future caller's attribute value (Tailwind class
 * names carry both — `bg-err/20`, `h-1.5`) would silently become a wildcard and start
 * matching the WRONG element while still looking like a literal at the call site.
 */
function tagWith(html: string, element: string, attr: string): string {
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Matched globally and required to be UNIQUE, not just present: returning the first hit
  // would silently pick one of two `exposure-banner`s (or one of two `Open tabs` landmarks)
  // and assert against it while the duplicate — itself the bug — went unmentioned.
  const found = [...html.matchAll(new RegExp(`<${element}[^>]*\\s${escaped}[^>]*>`, "g"))];
  if (found.length !== 1) {
    throw new Error(`expected exactly one <${element}> carrying ${attr}, found ${found.length}`);
  }
  return found[0]![0];
}

/** The opening tag of the rail toggle `<button>` with this testid. */
function tag(html: string, testid: string): string {
  return tagWith(html, "button", `data-testid="${testid}"`);
}

const noop = (): void => {};
const NO_TABLES: ReadonlyArray<SchemaTableInfo> = [];
const NO_INDEXES: ReadonlyArray<SchemaIndexInfo> = [];

/** Optional shell props a test opts into; everything omitted keeps the minimal fixture. */
type Extras = {
  readonly stopping?: boolean;
  readonly saveIndicator?: React.ReactNode;
};

/** Render the shell with the minimum explicit prop set; optional props stay omitted. */
function render(state: WorkspaceState, exposure?: ExposureInfo, extras: Extras = {}): string {
  return renderToStaticMarkup(
    <Workspace
      state={state}
      onOpen={noop}
      onOpenSettings={noop}
      onOpenCreateTable={noop}
      onActivate={noop}
      onClose={noop}
      onActivateTable={noop}
      onSchemaLoaded={noop}
      primaryKeys={[]}
      indexes={NO_INDEXES}
      allTables={NO_TABLES}
      queryDrafts={new Map()}
      onQueryDraftChange={noop}
      chatStates={new Map()}
      onChatStateChange={noop}
      lastProvider={null}
      reportStates={new Map()}
      onReportStateChange={noop}
      erdLayouts={{}}
      onErdLayoutChange={noop}
      onStop={noop}
      stopping={false}
      connectionIndicator={<span data-testid="health-stub">health</span>}
      panelSizes={[20, 80]}
      onLayout={noop}
      extraTables={NO_TABLES}
      schemas={["public"]}
      onTableCreated={noop}
      {...(exposure !== undefined ? { exposure } : {})}
      {...extras}
    />,
  );
}

/** A workspace whose active tab is an ordinary document tab (neither singleton). */
const IDLE = openTab(emptyWorkspace(), "query");
const SETTINGS_ACTIVE = openOrFocusSettings(IDLE);
const CREATE_TABLE_ACTIVE = openOrFocusCreateTable(IDLE);

describe("Workspace rail — toggle testids (DW-53)", () => {
  test("renders exactly one of each toggle, whatever the active tab is", () => {
    for (const state of [IDLE, SETTINGS_ACTIVE, CREATE_TABLE_ACTIVE]) {
      const out = render(state);
      expect(out.match(/data-testid="settings-toggle"/g)?.length).toBe(1);
      expect(out.match(/data-testid="create-table-toggle"/g)?.length).toBe(1);
    }
  });

  test("with no singleton active, both toggles are unpressed", () => {
    const out = render(IDLE);
    // Scoped to each toggle's OWN tag: a shell-wide `not.toContain('aria-pressed="true"')`
    // would also break for any unrelated pressed control inside a tab body.
    expect(tag(out, "settings-toggle")).toContain('aria-pressed="false"');
    expect(tag(out, "settings-toggle")).not.toContain('aria-pressed="true"');
    expect(tag(out, "create-table-toggle")).toContain('aria-pressed="false"');
    expect(tag(out, "create-table-toggle")).not.toContain('aria-pressed="true"');
  });

  test("the settings tab presses the settings toggle ONLY", () => {
    const out = render(SETTINGS_ACTIVE);
    expect(tag(out, "settings-toggle")).toContain('aria-pressed="true"');
    // The OTHER rail toggle stays unpressed — the two are not lit together. Asserted on the
    // create-table toggle itself rather than by counting pressed controls shell-wide.
    expect(tag(out, "create-table-toggle")).toContain('aria-pressed="false"');
  });

  test("the create-table tab presses the create-table toggle ONLY", () => {
    const out = render(CREATE_TABLE_ACTIVE);
    expect(tag(out, "create-table-toggle")).toContain('aria-pressed="true"');
    expect(tag(out, "settings-toggle")).toContain('aria-pressed="false"');
  });

  test("a singleton that is OPEN but not ACTIVE leaves its toggle unpressed", () => {
    // Polarity hole otherwise: every fixture above both OPENS and ACTIVATES the singleton, so
    // `settingsActive` mis-derived as "a settings tab EXISTS" would pass all of them. Here the
    // singleton stays open in the strip while a different tab is active — `aria-pressed`
    // tracks the ACTIVE view (the toggle's real meaning), nothing else.
    const otherTabId = IDLE.tabs[0]!.id;

    const settingsOpen = render(activateTab(SETTINGS_ACTIVE, otherTabId));
    expect(settingsOpen).toContain('aria-label="Close Settings"'); // still open
    expect(tag(settingsOpen, "settings-toggle")).toContain('aria-pressed="false"');

    const createTableOpen = render(activateTab(CREATE_TABLE_ACTIVE, otherTabId));
    expect(createTableOpen).toContain('aria-label="Close New Table"'); // still open
    expect(tag(createTableOpen, "create-table-toggle")).toContain('aria-pressed="false"');
  });

  test("both toggles stay labelled for screen readers, not icon-only mystery meat", () => {
    const out = render(IDLE);
    expect(out).toContain('aria-label="Settings"');
    expect(out).toContain('aria-label="Create table"');
  });
});

describe("Workspace — port-exposure banner (DW-53)", () => {
  const EXPOSED: ExposureInfo = { exposed: true, host: "0.0.0.0", port: 4123 };

  test("announces the exposure with role=alert and the reachable address", () => {
    const out = render(IDLE, EXPOSED);
    expect(out).toContain('data-testid="exposure-banner"');
    // `role="alert"` asserted on the BANNER's own tag: several unrelated components in the
    // tree (`TabContent`, `ReportTabView`, `CreateTablePanel`, `SettingsPanel`, `SchemaTree`)
    // also emit `role="alert"`, so a document-wide check would not prove the banner is live.
    expect(tagWith(out, "div", 'data-testid="exposure-banner"')).toContain('role="alert"');
    // The literal address the app is reachable at — the actionable half of the warning.
    // `renderToStaticMarkup` interpolates `{host}:{port}` with no `<!-- -->` text separators
    // (those are a `renderToString`/hydration artifact), so this is a plain substring.
    expect(out).toContain("0.0.0.0:4123");
  });

  test("sits ABOVE the resizable panels, not inside a scrollable one", () => {
    // Presence + `role="alert"` alone do not pin the thing that makes this warning work: it
    // has to be unmissable. Nesting `<ExposureBanner>` anywhere under the `PanelGroup`
    // (`Workspace.tsx:426`) would keep every other assertion in this describe green while
    // letting the banner scroll out of view inside a pane.
    const out = render(IDLE, EXPOSED);
    const banner = out.indexOf('data-testid="exposure-banner"');
    const panels = out.indexOf("data-panel-group");
    expect(banner).toBeGreaterThan(-1);
    expect(panels).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(panels);
  });

  test("is absent when `exposure` is omitted entirely", () => {
    const out = render(IDLE);
    // The banner's OWN testid is the discriminating hook. A `not.toContain('role="alert"')`
    // is deliberately NOT asserted: that role is shared with several tab-body components, so
    // it would pass only by luck of this fixture and break on any unrelated alert.
    expect(out).not.toContain("exposure-banner");
    expect(out).not.toContain("Port exposure");
  });

  test("is absent when the Core reports a loopback bind (`exposed:false`)", () => {
    // The prop being PRESENT is not the trigger — only `exposed` being true is.
    const out = render(IDLE, { exposed: false, host: "127.0.0.1", port: 4123 });
    expect(out).not.toContain("exposure-banner");
    expect(out).not.toContain("Port exposure");
    // Not even the address leaks into the shell when the bind is loopback.
    expect(out).not.toContain("127.0.0.1:4123");
  });
});

describe("Workspace — shell wiring (DW-53)", () => {
  test("hosts the tab strip and the injected connection indicator", () => {
    const out = render(IDLE);
    // The status bar slot renders whatever App hands it — here a stub, so this pins the
    // SLOT, not `ConnectionIndicator` (which `App.test.tsx` covers directly).
    expect(out).toContain('data-testid="health-stub"');
    // The tab STRIP is identified by its own landmark label, not by `role="tablist"` alone:
    // `TabContent` (`aria-label="table sub-view"`) and `ReportTabView` (`aria-label="result
    // view"`) emit tablists too, so the role by itself does not discriminate the strip.
    expect(tagWith(out, "div", 'aria-label="Open tabs"')).toContain('role="tablist"');
    expect(out).toMatch(/>Stop</);
  });

  test("keeps the schema panel's landmark as `Connections` (Story 10.5 rename)", () => {
    const out = render(IDLE);
    expect(out).toContain('aria-label="Connections"');
    expect(out).not.toContain("Schema tables");
  });

  test("renders the status bar's optional save-failure slot when App supplies one", () => {
    // `saveIndicator` (DW-22) is an OPTIONAL sibling of `connectionIndicator` in the same
    // status-bar row, so every fixture that omits it leaves the slot itself uncovered — it
    // could be deleted from the JSX without a single test noticing.
    const out = render(IDLE, undefined, {
      saveIndicator: <span data-testid="save-stub">save failed</span>,
    });
    expect(out).toContain('data-testid="save-stub"');
    // Both slots live, side by side, indicator first.
    expect(out.indexOf('data-testid="health-stub"')).toBeLessThan(
      out.indexOf('data-testid="save-stub"'),
    );
  });

  test("omits the save slot entirely when App supplies nothing", () => {
    expect(render(IDLE)).not.toContain("save-stub");
  });

  test("disables the Stop control and switches its copy while a shutdown is in flight", () => {
    // The `stopping` branch is the shell's only in-flight state and no fixture reached it.
    const out = render(IDLE, undefined, { stopping: true });
    // The copy AND the `disabled` attribute asserted on the SAME button, so a control that
    // only changes its label while staying clickable (a double-shutdown fire) turns this red.
    expect(out).toMatch(/<button[^>]*\sdisabled=""[^>]*>Stopping…<\/button>/);
    expect(out).not.toMatch(/>Stop</);
    // …and the idle render is the negative: same button, no `disabled` ATTRIBUTE. Matched as
    // `disabled=""` rather than bare `disabled` because the button's own class list carries
    // `disabled:cursor-not-allowed` / `disabled:opacity-60`, which a looser pattern reads as
    // the attribute and makes this negative un-satisfiable.
    expect(render(IDLE)).toMatch(/<button(?:(?!\sdisabled="")[^>])*>Stop<\/button>/);
  });

  test("renders the shell at all with an EMPTY workspace (boot / last tab closed)", () => {
    // The real state on first boot and after closing the last tab: `activeTab` is null and
    // `TabBar` returns null, so the strip landmark is simply absent. Every other fixture in
    // this file has an active tab, leaving the shell's null-active-tab branch unrendered —
    // and `tagWith(out, "div", 'aria-label="Open tabs"')` would throw here, which is exactly
    // why it needs its own case rather than being folded into the wiring test above.
    const out = render(emptyWorkspace());
    expect(out).not.toContain('aria-label="Open tabs"');
    // The rail, the status bar and the schema panel all survive the empty strip…
    expect(out).toContain('data-testid="health-stub"');
    expect(out).toContain('aria-label="Connections"');
    // …and both rail toggles are present and unpressed, since no singleton is active.
    expect(tag(out, "settings-toggle")).toContain('aria-pressed="false"');
    expect(tag(out, "create-table-toggle")).toContain('aria-pressed="false"');
  });

  test("makes no rpc call in its render body, for ANY tab kind", () => {
    // The registry read is a mount effect and `renderToStaticMarkup` never runs effects, so
    // this pins only that nothing is called from the RENDER body — which is what makes the
    // shell safe to render in this harness. Every tab kind is rendered, not just `query`:
    // each kind mounts a DIFFERENT tab body (`TabContent`, `ErdTabView`, `ChatTabView`,
    // `ReportTabView`, `SettingsPanel`, `CreateTablePanel`), so a render-body transport call
    // added to any one of them would otherwise never be exercised here.
    rpcMock.mockClear();
    // Derived from `LAUNCHER_KINDS`, never a hand-written list: the two singletons below
    // plus this array are what makes "every tab kind" true, and a sixth document kind added
    // to `WORKSPACE_TAB_KINDS` must be rendered here automatically rather than quietly
    // escaping the proof because nobody remembered to extend a literal.
    for (const kind of LAUNCHER_KINDS) {
      render(openTab(emptyWorkspace(), kind));
    }
    render(SETTINGS_ACTIVE);
    render(CREATE_TABLE_ACTIVE);
    render(emptyWorkspace());
    expect(rpcMock).toHaveBeenCalledTimes(0);
  });
});
