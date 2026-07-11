/**
 * quick-studio UI (Ring 2) — SandboxFrame structural + hardening tests (Story 5.5/5.6).
 *
 * No DOM at test runtime, so we assert the STATIC markup via `react-dom/server`
 * `renderToStaticMarkup` (effects never run there): the iframe carries
 * `sandbox="allow-scripts"`, its `src` is the injected Ring 3 origin, and the
 * containment-critical `allow-same-origin` is ABSENT. `resolveSandboxOrigin` is unit-
 * tested against the injected global. The Story-5.6 hardening logic lives in the pure,
 * exported `pushRenderDoc` / `createHeightCoalescer` / `EMPTY_RENDER_DOC` seams and is
 * driven directly with stubs + a manual scheduler (rebind + re-push, clear-on-null,
 * height coalescing).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FROZEN_SCHEMA_VERSION, type SandboxRenderDoc } from "../../shared/contract.ts";
import {
  createHeightCoalescer,
  EMPTY_RENDER_DOC,
  pushRenderDoc,
  rebindHost,
  resolveSandboxOrigin,
  SandboxFrame,
} from "./SandboxFrame.tsx";
import { createSandboxHost, type PostMessageTarget } from "./sandbox-host.ts";

const doc: SandboxRenderDoc = {
  markdown: "# hi",
  chart: { mark: "bar", x: "name", y: "id" },
  data: {
    schemaVersion: FROZEN_SCHEMA_VERSION,
    columns: [
      { name: "id", type: "number" },
      { name: "name", type: "string" },
    ],
    rows: [[{ kind: "number", value: 1 }, { kind: "string", value: "a" }]],
  },
};

describe("SandboxFrame static structure", () => {
  test("renders an iframe with sandbox='allow-scripts' and the injected src", () => {
    const html = renderToStaticMarkup(<SandboxFrame doc={doc} sandboxOrigin="http://127.0.0.1:5555" />);
    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('src="http://127.0.0.1:5555"');
  });

  test("NEVER renders allow-same-origin (the sacred negative)", () => {
    const html = renderToStaticMarkup(<SandboxFrame doc={doc} sandboxOrigin="http://127.0.0.1:5555" />);
    expect(html).not.toContain("allow-same-origin");
  });

  test("renders with a null doc prop (empty guest) without crashing", () => {
    const html = renderToStaticMarkup(<SandboxFrame doc={null} sandboxOrigin="http://127.0.0.1:6789" />);
    expect(html).toContain('src="http://127.0.0.1:6789"');
    expect(html).toContain('sandbox="allow-scripts"');
  });

  test("an empty/invalid origin renders src='about:blank' — NEVER src='' (parent-doc load)", () => {
    const html = renderToStaticMarkup(<SandboxFrame doc={doc} sandboxOrigin="" />);
    expect(html).toContain('src="about:blank"');
    // The sacred negative: `src=""` resolves to the token-bearing parent Core document.
    expect(html).not.toContain('src=""');
    // Containment is still intact — an about:blank frame stays allow-scripts only.
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
  });
});

/** A stub iframe window recording every posted (message, targetOrigin) pair. */
function makeIframe(): PostMessageTarget & { posts: Array<{ message: unknown; targetOrigin: string }> } {
  const posts: Array<{ message: unknown; targetOrigin: string }> = [];
  return { posts, postMessage: (message, targetOrigin) => posts.push({ message, targetOrigin }) };
}

describe("pushRenderDoc (hardening #1 rebind re-push, #2 clear-on-null)", () => {
  test("rebuilding the host over a fresh window and re-pushing the current doc draws it", () => {
    // Mirrors the component's `load` effect: build a host over the (re)resolved window and
    // re-push the current doc — a reloaded guest gets a live channel + its draw.
    const iframe = makeIframe();
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: () => {} });
    pushRenderDoc(host, doc);
    expect(iframe.posts).toHaveLength(1);
    const posted = iframe.posts[0]!.message as { type: string; markdown: string; data: unknown };
    expect(posted.type).toBe("render");
    expect(posted.markdown).toBe("# hi");
    expect(posted.data).toEqual(doc.data);
  });

  test("a null doc pushes the empty clearing frame (guest replaceChildren clears the draw)", () => {
    const iframe = makeIframe();
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: () => {} });
    pushRenderDoc(host, null);
    expect(iframe.posts).toHaveLength(1);
    const posted = iframe.posts[0]!.message as { markdown: string; chart: unknown; data: unknown };
    expect(posted.markdown).toBe("");
    expect(posted.chart).toBeNull();
    expect(posted.data).toEqual(EMPTY_RENDER_DOC.data);
    expect(EMPTY_RENDER_DOC.data).toEqual({ schemaVersion: FROZEN_SCHEMA_VERSION, columns: [], rows: [] });
  });

  test("a null host is a no-op (never throws)", () => {
    expect(() => pushRenderDoc(null, doc)).not.toThrow();
  });
});

describe("createHeightCoalescer (hardening #3)", () => {
  test("a flood of push()es collapses to ONE applied height (the last) per scheduled tick", () => {
    const applied: number[] = [];
    // Manual scheduler: capture the scheduled callback; run it only when we say.
    let scheduled: (() => void) | null = null;
    const coalescer = createHeightCoalescer(
      (px) => applied.push(px),
      (cb) => {
        scheduled = cb;
        return 1;
      },
      () => {
        scheduled = null;
      },
    );

    coalescer.push(100);
    coalescer.push(200);
    coalescer.push(300);
    // Nothing applied yet — all three collapsed into the single pending frame.
    expect(applied).toEqual([]);
    expect(coalescer.pending()).toBe(true);

    scheduled!(); // fire the frame
    expect(applied).toEqual([300]); // only the LAST value is applied, exactly once
    expect(coalescer.pending()).toBe(false);

    // A later push schedules a fresh frame.
    coalescer.push(400);
    expect(coalescer.pending()).toBe(true);
    scheduled!();
    expect(applied).toEqual([300, 400]);
  });

  test("cancel() drops a pending frame so no height is applied", () => {
    const applied: number[] = [];
    let scheduled: (() => void) | null = null;
    let canceled = false;
    const coalescer = createHeightCoalescer(
      (px) => applied.push(px),
      (cb) => {
        scheduled = cb;
        return 7;
      },
      (handle) => {
        canceled = handle === 7;
        scheduled = null;
      },
    );
    coalescer.push(500);
    coalescer.cancel();
    expect(canceled).toBe(true);
    expect(applied).toEqual([]);
    expect(scheduled).toBeNull();
  });
});

describe("rebindHost (hardening / P10 — null contentWindow at load)", () => {
  test("builds immediately (no retry scheduled) when the window is already available", () => {
    const win = { role: "win" };
    const built: unknown[] = [];
    let scheduled = 0;
    const cancel = rebindHost(
      () => win,
      (w) => built.push(w),
      () => {
        scheduled++;
        return 1;
      },
    );
    expect(built).toEqual([win]);
    expect(scheduled).toBe(0); // no retry needed
    cancel();
  });

  test("RETRIES when contentWindow is null at load, then rebinds once it appears (no dead channel)", () => {
    // The window is null for the first two ticks (a late contentWindow), then materializes.
    const win = { role: "late-win" };
    const state: { current: typeof win | null } = { current: null };
    const built: unknown[] = [];
    // A single-slot queue for the pending scheduled callback (array avoids closure-narrowing).
    const queue: Array<() => void> = [];
    rebindHost(
      () => state.current,
      (w) => built.push(w),
      (cb) => {
        queue.push(cb);
        return 1;
      },
      () => {
        queue.length = 0;
      },
    );
    // First attempt: window null → nothing built, a retry is scheduled.
    expect(built).toEqual([]);
    expect(queue).toHaveLength(1);

    queue.shift()!(); // second attempt: still null → reschedules
    expect(built).toEqual([]);
    expect(queue).toHaveLength(1);

    state.current = win; // window becomes available
    queue.shift()!(); // third attempt: rebinds
    expect(built).toEqual([win]);
  });

  test("the returned canceller stops a pending retry (no build after teardown)", () => {
    const built: unknown[] = [];
    const queue: Array<() => void> = [];
    const canceled: number[] = [];
    const cancel = rebindHost(
      () => null, // never available
      (w) => built.push(w),
      (cb) => {
        queue.push(cb);
        return 42;
      },
      (h) => {
        canceled.push(h);
        queue.length = 0;
      },
    );
    expect(queue).toHaveLength(1);
    cancel();
    expect(canceled).toEqual([42]);
    expect(built).toEqual([]);
  });

  test("gives up after maxAttempts rather than spinning forever on a window-less frame", () => {
    let ticks = 0;
    const queue: Array<() => void> = [];
    rebindHost(
      () => null,
      () => {},
      (cb) => {
        queue.push(cb);
        return 1;
      },
      () => {},
      3, // maxAttempts
    );
    // Drain the retry queue; it must stop rescheduling after a bounded number of ticks.
    while (queue.length > 0) {
      const cb = queue.shift() as () => void;
      ticks++;
      cb();
      if (ticks > 100) throw new Error("rebindHost spun without bound");
    }
    // 1 initial attempt + up to 3 retries, then it stops (bounded).
    expect(ticks).toBeLessThanOrEqual(3);
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
