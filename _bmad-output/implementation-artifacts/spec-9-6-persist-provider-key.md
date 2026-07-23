---
title: 'Persist AI provider API keys across sessions — verify the persistent-mode restore invariant and close the ephemeral-mode discoverability gap that makes it look broken'
type: 'refactor' # feature | bugfix | refactor | chore
created: '2026-07-18'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
baseline_revision: 'e2ef393bd5c7ba8efff06b02199be480f3853c85'
final_revision: 'cb222d6043a6e18a4c9aaa74467ab54304ffca31'
review_loop_iteration: 0 # incremented by step-04 before each review loopback
followup_review_recommended: false # set by step-04 on status: done from the final review pass significance judgment
context:
  - 'Story 5.1 (spec-5-1-configure-ai-providers.md) built the encrypted provider-key store + AI-providers Settings surface — this story verifies its cross-session persistence and closes the one honest UX gap.'
  - 'Story 2.2 / 2.3 (spec-2-2-encrypted-credential-store.md, spec-2-3-passphrase-fallback.md) own the at-rest crypto + key-load (keychain / passphrase-derived) substrate this store reuses UNCHANGED.'
warnings: [oversized] # frozen intent-contract pushes total past 1600 tokens; body kept tight
---

<intent-contract>

## Intent

**Problem — the persistence is NOT the defect; the DISCOVERABILITY is.** A first read of "I have to re-enter my provider key every time" suggests keys are only held in memory. They are NOT. The full persistent-mode path already exists and works end-to-end (Story 5.1):

- `src/core/provider-key-store.ts` **PERSISTS keys encrypted at rest** in persistent mode. `saveKey` → `commit` → `writeStoreFile` (`provider-key-store.ts:583-596`, `288-320`) atomically writes an AES-256-GCM envelope to `provider-keys.enc` (temp + rename, `0o600`). On reopen, `openProviderKeyStore` → `loadStoreFromFile` (`497-567`) reads, decrypts, and rehydrates the in-memory record map, so `getKey`/`listKeys` return the persisted keys. Ephemeral mode is `buildStore(mode, [], null, null)` (`348`) — memory only, `flush` short-circuits on `key === null` (`584`), zero disk writes.
- The **key-load / Ring-1 trust boundary is intact**: the store decrypts under the keychain master key (`loadOrCreateStoreKey`, `369`/`422-433`) or, on a keychain-less machine, a passphrase-derived key from the salt-descriptor sidecar (`provider-keys.meta.json`, `384-418`). `server.ts` injects ONE shared passphrase provider into BOTH stores (`server.ts:269, 285-286`) so the single-read fd is not starved. Raw keys never leave Ring 1.
- The **Settings AI-providers surface already shows configured (masked) + replace/remove**: `ProvidersPanel.tsx` calls `providers.list` on mount (`138-154`), and each `ProviderRow` renders `configured · …{last4}` (`71-79`) via the secret-free `ProviderSummary.keyPreview` (`provider-registry.ts:toSummary`, `84-92`) or `not configured`, with a `replace` input and a `remove` button (`96-115`) gated on `listLoaded`.

So in PERSISTENT mode (the default) a saved key IS restored on reopen and IS shown as configured with no re-entry. **The user's complaint is EPHEMERAL mode behaving exactly as designed** — memory-only, gone on restart — which is what a dev container runs (`QS_MODE=ephemeral`). The genuine defect is that **the AI-providers surface gives no run-mode signal**, so ephemeral-mode's by-design no-persist is indistinguishable from a persistence bug: the user sees "not configured" again after a restart with no explanation. The connections surface already shows this signal (`SettingsPanel.tsx` renders `active.mode` from `connection.active`, `248-257, 372-383`); the providers surface does not.

**Approach — verify the invariant, then make the mode honest; touch NO crypto, NO store, NO boundary.** (1) LOCK the persistent-mode restore invariant with a store-level unit test that proves save → close → reopen → key is restored (and its ephemeral counterpart: reopen → gone), so "persist across sessions" is a guarded regression fence — testable purely via the store, **no Docker, no live DB**. (2) CLOSE the discoverability gap by surfacing the run mode on the AI-providers surface, reusing the EXISTING `ConnectionMode` from `connection.active` (no new RPC): when the mode is `ephemeral`, render a terse note that keys are session-only and not remembered across restarts; when `persistent`, the existing configured/masked display already tells the true story. This turns the user's "it's broken" into "this is an ephemeral session" without weakening or duplicating the Story 5.1 mechanism. NO change to `provider-key-store.ts`, `provider-registry.ts`, the crypto substrate, the Ring-1 boundary, or the ephemeral no-write gate — those are preserved invariants, listed to pin the no-touch surface.

## Boundaries & Constraints

**Always:**
- Treat the persistent-mode restore path as a PRESERVED invariant: a key saved via `providers.set` in persistent mode is written encrypted to `provider-keys.enc` and, on the next `openProviderKeyStore`, decrypted and returned by `getKey`/`listKeys` — verified by a store-level unit test that opens, saves, re-opens against the SAME app dir + key, and asserts the record survives (mirror the reopen pattern the credential-store / passphrase-fallback tests already use).
- Reuse the EXISTING `ConnectionMode` (`contract.ts:384`, `"ephemeral" | "persistent"`) already carried by `ActiveConnectionInfo.mode` (`contract.ts:395-396`) and already fetched by the Settings surface via `rpc<ActiveConnectionInfo>("connection.active")` (`SettingsPanel.tsx:248-257`). The AI-providers surface derives its mode signal from that same value — confirm in step-02 whether to thread `active.mode` down from `SettingsPanel` into `ProvidersPanel` or have `ProvidersPanel` read `connection.active` itself; prefer threading the already-loaded value to avoid a duplicate RPC.
- Keep the masked configured display EXACTLY: `configured · …{keyPreview}` from the secret-free `ProviderSummary` (`ProvidersPanel.tsx:71-79`), the `replace`/`save` and `remove` affordances (`96-115`), the `password`-typed input never rendered back (`85-94`), and the mutation gates (`busy`/`loading`/`listLoaded`).
- Preserve the identity model: at most one key per `ProviderKind`; `providers.set` upserts, `providers.remove` is idempotent (`provider-registry.ts:145-183`).
- Keep the `role="alert"` envelope surfacing (`ProvidersPanel.tsx:36-42, 190-194`) and `envelopeText` error formatting; any new mode note is a plain informational line, NOT an `alert`.

**Block If:**
- If verification reveals the persistent-mode restore path does NOT actually rehydrate a saved key on reopen (i.e. Story 5.1's `provider-key-store` restore is genuinely broken, not just undiscovered) — HALT `blocked`, condition `persistent-mode provider-key restore is broken at the store level`; the scope changes from "verify + discoverability" to "fix the store" and the Intent above is wrong.
- If the run mode cannot be surfaced to the AI-providers section without a NEW Core RPC or a change to `provider-registry.ts` (i.e. `connection.active` / `ActiveConnectionInfo.mode` turns out not to be reachable from the Settings surface) — HALT `blocked`, condition `run mode is not reachable from the providers surface without a new provider-side RPC`, and reconsider the approach.

**Never:**
- NEVER log, return, echo, or place in an error `detail` the plaintext API key. The wire stays secret-free (`ProviderSummary` = `{ provider, keyPreview }` only); `keyPreview` is the last-4 masked form, and a key ≤4 chars collapses to a bare ellipsis (`provider-registry.ts:88-91`). No new code path may read `apiKey` into Ring 2, a log line, or a snapshot.
- NEVER weaken the Ring-1 credential trust boundary: provider keys stay Core-only, decrypted under the OS keychain master key or the passphrase-derived key. Do NOT import `provider-key-store` or `getKey` into Ring 2/3, do NOT add a new RPC that returns a raw key, and do NOT alter the crypto substrate (`crypto.ts`, `store-key.ts`, `passphrase-key.ts`) or the shared-passphrase-provider wiring (`server.ts:269, 285-286`).
- NEVER make ephemeral mode persist. Ephemeral stays memory-only, zero disk writes — the `buildStore(mode, [], null, null)` gate and the `key === null` flush short-circuit are untouched. The fix DESCRIBES ephemeral's no-persist to the user; it does not change it.
- NEVER regress the chat schema-only exposure note/policy (`contract.ts:526`, `policy: "schema-only"`) — this story does not touch the chat surface; that invariant is out of scope and preserved.
- NO new UI library, NO zod, NO snapshot-version bump, NO change to `provider-key-store.ts` / `provider-registry.ts` / `rpc.ts` provider handlers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Save then reopen (persistent) | `providers.set {anthropic, key}` in persistent mode, then a fresh `openProviderKeyStore` against the same app dir + key | The record is encrypted to `provider-keys.enc`; on reopen `getKey("anthropic")`/`listKeys()` return it; `providers.list` → `configured · …{last4}`; the panel shows it WITHOUT re-entry. Raw key never returned/logged | Corrupt/wrong-key → typed store `OpenResult` arm (`corrupt`/`key-invalid`) → registry `internal_error`, not a crash |
| Reopen with no keychain AND no passphrase | persistent mode, keychain-less machine, descriptor present, passphrase provider declines | `openProviderKeyStore` → `passphrase-declined` (`provider-key-store.ts:390-395`); registry `internal_error` (`detail: "passphrase-declined"`); panel surfaces the envelope, shows nothing configured | Typed arm, no throw, no plaintext in detail |
| Remove key | `providers.remove {anthropic}`, then again | First flushes the re-encrypted set (kind dropped); second is idempotent `ok` no-op (`provider-registry.ts:170-183`, `provider-key-store.ts:613-620`); panel drops the row via `applyRemoved` | No error |
| Replace key | `providers.set {anthropic, newKey}` for an already-configured kind | Upsert-by-kind — one record for the kind, new ciphertext flushed; `keyPreview` updates to the new last-4; panel `applySet` replaces in place | No error |
| Ephemeral mode — no persist (the complaint) | `QS_MODE=ephemeral`, set a key, restart the process | Held in memory this session only (`buildStore(…, null, null)`); NO `provider-keys.enc` written; after restart the store is empty → panel shows `not configured`. The AI-providers surface now shows an EPHEMERAL note explaining keys are session-only — so it reads as by-design, not broken | No error; behavior is correct AND now discoverable |
| Mode signal on the surface | Settings → ai providers, `connection.active.mode` known | `persistent` → existing configured/masked display (no extra note needed); `ephemeral` → a terse informational line "ephemeral session · keys are not remembered after restart" (plain line, not `role="alert"`) | `connection.active` failure leaves mode absent → omit the note, panel otherwise unchanged (mirror `SettingsPanel`'s independent-active-effect tolerance, `248-257`) |
| Secret-free wire (regression) | any `providers.list`/`set` reply or log line | Only `{ provider, keyPreview }`; raw key never present; short key → bare ellipsis | Enforced by the existing `provider-registry`/store tests + trust-boundary grep |
| Full suite | `bunx tsc --noEmit` + `bun test` + `bun run build` | tsc clean; store restore round-trip test green; existing provider/registry/panel suites green; build OK. No Docker/live DB needed | No error |

</intent-contract>

## Code Map

<!-- Line anchors reconciled to the tree read on 2026-07-18 (step-02 investigation). The mode-signal
     wiring is RESOLVED: thread `mode={active?.mode}` from SettingsPanel (single source of truth, zero new
     RPC). NO change to provider-key-store.ts, provider-registry.ts, rpc.ts, server.ts, or the crypto substrate. -->

- `src/core/provider-key-store.test.ts` — **VERIFY-ONLY, NO CHANGE.** Step-02 confirmed the load-bearing restore invariant is ALREADY comprehensively fenced (14 tests green, 0 fail): persistent save→reopen decrypted round-trip at `test("relaunch survival: save then reopen fresh instance → decrypted round-trip")` (l.42-56); passphrase reopen round-trip (l.167-191); ephemeral no-write at `describe("… ephemeral writes nothing to disk")` → `"a set in ephemeral mode holds in memory and writes no file under the dir"` (l.104-118); plus upsert-by-kind (l.74), idempotent remove (l.84), multi-provider coexistence (l.94), raw-file-no-key-material (l.58), and every typed error arm (key-invalid l.127, corrupt l.138/193/225, schema-unknown l.149, passphrase-declined l.213). Per the intent-contract's "if present, EXTEND/assert rather than duplicate", coverage is already complete — do NOT add a duplicate store test; just keep this suite green.
- `src/ui/settings/ProvidersPanel.tsx` — **ADD the run-mode signal.** Today `export function ProvidersPanel(): React.JSX.Element` is prop-less (217 lines) and already holds `rpc` (l.23). Add an optional `mode?: ConnectionMode` prop (add `ConnectionMode` to the EXISTING contract import at l.15-22 — same source as `PROVIDER_KINDS`/`ProviderSummary`). When `mode === "ephemeral"`, render one terse mono informational line (NOT `role="alert"`) in the gap between the error-envelope block (ends l.194) and the `{loading ? …}` block (l.196): `ephemeral session · keys are not remembered after restart`. When `persistent` or `undefined`, render nothing extra — the existing `configured · …last4` display already tells the true story. NO change to the `providers.list/set/remove` calls, the `password` input, the masked display, or the mutation gates.
- `src/ui/settings/SettingsPanel.tsx` — **THREAD the already-loaded mode.** It already fetches `active` via `rpc<ActiveConnectionInfo>("connection.active")` (l.248-257, state var l.224) and reads `active.mode` at l.381. Change the render at l.361 from `<ProvidersPanel />` to `<ProvidersPanel mode={active?.mode} />` (`active` may be `null` on boot/error → `active?.mode` is `undefined`, which the panel treats as "no note"). NO other change; the section switcher and connections flow are untouched.
- `src/ui/settings/ProvidersPanel.test.tsx` — **ADD** a component test mirroring the existing `.test.tsx` testing-library pattern (e.g. `ConfirmRun.test.tsx`, `ChatTabView.test.tsx`): stub `rpc` from `../rpc/client.ts` so the mount `providers.list` resolves without a live Core; render `<ProvidersPanel mode="ephemeral" />` → the ephemeral note is present and is NOT `role="alert"`; render `<ProvidersPanel mode="persistent" />` and `<ProvidersPanel />` → the ephemeral note is absent. There is no existing `ProvidersPanel.test.tsx` today (only the pure `providers-model.test.ts`); this is the mode-signal edge-case fence.
- `src/ui/settings/providers-model.ts` — **NO change** (pure secret-free view-model; the mode note is presentation-only and carried as a prop, not through the model).
- `src/shared/contract.ts` — **NO change.** `ConnectionMode` (l.384), `ActiveConnectionInfo.mode` (l.396), `ProviderSummary` (l.472-475), and `providers.*` types already exist and are reused verbatim.
- `src/core/provider-key-store.ts`, `src/core/provider-registry.ts`, `src/core/rpc.ts`, `src/core/server.ts`, `src/core/crypto.ts`, `src/core/store-key.ts`, `src/core/passphrase-key.ts` — **NO change.** Listed to PIN the no-touch boundary: the persistence mechanism, the secret-free registry, the RPC handlers, the shared-passphrase wiring, and the crypto substrate are preserved invariants.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/settings/ProvidersPanel.tsx` -- add optional `mode?: ConnectionMode` prop and render the terse ephemeral info line (not `role="alert"`) in the l.194→196 gap when `mode === "ephemeral"`; render nothing extra otherwise -- closes the discoverability gap without touching list/mutations/masked display/gates.
- [x] `src/ui/settings/SettingsPanel.tsx` -- pass `mode={active?.mode}` to `<ProvidersPanel />` at l.361 -- threads the already-loaded run mode from the single `connection.active` source with zero new RPC.
- [x] `src/ui/settings/ProvidersPanel.test.tsx` -- ADD a component test asserting the ephemeral note shows only for `mode="ephemeral"` (and is a plain line, not `role="alert"`) and is absent for `persistent`/undefined -- fences the "Mode signal on the surface" I/O row. (Implemented with the repo's actual convention — `renderToStaticMarkup` + `mock.module` — since there is no testing-library; same assertions.)
- [x] `src/core/provider-key-store.test.ts` -- VERIFY-ONLY (no edit): the existing 14-test suite (persistent reopen round-trip l.42, ephemeral no-write l.105, upsert/remove/typed arms) stays green -- the persistent-restore invariant is already fenced; not duplicated.

**Acceptance Criteria:**
- Given persistent mode and a key saved via the AI-providers surface, when the app is closed and reopened, then the key is restored from the encrypted `provider-keys.enc` (decrypted under keychain/passphrase key), shown as `configured · …{last4}` without re-entry, and never returned or logged — this invariant stays fenced by the green store round-trip test (`provider-key-store.test.ts:42`), which the story keeps passing rather than duplicating.
- Given ephemeral mode (e.g. a dev container with `QS_MODE=ephemeral`), when a key is set and the process restarts, then no `provider-keys.enc` is written and the key is gone (fenced by `provider-key-store.test.ts:104-118`), AND the AI-providers surface shows a terse note that the session is ephemeral and keys are not remembered — so the behavior is discoverable, not mistaken for a persistence bug.
- Given the AI-providers surface, when rendered, then the run-mode signal derives solely from the existing `connection.active` / `ConnectionMode` threaded as `mode={active?.mode}` — no new provider-side RPC, no raw-key exposure, and the Ring-1 boundary, crypto substrate, and ephemeral no-write gate are all untouched.
- Given a `connection.active` failure or a persistent boot where `active` is null, when the panel renders, then `mode` is `undefined`, the ephemeral note is omitted, and the panel is otherwise unchanged (no crash).
- Given the suite, when run, then `bunx tsc --noEmit` is clean, `bun test` is green (including the new `ProvidersPanel.test.tsx` and the unchanged store suite), and `bun run build` succeeds.

## Spec Change Log

## Review Triage Log

### 2026-07-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 0
- reject: 6: (high 0, medium 1, low 5)
- addressed_findings:
  - `[low]` `[patch]` `ProvidersPanel.test.tsx` ephemeral assertion strengthened: under SSR (`renderToStaticMarkup`, no mount effect, `error` stays null) the `not.toContain('role="alert"')` check was vacuous. Now it positively asserts the note is a plain `<p>` (`/<p\b[^>]*>[^<]*ephemeral session/`) and is NOT the `bg-err-soft` role=alert error envelope — a real guard on the "plain line, not alert" constraint. tsc clean, 3/3 panel tests green.
- rejected (recorded for transparency, not actioned):
  - `[medium]` connection.active failure → `mode` undefined → ephemeral note omitted. REJECTED: this is the explicitly designed behavior (I/O matrix "Mode signal on the surface" + the AC for a null `active`); the failure scenario is practically unreachable since `connection.active` and the provider RPCs hit the same Core, so a degraded panel loses far more than the note.
  - `[low]` note flash-in delay after the async `connection.active` resolve. REJECTED: cosmetic, inherent to the spec-chosen single-source async load; resolve latency of a local Core RPC is negligible.
  - `[low]` SSR test does not exercise note + loaded provider list together / role check vacuity. REJECTED (coexistence part): the note is a sibling of the `{loading?}` block and renders independently of list state; the vacuity is addressed by the patch above; a client-render harness does not exist in this repo (out of scope).
  - `[low]` note styled with the same muted className as `loading…`. REJECTED: this is the spec's Design-Notes golden shape verbatim; emphasizing it risks reading as the alert the spec forbids.
  - `[low]` microcopy hardcoded / coupled to the test by substring. REJECTED: normal for a copy assertion.
  - `[low]` a future third `ConnectionMode` member would fall through to `null` with no compile break. REJECTED: over-engineering an `assertNever` for a 2-member union in an optional-note ternary; the fallthrough is safe.

## Design Notes

- **The "persistence bug" is a discoverability gap, not a store defect — step-02 proved it.** The store-level restore invariant is already comprehensively fenced by 14 green tests (persistent save→reopen decrypted round-trip at `provider-key-store.test.ts:42`, passphrase reopen at l.167, ephemeral no-write at l.105, plus upsert/remove/multi-provider/all typed error arms). This resolves the intent-contract's open question ("confirm whether an equivalent reopen test already exists"): it does, and it is complete, so the story adds **no** duplicate store test and instead spends its code budget on the honest UX signal.
- **Mode signal is threaded, not independently fetched.** `SettingsPanel` already holds `active` from a single `connection.active` call (l.248-257) and reads `active.mode` at l.381; passing `mode={active?.mode}` into `<ProvidersPanel />` (l.361) is one attribute, zero new RPC, and one source of truth — avoiding a duplicate in-flight request and any risk of the two surfaces disagreeing. Because `active` can be `null` on a persistent boot or a fetch error, the prop is optional and an absent/`persistent` mode renders no extra line — only `ephemeral` triggers the note.
- **Golden shape of the note** (presentation only, secret-free, not an alert):
  ```tsx
  {mode === "ephemeral" ? (
    <p className="font-mono text-xs lowercase text-muted-foreground">
      ephemeral session · keys are not remembered after restart
    </p>
  ) : null}
  ```

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors (the new optional `mode?: ConnectionMode` prop is additive; reused contract types already compile).
- `bun test` -- expected: full suite green, including the new `ProvidersPanel.test.tsx` mode-note assertions and the UNCHANGED `provider-key-store.test.ts` (persistent restore round-trip + ephemeral no-write). Persistence is proven purely via the store's own unit tests — **no Docker, no live database, no container.**
- `bun run build` -- expected: OK (regenerates the UI bundle embedding the mode-aware AI-providers surface).

**Trust-boundary check (grep, mirrors Story 5.1):**
- No `ai`/`@ai-sdk/*` import and no raw-`apiKey` read outside `src/core/`; the AI-providers surface still handles only `ProviderSummary` (secret-free) and the run-mode literal.

**Manual checks (optional — the persistence claim is proven by the unit test, not manual):**
- Persistent (default): Settings → ai providers, set an Anthropic key → `configured · …last4`; restart the app → still configured, no re-entry, no ephemeral note.
- Ephemeral (`QS_MODE=ephemeral`, the dev-container case): set a key → shows the ephemeral note; restart → `not configured` with the note explaining why; confirm no `provider-keys.enc` was written under the app dir.

## Auto Run Result

Status: **done**

**Summary of implemented change.** The reported "I have to re-enter my provider key every time" was diagnosed as a discoverability gap, not a persistence defect: step-02 confirmed the persistent-mode restore invariant is already fenced by the existing green store suite (14 tests, incl. the save→reopen decrypted round-trip and the ephemeral no-write test), so no store/crypto/RPC/contract code was touched. The change surfaces the run mode on the AI-providers Settings surface — when the session is `ephemeral`, a terse plain line ("ephemeral session · keys are not remembered after restart") now explains the by-design memory-only behavior; `persistent`/unknown renders nothing extra. The mode is threaded from the already-loaded `connection.active` (zero new RPC).

**Files changed.**
- `src/ui/settings/ProvidersPanel.tsx` — added optional `mode?: ConnectionMode` prop; renders the terse ephemeral note (plain `<p>`, not `role="alert"`) between the error envelope and the loading/list block; masked display, mutations, and gates unchanged.
- `src/ui/settings/SettingsPanel.tsx` — passes `mode={active?.mode}` to `<ProvidersPanel />` (single source of truth, no duplicate RPC).
- `src/ui/settings/ProvidersPanel.test.tsx` — NEW: asserts the note shows only for `mode="ephemeral"`, is a plain paragraph and not the `role="alert"`/`bg-err-soft` envelope, and is absent for `persistent`/undefined (repo convention: `renderToStaticMarkup` + `mock.module`).
- `src/core/provider-key-store.test.ts` — VERIFY-ONLY, untouched; the persistent-restore + ephemeral-no-write invariants stay fenced and green.

**Review findings breakdown.** 2 reviewers (Blind Hunter + Edge Case Hunter). No security or hard-constraint violation. 7 findings deduped → **1 patch applied** (low: strengthened the vacuous SSR `role=alert` assertion into a positive plain-`<p>` / not-`bg-err-soft` check), **0 deferred**, **6 rejected** (1 medium + 5 low — the medium being the spec-designed "omit note on `connection.active` failure", which matches the AC and I/O matrix). Full detail in the Review Triage Log above.

**Verification performed.**
- `bunx tsc --noEmit` → clean (exit 0).
- `bun test` → 1262 pass, 0 fail, 3119 expect() calls across 72 files (includes the new panel tests and the unchanged store suite). The `[rpc] handler 'execute' threw: relation "secret" does not exist` line is an expected error-path test log, not a failure.
- `bun run build` → OK (regenerated the gitignored `*-bundle.generated.ts`).
- Trust-boundary: the change touches only Ring-2 presentation; no `apiKey`/`ai`/`@ai-sdk` read introduced outside `src/core/`; the surface still handles only `ProviderSummary` + the run-mode literal.

**Follow-up review recommendation:** `false` — the only review-driven change was a single localized low-severity test-assertion hardening; no behavior/API/security/data impact.

**Residual risks.** On a `connection.active` RPC failure the ephemeral note is omitted (by design, per the AC) — practically unreachable since the same Core serves both RPCs. The panel tests, bound by the repo's SSR-only (`renderToStaticMarkup`) convention, do not exercise the note alongside a fully-loaded provider list; the note renders independently of list state, so coverage risk is low.
