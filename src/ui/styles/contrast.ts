/**
 * quick-studio UI (Ring 2) — pure WCAG contrast helpers (DW-67).
 *
 * No dependency: the repo has no color library and must not gain one for a
 * three-function contrast check. Handles the two color notations the ERD's OPAQUE
 * text tokens use — 6-digit hex (`#6ba5ff`) and space-separated `hsl(H S% L%)`
 * (`hsl(224 14% 8%)`) — and throws a descriptive error on anything else (a
 * `var(--x)` reference, `rgb()`, a named color, …). Translucent tokens (8-digit
 * hex-with-alpha like `--edge: #ffffff2e`, or `rgba(...)` like `--coral-line`) are
 * DELIBERATELY out of scope: they are graphical objects under a different WCAG
 * criterion (1.4.11, not the 1.4.3 text contrast this module locks), and a caller
 * that hands one in gets a loud throw rather than a number computed against the
 * wrong backdrop. This module never resolves `var(--x)` aliases itself, that is the
 * caller's job (see `contrast.test.ts`, which resolves aliases against the same
 * theme block before calling in here).
 *
 * Math is WCAG 2.x sRGB relative luminance + contrast ratio — the same formula
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance defines, done in plain
 * floating point (no gamma-correction library needed: the sRGB→linear transfer
 * function is a five-line piecewise formula).
 */

/** An sRGB color as 0–255 channel values. */
export type RgbColor = { readonly r: number; readonly g: number; readonly b: number };

const HEX_RE = /^#([0-9a-fA-F]{6})$/;
// `hsl(224 14% 8%)` — space-separated (CSS Color 4 syntax), the only form this repo's
// `globals.css` uses. Percent signs are required on S/L; H is a bare number. Each
// numeric sub-pattern allows AT MOST ONE decimal point (`-?\d+(?:\.\d+)?`) — the
// looser `[0-9.]+` this replaced would also accept a malformed value like `1.2.3`,
// silently truncating it via `Number()` into `NaN` instead of failing the match.
const HSL_RE = /^hsl\(\s*(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)$/i;

/**
 * Parse a 6-digit hex color or a space-separated `hsl(H S% L%)` string into sRGB
 * 0–255 channels. Throws a descriptive `Error` on anything else (an unresolved
 * `var(--x)`, `rgb()`, a named color, a malformed hex/hsl, or an in-range-looking
 * `hsl()` whose S/L percentage is out of the valid 0–100 range) — this helper never
 * guesses, so a bad token fails the contrast test loudly instead of silently
 * comparing garbage.
 */
export function parseCssColor(value: string): RgbColor {
  const v = value.trim();

  const hex = HEX_RE.exec(v);
  if (hex) {
    const n = hex[1]!;
    return {
      r: parseInt(n.slice(0, 2), 16),
      g: parseInt(n.slice(2, 4), 16),
      b: parseInt(n.slice(4, 6), 16),
    };
  }

  const hsl = HSL_RE.exec(v);
  if (hsl) {
    const h = Number(hsl[1]);
    const sPct = Number(hsl[2]);
    const lPct = Number(hsl[3]);
    // Clamp S/L into the valid 0–1 fraction: the regex accepts a numerically well-formed
    // but out-of-range percentage like `150%`, which would otherwise yield channels
    // outside 0–255 and a meaningless ratio instead of a loud failure.
    if (sPct < 0 || sPct > 100 || lPct < 0 || lPct > 100) {
      throw new Error(
        `parseCssColor: out-of-range hsl() saturation/lightness in "${value}" — ` +
          `expected 0–100%.`,
      );
    }
    const rgb = hslToRgb(h, sPct / 100, lPct / 100);
    if (!Number.isFinite(rgb.r) || !Number.isFinite(rgb.g) || !Number.isFinite(rgb.b)) {
      throw new Error(`parseCssColor: non-finite channel parsing hsl() value "${value}".`);
    }
    return rgb;
  }

  throw new Error(
    `parseCssColor: unparseable color "${value}" — expected 6-digit hex (#rrggbb) or ` +
      `space-separated hsl(H S% L%); resolve var(--x) aliases before calling this helper.`,
  );
}

/** CSS Color 4 `hsl()` → sRGB 0–255 channels (H in degrees, S/L as 0–1 fractions). */
function hslToRgb(h: number, s: number, l: number): RgbColor {
  // Standard HSL→RGB conversion (CSS Color spec algorithm), channel values 0–1.
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hue < 60) {
    r1 = c;
    g1 = x;
  } else if (hue < 120) {
    r1 = x;
    g1 = c;
  } else if (hue < 180) {
    g1 = c;
    b1 = x;
  } else if (hue < 240) {
    g1 = x;
    b1 = c;
  } else if (hue < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/** One sRGB channel (0–255) → its linear-light value, per the WCAG relative-luminance formula. */
function linearizeChannel(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance of an sRGB color, in [0, 1]. Black = 0, white = 1.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(color: RgbColor): number {
  const r = linearizeChannel(color.r);
  const g = linearizeChannel(color.g);
  const b = linearizeChannel(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two CSS colors (hex or space-separated `hsl()`), in
 * [1, 21]. Identical colors → 1; black vs white → 21. Order-independent (the
 * lighter/darker luminance is resolved internally).
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseCssColor(a));
  const lb = relativeLuminance(parseCssColor(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
