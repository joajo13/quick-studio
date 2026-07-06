/**
 * Proof of the Persistent/Ephemeral gate: `QS_MODE` parsing and the safe default.
 * `resolveRunMode` is pure, so these are plain table assertions.
 */

import { describe, expect, test } from "bun:test";
import { resolveRunMode } from "./run-mode.ts";

describe("resolveRunMode — QS_MODE parsing + default", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly value: string | undefined;
    readonly expected: "persistent" | "ephemeral";
  }> = [
    { name: "unset → persistent (default)", value: undefined, expected: "persistent" },
    { name: "explicit persistent", value: "persistent", expected: "persistent" },
    { name: "ephemeral", value: "ephemeral", expected: "ephemeral" },
    { name: "EPHEMERAL is case-insensitive", value: "EPHEMERAL", expected: "ephemeral" },
    { name: "  ephemeral  is whitespace-tolerant", value: "  ephemeral  ", expected: "ephemeral" },
    { name: "unknown value → persistent (safe default)", value: "garbage", expected: "persistent" },
    { name: "empty string → persistent", value: "", expected: "persistent" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(resolveRunMode({ QS_MODE: c.value })).toBe(c.expected);
    });
  }
});
