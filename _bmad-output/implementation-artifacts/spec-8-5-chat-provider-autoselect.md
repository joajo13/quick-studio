---
title: 'Chat provider auto-select + shadcn dropdown — stop forcing a manual provider pick and replace the native <select> with the story 8.1 Radix Select'
type: 'feature'
created: '2026-07-16'
status: 'backlog'
context:
  - '{project-root}/src/ui/workspace/ChatTabView.tsx'
  - '{project-root}/src/ui/workspace/chat-model.ts'
  - '{project-root}/src/ui/settings/providers-model.ts'
  - '{project-root}/src/ui/settings/ProvidersPanel.tsx'
  - '{project-root}/src/ui/workspace/workspace-state.ts'
  - '{project-root}/src/ui/App.tsx'
  - '{project-root}/src/shared/contract.ts'
  - '{project-root}/src/core/workspace-store.ts'
  - '{project-root}/design-artifacts/ai-chat-chatgpt.html'
---

<intent-contract>

## Intent

**Problem (two user complaints, Epic 8 refinements):**

1. **The chat forces a manual provider pick every single time.** `ChatTabView` opens with `state.provider === null` (from `emptyChatState`), so the model button reads `select…` and `validateSend` blocks with `pick a provider` until the user manually chooses — every new chat Tab, every relaunch. This is friction the app already has enough signal to remove: it knows which providers are connected (`providers.list`) and can remember the last one used. The user wants the picker to **default-select the last-used provider**, and — when exactly **one** provider is connected — to **auto-select it** so a single-provider setup never asks at all.
2. **The provider picker is a raw native `<select>`.** After the Epic 7 neutral redesign the whole chat is ChatGPT-styled, but the provider control (`ChatTabView.tsx` L710-726) is still a Chrome-default `<select>` restyled with classes — its open list is the OS native dropdown, which breaks the neutral look the header's `.model-btn` (`design-artifacts/ai-chat-chatgpt.html` L393-402, L774-778) established. The user wants a **custom shadcn dropdown** matching the artifact.

**Approach:** A behavior-plus-presentation feature, NOT presentation-only. Two moves:

(a) **Default provider resolution.** Add a pure, DOM-free `resolveDefaultProvider(connected, lastUsed)` selector to `chat-model.ts` implementing the order **persisted last-used (if still connected) → the single connected provider (when exactly one) → the first connected provider (stable `PROVIDER_KINDS` order) → none (no providers connected)**. `ChatTabView` applies it exactly once on the providers-ready transition, only when no provider is yet selected (never overriding an explicit user choice). The last-used provider is remembered across Tabs and across relaunch by riding the EXISTING workspace-snapshot save pipeline as a new OPTIONAL `lastProvider` field — following the `erdLayouts` precedent (an additive optional snapshot field, no `WORKSPACE_SNAPSHOT_VERSION` bump; App-held, seeded on restore, folded into `toWorkspaceSnapshot`). This is a deliberate, SCOPED reversal of the "chat provider choice never touches disk" note (`App.tsx` L312-313): chat MESSAGES and per-Tab chat content still never persist — only the lightweight `lastProvider` default hint does.

(b) **Custom dropdown.** Replace the native `<select aria-label="provider">` with the shadcn/Radix **Select** primitive introduced by **story 8.1** (`src/ui/components/ui/select.tsx`), styled neutral per the artifact's `.model-btn` — the trigger reads `{provider} · schema-only ▾` with a neutral chevron, and the open list is a Radix `SelectContent` (neutral surface, keyboard-operable, monochrome `:focus-visible` ring), NOT the OS native dropdown. The `· schema-only` mode text and the "Provider sees schema only — no rows leave the Core" privacy chip stay as they are today.

The schema-only Provider RPC path and the sandbox seam are UNTOUCHED — this story changes ONLY the selection UX (default + persistence) and the control (native → shadcn). The provider still only ever sees schema shape; no request is sent until the user sends a message, so an auto-defaulted picker leaks nothing.

**Dependency:** This story **DEPENDS ON story 8.1 (shadcn/ui + Radix foundation)**. It CONSUMES the `components/ui` Select primitive 8.1 introduces (`src/ui/components/ui/select.tsx`, a Radix-based `Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`) and MUST NOT land before 8.1. If 8.1 exposes a `Command`-based combobox instead of/as well as `Select`, use the `Select` primitive — a fixed 1–3 item provider list is a select, not a searchable command palette.

## Boundaries & Constraints

**Always:**
- **Resolution order is exactly:** persisted `lastProvider` **iff it is still in the connected list** → else the sole connected provider **when `connected.length === 1`** → else the FIRST connected provider in stable `PROVIDER_KINDS` order → else `null` (no providers connected). Encoded as one pure, total, DOM-free `resolveDefaultProvider(connected, lastUsed)` in `chat-model.ts`, unit-tested.
- **Apply the default exactly once,** on the `providers.list`-ready transition, and ONLY when `state.provider === null`. Never override a provider the user (or a prior default) already set; never re-fire on later renders; never fire before providers are known (a failed/empty list yields no auto-select).
- **Persist the last-used provider through the EXISTING save pipeline.** Add `lastProvider?: ProviderKind` to `WorkspaceSnapshot` (additive, optional, NO version bump — mirrors `erdLayouts`, `contract.ts` L717 / `WORKSPACE_SNAPSHOT_VERSION` L683 stays `1`). App holds `lastProvider`, seeds it on restore (a `restoreLastProvider` accessor, twin of `restoreErdLayouts`), updates it whenever a chat Tab reports a non-null `provider` via `onChatStateChange`, and folds it into `toWorkspaceSnapshot` at every existing call site (debounced effect, sync-on-quit, quit-drain, load baseline). Reuse the debounced `createSaveScheduler` flow verbatim — add no new persistence mechanism.
- **Replace the native `<select>` with the story 8.1 shadcn/Radix `Select`,** styled neutral per `design-artifacts/ai-chat-chatgpt.html`'s `.model-btn`: trigger shows `{provider} · schema-only ▾`; the open list is a Radix `SelectContent` (neutral `--card`/`--border` surface, ink hover, monochrome `:focus-visible` ring). Keep the trigger's accessible name **`provider`** (`aria-label="provider"` on the `SelectTrigger`, replacing the old `<select aria-label="provider">` + `<label>`), so the control stays discoverable by that name.
- **Preserve every load-bearing test string in `ChatTabView.test.tsx` (all via `renderToStaticMarkup` + string assertions):** the substring `schema-only` (L452 — kept via the `· schema-only` mode span, a plain sibling of the Select, NOT inside the Radix trigger), `schema-only · 3 tables`, `ask a question about your schema`, `>run<`, the `reasoning` token gated on reasoning presence, the verbatim generated SQL, and NO `<iframe>` for a plain answer. The provider control's markup is NOT asserted by any test (no `getByRole`/`combobox`/`data-testid`/`querySelector` exists in the suite) — only that the component renders without throwing.
- **Keep the schema-only exposure note next to the control:** the `· schema-only` mode text on the model button AND the privacy chip "Provider sees schema only — no rows leave the Core" (`--ok` green) both stay, unchanged in copy.
- **Preserve the send seam:** `validateSend` (still blocks a null provider / blank message), `canSend`, `setProvider`, the `providers.list` load, `streamChat`, `runRawQuery`/`ConfirmRun`, and the disabled-when-no-providers state all stay behaviorally identical. Auto-select only changes the INITIAL value of `state.provider`, never how a send is validated or issued.
- **Keyboard + a11y:** the shadcn Select is fully keyboard-operable (open/close, arrow-select, type-ahead, Esc) with a discreet monochrome `:focus-visible` ring (never a coral ring, never the harsh white default). Honor `prefers-reduced-motion` for any Radix open/close animation.

**Block If:**
- Story 8.1's `components/ui` Select primitive is NOT yet available (no `src/ui/components/ui/select.tsx`) → HALT `blocked`, condition `depends on story 8.1 shadcn/Radix foundation; Select primitive absent`.
- The 8.1 Select cannot render under `renderToStaticMarkup` WITHOUT a DOM (throws on `document`/`ResizeObserver`/portal access during a closed-trigger SSR render), so `ChatTabView.test.tsx`'s static-structure tests would throw → HALT `blocked`, condition `shadcn Select is not SSR-safe under renderToStaticMarkup`. (Mitigation to attempt first, not a silent workaround: keep the `· schema-only` span + privacy chip as plain siblings so the load-bearing strings never depend on Radix, and confirm the closed `SelectTrigger` renders as a plain button in SSR; only HALT if the primitive still throws.)
- Persisting `lastProvider` cannot be done without EITHER a `WORKSPACE_SNAPSHOT_VERSION` bump (which would discard existing on-disk workspaces) OR persisting chat messages/per-Tab chat content to disk → HALT `blocked`, condition `last-provider persistence cannot stay additive + message-free`.

**Never:**
- Never change the schema-only Provider RPC or the sandbox seam: no edit to `providers.list`/`providers.set`/`providers.remove` params or handling, no new outbound provider call from Ring 2, no API-key handling in the UI, no change to `SandboxFrame.tsx`, and no `POST /chat/stream` change. The picker only selects a `ProviderKind`; the Core stays the sole key holder.
- Never persist chat messages, reasoning, run outcomes, or per-Tab `ChatState` to disk. ONLY the single `lastProvider` default hint is persisted; `chatStates` stays session-only (`App.tsx` L310-314) and a relaunch still starts every chat blank.
- Never bump `WORKSPACE_SNAPSHOT_VERSION`; never make `lastProvider` a required field (an old v1 file with no `lastProvider` must still restore cleanly, exactly like a pre-4.2 file with no `erdLayouts`).
- Never auto-select over an explicit user choice, never re-prompt after the user clears the picker, and never send a request as a side effect of defaulting (defaulting sets `state.provider` only).
- Never reintroduce the OS-native dropdown or a coral accent; never break, weaken, or edit `ChatTabView.test.tsx` (or any existing green test) to pass.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh chat, exactly one connected | `providers.list` → 1 kind, `lastProvider = null`, `state.provider = null` | That provider is auto-selected once providers load; trigger reads `{provider} · schema-only ▾`; `canSend` gated only by input | n/a |
| Fresh chat, persisted last-used still connected | `lastProvider = "openai"`, connected includes `openai`, `state.provider = null` | `openai` is auto-selected (takes precedence over first/single) | n/a |
| Persisted last-used no longer connected | `lastProvider = "openai"`, connected = `["anthropic"]` | Falls through: single connected → `anthropic` auto-selected; a stale `lastProvider` never selects an absent provider | n/a |
| Multiple connected, no valid last-used | connected = `["anthropic","openai"]`, `lastProvider = null`/absent | FIRST connected in stable `PROVIDER_KINDS` order (`anthropic`) auto-selected — a chat never opens unselected when ≥1 provider is connected | n/a |
| No providers connected | `providers.list` → `[]` | No auto-select; trigger shows `none configured`, disabled; the "no providers configured — add one in settings" note renders; `validateSend` still blocks | n/a |
| `providers.list` fails | RPC error envelope | No auto-select; existing "could not load providers: …" `role="alert"` preserved; picker disabled | Error copy unchanged |
| User explicitly picks a provider | user opens the Select, chooses `google` | `setProvider(state, "google")`; App captures `google` into `lastProvider`; a debounced `workspace.save` persists it | n/a |
| User clears the picker | user selects the empty/`select…` option (if offered) | `state.provider = null`; the default is NOT re-applied (fires once, on load only); `validateSend` blocks send until a pick | n/a |
| Reopen the app | on-disk snapshot carries `lastProvider = "google"` | `restoreLastProvider` seeds App `lastProvider`; a newly-opened chat Tab auto-selects `google` (if still connected) | Malformed/unknown `lastProvider` → treated as `null` (no default from it) |
| Second chat Tab in the same session | Tab A last used `anthropic`; user opens Tab B | Tab B auto-selects `anthropic` from the shared App `lastProvider` — no re-pick needed | n/a |
| Open the dropdown | user activates the trigger | Radix `SelectContent` opens as a neutral custom list (NOT OS-native), keyboard-navigable, monochrome focus ring, `prefers-reduced-motion` honored | n/a |
| SSR / `renderToStaticMarkup` (tests) | component rendered to a static string | Renders without throwing; `schema-only`, the empty prompt, and all load-bearing strings present as before | Must not access a live DOM during closed-trigger render |
| Old v1 snapshot without `lastProvider` | pre-8.5 on-disk file | Restores cleanly; App `lastProvider = null`; resolution falls back to single/first-connected | n/a |

</intent-contract>

## Code Map

- `src/ui/components/ui/select.tsx` (from **story 8.1** — CONSUMED, not created here) — the shadcn/Radix `Select` primitive family (`Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`). This story imports it; if it is absent, HALT per Block-If. If 8.1 also ships a `Command` combobox, still use `Select` for the fixed 1–3 provider list.
- `src/ui/workspace/chat-model.ts` (~175 lines) — ADD ONE pure, total, DOM-free exported selector `resolveDefaultProvider(connected: ReadonlyArray<ProviderKind>, lastUsed: ProviderKind | null): ProviderKind | null` implementing the resolution order (last-used-if-connected → sole-connected → first-connected → null). Do NOT touch `ChatMessage`/`ChatState` (L32-47), `validateSend`/`setProvider`/`appendUserMessage`/`appendAnswer` reducers, `deriveResultKpis`, or `accumulateStream`. The provider selection value continues to live on `ChatState.provider` (session-only) — this selector only computes an INITIAL value.
- `src/ui/workspace/ChatTabView.tsx` (~957 lines) — the primary UX change:
  - Header provider control (L706-728): DELETE the native `<label htmlFor="chat-provider">` + `<select id="chat-provider" aria-label="provider">` and its `<option>`s; render the story-8.1 `Select` in its place. `value={state.provider ?? ""}`, `onValueChange` → `onStateChange(setProvider(state, kind))`, `disabled={!hasProviders}`. The `SelectTrigger` reproduces `.model-btn` — `{state.provider ?? (hasProviders ? "select…" : "none configured")}` + a neutral chevron — and carries `aria-label="provider"`. Keep the `· schema-only` mode `<span>` (L727) and the privacy chip (L729-740) as PLAIN SIBLINGS of the Select (so the `schema-only` test string never depends on Radix rendering).
  - Auto-select effect (NEW): after the existing `providers.list` load (L567-583) resolves, if `providersReady && state.provider === null`, compute `resolveDefaultProvider(configured, lastProvider)` and, when non-null, `onStateChange(setProvider(state, resolved))`. Fire EXACTLY ONCE on the ready transition (guard on `state.provider === null` + a `didAutoSelectRef`), never overriding a set/cleared provider. `configured` (L517) already IS the connected list in stable `PROVIDER_KINDS` order (L574).
  - NEW prop `lastProvider: ProviderKind | null` on `ChatTabView({ state, onStateChange, lastProvider })` (L504-511), threaded from App (see below).
  - Everything else (streaming, run/confirm/cancel, KPI strip, sandbox, composer) is UNCHANGED.
- `src/ui/settings/providers-model.ts` / `src/ui/settings/ProvidersPanel.tsx` — REFERENCE ONLY, no change. These establish what "connected/configured" MEANS: a provider is connected iff it appears in the `providers.list` result as a `ProviderSummary` (it has a Core-stored key; `summaryFor` returns a summary → `configured = summary !== undefined`). `ChatTabView` uses the same signal (`configured` = `PROVIDER_KINDS` filtered to the kinds present in `providers.list`). There is NO separate health/"connected" ping — "connected" == "configured" == "present in providers.list".
- `src/shared/contract.ts` (~720+ lines) — ADD the optional field `lastProvider?: ProviderKind` to the `WorkspaceSnapshot` type (L717). Additive + optional; `WORKSPACE_SNAPSHOT_VERSION` (L683) STAYS `1` (mirrors the `erdLayouts` note at L714-716 — adding an optional field needs no bump). `ProviderKind` (L416) is already in this file. No RPC/param type changes.
- `src/ui/workspace/workspace-state.ts` (267 lines) — thread `lastProvider` through the snapshot bridge, mirroring `erdLayouts`:
  - `toWorkspaceSnapshot(state, panelSizes, erdLayouts?, lastProvider?)` (L252-266): carry `lastProvider` onto the returned snapshot ONLY when it is a non-null `ProviderKind` (so a workspace with none serializes byte-identically to today's snapshot — preserve the untouched-workspace no-resave invariant).
  - ADD `restoreLastProvider(snapshot): ProviderKind | null` (twin of `restoreErdLayouts`, L238-243): return `snapshot.lastProvider` when it is a member of `PROVIDER_KINDS`, else `null` (defensive against a hand-edited/unknown value). `restoreWorkspace` (L197-211) is UNCHANGED (it maps only tab lifecycle fields).
- `src/ui/App.tsx` (~600 lines) — hold and thread the last-provider value through the EXISTING save machinery:
  - NEW state `const [lastProvider, setLastProvider] = useState<ProviderKind | null>(null)`, seeded on restore from `restoreLastProvider(snapshot)` in the `workspace.load` effect (beside `restoreErdLayouts`, L426/L434) and folded into the load baseline `lastPersistedRef` (L436).
  - `onChatStateChange(tabId, next)` (L315-316): additionally `if (next.provider !== null) setLastProvider(next.provider)` — capture the last-used provider whenever any chat Tab picks one.
  - Fold `lastProvider` into `toWorkspaceSnapshot(workspace, panelSizes, erdLayouts, lastProvider)` at ALL FOUR call sites (debounced effect L456, sync-on-quit L477, quit-drain L507/L519, load baseline L436) and add `lastProvider` to those effects' dependency arrays (L466, L487) so a provider change schedules a debounced save. Reuse `createSaveScheduler` verbatim.
  - Pass `lastProvider` down toward the chat Tab (see threading below). `chatStates` stays session-only — `lastProvider` is the ONLY new thing that rides into the snapshot.
- `src/ui/workspace/Workspace.tsx` — thread the new `lastProvider` prop from App to `TabContent` alongside `chatStates`/`onChatStateChange` (L201-202/L237-239, forwarded near L361).
- `src/ui/workspace/TabContent.tsx` — accept `lastProvider` and pass it to `<ChatTabView>` (rendered at L527-530, beside `chatState`/`onChatStateChange`).
- `src/core/workspace-store.ts` — OPTIONAL defensive check (recommended, not required for the feature to function): in `isWorkspaceSnapshot` (L153-172), add — beside the `erdLayouts` optional check (L168-170) — `if (v.lastProvider !== undefined && !PROVIDER_KINDS.includes(v.lastProvider as ProviderKind)) return false;` (import `PROVIDER_KINDS`). NOTE: the validator today ignores unknown fields, so a written `lastProvider` already round-trips WITHOUT this edit; the check only rejects a hand-edited garbage value at the disk boundary. The UI-side `restoreLastProvider` is already defensive, so this Core edit is belt-and-suspenders. Prefer the field-drop posture (UI treats an unknown value as `null`) so a single bad field never discards a whole good workspace.
- `src/ui/workspace/chat-model.test.ts` — ADD unit tests for `resolveDefaultProvider`: single-connected auto-select, last-used precedence, stale last-used (not connected) fall-through, multi-connected first-pick, empty-connected → null. Additive only.
- `src/ui/workspace/workspace-state.test.ts` — ADD tests for the `lastProvider` round-trip: `toWorkspaceSnapshot` carries it only when set (absent when null — no-resave invariant), `restoreLastProvider` returns a known kind and drops an unknown/absent one. Additive only.
- `src/ui/workspace/ChatTabView.test.tsx` (~520 lines) — MUST stay green. The suite uses only `renderToStaticMarkup` + string assertions (no `getByRole`/`combobox`/`data-testid`), so it does not assert the provider control's markup; it needs a new `lastProvider` prop value only if a test constructs `<ChatTabView>` directly (pass `lastProvider={null}` — additive, no assertion churn). Do NOT edit existing assertions.

## Acceptance Criteria

- **Given** a fresh chat Tab with exactly ONE connected provider, **when** it mounts and `providers.list` resolves, **then** that provider is auto-selected (the model button shows `{provider} · schema-only ▾`, not `select…`) and the user can send without a manual pick.
- **Given** a persisted last-used provider that is still connected, **when** a chat Tab opens, **then** it is default-selected in preference to the single/first fallback; **given** the persisted value is no longer connected, **then** resolution falls through to the single/first connected provider (never selecting an absent one).
- **Given** the picker, **when** it is inspected/opened, **then** it is a custom shadcn/Radix dropdown (from story 8.1) styled neutral per `design-artifacts/ai-chat-chatgpt.html` — NOT a native `<select>`/OS dropdown — keyboard-operable with a monochrome focus ring, and the `· schema-only` mode text + "Provider sees schema only — no rows leave the Core" privacy chip remain beside it.
- **Given** the user changes the provider, **when** the change settles, **then** it is captured as `lastProvider` and persisted through the existing debounced `workspace.save`; **when** the app is reopened, **then** a new chat Tab auto-selects that provider (verify live at http://127.0.0.1:6061).
- **Given** the schema-only path, **when** anything above runs, **then** Ring 2 still holds no key and makes no outbound provider call, the sandbox seam is untouched, and no request is sent as a side effect of defaulting (defaulting only sets `state.provider`).
- **Given** `bun test`, **when** it runs, **then** `ChatTabView.test.tsx` passes UNEDITED (all load-bearing strings present/absent as asserted) and the new additive `resolveDefaultProvider` + `lastProvider` round-trip tests pass; **given** an old v1 snapshot with no `lastProvider`, **then** it still restores cleanly.
- **Given** `bunx tsc --noEmit`, **when** it runs, **then** there are no type errors (the `WorkspaceSnapshot.lastProvider` addition, the `toWorkspaceSnapshot`/`restoreLastProvider` threading, and the new selector all type-check).

## Design Notes

**"Connected" == "configured" == present in `providers.list`.** There is no separate connectivity/health probe. `ProvidersPanel` treats a provider as configured when `summaryFor(state, kind)` finds a `ProviderSummary` in the `providers.list` reply (it has a Core-stored key). `ChatTabView` uses the identical signal: `configured = PROVIDER_KINDS.filter(k => listedKinds.includes(k))`. So "one connected provider" means the `providers.list` result has exactly one entry. `resolveDefaultProvider` takes that already-computed connected list — it never re-queries Core.

**Why the workspace snapshot, not `localStorage`.** The codebase deliberately keeps ALL persistence in Core via `workspace.save` — the UI ring never touches `localStorage` (Workspace.tsx L12: "never touches `workspace.save`/`localStorage` itself"; workspace-state.ts: "Persistence lives ONLY in Core"). There are zero `localStorage` writes in `src/ui`. So the convention-honoring home for a persisted default is the snapshot, following the `erdLayouts` precedent (an additive optional field threaded through App's existing debounced/quit save pipeline, no version bump). A `localStorage`-backed pref is explicitly REJECTED — it would break the "no `localStorage` in the UI ring" convention and would be per-browser rather than per-workspace.

**Scoped reversal of "chat provider choice never touches disk."** `App.tsx` L312-313 says chat provider choice never persists. This story narrows that: chat MESSAGES, reasoning, run outcomes, and per-Tab `ChatState` STILL never persist (`chatStates` stays session-only) — only a single lightweight `lastProvider` default HINT is written. That hint is a UX seed for the picker, not chat content, and carries no key and no row data.

**"First connected" as the final fallback (vs "none").** The task allows "else first/none". This spec chooses FIRST connected (stable `PROVIDER_KINDS` order) so a chat NEVER opens unselected when ≥1 provider is connected — the strongest answer to complaint #10 ("should NOT force manual provider selection every time"). This is safe: the schema-only policy means an auto-selected provider sees nothing until the user sends, and the selected provider is always visible on the model button before any send. If a future story prefers a conservative "leave unselected + subtle prompt" for the multi-provider-no-memory case, only `resolveDefaultProvider`'s last branch changes.

**Load-bearing `schema-only` string stays Radix-independent.** `ChatTabView.test.tsx:452` asserts `html.toContain("schema-only")` via `renderToStaticMarkup`. Keep the `· schema-only` mode text and the privacy chip as PLAIN sibling `<span>`s of the Select (as today), NOT inside the Radix `SelectTrigger`/`SelectValue`. That way the test string never depends on whether the Radix primitive renders content in SSR — and the closed-trigger Select need only render a plain button. If 8.1's Select still throws under `renderToStaticMarkup`, that is a Block-If (SSR-safety belongs to the 8.1 primitive), not a reason to weaken the test.

**Fire-once auto-select.** The default is applied only on the `providers.list`-ready transition and only when `state.provider === null`, guarded by a ref so a later re-render (or a user clearing the picker) never re-triggers it. This preserves the user's agency: an explicit choice or an explicit clear is never overridden.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors across `ChatTabView.tsx`, `chat-model.ts`, `workspace-state.ts`, `App.tsx`, `contract.ts`, `workspace-store.ts`, and the touched tests.
- `bun test` — expected: all suites pass; `ChatTabView.test.tsx` UNEDITED and green (static-structure strings intact); new additive `resolveDefaultProvider` tests (`chat-model.test.ts`) and `lastProvider` round-trip tests (`workspace-state.test.ts`) pass; `workspace-store`/`workspace-registry` stay green (old v1 snapshot without `lastProvider` still validates/restores).
- `rg 'coral.*#|bg-\[#' src/ui/workspace/ChatTabView.tsx src/ui/components/ui/select.tsx` — expected: no coral/hardcoded-palette accents introduced by the new control.

**Manual checks (live app at http://127.0.0.1:6061):**
- Configure exactly one provider in Settings, open a fresh chat Tab → it is auto-selected (model button shows `{provider} · schema-only ▾`), and the picker is a CUSTOM neutral dropdown, not a native `<select>` (open it: the list is a styled Radix panel, keyboard-navigable, with a monochrome focus ring).
- Configure a second provider, pick it in the chat, reload/relaunch the app, open a new chat Tab → it auto-selects the last-used provider (persisted via `workspace.save`).
- Remove all providers → the picker shows `none configured`, is disabled, and no auto-select occurs; the "no providers configured" note renders.
- Toggle light/dark → the dropdown and trigger stay neutral and legible in both themes.
