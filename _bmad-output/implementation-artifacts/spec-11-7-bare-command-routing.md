---
title: 'Bare-command routing — boot the persistent workspace or route to connection onboarding'
type: 'feature'
created: '2026-07-21'
status: 'done'
baseline_revision: '62caa84ccba655ae7e6d8e124f9f65a7418ad5cf'
final_revision: '1b210b7a5f4be54803d7ef5048517a99068c7509'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.7
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** A bare `quick-studio` resolves to Persistent mode (`run-mode.ts:35-38`, default `persistent`) and boots a workspace regardless of whether any connection has ever been saved. For a returning user that is exactly right. For someone who just installed the tool — the entire audience this epic is built for — it opens a browser onto an empty schema tree with no indication that the next step is to add a connection, or that passing a database URL would have started an Ephemeral session immediately. Nothing on the CLI side distinguishes "I have a configured workspace" from "I have nothing at all", and the stderr output on a first run is identical to the output on the thousandth: one listening-URL line. The epic's flow #2 asks for that distinction to be made and acted on.

**Approach:** Add a cheap, read-only presence check and use it for **routing and messaging only**, not for changing what boots.
- Reuse the `store-presence.ts` probe introduced in Story 11.6 — a filesystem presence check over the app-data directory that never decrypts anything.
- When config is present: behavior is byte-for-byte what it is today.
- When it is absent: still boot Persistent (so the user lands somewhere useful), but print a terse stderr hint naming both ways forward, and have the UI open on connection onboarding rather than an empty tree.
- The database URL is asked for **in the UI**, which already owns the connection form from Story 2.4 (`src/ui/settings/SettingsPanel.tsx`, `connections-model.ts`). A terminal prompt for a URL was considered and rejected: it would duplicate a form that already exists, in a worse medium, for a value that frequently contains a password.

## Boundaries & Constraints

**Always:**
- The presence check is a **presence check only** — `existsSync`-class stats on the store descriptor and `.enc`. It must **never** attempt to decrypt, load a key, acquire the store lock, or open the store. Decryption may require the very passphrase prompt that Story 11.6 gates on knowing whether a store exists; making that circular would deadlock the design.
- A store that exists but holds **zero** connections is the **UI's** empty state, not the CLI's business. The CLI's signal is coarse by design: "has this machine ever been set up?"
- When config is present, the boot path is **unchanged** — no new prompt, no new stderr line, no measurable delay.
- The first-run hint is one terse stderr block naming both paths: add a connection in the UI (with the URL already printed above it), or re-run with a database URL for a throwaway Ephemeral session. It is a hint, never an error, and the exit code is unaffected.
- Ephemeral mode (URL positional, `--ephemeral`, or `QS_MODE=ephemeral`) is entirely unaffected — it never consults the probe and never touches the app-data directory.

**Block If:**
- If Story 11.6 has not landed `store-presence.ts`, implement it here to the same contract (no decryption) and update 11.6's Code Map — but do **not** create a second, divergent presence check. One classifier, one source of truth.
- If routing the UI to onboarding requires a new RPC or a change to the token/gate surface, STOP and reconsider: the intended mechanism is an existing boot-state signal the UI already receives, or an additive, credential-free field on one. The RPC contract and auth gates are epic-level invariants.

**Never:**
- Never prompt for a database URL in the terminal. The UI owns that form.
- Never refuse to boot because config is absent — booting into onboarding is strictly better than exiting with an error.
- Never decrypt or open the store to answer "is there config?".
- Never change the mode-selection precedence rules from `cli-args.ts`; this story consumes the resolved mode, it does not influence it.
- Never leak a URL, credential, or file path into the hint text.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Returning user | bare `quick-studio`, store present | Identical to today: listening URL, workspace restored | none |
| True first run | bare `quick-studio`, no app-data dir at all | Boots Persistent, listening URL, plus the first-run hint; UI opens on connection onboarding | Hint only, exit code unaffected |
| Store present, zero connections | store exists but empty | Treated as **configured** — no CLI hint; the UI's existing empty state handles it | Deliberately coarse |
| Explicit persistent, first run | `quick-studio --persistent`, nothing configured | Same as the bare first-run path (plus Story 11.6's setup if the keychain is unavailable) | none |
| Ephemeral | `quick-studio postgres://x` | Probe never runs; no app-data access; no hint | Hard invariant |
| App-data dir unreadable | permissions error on the probe | Treated as "not configured" — degrade to the hint and boot; never crash the CLI over a stat failure | Total, never throws |
| Descriptor absent, `.enc` present | Story 2.2 back-compat layout | Configured — must not misread a legacy keychain-mode store as a first run | Classification must match 11.6's |
| Help/version | `quick-studio --help` | Exits before any probe (Story 11.1) | none |

</intent-contract>

## Code Map

- `src/core/store-presence.ts` — landed in Story 11.6, **consumed unmodified**. Exports `classifyStorePresence(dir, deps = DEFAULT_STORE_PRESENCE_DEPS)` (`:75-91`) → `{credential, providerKeys}`, each `StorePresence = "passphrase-mode" | "keychain-mode" | "first-run"` (`:39`), plus `anyDescriptorPresent` (`:102`). It takes a `dir` and never resolves one itself. **Do not use `anyDescriptorPresent` here** — it is descriptor-only, so it would misread a legacy keychain-mode store (`.enc`, no descriptor) as a first run, contradicting the I/O matrix.
- `src/core/first-run-signal.ts` (new) — the boot-level question `store-presence.ts` deliberately does not own (11.6's Code Map: "keep it free of any prompt/boot concern"). Exports `isFirstRunBoot(mode, env, platform, deps?)` and `FIRST_RUN_HINT`. Lives in `src/core` so it is unit-testable; `bin/` stays a thin caller.
- `src/core/app-dir.ts` — `resolveAppDir(env, platform, home?)` (`:43`) is the **pure, non-creating** resolver; `ensureAppDir()` (`:80`) `mkdirSync`s. Only the former may be used here, exactly as `first-run-setup.ts:348` does.
- `bin/quick-studio.ts` — compute `firstRun` after `const port = resolvePort()` (`:98`) and **before** the Story 11.6 pre-flight (`:115-125`; ordering is load-bearing, see Design Notes); thread it into `startCore` (`:127-138`); print the hint to stderr immediately after the listening-URL line (`:148`), before `runUpdateCheck` (`:155`) and the Port-Exposure Warning (`:162-179`).
- `src/core/server.ts` — `StartCoreOptions` (`:335-384`) gains `firstRun?: boolean`, an additive peer of the existing `mode`/`databaseUrl`. `renderIndexHtml` (`:457-496`) injects it as a fourth inline global alongside `__QS_TOKEN__`/`__QS_EXPOSURE__`/`__QS_SANDBOX_ORIGIN__` (`:486-488`), carrying the **same** `nonceAttr` (DW-2 CSP: an inline script without the per-boot nonce is refused) and the same `scriptJson` (`:423`) escaping. Single render site: `:1006-1011`.
- `src/ui/workspace/workspace-state.ts` — `openOrFocusSettings(state)` (`:211`) is the Settings-singleton seam; `emptyWorkspace()` (`:127`) is today's no-snapshot default; `restoreWorkspace` (`:409`) collapses duplicate settings tabs. Add the pure `initialWorkspace(base, firstRun)` decision function and its `shouldRouteToOnboarding(firstRun, snapshot)` predicate next to them — `App.tsx` has no test harness, so anything decided inline there is untestable by construction.
- `src/ui/App.tsx` — `declare global` (`:70-75`) gains `__QS_FIRST_RUN__?: boolean`; the `workspace.load` effect (`:488-527`) applies the routing at `:500`/`:515`/`:520`. `SettingsPanel.tsx` needs **no change**: its `section` state already defaults to `"connections"` (`:32`, `:256`), so landing on the Settings tab lands on the connections form.
- Tests — `src/core/first-run-signal.test.ts` (new); additions to `src/core/server.test.ts` (the `renderIndexHtml` injection describe at `:547-600` and the nonce describe at `:885` are the models) and `src/ui/workspace/workspace-state.test.ts` (`openOrFocusSettings` describe at `:173-208` is the model).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/first-run-signal.ts` (new) -- Author `isFirstRunBoot(mode, env, platform, deps: Partial<FirstRunSignalDeps> = {})` with deps `{resolveDir, classify}` defaulting to `resolveAppDir`/`classifyStorePresence`, in this exact order: (1) `mode !== "persistent"` → return `false` **before** invoking either dep; (2) resolve the dir and, if it is not `isAbsolute`, return `true` without classifying; (3) `classify(dir)`; (4) return `credential === "first-run" && providerKeys === "first-run"`; (5) wrap 2–4 in `try/catch` returning `true` on any throw. Also export `FIRST_RUN_HINT` (golden text in Design Notes) -- the CLI needs one total, side-effect-free, unit-testable answer to "has this machine ever been set up?", and `store-presence.ts` must stay free of mode/boot concerns.
- [x] `src/core/server.ts` -- Add `firstRun?: boolean` to `StartCoreOptions`; inside `startCore` resolve `const firstRun = options.firstRun ?? false;` and pass it as `renderIndexHtml`'s fifth parameter (declared `firstRun = false` so existing call sites keep compiling); in `renderIndexHtml` emit `<script${nonceAttr}>window.__QS_FIRST_RUN__ = ${scriptJson(firstRun)};</script>` as a fourth inline global -- the UI needs the flag synchronously at first paint, and the nonce is mandatory or the strict shell CSP refuses the tag.
- [x] `bin/quick-studio.ts` -- After `const port = resolvePort()` and **before** `runFirstRunSetup`, add `const firstRun = isFirstRunBoot(cli.mode, process.env, process.platform);`; pass `firstRun` into the `startCore` options; after the listening-URL write, `if (firstRun) process.stderr.write(FIRST_RUN_HINT);` -- the probe must read disk state as it was at process start, because 11.6's pre-flight can create the app dir and (on the passphrase create path) the descriptor and `.enc` before `startCore` is ever called.
- [x] `src/ui/workspace/workspace-state.ts` -- Add `export function initialWorkspace(base: WorkspaceState, firstRun: boolean): WorkspaceState` returning `firstRun ? openOrFocusSettings(base) : base` (returning `base` **by reference** when false), and `export function shouldRouteToOnboarding(firstRun: boolean, snapshot: WorkspaceSnapshot | null | undefined): boolean` returning `firstRun && snapshot == null` (loose on purpose — see the Review Triage Log), both documented as the first-run onboarding routing -- extracting BOTH the decision and its predicate makes them unit-testable under the repo's no-jsdom convention, and reusing `openOrFocusSettings` keeps the singleton guarantee.
- [x] `src/ui/App.tsx` -- Add `__QS_FIRST_RUN__?: boolean` to `declare global`; read `const firstRun = window.__QS_FIRST_RUN__ === true;` at render scope; inside the `workspace.load` `.then()` rename the current binding to `const base = snapshot ? restoreWorkspace(snapshot) : emptyWorkspace();`, bind the routing decision ONCE as `const routeToOnboarding = shouldRouteToOnboarding(firstRun, snapshot);` and use that same binding for both `const restored = initialWorkspace(base, routeToOnboarding);` and, after the existing `dispatch({type:"restore", snapshot})`, `if (routeToOnboarding) dispatch({type:"openSettings"});`; keep `restoreErdLayouts(snapshot, base.tabs)` reading `base`; keep `lastPersistedRef` seeded from `restored`; in the **error** branch (`!ok`, no snapshot reachable, reducer still holds `emptyWorkspace()`) `if (firstRun) dispatch({type:"openSettings"});` -- the autosave baseline must be seeded from the state actually held (otherwise the injected tab triggers an immediate save), the dispatch must live inside the `.then()` because a separate mount effect would be overwritten by the later `restore`, and `snapshot === null` is what keeps a page reload from re-stealing focus and keeps a deliberately closed Settings tab closed on the next launch.
- [x] `src/core/first-run-signal.test.ts` (new) -- Table tests with argument-recording spy deps (`update-check.test.ts:143-172` / `store-presence.test.ts:26-30` pattern): `"ephemeral"` → `false` with **zero** calls to `resolveDir`/`classify`; a wiring test pinning `resolveDir(env, platform)` receives exactly those and `classify` receives exactly that dir; persistent across all 9 `(credential, providerKeys)` combinations → `true` only for `first-run`/`first-run`; descriptor-absent-`.enc`-present → `false`; a relative dir → `true` with zero `classify` calls; a throwing `resolveDir` and a throwing `classify` → `true`; a **discriminating defaults test** that builds a real app dir under a temp `XDG_DATA_HOME`, writes a real descriptor, asserts `false`, then removes it and asserts the flip to `true`; and assert `FIRST_RUN_HINT` names both paths, ends in a newline, quotes `"Settings"` and `"connections"`, contains neither `nothing configured` nor a lowercase `"settings"` label, and contains no `/`, `\`, `://`, or app-dir substring -- this is the whole story's decision surface and the "never leak a path" boundary, and a `true`-only assertion cannot tell correct wiring from the never-throws fallback.
- [x] `src/core/server.test.ts` -- Extend the `renderIndexHtml` injection describe: `firstRun: true` renders `window.__QS_FIRST_RUN__ = true` carrying the same `nonce="…"` as the other three globals; `false` and the defaulted call render `= false`; assert the inline-tag count. Plus two tests that boot a real Core — `startCore({firstRun: true})` and the option omitted — and assert the served shell reflects the option -- a regression dropping `options.firstRun` on the floor would leave the CLI hint printing while the UI never routes, with a green suite.
- [x] `src/ui/workspace/workspace-state.test.ts` -- Add an `initialWorkspace` describe: `firstRun:false` returns the same object reference; `firstRun:true` over `emptyWorkspace()` yields exactly one `kind:"settings"` tab and makes it active; `firstRun:true` over a state that already holds a settings tab focuses it without adding a second; `firstRun:true` over a state with other tabs preserves them and does not mutate the input -- the singleton and no-data-loss guarantees are what make forcing the tab safe. Plus a `shouldRouteToOnboarding` describe over all four `(firstRun, snapshot)` combinations, the zero-tab snapshot, and `undefined` -- this predicate is the story's whole decision and lives one call away from an untestable file.
- [x] `README.md` -- Add a "First run" section: a bare `quick-studio` with nothing saved still boots Persistent and prints a one-block hint; the UI lands on the Settings tab's connections form **when there is nothing to restore**, and otherwise restores as-is with the hint as the only nudge; a configured boot is unchanged; Ephemeral never consults it; and the browser only opens at all when `--no-open`/`QS_NO_OPEN` is not set. Mirror the existing section phrasing -- the hint is the discoverability half of this story and must be findable before it is first seen.

**Acceptance Criteria:**
- Given existing persistent config, when I run bare `quick-studio`, then stderr is byte-for-byte today's output and the served shell carries `window.__QS_FIRST_RUN__ = false`.
- Given the probe, when it runs, then it performs no decryption, no key load, no lock acquisition, and no directory creation — only `existsSync` reads under the app-data path.
- Given the first-run signal and **nothing to restore** (`workspace.load` resolves `snapshot: null`, or the reply is `!ok`), when the UI boots, then the Settings tab is open and active on its connections section, and no second Settings tab can be created by the routing.
- Given the first-run signal but a **restored workspace snapshot** (any snapshot, including one holding zero tabs), when the UI boots, then the routing does not fire: `activeTabId` is whatever was restored, no Settings tab is injected, and the stderr hint is the only first-run signal on that launch.
- Given the routing fired on a true first run, when the autosave effect next evaluates, then it finds no diff against `lastPersistedRef` and writes nothing — the injected tab is not persisted by the routing itself.

## Spec Change Log

<!-- populated by step-04 as the spec is refined -->

## Review Triage Log

### 2026-07-24 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` The story's entire decision — `firstRun && snapshot === null` — was written inline in `App.tsx`, which has no test harness (no jsdom, by repo convention). Inverting it to `!== null`, or dropping the `firstRun` conjunct, left the full 1793-test suite green while every returning user's `activeTabId` got hijacked on every boot; the `initialWorkspace` tests only re-proved `openOrFocusSettings` and never touched the predicate. Extracted as the pure `shouldRouteToOnboarding(firstRun, snapshot)` in `workspace-state.ts` — the same "the decision lives in a testable module because `App.tsx` cannot be one" move that produced `initialWorkspace` — with 5 tests covering all four `(firstRun, snapshot)` combinations plus the zero-tab snapshot.
  - `[low]` `[patch]` Two different absence predicates for one value inside one function: `snapshot ? restoreWorkspace(snapshot) : emptyWorkspace()` (truthiness) and `snapshot === null` (strict). They coincide today because `LoadWorkspaceResult.snapshot` is `WorkspaceSnapshot | null` and every arm returns a literal `null`, but an optional field or any normalizer that drops null keys yields `undefined` → `base = emptyWorkspace()` **and** `routeToOnboarding === false`, i.e. an empty tree with no onboarding — precisely the outcome this story exists to eliminate, reached with no type error. The extracted predicate uses `== null` and a test pins the `undefined` case.
  - `[low]` `[patch]` The README's "Once a connection has been saved…" framing implied the hint survives until a connection exists. It does not: the signal is "has this machine ever been set up?", so a saved AI provider key — or, on a keychain-less host, the store that Story 11.6's passphrase setup writes during the very first boot — silently ends it. A user interrupted mid-setup on such a host gets the hint exactly once and never again, with the doc saying otherwise. Rewritten to state the coarse question, name all three things that end it, and point at the UI's own empty state as what carries the user from there; also added that the onboarding Tab is session-only, so a later launch neither restores it nor undoes a deliberate close.
  - `[low]` `[patch]` Two real-`startCore` boot tests (fetching the served shell over the loopback socket) were nested inside `describe("renderIndexHtml exposure injection")`, a unit-test block named for something else. Hoisted to their own top-level `describe("startCore — firstRun option threading")`.

<!-- deferred: DW-93 (`resolveAppDir` takes `platform` as data but joins with the HOST's `node:path`, so a cross-platform call returns a mixed-separator path that `isAbsolute` misjudges — pre-existing since Story 2.2, unreachable in production since every caller passes `process.platform`, and hardening only 11.7's consumer would imply a portability guarantee the resolver still does not provide). -->

<!-- rejected (accepted-by-design / in-contract / already dispositioned / noise): the `providerKeys` conjunct classifying an AI-key-only user as configured, and the coarse signal firing once per machine rather than once per empty workspace (both are explicit "Known residuals" in this spec's Design Notes and follow directly from the intent contract's "a store that exists but holds zero connections is the UI's empty state, not the CLI's business" — the README now documents them instead); the in-session page reload re-routing to Settings (same list; suppressing it needs a per-page-load answer, which the contract's "no new RPC" boundary rules out); the injected Settings Tab never being written to disk (that is exactly what AC#5 mandates); `initialWorkspace` and the reducer's `openSettings` case being two call sites of one transformation (the reducer case literally *is* `openOrFocusSettings(state)`, so they cannot diverge without someone deliberately extending it); the `bin/` ordering invariant being protected only by a comment, and no `bin/` coverage for the hint (the repo has no `bin/` harness — established in 11.6 and out of this story's scope to build); the `try/catch` in `isFirstRunBoot` being unreachable through the real seams (the module docstring already says exactly this, and names why it is kept); `startCore({mode:"ephemeral", firstRun:true})` being type-permitted (unreachable — `isFirstRunBoot` short-circuits Ephemeral before either seam runs, and a second guard would create two sources of truth for one invariant); the `!reply.ok` branch guarding on `firstRun` alone (no restore path exists there, the reducer provably still holds `emptyWorkspace()`, and the invariant is documented in code); the hint printing above the Port-Exposure Warning (the spec's Code Map prescribes that exact placement, and the banner is boxed and still prints last); `renderIndexHtml`'s fifth positional boolean rather than an options object (the spec prescribes the defaulted positional so pre-11.7 call sites keep compiling); the `options.firstRun ?? false` / parameter-default pair being redundant at the single production call site (both are spec-mandated and serve different callers); `not.toContain("/")` being an over-broad proxy for the leak boundary (deliberate, cheap, and directly derived from the contract's "never leak a … file path"); the four-vs-five `<script>` tag counts being asserted in two tests (they assert different things — nonce-bearing inline globals vs total tags including the external module). -->

## Design Notes

**Prior art — this story was implemented once and rolled back.** bmad-loop run `20260723-161652-a99f` deferred 11.7 for *"review did not converge within budget"*, not for a design fault: it landed 0 intent_gap / 0 bad_spec across two adversarial review passes (10 patches then 7). The frozen spec is at `.bmad-loop/runs/20260723-161652-a99f/deferred/11-7-bare-command-routing/spec-11-7-bare-command-routing.md` and the code is preserved on branch `attempt-preserve/20260723-161652-a99f-255eda31` (`git diff epic-11...attempt-preserve/20260723-161652-a99f-255eda31`). The Code Map, Tasks, and AC above are that hardened design with every line ref re-verified against HEAD. Consult the branch, but re-verify — it was written against baseline `8296fd2` and 11.2 has landed since.

**The probe must run BEFORE Story 11.6's pre-flight — this is load-bearing.** `runFirstRunSetup` step (3) calls `openCredentialStore` with an always-declining provider. On a keychain-available host that is a true first run, `openPersistent` takes its "true first run" arm, `loadOrCreateStoreKey()` returns `created`, and the store opens in keychain mode — that arm writes no descriptor and no `.enc`, so presence is unchanged, but `ensureAppDir()` has already created the directory. On a keychain-**less** host where the user completes the create path, the descriptor and the eager empty `.enc` *are* written before `startCore` is reached. A probe placed after the pre-flight would report "configured" on exactly the machine the hint exists for.

**Why a fourth inline global rather than an RPC or an `ExposureInfo` field.** `connection.active` (`rpc.ts:168`) already returns boot state and would satisfy "no new RPC", but it resolves *after* mount — routing the initial surface on an async reply means a visible flash of the empty tree and a race against `workspace.load`. `__QS_EXPOSURE__` is the documented precedent for the opposite property ("known at boot and static for the session — NOT an RPC", read once at `App.tsx:617`), which is exactly what this flag is. A separate global beats adding a key to `ExposureInfo`, which is specifically about network exposure and is consumed by the Port-Exposure banner. The new tag reuses `nonceAttr` and `scriptJson`, so it adds no new CSP surface (DW-2). Note that `rpc.test.ts:291-295` asserts `connection.active`'s result with an exact `toEqual` — another reason not to widen that payload.

**Classification rule.** `firstRun := credential === "first-run" && providerKeys === "first-run"`. Any descriptor (passphrase mode) or any `.enc` (keychain mode, Story 2.2 back-compat) on **either** store counts as configured. A keychain-mode store that has never been saved leaves no file at all and is correctly read as a first run. A passphrase-mode store with zero connections has a descriptor and is correctly read as configured, matching the I/O matrix. The "app-data dir unreadable" matrix row is satisfied by the *normal* path, not the `try/catch`: `resolveAppDir` is total and `existsSync` swallows `EACCES` and returns `false`, landing on `first-run`/`first-run`. The catch exists for the injected seams.

**No `bin/` test harness exists** (established in Story 11.6 and unchanged). The tested unit is `isFirstRunBoot` plus `FIRST_RUN_HINT`; `bin/`'s role is one `if` over a covered boolean. Likewise `App.tsx` has no jsdom/testing-library harness (DW-53), which is why the routing decision is extracted into the pure `initialWorkspace`.

**Golden hint text** (`FIRST_RUN_HINT`, stderr, no paths or credentials). Each label is quoted in the spelling its control actually renders: the tab title is capital-S `Settings` (`openOrFocusSettings` sets it; `TabBar.tsx` renders `{tab.title}` with no casing utility), while the section button is lowercase mono `connections` (`SettingsPanel.tsx`).

```
quick-studio: no connections saved yet — this looks like a first run.
  - Add one in the UI at the URL above: the "Settings" Tab, "connections" section.
  - Or start a throwaway session directly: quick-studio <database-url>
```

**Known residuals, accepted by the intent contract (do not "fix" these):** the signal fires once per machine, not once per empty workspace (a keychain-less host writes a descriptor during 11.6's create path, so from boot 2 it reads as configured); a saved AI provider key alone counts as configured; a true-first-run session that has never persisted anything re-routes to Settings on an in-session page reload (a per-page-load answer would need the new RPC the contract forbids); and the CLI hint is deliberately coarser than the UI routing, so a machine with no store but an existing `workspace-state.json` gets the hint and keeps its tabs.

## Verification

**Commands:**
- `bun x tsc --noEmit` -- expected: no type errors.
- `bun test src/core/first-run-signal.test.ts src/core/store-presence.test.ts src/ui/workspace/workspace-state.test.ts` -- expected: all green; `store-presence.test.ts` green and **unmodified** (this story must not change 11.6's classifier).
- `bun test src/core/server.test.ts` -- expected: green, including the pinned CSP/nonce and exposure-injection assertions.
- `bun test` -- expected: full suite green apart from the 9 known-environmental `bin/quick-studio-shim.test.ts` failures recorded in spec 11-5 (they spawn platform packages absent from this dev env). Confirm the count is still 9 and that none are new.
- `bun run build` -- expected: exit 0.

**Manual checks:**
- Fresh app-data dir (point `XDG_DATA_HOME` at an empty temp dir), bare `quick-studio`: the hint prints once after the listening URL, the UI opens on Settings → connections, and the exit code is 0.
- Same dir after saving one connection, re-run: no hint, no Settings tab forced, stderr is one URL line.
- `quick-studio postgres://user:pw@host/db`: no hint, and the app-data directory is not created.
- View source on the served shell in both states: exactly four inline `<script>` tags, all carrying the same `nonce`, and no path or credential anywhere in the injected values.

## Auto Run Result

Status: **done**

### Summary

A bare `quick-studio` now tells a brand-new user what to do next instead of opening a browser onto an empty tree. Before the Story 11.6 pre-flight can touch the app-data directory, `bin/` asks one cheap, total, read-only question — `isFirstRunBoot(mode, env, platform)`, which delegates to 11.6's `classifyStorePresence` and is `true` only when Persistent mode is booting and **neither** persistent store has ever left a file on disk. Nothing about what boots changes: Persistent still boots Persistent. The answer is used twice and only twice — one terse stderr hint printed immediately after the listening-URL line, naming both ways forward (add a connection in the UI, or re-run with a database URL for a throwaway Ephemeral session), and one credential-free boolean threaded through `StartCoreOptions` into the served shell as a fourth nonce-bearing inline global, which the UI reads synchronously at first paint to open onto the Settings Tab's connections form — but only when `workspace.load` came back with nothing to restore, so a saved workspace is never hijacked and a deliberately closed onboarding Tab stays closed. A configured boot is byte-for-byte what it was: no probe output, no prompt, no extra tag content, no routing. Ephemeral never consults the probe at all — the short-circuit happens before either seam is invoked, so the app-data directory is never even resolved.

### Files changed

- `src/core/first-run-signal.ts` (new) — `isFirstRunBoot` (Ephemeral short-circuit → absoluteness guard → delegate to `classifyStorePresence` → total `try/catch`) and `FIRST_RUN_HINT`. Never decrypts, locks, or creates anything; the presence logic itself is consumed, never re-implemented.
- `src/core/first-run-signal.test.ts` (new) — Ephemeral zero-seam-call invariant, argument-recording seam-wiring assertions, the full 3×3 presence matrix, the relative-dir and throwing-dep fallbacks, a discriminating real-disk defaults test, and the hint's "never leak a path" boundary.
- `src/core/server.ts` — `StartCoreOptions.firstRun?`, defaulted at the single render site; `renderIndexHtml` gained a fifth `firstRun = false` parameter emitting `window.__QS_FIRST_RUN__` with the same per-boot CSP nonce as the other three globals.
- `src/core/server.test.ts` — `renderIndexHtml` injection tests (true/false/defaulted, one-nonce-for-all-four, tag counts) plus a separate top-level describe booting a real Core to prove the option→shell threading.
- `bin/quick-studio.ts` — computes `firstRun` after `resolvePort()` and **before** `runFirstRunSetup`, threads it into `startCore`, and prints the hint right after the listening-URL line.
- `src/ui/workspace/workspace-state.ts` — pure `initialWorkspace(base, firstRun)` over the existing `openOrFocusSettings` singleton seam (returns `base` by reference when false), plus the `shouldRouteToOnboarding(firstRun, snapshot)` predicate.
- `src/ui/workspace/workspace-state.test.ts` — reference no-op, singleton open, focus-not-duplicate, tab preservation, no mutation; and the predicate across all four combinations, the zero-tab snapshot, and `undefined`.
- `src/ui/App.tsx` — `__QS_FIRST_RUN__` declared and read once; the `workspace.load` effect binds `routeToOnboarding` ONCE from the extracted predicate and reuses it for both the baseline seed and the dispatch, routes in the error branch on `firstRun` alone (no snapshot is reachable there), and seeds the autosave baseline from the routed state.
- `README.md` — a "First run" section covering the hint, when the routing does and does not fire, that the onboarding Tab is session-only, what stays unchanged for a returning user, how coarse the signal deliberately is (and all three things that end it), and that Ephemeral never consults it.

### Review findings breakdown

One pass, two adversarial reviewers (blind + edge-case), 20 raw findings → 16 after dedup → **0 intent_gap, 0 bad_spec, 3 patches applied (1 medium, 2 low), 1 deferred (DW-93), 12 rejected**.

The medium patch: the story's entire decision (`firstRun && snapshot === null`) was written inline in `App.tsx`, which has no test harness — inverting it left the whole 1793-test suite green while every returning user's `activeTabId` got hijacked. Extracted as the pure, tested `shouldRouteToOnboarding`, which also resolved the second (low) finding: `App.tsx` used truthiness and strict-`null` for the same value in one function, so an `undefined` snapshot would have produced an empty tree AND no onboarding — exactly the outcome this story exists to eliminate. The third (low) patch corrected the README, which implied the hint survives until a connection is saved when in fact any local store ends it. The twelve rejections are dispositioned individually in the Review Triage Log; most were the intent contract's own accepted residuals, re-raised.

Follow-up review recommended: **false** — three localized fixes on a design that has now cleared five adversarial reviewer passes across two runs (three in the deferred a99f run, two here) with zero intent_gap and zero bad_spec throughout. The new production code is a three-line pure predicate with five tests.

### Verification performed

- `bun x tsc --noEmit` — clean, before and after the patches.
- `bun test` — **1798 pass / 1 skip / 9 fail** (1793 before the patches; +5 predicate tests). All 9 failures are the known-environmental `bin/quick-studio-shim.test.ts` set — this machine has no `node` on PATH, recorded in spec 11-5. Verified by filter that the non-shim failure count is **0**.
- `bun test src/core/first-run-signal.test.ts src/core/server.test.ts src/ui/workspace/workspace-state.test.ts` — 182 pass / 0 fail.
- `bun run build` — exit 0, all five generators wrote.
- `git diff --exit-code src/core/store-presence.ts src/core/store-presence.test.ts` — empty: 11.6's classifier is provably unmodified.
- Every line ref in the Code Map re-verified against HEAD `62caa84` before implementation began.
- Manual checks in the Verification section were not executed: they need a fresh app-data dir, a real browser, and an exposed bind.

### Residual risks

- **The coarse signal fires once per machine, not once per empty workspace.** On a keychain-less host, 11.6's pre-flight writes the descriptor and an empty `.enc` while creating the store, so from boot 2 onward that machine reads as configured even with zero connections saved. This is the intent contract's explicit choice, and the UI's own empty state carries the user from there — but the headless-Linux user this epic targets gets exactly one shot at the CLI hint. Now documented in the README rather than only in the spec.
- **A saved AI provider key alone counts as configured.** The predicate answers "has this machine ever been set up?", so someone who saved an API key and no connection sees no hint even though the hint's destination is the connections form.
- **The shell's boot flag is static for the process.** Routing is suppressed whenever `workspace.load` returned any snapshot, which covers both the reload-after-configuring case and a deliberately closed onboarding Tab. What remains: a true-first-run session that has never persisted anything re-routes to Settings on an in-session page reload. A per-page-load answer would need the new RPC the intent contract forbids.
- **The CLI hint is deliberately coarser than the UI routing.** `bin/` prints on `isFirstRunBoot` alone while the UI additionally requires nothing to restore, so a machine with no store but an existing `workspace-state.json` gets the hint and keeps its tabs. The hint stays literally true and names the Tab to click; the README documents both cases.
- **`bin/`'s wiring is unit-tested only indirectly** — the repo has no `bin/` harness (established in 11.6), so the probe's placement before the pre-flight and the hint's position after the URL line are guaranteed by an extensive code comment and the manual checks, not by a test. A cohesion refactor that moved the probe down would silently disable the feature on exactly the hosts it targets.
