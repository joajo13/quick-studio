---
title: 'Configure AI Providers with user-supplied API keys'
type: 'feature' # feature | bugfix | refactor | chore
created: '2026-07-11'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
baseline_revision: '178ec54c9704ea990b8718de210b2862d31cbf63'
final_revision: 'eab1fa6b1705266709de34059b97b16f6a95193e'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** quick-studio has no way to configure the AI providers (Anthropic, OpenAI, Google Gemini) the AI Chat epic depends on. Users must be able to supply their own API keys and have them protected exactly like database credentials, with the keys reachable only from the Core.

**Approach:** Add a Core-only provider-key store that mirrors the Epic 2 encrypted credential substrate (encrypted at rest in Persistent mode, in-memory only in Ephemeral mode), expose `providers.*` RPC methods returning secret-free summaries, add a "AI providers" section to Settings to set/replace/remove keys, and establish the unified AI layer seam (`ai-provider.ts`, Vercel AI SDK) so a configured provider is reachable from Ring 1 only. No chat, no network calls yet.

## Boundaries & Constraints

**Always:**
- Provider API keys live only in Ring 1 (Core). They are never returned to Ring 2/3 (summaries are secret-free; at most a last-4 `keyPreview`), never logged, never placed in error `detail`.
- Persistent mode → keys encrypted at rest with AES-256-GCM, reusing the Epic 2 substrate (`crypto.ts`, `store-key.ts`, passphrase fallback). Ephemeral mode → in-memory only, zero disk writes (mirror the credential-store ephemeral gate).
- All provider access goes through the unified AI layer (`src/core/ai-provider.ts`). No `@ai-sdk/*` or `ai` import may appear outside `src/core/`.
- Mirror established patterns: `RegistryResult`/`RpcReply`, `preformed(toReply(...))`, own-key `HANDLERS` entries, lazy+memoize-on-success registry, atomic writes (temp + rename, `0o600`), total functions returning typed unions, and a co-located `*.test.ts` for every pure module.
- Identity is the provider kind: at most one key per kind. `providers.set` upserts; `providers.remove` is idempotent.

**Block If:**
- The Vercel AI SDK packages (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`) cannot be installed at versions compatible with the Bun + TypeScript toolchain.

**Never:**
- No chat UI, NL→query, streaming, or any provider network call — those are Story 5.2+. `ai-provider.ts` only constructs model handles; it does not invoke them.
- No live (network) API-key validation.
- Do not store provider keys inside `StoredConnection`/`credential-store.enc`; do not add zod, shadcn, or any new UI library.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Set key (persistent) | `providers.set {provider:"anthropic", apiKey}` | Record encrypted to `provider-keys.enc`; `list` shows `{provider, keyPreview}`; raw key never returned | No error expected |
| Set key (ephemeral) | same, `QS_MODE=ephemeral` | Held in memory; no file written under app dir; `list` shows it this session only | No error expected |
| Replace existing | `set` for already-configured kind | Upsert — old key overwritten, still one record for that kind | No error expected |
| Remove | `providers.remove {provider}` then again | First removes; second is a no-op success (idempotent) | No error expected |
| List none | no keys configured | `{ providers: [] }` | No error expected |
| Invalid input | empty/blank `apiKey` or unknown `provider` | Nothing stored | `errorReply("bad_request", …)`, no secret echoed |
| Resolve unknown | `ai-provider.resolveModel("bogus", key)` | — | typed `{ok:false}` result, no throw |
| Persistent restart | app restarts, persistent mode | keys decrypt and reload | corrupt/wrong-key → typed store failure, not crash |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- add `ProviderKind` enum + `providers.*` param/result/summary types (mirror `DbEngine`, `RpcReply`, secret-free summary rule)
- `src/core/credential-store.ts` -- reference skeleton to mirror (ephemeral gate, unlock dance, atomic flush, schema version)
- `src/core/crypto.ts`, `src/core/store-key.ts`, `src/core/passphrase-key.ts`, `src/core/passphrase-provider.ts`, `src/core/run-mode.ts`, `src/core/app-dir.ts` -- reused primitives (do not modify)
- `src/core/connection-registry.ts` -- reference for the RPC-facing registry (validation, secret-free summaries, memoized lazy open)
- `src/core/rpc.ts` -- `RpcContext` + `HANDLERS` dispatch table; add `providers` capability + methods
- `src/core/server.ts` -- constructs registries into `rpcContext`; add the provider registry
- `src/ui/rpc/client.ts`, `src/ui/rpc/envelope-text.ts` -- UI RPC call + error formatting (reused)
- `src/ui/settings/connections-model.ts`, `src/ui/settings/SettingsPanel.tsx` -- reference model + panel to mirror
- `package.json` -- add AI SDK dependencies

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- install `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` via `bun add` (architecture targets `ai` v7, `@ai-sdk/*` v4) -- provides the unified AI layer; Block If incompatible with toolchain
- [x] `src/shared/contract.ts` -- add `PROVIDER_KINDS = ["anthropic","openai","google"] as const` + derived `ProviderKind`; `SetProviderParams`, `RemoveProviderParams`, `ProviderSummary {provider, keyPreview}`, `ListProvidersResult {providers: ProviderSummary[]}` -- typed, secret-free wire contract
- [x] `src/core/provider-key-store.ts` (+ `.test.ts`) -- mode-aware encrypted store mirroring `credential-store.ts`: `StoredProviderKey {provider, apiKey}`, own `provider-keys.enc` + schema version, ephemeral in-memory gate, atomic persistent flush, reusing crypto/store-key/passphrase/run-mode/app-dir -- the secure secret home
- [x] `src/core/provider-registry.ts` (+ `.test.ts`) -- RPC-facing registry mirroring `connection-registry.ts`: validate provider kind + non-blank key (`bad_request`), upsert-by-kind `set`, idempotent `remove`, `list` → secret-free summaries with last-4 `keyPreview`, `getKey(kind)` for Core-internal use, memoized lazy open -- validation + secret-free boundary
- [x] `src/core/ai-provider.ts` (+ `.test.ts`) -- unified AI layer: `resolveModel(provider, apiKey)` maps a `ProviderKind` + key to a Vercel AI SDK provider/model handle; unknown kind → typed failure; NO network call -- the AR-17 seam Ring-1 only
- [x] `src/core/rpc.ts` -- add `providers: ProviderRegistry` to `RpcContext`; add own-key `HANDLERS` entries `providers.list` / `providers.set` / `providers.remove` (shape-check params via `asParamsObject`, delegate, wrap in `preformed(toReply(...))`)
- [x] `src/core/server.ts` -- construct `createProviderRegistry({ storeDeps: { mode } })` and add it to `rpcContext`
- [x] `src/ui/settings/providers-model.ts` (+ `.test.ts`) -- pure view-model mirroring `connections-model.ts`: state, `Draft`, `validateDraft`, reducers (`loadProviders`, `applySet`, `applyRemoved`) -- React-free, unit-tested
- [x] `src/ui/settings/SettingsPanel.tsx` (+ sibling `ProvidersPanel.tsx`) -- render an "ai providers" section listing the three kinds with configured state + `keyPreview`, an input to set/replace a key, and a remove action; wire `rpc<ListProvidersResult>("providers.list")` on mount and `providers.set`/`providers.remove` mutations with `busy`/`loading`/`error` flags mirroring connections

**Acceptance Criteria:**
- Given a provider and my own API key, when I save it in Settings, then it is stored by the Core, appears as configured, and becomes selectable for a future chat — reached only through the unified AI layer, never called from Ring 2/3.
- Given Persistent mode, when a provider key is stored, then it is encrypted at rest under the same substrate as database credentials and reloads after a restart.
- Given Ephemeral mode, when a key is supplied, then it is session-only and in-memory, no file is written under the app data dir, and it is gone after restart.
- Given any RPC response or log line, when a provider is configured, then the raw API key never appears (only a last-4 `keyPreview`).

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 0
- reject: 7
- addressed_findings:
  - `[medium]` `[patch]` passphrase-fallback path of `provider-key-store.ts` was entirely untested — added first-run seed, same-passphrase round-trip, wrong-passphrase→corrupt, declined→nothing-written, and `.enc`-removed→corrupt tests
  - `[low]` `[patch]` `keyPreview` exposed the whole key for keys ≤4 chars — `toSummary` now collapses to a bare ellipsis for short keys
  - `[low]` `[patch]` passphrase reopen with descriptor present but `.enc` removed silently opened an empty store (any passphrase accepted) — added `existsSync` guard returning `corrupt`
  - `[low]` `[patch]` `saveKey` stored the caller's record by reference — now stores a defensive copy
  - `[low]` `[patch]` Settings save/remove were enabled before the list loaded (silent no-op) — `canSave`/remove now gated on `listLoaded` (`ready`)
  - `[low]` `[patch]` typed API key was retained in Ring 2 draft state after a failed set — draft now cleared regardless of outcome
- rejected (noise/by-design): `resolveModel` empty-key deferred to invoke-time (documented, no live caller); unmount-setState in mutations (React 19 tolerant); hardcoded default model IDs (no network by design); dep versions within caret range; boundary enforced by grep not lint; `RegistryResult<T>` structural duplication; read-error-without-code classified `corrupt`

## Design Notes

- **Store the whole record encrypted** (the key is embedded), exactly as `credential-store.ts` encrypts `StoredConnection`. Simplest safe reuse: share the same keychain master key (same service/account) so one unlock covers both stores; in passphrase mode each `.enc` carries its own salt descriptor. Do not merge into the connections payload.
- **Identity = provider kind.** `list` returns only configured providers as secret-free summaries; the UI knows the three kinds statically and overlays "not configured" for the rest.
- `resolveModel` shape (no network):
```ts
// returns a handle the future chat (5.2) calls; here only construct + type-check
export function resolveModel(provider: ProviderKind, apiKey: string): ResolveModelResult {
  switch (provider) {
    case "anthropic": return { ok: true, model: createAnthropic({ apiKey })("claude-...") };
    // openai / google similarly
    default: return { ok: false, code: "unknown_provider" };
  }
}
```

## Verification

**Commands:**
- `bun test` -- expected: all suites pass, including new `provider-key-store`, `provider-registry`, `ai-provider`, `providers-model` tests covering the I/O matrix (persistent/ephemeral, upsert, idempotent remove, bad_request, secret-free summaries)
- `bunx tsc --noEmit` -- expected: no type errors

**Manual checks (if no CLI):**
- Run the app, open Settings → AI providers, set an Anthropic key: it shows as configured with a last-4 preview; the RPC response body contains no raw key.
- Restart in Persistent mode (default): the provider is still configured. Restart with `QS_MODE=ephemeral` after setting a key: it is gone and no `provider-keys.enc` was written.

## Auto Run Result

Status: done

**Summary.** Added user-configurable AI providers (Anthropic / OpenAI / Google). Provider API keys are stored Core-only, encrypted at rest in Persistent mode (reusing the Epic 2 substrate — shared keychain master key or passphrase fallback) and in-memory only in Ephemeral mode, exposed over `providers.list/set/remove` RPC as secret-free summaries, configured from a new "ai providers" Settings section, and reachable through a unified AI layer (`ai-provider.ts`, Vercel AI SDK) that lives in Ring 1 only. No chat, no network calls — that is Story 5.2+.

**Files changed:**
- `src/shared/contract.ts` -- `PROVIDER_KINDS`/`ProviderKind` + `providers.*` param/result/secret-free summary types
- `src/core/provider-key-store.ts` (+ test) -- mode-aware AES-256-GCM store mirroring `credential-store.ts`; own `provider-keys.enc`/meta + schema version; ephemeral hard no-write; passphrase-reopen `.enc`-missing guard
- `src/core/provider-registry.ts` (+ test) -- RPC-facing registry: validation, upsert-by-kind, idempotent remove, secret-free summaries (short-key preview masked), Core-internal `getKey`
- `src/core/ai-provider.ts` (+ test) -- unified AI layer seam `resolveModel` (construction only, no network)
- `src/core/rpc.ts` -- `providers` capability + `providers.list/set/remove` handlers
- `src/core/server.ts` -- constructs the provider registry into the RPC context
- `src/ui/settings/providers-model.ts` (+ test) -- pure view-model
- `src/ui/settings/ProvidersPanel.tsx` -- Settings "ai providers" section (password input, draft cleared on submit, mutations gated on list load)
- `src/ui/settings/SettingsPanel.tsx` -- connections/ai-providers switcher
- `package.json` -- `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`

**Review findings.** 6 patches applied (1 medium: untested passphrase-fallback path → tests added; 5 low: short-key preview leak, `.enc`-missing silent-accept guard, defensive record copy, list-load gating on the Save/Remove buttons, draft-key cleared on failed submit). 0 intent gaps, 0 bad_spec loopbacks, 0 deferrals. 7 findings rejected as noise/by-design. Follow-up review not recommended — fixes are localized hardening + tests, no behavior/API/security regressions.

**Verification.** `bunx tsc --noEmit` clean. `bun test` → 661 pass / 0 fail across 37 files (4 new passphrase-fallback tests). Trust boundary grep confirms zero `ai`/`@ai-sdk/*` imports outside `src/core/`.

**Residual risks.** Default model IDs in `ai-provider.ts` are unvalidated until invoked (Story 5.2). The Ring-1-only import boundary is grep-verified, not lint-enforced. Live API-key validation is intentionally out of scope.
