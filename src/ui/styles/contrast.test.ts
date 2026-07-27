/**
 * quick-studio UI (Ring 2) — contrast helper units + the DW-67 AA-conformance lock.
 *
 * Two describe blocks:
 *  - the pure `contrast.ts` helpers (parseCssColor / relativeLuminance / contrastRatio)
 *    in isolation — known fixed points (black/white, identical colors, hex/hsl()
 *    parity, a descriptive throw on garbage input);
 *  - a test that reads `src/ui/styles/globals.css` from disk via
 *    `Bun.file(new URL("./globals.css", import.meta.url))` — `Bun.file` accepts a
 *    `URL` object directly, so this passes the URL as-is rather than `.pathname`
 *    (unlike `src/core/driver.test.ts:829-839`'s precedent, fixed here but not
 *    there — deferred separately): on native Windows, `.pathname` yields
 *    `/C:/Users/…`, which `Bun.file` cannot open. To be exact about the stakes
 *    (P16): no CI leg runs this suite at all — `release.yml`'s `windows-latest` job
 *    builds and smoke-tests a binary, and the only `bun test` in `.github/workflows`
 *    is `keyring-spike.yml`'s single `src/core/keychain.test.ts`. So the hazard this
 *    guards is a developer running `bun test` on native Windows, not a red build.
 *    The test then extracts the dark `:root { … }` and light
 *    `:root[data-theme="light"] { … }` blocks SEPARATELY, resolves `var(--x)` aliases
 *    within each block, and asserts every ERD small-label token reaches WCAG AA
 *    (>= 4.5:1) against every ERD surface (`--card`, `--muted`, `--background`) in
 *    BOTH blocks. This is the enforcement mechanism the DW-67 intent requires:
 *    contrast conformance is proven by a test that measures the real tokens, not a
 *    comment — with the same caveat, that the measurement runs where the suite runs.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { contrastRatio, parseCssColor, relativeLuminance } from "./contrast.ts";

describe("contrast.ts — parseCssColor / relativeLuminance / contrastRatio", () => {
  test("black vs white contrast ratio is 21 (the WCAG maximum)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 2); // order-independent
  });

  test("identical colors have a contrast ratio of 1 (the WCAG minimum)", () => {
    expect(contrastRatio("#6ba5ff", "#6ba5ff")).toBeCloseTo(1, 5);
    expect(contrastRatio("hsl(224 14% 8%)", "hsl(224 14% 8%)")).toBeCloseTo(1, 5);
  });

  test("hex and hsl() parity: the same color in both notations parses identically", () => {
    // Canonical HSL primaries have exact, hand-verifiable RGB equivalents.
    expect(parseCssColor("hsl(0 100% 50%)")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseCssColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseCssColor("hsl(120 100% 50%)")).toEqual({ r: 0, g: 255, b: 0 });
    expect(parseCssColor("#00ff00")).toEqual({ r: 0, g: 255, b: 0 });
    expect(parseCssColor("hsl(240 100% 50%)")).toEqual({ r: 0, g: 0, b: 255 });
    expect(parseCssColor("#0000ff")).toEqual({ r: 0, g: 0, b: 255 });
    // Parity holds through to the derived luminance too, not just the raw channels.
    expect(relativeLuminance(parseCssColor("hsl(0 0% 100%)"))).toBeCloseTo(
      relativeLuminance(parseCssColor("#ffffff")),
      6,
    );
  });

  test("throws a descriptive error on an unparseable value", () => {
    expect(() => parseCssColor("var(--t-int)")).toThrow(/unparseable/i);
    expect(() => parseCssColor("rgb(107, 165, 255)")).toThrow(/unparseable/i);
    expect(() => parseCssColor("red")).toThrow(/unparseable/i);
    expect(() => parseCssColor("#fff")).toThrow(/unparseable/i); // 3-digit hex unsupported
    expect(() => parseCssColor("")).toThrow(/unparseable/i);
  });

  // P4: a malformed hsl() with a multi-dot numeric (e.g. a fat-fingered "1.2.3") must
  // fail the regex match — and thus throw — rather than `Number()` silently truncating
  // it into `NaN` and producing a `{ r, g, b: NaN }` no caller asked for.
  test("throws on a malformed hsl() component with more than one decimal point", () => {
    expect(() => parseCssColor("hsl(1.2.3 50% 50%)")).toThrow(/unparseable/i);
    expect(() => parseCssColor("hsl(0 5.0.0% 50%)")).toThrow(/unparseable/i);
  });

  // P4: a numerically well-formed but out-of-range S/L percentage (the regex alone
  // can't reject `150%`) must also throw loudly instead of yielding channels outside
  // 0–255 and a meaningless ratio.
  test("throws on an out-of-range hsl() saturation/lightness percentage", () => {
    expect(() => parseCssColor("hsl(0 150% 50%)")).toThrow(/out-of-range/i);
    expect(() => parseCssColor("hsl(0 50% 150%)")).toThrow(/out-of-range/i);
  });
});

// ---- globals.css block extraction + var(--x) alias resolution (test-local only —
// contrast.ts stays a pure color-math helper with no CSS-parsing concerns). ----

/**
 * Strip `/* … *\/` comments from the raw CSS text BEFORE rule-body extraction or
 * declaration parsing (P7). `parseCustomProperties`'s regex runs over the raw rule
 * body with no comment awareness, and `Map.set` makes the LAST match win — so a
 * comment that merely LOOKS like a declaration (e.g. `--t-int: was #2f6fd6;`, a
 * plausible way to annotate a token's old value) would silently shadow the real
 * token and make the AA lock measure a value the browser never renders. Stripping
 * comments first also removes the realistic way a stray `}` inside a comment could
 * break `extractRuleBody`'s "first `}` after the opening brace closes the rule" scan.
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Read + comment-strip `globals.css` once per call site (P7/P8). */
async function readGlobalsCss(): Promise<string> {
  const raw = await Bun.file(new URL("./globals.css", import.meta.url)).text();
  return stripCssComments(raw);
}

/**
 * Extract the `{ ... }` body of the FIRST rule whose selector matches `selectorPattern`.
 * Every rule body in `globals.css`'s token blocks is flat (declarations only, no nested
 * `{`), so the first `}` after the opening brace closes it — this is what keeps the dark
 * `:root` extraction from swallowing into the light block (and vice versa): the pattern
 * is anchored to match ONLY the exact token-block selector, never a compound selector
 * like `:root[data-theme="light"] .wtab:hover…` that happens to start the same way.
 */
function extractRuleBody(css: string, selectorPattern: RegExp): string {
  const match = selectorPattern.exec(css);
  if (!match) {
    throw new Error(`extractRuleBody: selector ${selectorPattern} not found in globals.css`);
  }
  const openBrace = css.indexOf("{", match.index);
  const closeBrace = openBrace === -1 ? -1 : css.indexOf("}", openBrace);
  if (openBrace === -1 || closeBrace === -1) {
    throw new Error(`extractRuleBody: malformed rule body for ${selectorPattern}`);
  }
  return css.slice(openBrace + 1, closeBrace);
}

// Anchored so `:root {` never also matches the light theme's `:root[data-theme="light"] {`
// (the `[` immediately breaks the `:root\s*\{` pattern), and so the light pattern never
// matches the later compound selector `:root[data-theme="light"] .wtab:hover…` (which has
// text between the attribute selector and its own, different, `{`).
const DARK_ROOT_SELECTOR = /(^|\n):root\s*\{/;
const LIGHT_ROOT_SELECTOR = /(^|\n):root\[data-theme="light"\]\s*\{/;
// The Tailwind alias block. Its body is flat declarations too, so `extractRuleBody`'s
// "first `}` closes the rule" scan holds here as well.
const THEME_INLINE_SELECTOR = /(^|\n)@theme\s+inline\s*\{/;

/** Parse `--name: value;` custom-property declarations out of a rule body. */
function parseCustomProperties(block: string): Map<string, string> {
  const props = new Map<string, string>();
  // Every value in these blocks (hex, hsl(), rgba(), var()) is `;`-terminated and
  // contains no literal `;` of its own, so a non-greedy run up to `;` is exact.
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    props.set(m[1]!, m[2]!.trim());
  }
  return props;
}

/**
 * Resolve `--name` to its literal value within `props`, following `var(--other)`
 * aliases (e.g. dark's `--edge-hot: var(--t-int)`) until a non-alias value is found.
 * Aliases are resolved ONLY against the SAME block's properties — the story's
 * contract — never across dark/light.
 */
function resolveToken(props: Map<string, string>, name: string): string {
  let value = props.get(name);
  if (value === undefined) {
    throw new Error(`resolveToken: --${name} not found in this theme block`);
  }
  const seen = new Set<string>([name]);
  const varRe = /^var\(--([a-zA-Z0-9-]+)\)$/;
  let match = varRe.exec(value);
  while (match) {
    const next = match[1]!;
    if (seen.has(next)) {
      throw new Error(`resolveToken: circular var() alias involving --${next}`);
    }
    seen.add(next);
    const nextValue = props.get(next);
    if (nextValue === undefined) {
      throw new Error(`resolveToken: --${next} (aliased from --${name}) not found in this block`);
    }
    value = nextValue;
    match = varRe.exec(value);
  }
  return value;
}

describe("globals.css block extraction + alias resolution", () => {
  test("dark and light blocks are extracted separately (no swallowing)", async () => {
    const css = await readGlobalsCss();
    const dark = parseCustomProperties(extractRuleBody(css, DARK_ROOT_SELECTOR));
    const light = parseCustomProperties(extractRuleBody(css, LIGHT_ROOT_SELECTOR));
    // Both blocks define --t-enum, but to DIFFERENT values — if extraction ever swallowed
    // one block into the other, these would collapse to the same value. P19: asserted as a
    // RELATIONSHIP, not against literals — this test's subject is the block boundary, and
    // pinning `#e0a458`/`#ef6a63` here made any unrelated palette edit fail it with a
    // misleading "extraction broke" signal. The token VALUES are locked, by measurement,
    // in the AA describe block below, which is where a palette change should be caught.
    expect(dark.get("t-enum")).toBeDefined();
    expect(light.get("t-enum")).toBeDefined();
    expect(light.get("t-enum")).not.toBe(dark.get("t-enum"));
    // The dark block's own dark-only tokens (Story 7.3, never overridden in light) must
    // still be visible — proof the dark block wasn't truncated early — and must NOT leak
    // into the light block, proof the light extraction didn't start too early.
    expect(dark.has("err")).toBe(true);
    expect(light.has("err")).toBe(false);
  });

  test("var(--x) aliases resolve within the same block", async () => {
    const css = await readGlobalsCss();
    const dark = parseCustomProperties(extractRuleBody(css, DARK_ROOT_SELECTOR));
    // `--edge-hot: var(--t-int);` is the one real alias in this file — resolving it must
    // land on the same literal `--t-int` itself resolves to.
    expect(resolveToken(dark, "edge-hot")).toBe(resolveToken(dark, "t-int"));
  });
});

describe("stripCssComments — comment-blind parser guard (P7)", () => {
  // A comment naming a token (this very change added one: "--t-bool" survived only
  // because it happened to be followed by `(` rather than `:`) must never shadow the
  // real declaration — `parseCustomProperties`'s regex has no comment awareness, and
  // `Map.set` makes the LAST match win, so an unstripped comment written as
  // `--t-int: was #2f6fd6;` would silently overwrite the real value.
  test("a comment BEFORE the real declaration does not shadow it", () => {
    const css = `:root {\n  /* --t-int: was #2f6fd6; */\n  --t-int: #6ba5ff;\n}`;
    const body = extractRuleBody(stripCssComments(css), /:root\s*\{/);
    expect(parseCustomProperties(body).get("t-int")).toBe("#6ba5ff");
  });

  test("a comment AFTER the real declaration does not shadow it (Map.set last-write-wins)", () => {
    const css = `:root {\n  --t-int: #6ba5ff;\n  /* --t-int: was #2f6fd6; */\n}`;
    const body = extractRuleBody(stripCssComments(css), /:root\s*\{/);
    expect(parseCustomProperties(body).get("t-int")).toBe("#6ba5ff");
  });
});

describe("ERD small-label contrast (DW-67) — dark AND light, every ERD surface, all >= 4.5:1", () => {
  // The ERD's small-label tokens: the five type-color labels, the muted-foreground tone
  // the legend/panel/toolbar share, and `--foreground` (P17) — the ERD's most PROMINENT
  // small text, and the one the original list omitted: the node header label
  // (`ErdTableNode`, 12.5px) and every PK column name (12px, `text-[var(--foreground)]`),
  // on `--muted` and `--card` respectively. It passes comfortably in both themes
  // (>= 12.9 dark, >= 15.8 light), so this locks a margin rather than fixing a failure.
  // `--t-key` (the PK key GLYPH, an icon under WCAG 1.4.11's 3:1, not 1.4.3's text) and
  // `--t-bool`/`--t-json` (data-grid / schema-tree, out of scope) stay excluded — the
  // intent contract forbids touching them. Note `--t-bool` is REAL small text elsewhere
  // (`DataGrid.tsx` renders it as the header type tag's `color`) and measures 3.49 in
  // light, a live AA failure; `--t-json` is only a 6px `bg-t-json` dot in the schema
  // tree, so it answers to 3:1 and clears it except on `--muted`. Both are deferred
  // (see the ledger), not fixed here — this list is the ERD's scope, not the app's.
  const TOKENS: ReadonlyArray<string> = [
    "t-int",
    "t-time",
    "t-num",
    "t-enum",
    "t-text",
    "muted-foreground",
    "foreground",
  ];

  // P6: the spec's design notes claimed the token fixes "also clear --muted and
  // --background, so they hold on every ERD surface" — the ERD genuinely renders small
  // labels on all three (a node's HEADER is `bg-[var(--muted)]`, where `--foreground` and
  // `--muted-foreground` really land; the CANVAS itself is `bg-[var(--background)]`;
  // everything else sits on `--card`), so this is now a LOCK against all three, not just
  // `--card`. Some pairs in the resulting matrix are deliberately over-constraining — a
  // `t-*` type label never renders on `--muted` today, and `--background` is strictly
  // lighter (light) / darker (dark) than `--card`, so its rows can never be the binding
  // ones. That redundancy is the point: the lock stays valid if a label MOVES surfaces.
  // Measured, all pass — light `--t-time` on `--muted` (4.52) is the thinnest margin.
  //
  // SCOPE (P20): this measures the AT-REST canvas. On hover, `ErdTabView` dims every
  // unconnected node to `opacity: 0.4`, which composites these same tokens down to
  // ~1.6-2.1:1 — far below AA — for as long as the pointer rests on a node. That is the
  // pre-existing Story 7.4 dim overlay, not something this lock introduced or covers; it
  // is recorded in the deferred-work ledger. Read "every ERD small-label pair reaches
  // AA" as a statement about the tokens and their surfaces, not about the dimmed state.
  const SURFACES: ReadonlyArray<string> = ["card", "muted", "background"];

  type Failure = {
    theme: string;
    token: string;
    surface: string;
    value: string;
    surfaceValue: string;
    ratio: number;
  };

  test("every ERD small-label token reaches WCAG AA (>= 4.5:1) against every surface", async () => {
    const css = await readGlobalsCss();
    const blocks: ReadonlyArray<readonly [string, RegExp]> = [
      ["dark", DARK_ROOT_SELECTOR],
      ["light", LIGHT_ROOT_SELECTOR],
    ];

    // P5: collect every failing (or non-finite) pair instead of throwing on the first
    // one found — the old `if (ratio < 4.5) throw …` followed by an `expect(ratio)…`
    // meant the `expect` was unreachable on a real failure (the throw ran first) and
    // the `throw` branch was dead on a pass, AND `NaN < 4.5` is `false`, so a
    // non-finite ratio slipped past the descriptive-message branch entirely — exactly
    // the diagnostic the acceptance criterion promises. One assertion at the end
    // reports every offending token with its measured ratio, non-finite included.
    const failures: Failure[] = [];
    for (const [themeName, selector] of blocks) {
      const props = parseCustomProperties(extractRuleBody(css, selector));
      for (const surface of SURFACES) {
        const surfaceValue = resolveToken(props, surface);
        for (const token of TOKENS) {
          const value = resolveToken(props, token);
          const ratio = contrastRatio(value, surfaceValue);
          if (!Number.isFinite(ratio) || ratio < 4.5) {
            failures.push({ theme: themeName, token, surface, value, surfaceValue, ratio });
          }
        }
      }
    }

    // One mechanism, no dead branch: a formatted string per failure so the assertion
    // output names each offending token with its measured ratio to 2 decimals (or
    // "NaN" if non-finite, via `toFixed` on a NaN, which itself prints "NaN").
    const formatted = failures.map(
      (f) =>
        `${f.theme} --${f.token} (${f.value}) vs --${f.surface} (${f.surfaceValue}): ` +
        `measured contrast ratio ${f.ratio.toFixed(2)}:1, expected >= 4.5:1 (WCAG AA normal text).`,
    );
    expect(formatted).toEqual([]);
  });
});

describe("destructive-fill contrast (DW-58) — white on --err-fill, --err as text, --err as the rim", () => {
  // `--err` is dual-purpose: fine as TEXT on dark surfaces, but only 3.04:1 as a solid
  // fill under a white label. DW-58 splits the fill out into `--err-fill` and leaves
  // `--err` untouched, so this block has to lock BOTH directions at once — darkening
  // `--err` must break the text lock, lightening `--err-fill` must break the fill lock.
  //
  // globals.css is read + parsed ONCE for the whole describe (not once per test).
  let dark!: Map<string, string>;
  let light!: Map<string, string>;
  let themeInline!: Map<string, string>;

  beforeAll(async () => {
    const css = await readGlobalsCss();
    dark = parseCustomProperties(extractRuleBody(css, DARK_ROOT_SELECTOR));
    light = parseCustomProperties(extractRuleBody(css, LIGHT_ROOT_SELECTOR));
    themeInline = parseCustomProperties(extractRuleBody(css, THEME_INLINE_SELECTOR));
  });

  const WHITE = "#ffffff";
  const toHexChannel = (v: number): string =>
    Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");

  /**
   * Model CSS `filter: brightness(f)` on ONE opaque color. The shorthand filter functions
   * multiply each channel in *sRGB* space (NOT in linear light), then the result is
   * rounded to an integer channel and clamped to 0–255. Kept local to this file:
   * `contrast.ts` stays pure color math.
   *
   * Note the real `hover:brightness-110` is an ELEMENT filter: it brightens the fill, the
   * rim and the label together. Callers below apply it per color and assert the pairs that
   * matter, rather than this helper modelling the whole button.
   */
  function brightness(hex: string, factor: number): string {
    const { r, g, b } = parseCssColor(hex);
    return `#${toHexChannel(r * factor)}${toHexChannel(g * factor)}${toHexChannel(b * factor)}`;
  }

  /**
   * Composite an opaque color over an opaque backdrop at `alpha` — the effect of CSS
   * `opacity` on a whole element, which fades the button's fill AND its white label
   * together onto whatever sits behind them.
   */
  function composite(hex: string, alpha: number, backdrop: string): string {
    const f = parseCssColor(hex);
    const b = parseCssColor(backdrop);
    const mix = (fc: number, bc: number): number => fc * alpha + bc * (1 - alpha);
    return `#${toHexChannel(mix(f.r, b.r))}${toHexChannel(mix(f.g, b.g))}${toHexChannel(mix(f.b, b.b))}`;
  }

  test("brightness() multiplies each sRGB channel, rounds, and clamps at 255", () => {
    // Hand-verifiable fixed points: 0x80 = 128, 128 * 1.1 = 140.8 -> 141 = 0x8d.
    expect(brightness("#808080", 1.1)).toBe("#8d8d8d");
    // 0xf0 = 240, 240 * 1.5 = 360 -> clamped to 255 = 0xff.
    expect(brightness("#f0f0f0", 1.5)).toBe("#ffffff");
    // A factor of 1 is the identity (modulo hex casing).
    expect(brightness("#be342d", 1)).toBe("#be342d");
  });

  test("--err stays an AA text color (>= 4.5:1) on every dark surface", () => {
    // Deliberately NOT appended to the DW-67 ERD lock's `TOKENS`: that lock iterates the
    // dark AND light blocks, and `resolveToken` THROWS on a missing key — `--err` is
    // dark-only (no `:root[data-theme="light"]` override), so it would blow up on light.
    // Measured: --card 5.72, --muted 5.10, --background 6.11.
    for (const surface of ["card", "muted", "background"] as const) {
      const ratio = contrastRatio(resolveToken(dark, "err"), resolveToken(dark, surface));
      expect(ratio).toBeGreaterThanOrEqual(4.5); // --err as text vs --{surface}
    }
  });

  test("white on --err-fill clears AA at rest (>= 4.5:1)", () => {
    // The label of both destructive buttons: `text-white` on `--err-fill`. Measured 5.65.
    const ratio = contrastRatio(WHITE, resolveToken(dark, "err-fill"));
    expect(ratio).toBeGreaterThanOrEqual(4.5); // #ffffff vs --err-fill
  });

  test("white on the hover-brightened --err-fill still clears AA (ConfirmRun hover:brightness-110)", () => {
    // `hover:brightness-110` lightens the fill toward white, so the hover state is the
    // BINDING one, not the rest state. Measured 4.84 (#be342d -> #d13932).
    const ratio = contrastRatio(WHITE, brightness(resolveToken(dark, "err-fill"), 1.1));
    expect(ratio).toBeGreaterThanOrEqual(4.5); // #ffffff vs brightness(1.10) of --err-fill
  });

  test("the settings hover:opacity-90 composite still clears AA (SettingsPanel remove-confirm)", () => {
    // A genuinely different composite from brightness(): `opacity` fades the button as a
    // whole, so the white LABEL fades onto the `bg-card` row too and both sides move.
    // Measured 5.27 (#ad312c label-side #e8e8e9).
    const card = resolveToken(dark, "card");
    const ratio = contrastRatio(
      composite(WHITE, 0.9, card),
      composite(resolveToken(dark, "err-fill"), 0.9, card),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5); // faded white vs faded --err-fill, over --card
  });

  test("the --err rim clears WCAG 1.4.11 (>= 3:1), at rest and hovered, on the surface each button sits on", () => {
    // The rim is the buttons' only boundary signal, so it answers to 1.4.11's 3:1 against
    // the surface BEHIND the button — `--muted` for the ConfirmRun footer
    // (`ConfirmRun.tsx`'s `bg-[var(--muted)]` button row), `--card` for the settings
    // remove-confirm row. Measured: --err 5.10 / 5.72. The FILL alone would be 2.74 on
    // --muted and 3.08 on --card, which is exactly why the rim stays `--err`. Not
    // measured against `--background`: neither button sits there, and it is the single
    // most favourable surface (an earlier pass certified 3.29 on a surface it never
    // touches while the real one failed).
    //
    // The at-rest half overlaps the >= 4.5 text lock above and cannot fail on its own; it
    // is kept because it pins a DIFFERENT criterion (1.4.11 boundary, not 1.4.3 text) and
    // would survive a future decision to give the rim its own token. The hovered half is
    // the part that measures something new: `hover:brightness-110` is an element filter,
    // so it lightens the RIM as well as the fill (#ef6a63 -> #ff756d, red channel clamped),
    // moving it toward the surface. Measured 5.92 / 6.64 — benign, but now locked.
    //
    // DARK BLOCK ONLY. `--err` has no light override (Story 7.3 kept the `--err*` group
    // dark-only) and light theme has no activation path in `src/` today, so light-theme
    // ratios are deliberately out of this lock's scope — see the deferred-work note on the
    // `--err*` palette under a light theme.
    for (const surface of ["muted", "card"] as const) {
      const surfaceValue = resolveToken(dark, surface);
      const rim = resolveToken(dark, "err");
      expect(contrastRatio(rim, surfaceValue)).toBeGreaterThanOrEqual(3); // rim vs --{surface}
      expect(contrastRatio(brightness(rim, 1.1), surfaceValue)).toBeGreaterThanOrEqual(3); // hovered rim
    }
  });

  test("@theme inline maps --color-err-fill to var(--err-fill)", () => {
    // `SettingsPanel` consumes the BARE `bg-err-fill` utility, which only exists because
    // of this alias. Drop the alias and the button paints nothing — with every color
    // assertion above still green, since the token itself is untouched.
    expect(themeInline.get("color-err-fill")).toBe("var(--err-fill)");
  });

  test("the light block gains no err-fill key (one value serves both themes today)", () => {
    // Mirrors the existing `light.has("err") === false`. `--err-fill` is declared once in
    // `:root` with no light override on purpose: white-on-fill is theme-invariant (5.65:1
    // whatever sits behind the button), and the fill itself still clears 1.4.11 against the
    // light surfaces (5.27 on light --card, 4.91 on light --muted).
    //
    // This is a "did someone fork it by accident?" tripwire, NOT a prohibition. A future
    // light-theme pass may legitimately want a light `--err-fill` — `--err` is only 2.84:1
    // on light --card today, so that palette needs work — and when it does, updating this
    // expectation is the correct move, not a workaround.
    expect(dark.has("err-fill")).toBe(true);
    expect(light.has("err-fill")).toBe(false);
  });
});
