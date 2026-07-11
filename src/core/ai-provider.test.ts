/**
 * Covers the unified AI layer (Story 5.1, AR-17): `resolveModel` CONSTRUCTS a model
 * handle for each known provider kind (no network call — pure construction) and
 * returns a typed failure for an unknown kind. Invoking the handle is Story 5.2+; here
 * we only assert a handle is produced.
 */

import { describe, expect, test } from "bun:test";
import { resolveModel } from "./ai-provider.ts";
import { PROVIDER_KINDS } from "../shared/contract.ts";

describe("ai-provider — resolveModel", () => {
  test("constructs a handle for every known provider kind (no network)", () => {
    for (const provider of PROVIDER_KINDS) {
      const r = resolveModel(provider, "sk-test-key");
      expect(r.ok).toBe(true);
      if (r.ok) {
        // A model handle was constructed (a non-null object/string reference).
        expect(r.model).toBeDefined();
      }
    }
  });

  test("distinct kinds produce distinct model handles", () => {
    const a = resolveModel("anthropic", "k");
    const o = resolveModel("openai", "k");
    expect(a.ok && o.ok).toBe(true);
    if (a.ok && o.ok) expect(a.model).not.toBe(o.model);
  });

  test("unknown provider -> typed failure, never a throw", () => {
    const r = resolveModel("bogus" as never, "k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_provider");
  });
});
