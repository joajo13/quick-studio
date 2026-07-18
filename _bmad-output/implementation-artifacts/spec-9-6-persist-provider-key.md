---
title: 'Persist AI provider API keys across sessions — verify the persistent-mode restore invariant and close the ephemeral-mode discoverability gap that makes it look broken'
type: 'refactor' # feature | bugfix | refactor | chore
created: '2026-07-18'
status: 'draft' # draft | ready-for-dev | in-progress | in-review | done | blocked
context:
  - 'Story 5.1 (spec-5-1-configure-ai-providers.md) built the encrypted provider-key store + AI-providers Settings surface — this story verifies its cross-session persistence and closes the one honest UX gap.'
  - 'Story 2.2 / 2.3 (spec-2-2-encrypted-credential-store.md, spec-2-3-passphrase-fallback.md) own the at-rest crypto + key-load (keychain / passphrase-derived) substrate this store reuses UNCHANGED.'
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

## Acceptance Criteria

- **Given** persistent mode and a provider key saved via the AI-providers Settings surface, **when** the app is closed and reopened, **then** the key is restored from the ENCRYPTED `provider-keys.enc` (decrypted under the keychain or passphrase-derived key), the provider shows as `configured · …{last4}` without re-entry, and the raw key is never returned or logged — and a store-level unit test proves this save → reopen → restored round-trip (no Docker, no live DB).
- **Given** persistent mode on a keychain-less machine with no passphrase available, **when** the store is reopened, **then** it fails with a typed `passphrase-declined` arm surfaced as an `internal_error` envelope (no crash, no plaintext in `detail`), and the panel shows nothing configured rather than crashing.
- **Given** a configured provider, **when** the user replaces the key, **then** it upserts by kind (one record), re-encrypts, and the masked `keyPreview` updates; **when** the user removes it, **then** the record is dropped and a second remove is an idempotent success.
- **Given** ephemeral mode (e.g. a dev container with `QS_MODE=ephemeral`), **when** a key is set and the process restarts, **then** no `provider-keys.enc` is written, the key is gone (memory-only, by design), AND the AI-providers surface shows a terse note that the session is ephemeral and keys are not remembered across restarts — so the behavior is discoverable, not mistaken for a persistence bug.
- **Given** the AI-providers surface, **when** inspected, **then** the run-mode signal is derived from the EXISTING `connection.active` / `ConnectionMode` (no new provider-side RPC, no raw-key exposure), the Ring-1 boundary and crypto substrate are untouched, and the ephemeral no-write gate is unchanged.
- **Given** the suite, **when** run, **then** `bunx tsc --noEmit` is clean, `bun test` is green (with the new store restore round-trip test), and `bun run build` succeeds.

## Code Map

<!-- Line anchors reconciled to the tree read on 2026-07-18. The exact wiring of the mode
     signal (thread from SettingsPanel vs. read connection.active in ProvidersPanel) is an
     implementation choice — confirm in step-02. NO change to provider-key-store.ts,
     provider-registry.ts, rpc.ts, or the crypto substrate. -->

- `src/core/provider-key-store.test.ts` — ADD (the load-bearing verification). A persistent-mode restore round-trip: open the store against a temp dir with an injected fixed key (`loadStoreKey` dep) or a stubbed passphrase provider, `saveKey({provider:"anthropic", apiKey})`, then open a SECOND store instance against the SAME `dir` + same key dep, assert `getKey("anthropic")` / `listKeys()` return the record — proving reopen rehydrates from `provider-keys.enc`. ADD the ephemeral counterpart: `openProviderKeyStore({ mode: "ephemeral" })`, `saveKey`, confirm NO file at `join(dir, PROVIDER_STORE_FILE_NAME)` and that a fresh ephemeral open sees nothing. **Confirm in step-02** whether an equivalent persistent reopen test already exists (Story 5.1's I/O matrix lists "persistent restart → keys decrypt and reload"); if present, EXTEND/assert it explicitly rather than duplicate. NO production-code change in `provider-key-store.ts`.
- `src/ui/settings/ProvidersPanel.tsx` — ADD a run-mode signal. Accept the mode (e.g. a new optional `mode?: ConnectionMode` prop threaded from `SettingsPanel`, OR read `connection.active` here — confirm in step-02). When `mode === "ephemeral"`, render a terse mono informational line above the list (NOT `role="alert"`): "ephemeral session · keys are not remembered after restart". When `persistent` or unknown, render nothing extra — the existing `configured · …last4` display already tells the true story. NO change to the `providers.list/set/remove` calls, the `password` input, the masked display, or the mutation gates.
- `src/ui/settings/SettingsPanel.tsx` — thread the already-loaded mode into `<ProvidersPanel />` (`line 361`) IF the threading approach is chosen: it already fetches `active` via `rpc<ActiveConnectionInfo>("connection.active")` (`248-257`) and holds `active.mode`; pass `mode={active?.mode}` to `ProvidersPanel`. NO other change; `data-testid="settings-panel"`, the section switcher, and connections flow are untouched.
- `src/ui/settings/providers-model.ts` — likely NO change (pure secret-free view-model, no mode concern). Only touch if step-02 chooses to carry the mode through the model rather than as a prop; prefer the prop.
- `src/shared/contract.ts` — NO change. `ConnectionMode` (`384`), `ActiveConnectionInfo.mode` (`395-396`), `ProviderSummary` (`472-476`), and `providers.*` types already exist and are reused verbatim.
- `src/core/provider-key-store.ts`, `src/core/provider-registry.ts`, `src/core/rpc.ts`, `src/core/server.ts`, `src/core/crypto.ts`, `src/core/store-key.ts`, `src/core/passphrase-key.ts` — NO change. Listed to PIN the no-touch boundary: the persistence mechanism, the secret-free registry, the RPC handlers, the shared-passphrase wiring, and the crypto substrate are all preserved invariants.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors (a new optional `mode?: ConnectionMode` prop on `ProvidersPanel` is additive; the reused contract types already compile).
- `bun test` — expected: full suite green, INCLUDING the new/extended `provider-key-store.test.ts` persistent restore round-trip and ephemeral no-persist assertions. **Persistence is fully testable via the store's own unit tests — no Docker, no live database, no container.** The existing `provider-registry` and `providers-model` suites (pure, no DOM) are unaffected by a UI-only mode note.
- `bun run build` — expected: OK (regenerates the UI bundle embedding the mode-aware AI-providers surface).

**Trust-boundary check (grep, mirrors Story 5.1):**
- No `ai`/`@ai-sdk/*` import and no raw-`apiKey` read outside `src/core/`; the AI-providers surface still handles only `ProviderSummary` (secret-free) and the run-mode literal.

**Manual checks (optional — the persistence claim is proven by the unit test, not manual):**
- Persistent (default): Settings → ai providers, set an Anthropic key → `configured · …last4`; restart the app → still configured, no re-entry.
- Ephemeral (`QS_MODE=ephemeral`, the dev-container case): set a key → shows the ephemeral note; restart → `not configured` with the note explaining why; confirm no `provider-keys.enc` was written under the app dir.
