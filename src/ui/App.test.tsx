/**
 * quick-studio UI (Ring 2) — connection-indicator render tests (DW-53).
 *
 * Pins the status-bar half of the DW-53 a11y/testid contract: the `data-testid="health"`
 * hook and the connection-status dot's semantic token per `Status.phase`
 * (`bg-ok` / `bg-err` / `bg-muted-foreground`), plus the label copy and the error
 * `title` envelope. Those survived the Epic-7 restyle as a hard constraint with no
 * render test behind them.
 *
 * `App` itself CANNOT be rendered in this harness — it reads `window.__QS_FIRST_RUN__` /
 * `window.__QS_EXPOSURE__` during render and its layout gate early-returns until an
 * effect flips `workspaceReady`, and `renderToStaticMarkup` never runs effects — so the
 * indicator is asserted through the EXPORTED presentational `ConnectionIndicator` with
 * explicit props, exactly the pattern `SchemaTree.tsx`'s `ConnectionRoot` and
 * `TabContent.tsx`'s `ConnectionUnavailable` already use. That is why it is exported;
 * static rendering suffices because the component is pure — props in, markup out, no
 * effect and no transport in its render body.
 *
 * Every structural assertion here is scoped to the DOT's or the LABEL's own node rather
 * than to the whole markup string. The indicator is only three elements deep, so a
 * document-wide `toContain` cannot tell "the dot is green" from "something in here is
 * green": moving `bg-ok` onto the wrapper `<div>` would keep a document-wide check green
 * while destroying the hook. Class checks are exact TOKEN membership for the same reason —
 * `bg-err` is a strict prefix of `bg-err-soft` / `bg-err-fill`, both already used elsewhere
 * in this shell, so a substring match would accept the wrong colour.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { errorReply, FROZEN_SCHEMA_VERSION, type RpcReply } from "../shared/contract.ts";

// Mock the RPC client BEFORE the module under test is imported — `App.tsx` pulls in the
// real client (workspace.load / workspace.save) transitively, and nothing here should ever
// reach a real transport.
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<unknown>> =>
    errorReply("internal_error", "unset"),
);
const saveWorkspaceSyncMock = mock((_snapshot: unknown): boolean => true);
mock.module("./rpc/client.ts", () => ({
  rpc: rpcMock,
  saveWorkspaceSync: saveWorkspaceSyncMock,
}));

const { ConnectionIndicator } = await import("./App.tsx");

beforeEach(() => {
  rpcMock.mockClear();
  saveWorkspaceSyncMock.mockClear();
});

type Status = React.ComponentProps<typeof ConnectionIndicator>["status"];

/**
 * Every `Status` variant, ONCE. Both the markup fixtures below and the no-transport test
 * iterate this same object, so a phase cannot be half-added — adding it here automatically
 * renders it everywhere it needs to be rendered.
 *
 * Keyed by `Status["phase"]` rather than by `string`: `satisfies Record<string, Status>`
 * would have accepted this object with a variant MISSING, so the exhaustiveness the comment
 * above claims would have been prose only. Keyed on the union, adding a fifth `Status`
 * variant to `App.tsx` fails `tsc` here until it is listed.
 */
const PHASES = {
  loading: { phase: "loading" },
  ok: { phase: "ok", result: { status: "ok", schemaVersion: FROZEN_SCHEMA_VERSION } },
  stopped: { phase: "stopped" },
  error: { phase: "error", error: { code: "network_error", message: "fetch failed" } },
} as const satisfies Record<Status["phase"], Status>;

const OUT = Object.fromEntries(
  Object.entries(PHASES).map(([key, status]) => [
    key,
    renderToStaticMarkup(<ConnectionIndicator status={status} />),
  ]),
) as Record<keyof typeof PHASES, string>;

const { loading: LOADING, ok: OK, stopped: STOPPED, error: ERROR } = OUT;

/**
 * The connected label, built from the SAME constant the fixture feeds the component, so a
 * frozen-schema-version bump does not fail this file for a reason that has nothing to do
 * with the connection indicator.
 */
const CONNECTED_LABEL = `Connected · schema v${FROZEN_SCHEMA_VERSION}`;

/* ------------------------------------------------------------------ *
 * Node-scoped slicing — see the file docblock for why nothing here matches document-wide
 * ------------------------------------------------------------------ */

type SpanNode = { readonly attrs: string; readonly text: string };

function spans(html: string): ReadonlyArray<SpanNode> {
  return [...html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/g)].map((m) => ({
    attrs: m[1] ?? "",
    text: m[2] ?? "",
  }));
}

function spanAt(html: string, index: number, what: string): SpanNode {
  const node = spans(html)[index];
  if (node === undefined) {
    throw new Error(`no ${what} (<span> #${index}) in the indicator render`);
  }
  return node;
}

/** The status dot — the indicator's FIRST span, the empty one that carries only colour. */
function dot(html: string): SpanNode {
  return spanAt(html, 0, "status dot");
}

/** The label — the indicator's SECOND span, the one carrying the phase as words. */
function label(html: string): SpanNode {
  return spanAt(html, 1, "phase label");
}

/**
 * A node's class list as exact tokens. `expect(html).toContain("bg-err")` would also be
 * satisfied by `bg-err-soft` / `bg-err-fill` / `bg-err/20`; membership in this array is not.
 */
function classes(node: SpanNode): ReadonlyArray<string> {
  return (node.attrs.match(/\sclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter((c) => c !== "");
}

/**
 * The whole opening tag of the indicator's OWN `<div data-testid="health">`. The `health`
 * hook and the `title` tooltip both belong to this node and to no other, so asserting them
 * against the raw document would hold just as well once either had been moved down onto the
 * dot or the label span — where `title` is a tooltip on a 6px dot instead of on the whole
 * segment, and where the testid no longer identifies the segment at all.
 */
function healthTag(html: string): string {
  const found = html.match(/<div\b[^>]*\sdata-testid="health"[^>]*>/);
  if (found === null) {
    throw new Error('no <div> carrying data-testid="health" in the indicator render');
  }
  return found[0];
}

describe("ConnectionIndicator — the `health` hook (DW-53)", () => {
  test("carries the health testid on its ROOT node in every phase", () => {
    // The testid is the stable handle the status bar is found by; it must not depend on
    // which phase happens to be showing. Pinned to the OUTERMOST element (the render starts
    // with it) and to exactly one node: a testid pushed down onto the dot or the label span
    // would still satisfy a document-wide `toContain` while no longer identifying the
    // segment a caller means when it looks up `health`.
    for (const out of Object.values(OUT)) {
      expect(out.match(/data-testid="health"/g)?.length).toBe(1);
      expect(out.startsWith(healthTag(out))).toBe(true);
    }
  });

  test("hides the DOT from the accessibility tree and leaves the LABEL announced", () => {
    // Both halves asserted on their own node. A document-wide `toContain("aria-hidden")`
    // stays green even if the attribute is moved onto the label span — which would announce
    // the colour dot as garbage and silence the only words describing the phase.
    expect(dot(OK).attrs).toContain("aria-hidden");
    expect(dot(OK).text).toBe("");
    expect(label(OK).attrs).not.toContain("aria-hidden");
    expect(label(OK).text).toBe(CONNECTED_LABEL);
  });
});

describe("ConnectionIndicator — the status dot per phase (DW-53)", () => {
  // Each phase asserts its own token PRESENT on the dot and the other two ABSENT. One-sided
  // negatives would all stay green for a dot that emitted several tokens at once (the last
  // class wins visually, so the bug would be invisible in the markup otherwise).
  test("connected is the semantic ok token", () => {
    expect(classes(dot(OK))).toContain("bg-ok");
    expect(classes(dot(OK))).not.toContain("bg-err");
    expect(classes(dot(OK))).not.toContain("bg-muted-foreground");
  });

  test("errored is the semantic err token", () => {
    expect(classes(dot(ERROR))).toContain("bg-err");
    expect(classes(dot(ERROR))).not.toContain("bg-ok");
    expect(classes(dot(ERROR))).not.toContain("bg-muted-foreground");
  });

  test("loading and stopped are muted — neither ok nor err", () => {
    // Both polarities of the "color is spent only where it is functional" rule: the
    // muted token must be PRESENT and the two functional tokens ABSENT.
    for (const out of [LOADING, STOPPED]) {
      expect(classes(dot(out))).toContain("bg-muted-foreground");
      expect(classes(dot(out))).not.toContain("bg-ok");
      expect(classes(dot(out))).not.toContain("bg-err");
    }
  });

  test("the err token is the real one, not a soft/fill variant sharing its prefix", () => {
    // `bg-err-soft` (buttons, settings, the Stop control) and `bg-err-fill` are live in this
    // shell, so a substring check would accept either as "the error dot".
    expect(classes(dot(ERROR)).filter((c) => c.startsWith("bg-err"))).toEqual(["bg-err"]);
  });
});

describe("ConnectionIndicator — labels and the error envelope (DW-53)", () => {
  test("labels each phase with its own copy", () => {
    expect(label(LOADING).text).toBe("Connecting…");
    expect(label(STOPPED).text).toBe("Stopped");
    expect(label(OK).text).toBe(CONNECTED_LABEL);
    // The error label surfaces the CODE, so the user sees what failed, not just "error".
    expect(label(ERROR).text).toBe("Disconnected · network_error");
  });

  test("the error tooltip carries `code: message`, not just the code", () => {
    // On the segment's own tag: a `title` moved onto the dot span would leave a
    // document-wide match green while the tooltip only appeared over a 6px circle.
    expect(healthTag(ERROR)).toContain('title="network_error: fetch failed"');
  });

  test("the non-error tooltip repeats the label", () => {
    expect(healthTag(OK)).toContain(`title="${CONNECTED_LABEL}"`);
    expect(healthTag(LOADING)).toContain('title="Connecting…"');
    expect(healthTag(STOPPED)).toContain('title="Stopped"');
  });

  test("preserves an rpc error envelope's own code verbatim", () => {
    const out = renderToStaticMarkup(
      <ConnectionIndicator
        status={{ phase: "error", error: { code: "unauthorized", message: "bad token" } }}
      />,
    );
    expect(label(out).text).toBe("Disconnected · unauthorized");
    expect(healthTag(out)).toContain('title="unauthorized: bad token"');
  });

  test("reaches NO transport in its render body, in any phase (pure presentation)", () => {
    rpcMock.mockClear();
    // `fetch` is spied, not just the rpc client: this component's own family BYPASSES the
    // rpc client entirely — `callHealth()` / `callShutdown()` in `App.tsx` POST `/rpc` with a
    // bare `fetch`. An rpc-only assertion would therefore stay green for exactly the
    // regression it names ("re-probing health on `error`"), because that probe would go
    // through `fetch`, not through `rpc`. Both seams are covered.
    // The spy REPLACES `fetch` rather than wrapping it: a bare `spyOn` calls through, so a
    // transport call sneaking into the render body would fire a real request at whatever
    // `/rpc` resolves to in the test process before this assertion ever reported it.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("ConnectionIndicator reached `fetch` from its render body");
    }) as unknown as typeof fetch);
    try {
      // Every phase, not just `loading`: a transport call added under a single branch would
      // otherwise never be exercised here.
      for (const status of Object.values(PHASES)) {
        renderToStaticMarkup(<ConnectionIndicator status={status} />);
      }
      // Static rendering runs no effects, so this pins only that the RENDER body itself
      // reaches no transport — which is what makes the component safe here at all.
      // (`saveWorkspaceSync` is deliberately NOT asserted: `ConnectionIndicator` never
      // references it, so a zero-call expectation on it could not fail. Its stub stays in the
      // `mock.module` factory above so this file registers the module's whole shape.)
      expect(rpcMock).toHaveBeenCalledTimes(0);
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
