---
title: 'shadcn/ui + Radix foundation — introduce the component primitives (cn, base ui/) styled with the existing neutral tokens, no surface restyled'
type: 'feature'
created: '2026-07-16'
status: 'backlog'
context:
  - '{project-root}/package.json'
  - '{project-root}/tsconfig.json'
  - '{project-root}/scripts/build-ui.ts'
  - '{project-root}/src/ui/main.tsx'
  - '{project-root}/src/ui/styles/globals.css'
  - '{project-root}/src/ui/settings/ProvidersPanel.tsx'
  - '{project-root}/src/ui/workspace/ChatTabView.tsx'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<intent-contract>

## Intent

**Problem:** The user wants "dropdowns custom de shadcn" across the app — first in the chat provider picker (Story 8.5) and the settings surface (Story 8.6). But the project only ever adopted shadcn's **token layer** (the `globals.css` custom properties + `@theme inline` map): there is NO shadcn/ui component library, NO `@radix-ui/*` primitives, NO `cmdk`, and none of the `cn()` toolchain (`class-variance-authority` / `clsx` / `tailwind-merge`). Every current dropdown is a native `<select>` (the provider picker `#chat-provider` in `ChatTabView.tsx`, the type/schema pickers in `CreateTablePanel.tsx`, the mark/x/y/series/target pickers in `ReportTabView.tsx`). There is nothing for the consumer stories to build on. This story stands up that foundation — and nothing else. It is infrastructure only; it MUST NOT restyle or change the behavior of any existing surface.

**Approach:** Add the shadcn/ui foundation **manually** (the shadcn CLI cannot run cleanly here — see the Boundaries gotcha) and wire it into this project's Bun + React 19 + Tailwind v4 reality:
1. Add the runtime deps the consumer stories need: the `@radix-ui/react-*` primitives (`react-slot`, `react-select`, `react-popover`, `react-dialog`, `react-dropdown-menu`), `cmdk` (Command/combobox for the provider picker), and the class toolchain (`class-variance-authority`, `clsx`, `tailwind-merge`).
2. Add `src/ui/lib/utils.ts` exporting `cn()` = `twMerge(clsx(inputs))`.
3. Add `src/ui/components/ui/` base components — at minimum `button`, `select`, `popover`, `command`, `dialog` (plus `dropdown-menu` for Story 8.6) — authored in the shadcn structure but **re-pointed onto this project's EXISTING tokens**: near-black surfaces `--card`/`--muted`/`--accent`, `--border`, the ink accent `--coral`/`--coral-soft`/`--coral-ink`, destructive `--err`/`--err-soft`/`--err-line`, focus `--focus-ring`/`--coral`. NO new color tokens; neutral look consistent with Epic 7.

The default shadcn component source assumes token names this project does not have (`--popover`, `--input`, `--ring`, `--secondary`, `--destructive`) — those references are rewritten onto the present tokens (see the token-remap table in the Code Map). The components can ship **unused** (or wired into a single throwaway demo that is reverted before commit); they only have to typecheck, build, and render neutral in isolation. Every existing surface, test, and the `bun run build` output stay untouched and green.

## Boundaries & Constraints

**Always:**
- Foundation only. This story ADDS `src/ui/lib/utils.ts` and `src/ui/components/ui/*` and the deps in `package.json`. It does not edit, import into, or re-render any existing surface — `ChatTabView.tsx`, `ProvidersPanel.tsx`, `SettingsPanel.tsx`, `CreateTablePanel.tsx`, `ReportTabView.tsx`, `DataGrid.tsx`, `App.tsx`, `Workspace.tsx` are read-only references, not edit targets. The native `<select>`s stay exactly as they are — replacing them is Stories 8.5 / 8.6.
- Author every base component against the tokens that ALREADY exist in `globals.css`. Surfaces (popover/dialog/select/command panels) use `bg-card` / `text-card-foreground`; hover/active use `bg-accent` / `bg-muted`; the default/primary button uses the **ink** accent `bg-coral text-coral-ink` (NOT the blue `--primary`); destructive uses `text-err` / `bg-err-soft` / `border-err-line`; borders use `border-border`; focus uses `focus-visible:ring-2 focus-visible:ring-coral` (and the global `:focus-visible` ink outline already applies). All of these resolve today through the `@theme inline` block.
- Keep the neutral Epic-7 discipline: color survives only where functional (destructive red = `--err`). No coral/orange hex, no new hue, no decorative accent. The primitives read near-black + ink.
- Respect this repo's module rules: relative imports with **explicit** `.ts`/`.tsx` extensions (`allowImportingTsExtensions` is on and there is NO `@/*` path alias), and `import type` / `export type` for type-only symbols (`verbatimModuleSyntax` + `isolatedModules` are on). The canonical shadcn `import { cn } from "@/lib/utils"` will NOT compile — use `import { cn } from "../../lib/utils.ts"`.
- Follow the codebase icon convention: inline SVG paths (as the existing `Icon` helper does) for chevrons/checks/close glyphs. Do NOT add `lucide-react` or `@radix-ui/react-icons` — no icon dependency.
- Keep every existing test green and `bunx tsc --noEmit`, `bun test`, and `bun run build` all passing. The generated `src/core/ui-bundle.generated.ts` and the served app are unchanged (the new, unimported components are tree-shaken out of the bundle but still typechecked by `tsc` since `include: ["src","bin"]`).

**Block If:**
- A required primitive dependency has no release whose `peerDependencies` accept React 19 (`react`/`react-dom` `^19`) — HALT `blocked`, condition `radix/cmdk peer versions incompatible with React 19`. (Expectation: current `@radix-ui/*` and `cmdk` list `^16.8 || ^17 || ^18 || ^19` and install cleanly; verify the resolved versions before wiring.)
- Rendering the base components neutral is impossible without introducing a new color/surface token (i.e. an existing token genuinely cannot cover a required element) — HALT `blocked`, condition `foundation needs a new token`. (Expectation: it does not — the present token set covers every element; this story adds NO token.)

**Never:**
- Never restyle, re-mount, or change the behavior/markup of any existing surface or its `<select>`s; never touch `globals.css` tokens, `scripts/build-ui.ts`, `src/ui/main.tsx`, or any `src/core/**` / `src/shared/**` file. (`main.tsx` may be touched ONLY inside a throwaway live-render demo that is reverted before commit — the committed tree imports the new components nowhere shipping.)
- Never add a new color token, coral/orange hex, or the blue `--primary` as a component's default accent; never invent `--popover`/`--input`/`--ring`/`--secondary`/`--destructive` — remap those shadcn defaults onto the existing tokens instead.
- Never depend on `tailwindcss-animate` / the `animate-in`/`data-[state=*]:animate-*` utilities (they don't resolve under Tailwind v4's `@theme` without an extra plugin) — author the primitives static; Radix functions without enter/exit motion, and `prefers-reduced-motion` is already honored. (If motion is wanted later, add `tw-animate-css` via `@import` — out of scope here.)
- Never add a `tailwind.config.js`, a `components.json`, or run the shadcn CLI against this repo; never weaken or rewrite an existing test to accommodate the new files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deps added | `package.json` + lockfile | `@radix-ui/react-{slot,select,popover,dialog,dropdown-menu}`, `cmdk`, `class-variance-authority`, `clsx`, `tailwind-merge` present as direct `dependencies`; resolved versions accept React 19 | if any peer rejects React 19 → HALT `blocked` |
| `cn()` helper | `cn("a", cond && "b", undefined)` | returns a merged, conflict-resolved class string (`twMerge(clsx(...))`); falsy inputs dropped; later Tailwind class wins on conflict | pure, never throws |
| Button variants | `<Button variant?=… size?=…>` | `default` = `bg-coral text-coral-ink`; `outline` = `border-border bg-transparent hover:bg-accent`; `ghost` = `hover:bg-accent`; `destructive` = `bg-err text-… / err-soft` ink-neutral; sizes map to padding/height; `asChild` composes via `@radix-ui/react-slot` | n/a |
| Select primitive | Radix `Select` open | trigger + `bg-card` content panel with `border-border`, ink-highlighted `SelectItem` (`focus:bg-accent`), inline SVG chevron/check; keyboard + `aria-*` from Radix intact | n/a |
| Popover primitive | Radix `Popover` open | `bg-card` `border-border` rounded panel, no animation utilities; portal + focus management from Radix | n/a |
| Command / combobox | `cmdk` `Command` + `CommandInput` | mono neutral list: input row, `CommandEmpty`, `CommandGroup`, `CommandItem` with `focus/aria-selected:bg-accent`; usable inside `Popover` (Story 8.5's provider picker) and as `CommandDialog` (via Dialog) | n/a |
| Dialog primitive | Radix `Dialog` open | `bg-card` content over a neutral overlay scrim, `border-border`, inline SVG close button with an `aria-label`; Radix focus-trap/escape intact | n/a |
| Token remap | component references a shadcn default token | remapped to an existing token (popover→`card`, input→`border`, ring→`coral`, secondary→`muted`/`accent`, destructive→`err`); no missing utility, no new token | if an element truly needs an absent token → HALT `blocked` |
| Unused in bundle | components imported nowhere shipping | `bunx tsc --noEmit` still typechecks them (include=`src`); `bun run build` succeeds; they are tree-shaken from `ui-bundle.generated.ts` (bundle bytes ~unchanged) | build must not fail on resolution |
| Existing surfaces | full app | `ChatTabView`/`ProvidersPanel`/`CreateTablePanel`/`ReportTabView`/grid/shell render byte-identical; all native `<select>`s unchanged | no regression |
| Live isolation render | temporary demo mount at `http://127.0.0.1:6061` | Button/Select/Popover/Command/Dialog render neutral (near-black + ink), light/dark both read correctly, no coral | demo reverted before commit — no surface ships |
| Full suite | `tsc` / `bun test` / `bun run build` | all clean/green; existing test count unchanged (no new deps break resolution) | n/a |

</intent-contract>

## Code Map

- `package.json` -- add to `dependencies` (runtime, not dev): `@radix-ui/react-slot` (Button `asChild`), `@radix-ui/react-select` (Select), `@radix-ui/react-popover` (Popover), `@radix-ui/react-dialog` (Dialog + Command's dialog variant), `@radix-ui/react-dropdown-menu` (menus for Story 8.6), `cmdk` (Command/combobox for Story 8.5's provider picker), `class-variance-authority` (Button `cva` variants), `clsx`, `tailwind-merge` (the `cn()` pair). NOTE `clsx` is currently only a TRANSITIVE dep (via `recharts`) — promote it to a direct dep. Pick versions whose `peerDependencies` accept `react`/`react-dom` `^19` (verify against the resolved lockfile). Do NOT add `tailwindcss-animate`, `lucide-react`, `@radix-ui/react-icons`, `components.json`, or `tailwind.config.js`.
- `src/ui/lib/utils.ts` (NEW) -- export `cn(...inputs: ClassValue[]): string` = `twMerge(clsx(inputs))`. `import { clsx, type ClassValue } from "clsx"; import { twMerge } from "tailwind-merge";`. This is the single class-composition helper every base component imports as `import { cn } from "../../lib/utils.ts"` (relative + `.ts`, no `@/` alias).
- `src/ui/components/ui/button.tsx` (NEW) -- `Button` + `buttonVariants` (via `cva`). Variants remapped to the neutral tokens: `default` → `bg-coral text-coral-ink hover:opacity-90` (ink accent, NOT `--primary`); `outline` → `border border-border bg-transparent hover:bg-accent hover:text-accent-foreground`; `ghost` → `hover:bg-accent`; `destructive` → `bg-err-soft text-err border border-err-line hover:bg-err/10` (functional red only); `secondary` → `bg-muted text-foreground hover:bg-accent`. Sizes `sm|default|lg|icon`. `asChild` via `@radix-ui/react-slot`. Focus: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral`. `disabled:pointer-events-none disabled:opacity-50`.
- `src/ui/components/ui/select.tsx` (NEW) -- thin wrappers over `@radix-ui/react-select`: `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger` (`border-border bg-transparent` + inline chevron SVG), `SelectContent` (`bg-card text-card-foreground border-border` portal panel, NO `animate-*`), `SelectLabel`, `SelectItem` (`focus:bg-accent focus:text-accent-foreground` + inline check SVG for the selected indicator), `SelectSeparator`. All Radix `aria-*` / keyboard behavior passes through untouched. This is what Story 8.6 (and optionally 8.5) consumes.
- `src/ui/components/ui/popover.tsx` (NEW) -- wrappers over `@radix-ui/react-popover`: `Popover`, `PopoverTrigger`, `PopoverContent` (`bg-card text-card-foreground border-border` rounded panel, `z`-layered, `align`/`sideOffset` props forwarded, NO `animate-*`), `PopoverAnchor`. Story 8.5 mounts a `Command` inside this for the provider combobox.
- `src/ui/components/ui/command.tsx` (NEW) -- wrappers over `cmdk`: `Command` (`bg-card text-card-foreground`), `CommandInput` (mono, borderless, inline search SVG), `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem` (`aria-selected:bg-accent aria-selected:text-accent-foreground`), `CommandSeparator`, and `CommandDialog` (composes `command` inside `dialog`). This is the combobox Story 8.5 uses to replace the native `#chat-provider` `<select>`.
- `src/ui/components/ui/dialog.tsx` (NEW) -- wrappers over `@radix-ui/react-dialog`: `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose`, `DialogOverlay` (neutral scrim, e.g. `bg-black/60`), `DialogContent` (`bg-card text-card-foreground border-border` + an inline-SVG close button carrying `aria-label` and an `sr-only` label), `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`. NO `animate-*` utilities.
- `src/ui/components/ui/dropdown-menu.tsx` (NEW, for Story 8.6) -- wrappers over `@radix-ui/react-dropdown-menu` (`DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent` = `bg-card border-border`, `DropdownMenuItem` = `focus:bg-accent`, `…CheckboxItem`/`…RadioItem`/`…Label`/`…Separator` with inline-SVG indicators). Include if Story 8.6's settings menus need it; otherwise defer to 8.6 — the button/select/popover/command/dialog five are the mandatory minimum.
- `src/ui/styles/globals.css` -- VERIFY-ONLY, do NOT edit. Confirm the tokens the components consume already resolve as utilities via `@theme inline`: `bg-background`/`text-foreground`, `bg-card`/`text-card-foreground`, `bg-muted`/`text-muted-foreground`, `bg-accent`/`text-accent-foreground`, `border-border`, `bg-coral`/`text-coral`/`text-coral-ink`/`bg-coral-soft`/`ring-coral`, and `text-err`/`bg-err`/`bg-err-soft`/`border-err-line`. All are present. The absent shadcn defaults (`--popover`, `--input`, `--ring`, `--secondary`, `--destructive`) are intentionally NOT added — remap in the components (popover→`card`, input→`border`, ring→`coral`, secondary→`muted`/`accent`, destructive→`err`). Add NO token.
- `scripts/build-ui.ts` -- VERIFY-ONLY, do NOT edit. `Bun.build` over `src/ui/main.tsx` with `bun-plugin-tailwind`; it emits only reachable modules, so unimported base components are tree-shaken (bundle bytes ~unchanged) — expected and correct for a foundation-only story. The build must still succeed with the new deps resolvable.
- `src/ui/main.tsx` -- VERIFY-ONLY under normal flow. May be touched ONLY for the optional throwaway live-render demo (import + mount one primitive), which MUST be reverted before commit so the committed entry imports no `components/ui/*`.
- `tsconfig.json` -- VERIFY-ONLY. Constrains authoring: `include: ["src","bin"]` (so the new files ARE typechecked even while unimported), `jsx: "react-jsx"`, `moduleResolution: "bundler"`, `allowImportingTsExtensions` + `verbatimModuleSyntax` + `isolatedModules` + `noUncheckedIndexedAccess` + `strict` all on, and NO `paths` alias. Author accordingly (explicit `.ts`/`.tsx` extensions, `import type`, no `@/`).
- `src/ui/workspace/ChatTabView.tsx` -- REFERENCE ONLY (future consumer, Story 8.5). The native provider picker is the `<select id="chat-provider" aria-label="provider">` at ~lines 710–726; its `value`/`onChange`/`disabled`/`aria-label` contract is what the `Command`+`Popover` combobox must later preserve. Do NOT edit in this story.
- `src/ui/settings/ProvidersPanel.tsx` -- REFERENCE ONLY (future consumer context, Story 8.6). Establishes the settings voice (mono, lowercase, `text-err` banners, `bg-card`/`border-border` cards) the new components should read consistently with. Do NOT edit in this story.

## Acceptance Criteria

- Given the foundation is added, when `package.json` is inspected, then `@radix-ui/react-slot`, `@radix-ui/react-select`, `@radix-ui/react-popover`, `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `cmdk`, `class-variance-authority`, `clsx`, and `tailwind-merge` are direct `dependencies`, and the resolved versions install cleanly with `react`/`react-dom` `^19` (no peer-dependency error).
- Given `src/ui/lib/utils.ts`, when `cn()` is called, then it returns `twMerge(clsx(inputs))` — falsy inputs dropped, conflicting Tailwind classes resolved to the last — and is imported by the base components via a relative `.ts` path (not `@/lib/utils`).
- Given `src/ui/components/ui/`, when the base components are read, then `button`, `select`, `popover`, `command`, and `dialog` exist (plus `dropdown-menu` if Story 8.6 needs it), authored in the shadcn structure but consuming ONLY existing tokens — surfaces `bg-card`/`border-border`, hover `bg-accent`/`bg-muted`, the default button `bg-coral text-coral-ink`, destructive `text-err`/`bg-err-soft`/`border-err-line`, focus `ring-coral` — with no new token, no coral/orange hex, no blue `--primary` accent, no `animate-*`/`tailwindcss-animate` utility, and no icon-library import (inline SVGs only).
- Given this story is infrastructure-only, when the existing surfaces are exercised, then every one — including all native `<select>`s (`#chat-provider`, the create-table type/schema pickers, the report pickers) — renders and behaves exactly as before, and the generated `ui-bundle.generated.ts` / served app are unchanged.
- Given the full toolchain, when run, then `bunx tsc --noEmit` is clean (it typechecks the new `lib/utils.ts` + `components/ui/*` because `include` covers `src`), `bun test` stays green with no test added, weakened, or rewritten, and `bun run build` succeeds and the app still serves at `http://127.0.0.1:6061`.
- Given a temporary isolation demo (reverted before commit), when a Button/Select/Popover/Command/Dialog is mounted and viewed at `http://127.0.0.1:6061`, then each renders neutral (near-black surfaces + ink accent) and reads correctly in both dark and the explicit `data-theme="light"` mode — with no coral anywhere — and the committed tree imports these components from no shipping surface.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors; the new `src/ui/lib/utils.ts` and every `src/ui/components/ui/*.tsx` typecheck under `strict` + `verbatimModuleSyntax` + `noUncheckedIndexedAccess` (relative `.ts`/`.tsx` imports, `import type` for type-only symbols, no `@/` alias).
- `bun test` -- expected: the full existing suite stays green with an unchanged test count; no suite is edited (this story adds no test and touches no tested module).
- `bun run build` -- expected: `bun scripts/build-ui.ts` (+ the sandbox/snapshot/live-report builds) succeed with the new deps resolvable; `src/core/ui-bundle.generated.ts` regenerates and the served bundle is effectively unchanged (the unimported base components are tree-shaken out).

**Manual checks (if a browser is available):**
- Verify the resolved dependency versions accept React 19 (inspect the lockfile / `bun pm ls`); confirm no peer-dependency warning names `react@19` as unsatisfied.
- Temporarily import one of each primitive (`Button`, `Select`, `Popover` hosting a `Command`, and a `Dialog`) into a throwaway mount reachable from `main.tsx`, run `bun run dev`, open `http://127.0.0.1:6061`, and confirm: each renders on near-black surfaces with the ink accent and `border-border` outlines, the Select/Command lists highlight with `bg-accent`, the Dialog scrim + inline-SVG close button work, Radix keyboard/focus behavior is intact, and there is no coral. Toggle `document.documentElement.dataset.theme = "light"` and confirm the primitives flip to the light neutral values. Then REVERT the demo so the committed tree imports no `components/ui/*` from any shipping surface.
