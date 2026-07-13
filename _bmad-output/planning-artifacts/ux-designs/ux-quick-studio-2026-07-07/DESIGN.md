---
name: quick-studio
description: A lightweight local database client — a precision instrument, anti-DBeaver, TablePlus-grade taste. Lightweight is the identity; fast is the promise. Custom design system (not a shadcn brand-layer delta) — CSS tokens live in src/ui/styles/globals.css, applied with Tailwind v4 config-less.
status: draft
updated: 2026-07-07
sources:
  - imports/workspace-prototype.html   # design-artifacts/workspace-prototype.html — the north star
  - {planning_artifacts}/epics.md#ux-design-requirements   # UX-DR1..UX-DR7, AR-17 stack seed
colors:
  # ---- neutrals: cool, faintly blue-biased (an instrument, not a warm doc) ----
  bg: '#0b0d11'
  surface: '#101319'
  surface-2: '#161a21'
  surface-3: '#1c212a'
  border: '#222835'
  border-strong: '#313a49'
  text: '#e7eaf0'
  text-dim: '#98a1b0'
  text-faint: '#616a7a'
  bg-light: '#eef0f3'
  surface-light: '#ffffff'
  surface-2-light: '#f4f6f8'
  surface-3-light: '#e9edf1'
  border-light: '#dde1e7'
  border-strong-light: '#c6cdd7'
  text-light: '#171b22'
  text-dim-light: '#56606f'
  text-faint-light: '#8a93a2'
  # ---- accent: the ONE bold place — coral. Primary action + active state only ----
  accent: '#f2705d'
  accent-ink: '#0b0d11'
  accent-soft: 'rgba(242,112,93,0.14)'
  accent-line: 'rgba(242,112,93,0.45)'
  accent-light: '#dd5641'
  accent-ink-light: '#ffffff'
  accent-soft-light: 'rgba(221,86,65,0.10)'
  accent-line-light: 'rgba(221,86,65,0.40)'
  # ---- semantic: row/query STATE, kept deliberately apart from the accent ----
  ok: '#46c99a'
  ok-soft: 'rgba(70,201,154,0.13)'
  warn: '#e0a458'
  warn-soft: 'rgba(224,164,88,0.14)'
  err: '#f05a63'
  err-soft: 'rgba(240,90,99,0.13)'
  ok-light: '#1f9d6f'
  warn-light: '#b3781f'
  err-light: '#d23b45'
  # ---- data-type coding: a real information system for column headers/cells ----
  t-int: '#6ba5ff'       # int / numeric-int
  t-time: '#b18cff'      # timestamp / timestamptz
  t-bool: '#e0a458'      # bool (shares the warn amber value, distinct role)
  t-json: '#3ec6b6'      # jsonb / numeric (teal)
  t-text: '#98a1b0'      # text / varchar / citext (muted)
  t-key: '#f2705d'       # PK — reuses accent coral (var(--accent))
  t-int-light: '#2f6fd6'
  t-time-light: '#7d54cf'
  t-bool-light: '#b3781f'
  t-json-light: '#1a9b8c'
  t-text-light: '#56606f'
typography:
  # MONOSPACE is the voice of the interface. SANS only for soft chrome (action buttons).
  mono-stack:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace'
    note: 'The interface voice — data, metrics, table/column names, grid cells, tabs, tree, status bar. tabular-nums for numeric alignment.'
  sans-stack:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    note: 'Soft chrome only — the Run button label. Do not use for data.'
  body:
    fontFamily: '{typography.sans-stack.fontFamily}'
    fontSize: 13px
    lineHeight: '1.4'
  label:
    fontFamily: '{typography.mono-stack.fontFamily}'
    fontSize: 10.5px
    fontWeight: '400'
    letterSpacing: 0.11em    # uppercase section labels
    note: 'UPPERCASE, tracked. text-transform: uppercase; color {colors.text-faint}.'
  data-cell:
    fontFamily: '{typography.mono-stack.fontFamily}'
    fontSize: 12.5px
    note: 'Result-grid cells. tabular-nums for numeric columns.'
  editor:
    fontFamily: '{typography.mono-stack.fontFamily}'
    fontSize: 13px
    lineHeight: '1.7'
  latency-number:
    fontFamily: '{typography.mono-stack.fontFamily}'
    fontSize: 15px
    fontWeight: '600'
    note: 'tabular-nums; color {colors.accent}.'
rounded:
  sm: 4px      # focus rings, kbd chips, tab close hit-target
  DEFAULT: 6px # buttons, filter, tabs-in-tree rows, icon buttons
  md: 7px      # --radius — panels, editor, primary containers
  lg: 8px      # rail buttons, brand mark
  full: 9999px # status pills only
spacing:
  # 4-based rhythm observed in the prototype. Config-less Tailwind v4 default scale applies.
  rail: 52px    # --rail launcher column width
  tree: 232px   # --tree schema-tree column width
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
components:
  rail-button:
    size: 36px
    radius: '{rounded.lg}'
    idle-color: '{colors.text-faint}'
    hover-color: '{colors.text-dim}'
    hover-bg: '{colors.surface-2}'
    active-color: '{colors.accent}'      # .on state
    active-bg: '{colors.accent-soft}'
  brand-mark:
    size: 30px
    radius: '{rounded.lg}'
    background: '{colors.accent}'
    foreground: '{colors.accent-ink}'
    font: '{typography.mono-stack.fontFamily}'
    fontWeight: '700'
  tree-table-row:
    radius: '{rounded.DEFAULT}'
    font: '{typography.mono-stack.fontFamily}'
    fontSize: 12px
    idle-color: '{colors.text-dim}'
    hover-bg: '{colors.surface-2}'
    active-bg: '{colors.accent-soft}'    # .on
    active-icon: '{colors.accent}'
  connection-dot:
    size: 7px
    color: '{colors.ok}'
    halo: '0 0 0 3px {colors.ok-soft}'
  mode-chip:
    font: '{typography.mono-stack.fontFamily}'
    fontSize: 9.5px
    color: '{colors.t-time}'
    background: 'color-mix(in srgb, {colors.t-time} 14%, transparent)'
    radius: 5px
    note: 'e.g. "persistent" — persistent/ephemeral run-mode indicator.'
  tab:
    height: 40px
    font: '{typography.mono-stack.fontFamily}'
    fontSize: 12px
    idle-color: '{colors.text-faint}'
    active-color: '{colors.text}'
    active-bg: '{colors.bg}'
    active-underline: '2px solid {colors.accent}'   # ::after
  run-button:
    background: '{colors.accent}'
    foreground: '{colors.accent-ink}'
    radius: '{rounded.DEFAULT}'
    font: '{typography.sans-stack.fontFamily}'   # the ONE sans component
    fontSize: 12.5px
    fontWeight: '600'
    kbd: '⌘↵'
    active-transform: 'translateY(1px)'
  latency:
    number: '{typography.latency-number}'
    color: '{colors.accent}'
    pulse-keyframe: 'pop 0.5s ease'   # scale .8→1.12→1, opacity .3→1
  stop-button:
    color: '{colors.err}'
    background: '{colors.err-soft}'
    radius: '{rounded.DEFAULT}'
    font: '{typography.mono-stack.fontFamily}'
  grid-header:
    background: '{colors.surface-2}'
    border-bottom: '1px solid {colors.border-strong}'
    sticky: true
    col-name-color: '{colors.text}'
    type-label: '{typography.label}'    # 9.5px uppercase, colored by data-type
    pk-icon-color: '{colors.t-key}'
  grid-row:
    even-bg: 'color-mix(in srgb, {colors.surface} 45%, transparent)'   # zebra
    hover-bg: '{colors.accent-soft}'
    selected-bg: '{colors.accent-soft}'
    selected-marker: 'inset 2px 0 0 {colors.accent}'
    null-cell: '{colors.text-faint} italic opacity .7'
    fk-cell: '{colors.t-int} underline'
  pill:
    radius: '{rounded.full}'
    font: '{typography.mono-stack.fontFamily}'
    fontSize: 11px
    paid: 'color {colors.ok} / bg {colors.ok-soft}'
    pending: 'color {colors.warn} / bg {colors.warn-soft}'
    refunded: 'color {colors.err} / bg {colors.err-soft}'
    note: 'Dot::before in currentColor. status/bool cells use pills.'
  filter-input:
    background: '{colors.surface}'
    border: '1px solid {colors.border}'
    radius: '{rounded.DEFAULT}'
    font: '{typography.mono-stack.fontFamily}'
    fontSize: 11.5px
    note: 'Live client-side row filter.'
  ghost-button:
    background: '{colors.surface}'
    border: '1px solid {colors.border}'
    hover-border: '{colors.border-strong}'
    color: '{colors.text-dim}'
    radius: '{rounded.DEFAULT}'
    font: '{typography.mono-stack.fontFamily}'
    note: 'Secondary actions: Add Row, Export.'
  status-bar:
    background: '{colors.surface}'
    border-top: '1px solid {colors.border}'
    font: '{typography.mono-stack.fontFamily}'
    fontSize: 10.5px
    color: '{colors.text-faint}'
    ms-accent: '{colors.accent}'
  focus-ring:
    outline: '2px solid {colors.accent}'
    outline-offset: 1px
---

# quick-studio — Design Spine

> **SUPERSEDED (2026-07-13) — Neutral pivot (Epic 7).** The coral accent + monospace-first rules described below are historical. The UI has pivoted to a **neutral, ChatGPT-style** language: the accent is **ink** (white/black), **no coral**; color is kept only where functional (data-type column colors, ok/warn/err semantics, a blue chart data-series, red on destructive actions). The prototypes in `design-artifacts/*.html` are the current **visual source of truth**. Where any coral/mono rule below conflicts with the neutral pivot, the pivot wins.

> This DESIGN.md and its paired EXPERIENCE.md are the identity. **Both spines win over any mock on conflict** (including the prototype's incidental choices). The prototype `design-artifacts/workspace-prototype.html` is the north star for *intent and tokens*; where a literal mock detail contradicts a rule stated here, this spec governs. Epic 3 stories (3-1..3-6) and Epic 4 (ERD) reference these tokens so the React 19 + Tailwind v4 (config-less) implementation respects the aesthetic. Written for the dev who implements: token names map to CSS custom properties in `src/ui/styles/globals.css`.

## Brand & Style

quick-studio is a **precision instrument that happens to be lightweight** — the anti-DBeaver. DBeaver is the explicit anti-reference (UX-DR1): dense, Eclipse-era, chrome-heavy. The taste target is TablePlus: quiet surfaces, one confident accent, information rendered as information. Lightweight is the identity, fast is the promise — so the interface reads like a tool a developer trusts at a glance and never fights.

Three disciplines carry the whole system:

1. **Monospace-first.** The interface *speaks in mono* (UX-DR1 restraint + the identity of a data tool). Data, metrics, table and column names, tabs, the schema tree, the status bar, uppercase labels — all mono. Sans appears in exactly one place: the Run button label. The interface looks like it was built by someone who lives in a terminal and respects your columns lining up.
2. **One accent, spent once.** Coral is the single bold color, reserved for the primary action and the active/selected state. Everything else is cool neutral or a semantic state color. Color is never decoration.
3. **Motion is feedback, never ornament** (UX-DR2, counter-metric SM-C1). The only animation is the latency-number `pop` on query completion — the interface's signature "done, and here's how fast" gesture. `prefers-reduced-motion` kills all animation and transition.

Dark-first (UX-DR1): the dark theme is the primary surface; light is a full parity theme via `data-theme="light"` and `prefers-color-scheme`.

## Colors

Color in quick-studio is **information, not decoration.** Four separate subsystems, deliberately non-overlapping in role:

### 1. Neutrals — cool, faintly blue-biased

The canvas of an instrument, not a warm document. Layered surfaces build depth without shadow: `{colors.bg}` (#0b0d11) → `{colors.surface}` (#101319) → `{colors.surface-2}` (#161a21) → `{colors.surface-3}` (#1c212a), separated by `{colors.border}` (#222835) / `{colors.border-strong}` (#313a49). Text ramps `{colors.text}` → `{colors.text-dim}` → `{colors.text-faint}`. Light theme mirrors every step (`*-light` tokens): near-white surfaces on a cool `#eef0f3` canvas.

### 2. Accent — coral, the one bold place

`{colors.accent}` = **#f2705d dark / #dd5641 light**. This is the *only* saturated brand color, and it is **spent on exactly two things: the primary action (Run button, brand mark) and the active/selected state** (active tab underline, selected tree table, selected grid row marker, active rail button, primary key coral, focus ring, latency number). `{colors.accent-soft}` is the tinted background for active/hover states; `{colors.accent-line}` for hairlines. If coral appears somewhere that is neither "the primary action" nor "what's active," that is a bug.

### 3. Semantic — row/query state, kept apart from the accent

Deliberately separate from coral so that "this is active" never reads as "this is healthy." `{colors.ok}` #46c99a (paid, true, connected), `{colors.warn}` #e0a458 (pending), `{colors.err}` #f05a63 (refunded, false, Stop). Each has a `-soft` tint for pill/badge backgrounds; light theme values are `{colors.ok-light}` / `{colors.warn-light}` / `{colors.err-light}`. These color *state*, never chrome and never the primary action.

### 4. Data-type coding — a real information system

Column-header type labels and cells are colored by SQL type, so a developer reads the shape of a table by color before reading a word:

| Role | Token | Dark | Light | Applies to |
|---|---|---|---|---|
| int / int-ish | `{colors.t-int}` | #6ba5ff | #2f6fd6 | int4/int8, numeric-cell right-aligned, FK ints |
| timestamp | `{colors.t-time}` | #b18cff | #7d54cf | timestamptz, mode-chip, SQL function highlight |
| bool | `{colors.t-bool}` | #e0a458 | #b3781f | bool type label (shares the amber value, distinct role) |
| jsonb / numeric | `{colors.t-json}` | #3ec6b6 | #1a9b8c | jsonb, numeric/money cells (teal) |
| text | `{colors.t-text}` | #98a1b0 | #56606f | varchar/citext/uuid/inet (muted on purpose) |
| primary key | `{colors.t-key}` | #f2705d | #dd5641 | PK key-icon — reuses accent coral |

Note the two intentional reuses: `t-bool` shares the warn amber *value* but is a separate role (a type, not a state), and `t-key` *is* the accent (a PK is the identity of a row — the one place data-coding borrows the brand color). Keep them as distinct tokens even though values coincide, so either can move independently.

## Typography

**Monospace is the voice of the interface.** `{typography.mono-stack}` renders everything that is data or that labels data: result-grid cells, table and column names, the schema tree, tabs, the SQL editor, latency and row-count metrics, the status bar, and uppercase section labels (`{typography.label}` — 10.5px, `letter-spacing: 0.11em`, uppercase, `{colors.text-faint}`). Numeric columns use `font-variant-numeric: tabular-nums` so digits align in a column — non-negotiable for a data grid.

**Sans (`{typography.sans-stack}`) is soft chrome only** — in the prototype it appears on a single element: the Run button label (`{components.run-button}`). Body base is 13px sans, but the moment content *is* data, it switches to mono. If you find yourself setting a table name or a metric in sans, stop — that is the DBeaver drift.

The SQL editor (`{typography.editor}`, mono 13px / 1.7) uses type-colored syntax highlighting drawn from the same palette: keywords in `{colors.accent}` (bold), functions in `{colors.t-time}`, strings in `{colors.ok}`, numbers in `{colors.t-int}`, comments/punctuation in `{colors.text-faint}`. Syntax coloring is the data-type system applied to code.

## Layout & Spacing

Three-column app shell: `grid-template-columns: {spacing.rail} {spacing.tree} 1fr` — a 52px launcher rail, a 232px schema tree, and a fluid main column. Below 720px the tree collapses (`display:none`) to `rail 1fr`. The main column is a vertical stack: topbar (tabs + window actions) → SQL editor panel → results (result-bar + scrolling grid) → status bar.

Rhythm is 4-based (`{spacing.1}`..`{spacing.4}` = 4/8/12/16). Tailwind v4 is config-less: consume the CSS tokens from `globals.css` directly via arbitrary values / `@theme` inline, do not restate the scale in a config file. Panels are resizable and Tabs freely open/close (UX-DR7, FR-23/FR-24) — the grid columns above are the default resting layout, not fixed constraints.

## Elevation & Depth

**Depth comes from tonal layering, not shadows.** The four surface tokens stack to create hierarchy (canvas → panel → raised → control), separated by borders. The only shadows in the system are functional glows, not drop-shadows: the connection dot's `{components.connection-dot.halo}` (a 3px ok-soft ring signalling "connected") and a faint accent glow under the brand mark. No Material elevation, no card shadows — shadow is not a hierarchy device here (that would read heavy, anti-DBeaver).

## Shapes

Crisp, tool-like radii. `{rounded.sm}` 4px (focus rings, kbd chips), `{rounded.DEFAULT}` 6px (buttons, filter, icon buttons, tab-close), `{rounded.md}` 7px (`--radius` — the primary panel/editor radius), `{rounded.lg}` 8px (rail buttons, brand mark). `{rounded.full}` (pill) is reserved **exclusively for status/bool pills** — the only fully-round shape in the system, which is what makes a pill read as a pill.

## Components

Each maps to a `components.*` frontmatter entry; values there are the source of truth.

- **Launcher rail** (`{components.rail-button}`) — 36px icon buttons, `{colors.text-faint}` idle → hover lifts to `{colors.text-dim}` on `{colors.surface-2}`; active (`.on`) is `{colors.accent}` on `{colors.accent-soft}`. Brand mark (`{components.brand-mark}`) is the coral square "q" at top. Five surfaces + Settings (see EXPERIENCE.md IA).
- **Schema tree** (`{components.tree-table-row}`) — mono 12px rows, hover `{colors.surface-2}`, selected `.on` gets `{colors.accent-soft}` bg and coral icon. Header carries the connection dot (`{components.connection-dot}`), db name + host in mono, and the run-mode chip (`{components.mode-chip}`).
- **Tabs** (`{components.tab}`) — 40px mono tabs, active tab drops to `{colors.bg}` with a 2px coral underline (`::after`) and a close ×. Openable/closable per UX-DR7.
- **SQL editor** (`{typography.editor}`) — mono with type-colored syntax highlighting; editor-bar holds the Run button, query name, and the latency readout.
- **Run button** (`{components.run-button}`) — the primary action: coral fill, `{colors.accent-ink}` text, **the one sans-labelled component**, with a `⌘↵` kbd chip. Presses down 1px on `:active`.
- **Latency readout** (`{components.latency}`) — coral tabular-nums number + faint "ms" unit; on query completion it plays the `pop` keyframe (scale .8→1.12→1). This is the signature feedback gesture — see EXPERIENCE.md State Patterns.
- **Stop button** (`{components.stop-button}`) — err-colored, err-soft bg; stops the local server and exits (maps to FR-3 shutdown).
- **Result grid** (`{components.grid-header}` / `{components.grid-row}`) — sticky mono headers on `{colors.surface-2}` with data-type-colored type labels and PK key-icon; zebra rows via `color-mix`, hover and selection in `{colors.accent-soft}` with an inset coral left-marker on the selected row. Cells: numeric right-aligned tabular `{colors.t-int}`, time `{colors.text-dim}`, FK underlined `{colors.t-int}`, NULL faint italic, json teal.
- **Pills** (`{components.pill}`) — the only `{rounded.full}` element; a leading dot in `currentColor`; paid/ok, pending/warn, refunded/err. Bool cells render as true(paid)/false(refunded) pills.
- **Filter** (`{components.filter-input}`) and **ghost buttons** (`{components.ghost-button}`, Add Row / Export) — quiet mono secondary controls.
- **Status bar** (`{components.status-bar}`) — mono 10.5px faint strip: connection state, query ms (coral), row count, encoding, and the security stamps "encrypted store · OS keychain" and "127.0.0.1 only".
- **Focus ring** (`{components.focus-ring}`) — 2px coral outline, offset 1px, on every interactive element (`:focus-visible`).

## Do's and Don'ts

| Do | Don't |
|---|---|
| Set all data (tables, cells, metrics, tree, tabs, labels) in `{typography.mono-stack}` | Use sans for anything that is data — that is the DBeaver drift |
| Spend `{colors.accent}` coral only on the primary action and the active/selected state | Use coral for state, chrome, hover-on-idle, or decoration |
| Color columns by SQL type via the `t-*` system so shape reads before words | Paint the grid a single neutral and hide the type information |
| Keep semantic ok/warn/err strictly for row/query state | Let a semantic color stand in for "active," or the accent stand in for "healthy" |
| Build depth from the four surface tones + borders | Add drop-shadows / Material elevation (reads heavy, anti-DBeaver) |
| Animate only feedback — the latency `pop`, streaming | Animate for delight; honor `prefers-reduced-motion` by killing all motion |
| Reserve `{rounded.full}` for status/bool pills only | Round arbitrary containers into pills |
| Render `tabular-nums` on every numeric column | Let digits jitter in a proportional font |
| Treat this spine as winning over the prototype on any conflict | Copy an incidental mock choice that contradicts a rule here |
