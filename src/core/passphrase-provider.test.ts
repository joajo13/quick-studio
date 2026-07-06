/**
 * Covers the default env passphrase provider (FR-5, AD-5): a set `QS_PASSPHRASE`
 * yields `provided`; unset/empty/whitespace yields `declined`. Uses a plain env
 * object per call so `process.env` is never touched — no leakage between tests.
 */

import { describe, expect, test } from "bun:test";
import {
  PASSPHRASE_ENV_VAR,
  envPassphraseProvider,
  type PassphraseContext,
} from "./passphrase-provider.ts";

const CTX: PassphraseContext = { reason: "keychain-unavailable", isFirstRun: true };

describe("passphrase-provider — envPassphraseProvider", () => {
  test("env var constant is QS_PASSPHRASE", () => {
    expect(PASSPHRASE_ENV_VAR).toBe("QS_PASSPHRASE");
  });

  test("QS_PASSPHRASE set → provided with the exact value", () => {
    const provider = envPassphraseProvider({ QS_PASSPHRASE: "hunter2" });
    const r = provider(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("hunter2");
  });

  test("QS_PASSPHRASE unset → declined", () => {
    expect(envPassphraseProvider({})(CTX).outcome).toBe("declined");
  });

  test("QS_PASSPHRASE empty → declined", () => {
    expect(envPassphraseProvider({ QS_PASSPHRASE: "" })(CTX).outcome).toBe("declined");
  });

  test("QS_PASSPHRASE whitespace-only → declined", () => {
    for (const ws of ["   ", "\t", "\n"]) {
      expect(envPassphraseProvider({ QS_PASSPHRASE: ws })(CTX).outcome).toBe("declined");
    }
  });

  test("a non-blank passphrase with surrounding spaces is kept verbatim", () => {
    const r = envPassphraseProvider({ QS_PASSPHRASE: " pw " })(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe(" pw ");
  });
});
