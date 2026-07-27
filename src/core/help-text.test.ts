import { describe, expect, test } from "bun:test";
import { HELP_TEXT } from "./help-text.ts";

/**
 * A cheap drift guard: every flag and env var the code actually honors must be
 * mentioned in the help text the user sees, or `--help` silently goes stale
 * the next time a flag/env var is added elsewhere.
 */

describe("HELP_TEXT", () => {
  test("ends with a trailing newline", () => {
    expect(HELP_TEXT.endsWith("\n")).toBe(true);
  });

  test("lists every flag spelling", () => {
    expect(HELP_TEXT).toContain("-h, --help");
    expect(HELP_TEXT).toContain("-v, --version");
    expect(HELP_TEXT).toContain("--persistent");
    expect(HELP_TEXT).toContain("--ephemeral");
    expect(HELP_TEXT).toContain("--no-open");
  });

  test("lists every honored environment variable", () => {
    expect(HELP_TEXT).toContain("QS_HOST");
    expect(HELP_TEXT).toContain("QS_PORT");
    expect(HELP_TEXT).toContain("QS_MODE");
    expect(HELP_TEXT).toContain("QS_NO_OPEN");
    expect(HELP_TEXT).toContain("QS_PASSPHRASE");
    expect(HELP_TEXT).toContain("QS_PASSPHRASE_FD");
  });
});
