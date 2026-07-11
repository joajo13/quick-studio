/**
 * Covers the provider-registry boundary (Story 5.1): validation (unknown provider,
 * blank/whitespace key -> bad_request), upsert-by-kind, idempotent remove, empty list,
 * SECRET-FREE summaries (raw key never in list output, only a last-4 keyPreview), the
 * Core-internal getKey, and store-open failure -> internal_error. The store is driven
 * through an INJECTED ephemeral open so no disk or keychain is touched.
 */

import { describe, expect, test } from "bun:test";
import { createProviderRegistry } from "./provider-registry.ts";
import { openProviderKeyStore, type OpenResult } from "./provider-key-store.ts";

/** An in-memory ephemeral store open — deterministic, no disk, no keychain. */
function ephemeralOpen(): OpenResult {
  return openProviderKeyStore({ mode: "ephemeral" });
}

describe("provider-registry — validation", () => {
  test("unknown provider kind -> bad_request, nothing stored", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    const r = reg.set({ provider: "bogus" as never, apiKey: "sk-123" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_request");
    expect(reg.list()).toEqual({ ok: true, value: { providers: [] } });
  });

  test("blank / whitespace-only key -> bad_request, nothing stored", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    for (const apiKey of ["", "   ", "\t\n"]) {
      const r = reg.set({ provider: "anthropic", apiKey });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("bad_request");
    }
    const list = reg.list();
    expect(list.ok && list.value.providers).toEqual([]);
  });
});

describe("provider-registry — set / list / remove", () => {
  test("set returns a secret-free summary; the raw key never appears in list", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    const apiKey = "sk-ant-super-secret-abcd";
    const set = reg.set({ provider: "anthropic", apiKey });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.provider).toBe("anthropic");
    expect(set.value.keyPreview).toBe("…abcd");
    expect(set.value.keyPreview).not.toContain(apiKey);

    const list = reg.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.providers).toHaveLength(1);
    // The full raw key must never be present anywhere in the serialized list.
    expect(JSON.stringify(list.value)).not.toContain(apiKey);
  });

  test("upsert by kind: replacing a key keeps one summary for that provider", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    reg.set({ provider: "openai", apiKey: "first-000A" });
    reg.set({ provider: "openai", apiKey: "second-00B" });
    const list = reg.list();
    expect(list.ok && list.value.providers).toHaveLength(1);
    // last-4 of "second-00B" is "-00B".
    expect(list.ok && list.value.providers[0]?.keyPreview).toBe("…-00B");
  });

  test("empty list before any set", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    expect(reg.list()).toEqual({ ok: true, value: { providers: [] } });
  });

  test("remove is idempotent: first removes, second is still ok", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    reg.set({ provider: "google", apiKey: "sk-google-xyz9" });
    const first = reg.remove({ provider: "google" });
    expect(first).toEqual({ ok: true, value: { removed: true } });
    const second = reg.remove({ provider: "google" });
    expect(second).toEqual({ ok: true, value: { removed: true } });
    expect(reg.list()).toEqual({ ok: true, value: { providers: [] } });
  });

  test("remove with an unknown provider kind -> bad_request", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    const r = reg.remove({ provider: "nope" as never });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_request");
  });
});

describe("provider-registry — Core-internal getKey", () => {
  test("getKey returns the raw key for a configured kind, null when unconfigured", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    expect(reg.getKey("anthropic")).toEqual({ ok: true, value: null });
    reg.set({ provider: "anthropic", apiKey: "sk-raw-value" });
    expect(reg.getKey("anthropic")).toEqual({ ok: true, value: "sk-raw-value" });
  });

  test("getKey with an unknown provider kind -> bad_request", () => {
    const reg = createProviderRegistry({ openStore: ephemeralOpen });
    const r = reg.getKey("bogus" as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_request");
  });
});

describe("provider-registry — store-open failure maps to internal_error", () => {
  test("a non-opened store surfaces internal_error with only the safe label as detail", () => {
    const reg = createProviderRegistry({
      openStore: (): OpenResult => ({ outcome: "unavailable", detail: "/secret/path/leak" }),
    });
    const r = reg.list();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("internal_error");
      expect(r.detail).toBe("unavailable"); // the LABEL, not the raw path
      expect(r.detail).not.toContain("/secret/path");
    }
  });

  test("open failure is retryable (memoized on success only)", () => {
    let calls = 0;
    const reg = createProviderRegistry({
      openStore: (): OpenResult => {
        calls += 1;
        return calls === 1
          ? { outcome: "unavailable", detail: "transient" }
          : openProviderKeyStore({ mode: "ephemeral" });
      },
    });
    expect(reg.list().ok).toBe(false); // first open fails
    expect(reg.list().ok).toBe(true); // retried and succeeded
    expect(calls).toBe(2);
  });
});
