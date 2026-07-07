import { describe, expect, test } from "bun:test";
import { CliArgsError, parseCliArgs } from "./cli-args.ts";

/** Empty env: no QS_MODE, no QS_NO_OPEN. */
const EMPTY_ENV = {} as const;

describe("parseCliArgs — mode precedence", () => {
  test("a DB URL positional selects Ephemeral and carries the URL forward", () => {
    const cli = parseCliArgs(["postgres://u:p@host/db"], EMPTY_ENV);
    expect(cli.mode).toBe("ephemeral");
    expect(cli.databaseUrl).toBe("postgres://u:p@host/db");
    expect(cli.openBrowser).toBe(true);
  });

  test("no args, no QS_MODE → Persistent (default), no URL", () => {
    const cli = parseCliArgs([], EMPTY_ENV);
    expect(cli.mode).toBe("persistent");
    expect(cli.databaseUrl).toBeNull();
    expect(cli.openBrowser).toBe(true);
  });

  test("--persistent selects Persistent", () => {
    const cli = parseCliArgs(["--persistent"], EMPTY_ENV);
    expect(cli.mode).toBe("persistent");
    expect(cli.databaseUrl).toBeNull();
  });

  test("QS_MODE=ephemeral fallback selects Ephemeral (no URL yet)", () => {
    const cli = parseCliArgs([], { QS_MODE: "ephemeral" });
    expect(cli.mode).toBe("ephemeral");
    expect(cli.databaseUrl).toBeNull();
  });

  test("a DB URL overrides QS_MODE=persistent (URL is the strongest signal)", () => {
    const cli = parseCliArgs(["mysql://h/db"], { QS_MODE: "persistent" });
    expect(cli.mode).toBe("ephemeral");
    expect(cli.databaseUrl).toBe("mysql://h/db");
  });

  test("--persistent overrides QS_MODE=ephemeral", () => {
    const cli = parseCliArgs(["--persistent"], { QS_MODE: "ephemeral" });
    expect(cli.mode).toBe("persistent");
  });
});

describe("parseCliArgs — rejections (typed CliArgsError, message only)", () => {
  test("a URL together with --persistent is contradictory", () => {
    expect(() => parseCliArgs(["pg://x", "--persistent"], EMPTY_ENV)).toThrow(CliArgsError);
    try {
      parseCliArgs(["pg://x", "--persistent"], EMPTY_ENV);
    } catch (err) {
      expect(err).toBeInstanceOf(CliArgsError);
      expect((err as CliArgsError).message).toMatch(/contradictory/i);
    }
  });

  test("a malformed URL positional is refused (shape check via new URL)", () => {
    expect(() => parseCliArgs(["not a url"], EMPTY_ENV)).toThrow(CliArgsError);
    try {
      parseCliArgs(["not a url"], EMPTY_ENV);
    } catch (err) {
      expect((err as CliArgsError).message).toMatch(/invalid database url/i);
    }
  });

  test("an unknown flag is refused", () => {
    expect(() => parseCliArgs(["--frobnicate"], EMPTY_ENV)).toThrow(CliArgsError);
  });

  test("more than one positional is refused", () => {
    expect(() => parseCliArgs(["pg://a", "pg://b"], EMPTY_ENV)).toThrow(CliArgsError);
    try {
      parseCliArgs(["pg://a", "pg://b"], EMPTY_ENV);
    } catch (err) {
      expect((err as CliArgsError).message).toMatch(/too many arguments/i);
    }
  });
});

describe("parseCliArgs — browser-open suppression", () => {
  test("--no-open suppresses browser-open", () => {
    expect(parseCliArgs(["--no-open"], EMPTY_ENV).openBrowser).toBe(false);
    expect(parseCliArgs(["pg://x", "--no-open"], EMPTY_ENV).openBrowser).toBe(false);
  });

  test("a non-empty QS_NO_OPEN suppresses browser-open", () => {
    expect(parseCliArgs([], { QS_NO_OPEN: "1" }).openBrowser).toBe(false);
  });

  test("an empty QS_NO_OPEN does NOT suppress (open stays on)", () => {
    expect(parseCliArgs([], { QS_NO_OPEN: "" }).openBrowser).toBe(true);
  });
});
