---
title: 'Manage Connections (add, edit, remove)'
type: 'feature'
created: '2026-07-08'
status: 'done'
baseline_revision: '63b813d623506ae6dd0f6b285fde5619e9a08ec5'
final_revision: '4b46267dc5d89457c258c56106f80dc5b5b097b3'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The encrypted credential store (`src/core/credential-store.ts`) exists and is tested, but nothing reaches it: there is no RPC method and no UI, so a developer cannot save, rename, re-point, or delete a Connection. Until connections survive a relaunch without re-entry, quick-studio cannot replace an established manager (FR-6).

**Approach:** Wire the existing store to the UI across the trust boundary — a Core-side connection registry exposing list/add/edit/remove, four typed RPC methods over the existing `/rpc` transport, and a Settings surface (rail-bottom pinned) hosting a Connections management panel. No changes to the store or crypto; this story is a consumer of the substrate built in 2.2/2.3.

## Boundaries & Constraints

**Always:**
- Ring 2 (UI) never receives credential material back from Core. `list`/`add`/`edit` responses carry only credential-free summaries `{ id, name, host, engine }` (host/engine derived from the url; no user, password, or full url). The UI transmits credentials only on an add/edit submit and retains none.
- Reuse the existing wire contract in `src/shared/contract.ts` (`RpcRequest`/`RpcReply`/`RpcErrorEnvelope`, `okReply`/`errorReply`) and the existing `/rpc` transport, token gate, and origin gate. Do not invent a second channel.
- All new RPC handlers validate their own `params` (the boundary passes `params: unknown` unvalidated). Missing/ill-typed params → `bad_request`; unknown id on edit → `not_found`.
- Connection ids are generated Core-side (`randomUUID`) on add — the store upserts by `record.id` and does not mint ids. Edit and remove address an existing id.
- Ephemeral mode writes nothing to disk. Open the store with the run-mode-resolved mode and let the substrate enforce the inverse contract (its ephemeral flush is already a no-op); do not add a second persistence path.
- Microcopy in the Connections UI is mono, lowercase, terse (a status line, not marketing). DB identifiers render verbatim.

**Block If:**
- The wire contract or `/rpc` transport shape must change incompatibly to fit connections CRUD (would break `health`/`shutdown`/`connect` callers).
- Delivering "manage connections" turns out to require the boot-time passphrase-prompt UX (that is Story 2.3/2.5 territory, not owned here).

**Never:**
- Do not modify `credential-store.ts`, `crypto.ts`, `store-key.ts`, or `app-dir.ts` (the substrate is done and reviewed).
- Do not build the keychain/passphrase unlock UX or persist Settings open/closed or workspace state (Story 2.3/2.5).
- Do not connect to a database or validate url scheme here (that is the connect flow, Story 1.3); manage only saves/edits/removes records. Validate url *shape* (`new URL()` parseable) only.
- Do not add a React render/DOM test harness; keep new UI logic in pure, dependency-free modules and test those.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Add (persistent) | mode=persistent, `{ name, url }` shape-valid | id minted; record encrypted + written under app dir; credential-free summary returned | No error expected |
| Add (ephemeral) | mode=ephemeral, valid params | record kept in memory only; no store file created/written | No error expected |
| Add — bad params | empty/whitespace `name`, or `url` not `new URL()`-parseable, or missing field | rejected; nothing written | `bad_request` (detail names the offending field) |
| List | store holds N records | N credential-free summaries `{ id, name, host, engine }`; raw response bytes contain no password/full url | No error expected |
| Edit — rename only | existing id, `{ name }` (no `url`) | stored url unchanged; name updated + re-persisted | No error expected |
| Edit — repoint | existing id, `{ name?, url }` valid | url replaced (re-encrypted); summary reflects new host/engine | `bad_request` on unparseable url |
| Edit — unknown id | id not in store | no mutation | `not_found` |
| Remove — existing | existing id | record + credentials deleted from store; absent from next list | No error expected |
| Remove — absent id | id not in store | idempotent success (matches store no-op) | No error expected |
| Store open fails | persistent, store open returns `unavailable`/`corrupt`/`key-invalid`/passphrase outcome | RPC returns error envelope; no partial write; store not memoized (retryable) | `internal_error` (detail carries the store outcome) |
| Relaunch survival | added in persistent, fresh Core over same app dir | connection present in list without re-entry | No error expected |

</intent-contract>

## Code Map

- `src/core/credential-store.ts` -- REUSE ONLY: `openCredentialStore(deps)`, `StoredConnection {id,name,url}`, `saveConnection`/`getConnection`/`listConnections`/`deleteConnection`, `OpenResult`/`MutationResult` outcomes. Do not modify.
- `src/shared/contract.ts` -- add connections CRUD param/result types + method names; reuse `okReply`/`errorReply`/`RpcErrorCode`.
- `src/core/connection-registry.ts` (new) -- lazy-memoized store open + list/add/edit/remove; mints ids; derives credential-free summaries; validates params; returns `{ ok, value } | { ok:false, code, message, detail }`.
- `src/core/rpc.ts` -- extend `RpcContext` with the registry capability; add `HANDLERS` entries `connections.list/add/edit/remove`; map registry results to `okReply`/`errorReply`.
- `src/core/server.ts` -- construct the registry once in `startCore` (gated by `Core.mode`); wire onto `rpcContext`.
- `src/ui/rpc/client.ts` (new) -- typed `rpc(method, params)` helper: single `fetch("/rpc")` with `x-qs-token`, returns `RpcReply<T>` (replaces inline fetches for the new calls).
- `src/ui/settings/connections-model.ts` (new, pure) -- form + list view-model: validation (name non-empty, url parseable), add/edit/remove transitions over summaries. No React.
- `src/ui/settings/SettingsPanel.tsx` (new) -- Settings surface + Connections panel: list, add/edit forms, remove-with-confirm; wires client + model.
- `src/ui/workspace/Workspace.tsx` -- add rail-bottom pinned Settings control that toggles the Settings surface (a pinned rail item, not a `TabKind`).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `ConnectionSummary {id,name,host,engine}`, `AddConnectionParams {name,url}`, `EditConnectionParams {id,name?,url?}`, `RemoveConnectionParams {id}`, and result types (`list` → `ConnectionSummary[]`, `add`/`edit` → `ConnectionSummary`, `remove` → `{ removed: true }`); keep ring-neutral, no secrets in any result type.
- [x] `src/core/connection-registry.ts` -- implement `createConnectionRegistry(deps)` with lazy memoized `openCredentialStore` (memoize success only; failures retryable), `list/add/edit/remove`; mint id via `randomUUID`; derive summary via `new URL(url)` (protocol→engine, host→host); validate params (name non-empty trimmed, url parseable); map store failures to `{ ok:false, code, message, detail }` (`unavailable`/`corrupt`/`key-*`/passphrase → `internal_error`; unknown id on edit → `not_found`; write-failed → `internal_error`).
- [x] `src/core/connection-registry.test.ts` -- DI a fixed-key temp-dir store (or injected store); cover every I/O matrix row: add persistent+reopen survival, add ephemeral writes nothing, bad params, list summary excludes secret bytes, edit rename-only vs repoint, edit unknown-id `not_found`, remove existing + remove-absent idempotent, store-open-failure mapping. Self-cleaning per project convention.
- [x] `src/core/rpc.ts` -- extend `RpcContext` with `connections`; add the four `HANDLERS` entries; each validates `params` shape then delegates and maps `{ ok }`→`okReply`, else `errorReply(code, message, detail)`.
- [x] `src/core/rpc.test.ts` -- (create if absent) handler-level tests: param validation → `bad_request`, unknown method unaffected, success path returns `okReply` with credential-free result, edit-unknown-id → `not_found`.
- [x] `src/core/server.ts` -- build the registry in `startCore` gated by `options.mode` and thread it onto `rpcContext`; no store open at boot (registry opens lazily on first call).
- [x] `src/ui/rpc/client.ts` -- typed `rpc<T>(method, params?): Promise<RpcReply<T>>` reading `window.__QS_TOKEN__`; central error-envelope handling.
- [x] `src/ui/settings/connections-model.ts` -- pure view-model: list state, draft add/edit form, `validateDraft` (name required, url parseable), reducers for load/add/edit/remove over summaries. No I/O.
- [x] `src/ui/settings/connections-model.test.ts` -- pure tests for validation and every reducer transition.
- [x] `src/ui/settings/SettingsPanel.tsx` -- Connections management UI (list of summaries with host·engine mono, add form, edit form supporting rename-only and repoint, remove with confirm); calls `rpc` client, drives `connections-model`; terse mono microcopy; surfaces error envelopes distinctly.
- [x] `src/ui/workspace/Workspace.tsx` -- add a rail-bottom pinned Settings toggle opening `SettingsPanel`; do not add a `settings` `TabKind`.
- [ ] Regenerate the UI bundle via `bun run build` so `src/core/ui-bundle.generated.ts` reflects the new UI.

**Acceptance Criteria:**
- Given persistent mode and a connection added through the Connections UI, when a fresh Core instance is started over the same app directory, then the connection appears in the list without re-entering its name or url (FR-6).
- Given a saved connection, when the user removes it, then its record and credentials are gone from the encrypted store file and from the next `list` response.
- Given any `list`/`add`/`edit` RPC response delivered to the UI, when its bytes are inspected, then they contain no password and no full credential-bearing url — only `{ id, name, host, engine }`.
- Given the workspace, when the user activates the rail-bottom pinned Settings control, then the Connections list with reachable add, edit, and remove actions is shown.

## Spec Change Log

## Review Triage Log

### 2026-07-08 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 0
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[medium]` `[patch]` Store-open/write failures forwarded the raw underlying `detail` (`err.message` carrying absolute app-dir paths / errno text) across the wire and into the panel, contradicting the dispatch convention against echoing exception messages. `obtain()` now emits `detail: opened.outcome` and `writeFailed()` a fixed `"write-failed"` label — safe outcome labels only, no paths.
  - `[medium]` `[patch]` A hung RPC wedged the panel forever (`busy` never cleared — `fetch` had no timeout). Added a 10s `AbortController` timeout in the RPC client; abort rejects → existing catch maps to `internal_error` → clears `busy`.
  - `[medium]` `[patch]` `list()` threw if any stored record held an unparseable url (disk only checks `typeof string`), taking down the entire connections surface. `list` now wraps per-record `toSummary` in try/catch and degrades a malformed record to empty `host`/`engine` (keeping `id`/`name`); `list` is total.
  - `[low]` `[patch]` `dispatch`'s preformed-reply detection sniffed a structural boolean `ok`, a landmine for any future domain payload carrying `ok`. Replaced with an explicit `PREFORMED` symbol brand + `preformed()` helper on the four `connections.*` handlers; health/shutdown/connect unchanged.
  - `[low]` `[patch]` Add form was enabled during the initial `connections.list` load, so a just-added row could be clobbered when the in-flight list resolved and replaced state. Gated Add/Edit-save/Remove on `!loading`.
  - `[low]` `[patch]` `not_found` (edit unknown id) was returned over HTTP 400. `server.ts` status map now sends `not_found → 404` (`internal_error → 500`, rest → 400).
  - `[low]` `[patch]` `edit({ id })` with an empty patch (no name, no url) re-encrypted + flushed the store for a zero-change edit. Now early-returns the unchanged summary after the `not_found` check, without writing.
  - `[low]` `[patch]` A url that parses but has no host (`foo:bar`, `mailto:x`) was accepted, yielding a blank `host · engine` summary. `checkUrl` (registry) and `validateDraft` (UI model) now reject an empty-host url ("url has no host") — shape validation only, no scheme allowlist (scheme validation stays out of scope per Boundaries).
  - `[low]` `[patch]` The RPC client cast `res.json()` blindly, so a 200 non-envelope body (or non-JSON) would `TypeError` in callers and wedge the panel. Client now validates `typeof body.ok === "boolean"` (and catches `res.json()` throwing) → synthesizes an `internal_error` envelope.
- rejected (representative): connection dedup/uniqueness (a product decision, not spec-mandated; same host with different credentials/db is legitimate — blocking name+url duplicates could be wrong); `fakeRegistry` in `rpc.test.ts` diverging from the real registry semantics (dispatch-level stub by design; registry semantics are covered by its own suite); triplicated name/url validation across model/handler/registry (layered defense-in-depth is intentional; only the messages differ).

### 2026-07-08 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 0
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` `edit()` was not total over a malformed stored url (unlike `list`): its two `toSummary(existing)`/`toSummary(record)` calls were unguarded, so a rename-only or empty-patch edit against a legacy/externally-written record with an unparseable url threw → `internal_error`. Worse, in the rename-only path the `saveConnection` had ALREADY committed the new name to disk before the throw, so on-disk state (renamed) diverged from the reply (error) — a persisted mutation reported as a failure, and the record became un-renameable from the UI. Added a `safeSummary` helper (the degrade-not-throw variant `list` already used inline) and routed both `edit` read-back returns and `list` through it; `add` keeps strict `toSummary` (its url just passed `checkUrl`). Regression tests cover rename-only + empty-patch over a legacy unparseable-url record.
  - `[low]` `[patch]` `SettingsPanel` could mutate against a phantom-empty list: if the mount-time `connections.list` errored, `loading` still cleared but `state.connections` stayed empty, so Add would fork a duplicate store record and Edit/Remove silently no-op'd. Added a `listLoaded` flag (set only on a successful list) and gated Add/Edit-save/Remove (and the Add button `disabled`) on it.
  - `[low]` `[patch]` `checkUrl` validated emptiness on `url.trim()` but returned/persisted the untrimmed original, so a direct `/rpc` caller could round-trip surrounding whitespace to disk. `checkUrl` now parses and returns the trimmed value; regression test asserts the stored url is trimmed.
  - `[low]` `[patch]` The credential-free trust-boundary tests asserted secret absence only by substring (`not.toContain`), which would pass a summary that leaked a differently-valued field. Added exact key-set assertions (`Object.keys(...) === {id,name,host,engine}`) on the `list` and `edit` (repoint) summaries.
- rejected (representative): success-memoized store not re-detecting out-of-band on-disk deletion/corruption (by-design per Design Notes "memoize success only", mirrors `connection.ts`); no `name`/`url` length bound (no spec requirement; local token-gated single-user app — not a real threat); RPC client's `detail: err.message` surfacing a raw fetch/abort message (browser-local, does NOT cross the Core→UI boundary — Edge Case Hunter concurred it is not a finding); `EditRow` draft seeded once from `summary.name` (no realistic concurrent-prop-change trigger in the single-user flow); duplicated url-shape validation in model vs registry (intentional layered defense — already rejected in the prior pass); `list`'s broad `catch` degrading any `toSummary` error (serves the totality contract by design); `not_found` `detail: id=<id>` reflecting the caller's own input back (the id is a Core-minted UUID, and echoing a caller's own request value to that same caller is not a leak).

## Design Notes

- **Consumer, not modifier.** All crypto/persistence/keychain logic stays in the untouched substrate. This story adds a Core registry (the sole store-holder), an RPC surface, and UI — mirroring the existing `connect` capability wiring (`contract.ts` type → `RpcContext` capability → `HANDLERS` entry → `server.ts` impl).
- **Trust boundary is credential-flow-directional.** Credentials flow UI→Core only on submit (the user typed them); Core→UI results are always credential-free summaries. This is why `edit` accepts a partial `{ id, name?, url? }`: rename sends `name` only (Core keeps the stored url the UI never held); changing credentials requires re-entering the full url. Deriving `host`/`engine` for the summary uses `new URL(url)` in Core.
- **Lazy, retryable store open.** The registry opens the store on first call and memoizes only success (like `connection.ts`), so a transient `unavailable` does not permanently poison the surface. Store-open failures surface as an `internal_error` envelope with the store outcome in `detail`; building the boot-time passphrase-prompt UX is explicitly out of scope (2.3/2.5).
- **Error mapping (single place, in the registry):** `bad_request` (param validation), `not_found` (edit unknown id), `internal_error` (store `unavailable`/`corrupt`/`key-*`/passphrase/`write-failed`). Remove is idempotent-ok to match the store's absent-id no-op.
- Registry result shape: `type RegistryResult<T> = { ok: true; value: T } | { ok: false; code: RpcErrorCode; message: string; detail?: string }` — handlers translate directly to `okReply`/`errorReply`.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors (strict, `noUncheckedIndexedAccess`, explicit `.ts`/`.tsx` imports).
- `bun test` -- expected: full suite green including the new `connection-registry`, `rpc`, and `connections-model` tests; no residual keychain entries or leftover temp store files.
- `bun test src/core/connection-registry.test.ts src/core/rpc.test.ts src/ui/settings/connections-model.test.ts` -- expected: all pass, deterministic, self-cleaning.
- `bun run build` -- expected: UI bundle regenerates cleanly (`src/core/ui-bundle.generated.ts` updated).

**Manual checks:**
- Launch persistent mode, open Settings from the rail bottom, add a connection, relaunch: it is listed without re-entry. Edit (rename), then repoint (new url). Remove it. Open `credential-store.enc` in a hex/text viewer after each save: confirm no plaintext `name`/`url` and no key — only base64 ciphertext/iv/authTag.

## Auto Run Result

Status: done

**Implemented change:** Wired the existing encrypted credential store to the UI across the Ring 1/Ring 2 trust boundary — a Core-side connection registry (list/add/edit/remove, Core-minted ids, credential-free `{id,name,host,engine}` summaries), four typed `connections.*` RPC methods over the existing `/rpc` transport, and a rail-bottom pinned Settings surface hosting a Connections management panel (list, add, inline edit supporting rename-only and repoint, remove-with-confirm). The store/crypto substrate (2.2/2.3) was consumed, not modified. Ephemeral mode writes nothing (substrate enforces the inverse contract).

**Files changed:**
- `src/shared/contract.ts` -- added credential-free connections CRUD param/result types.
- `src/core/connection-registry.ts` (new) -- lazy success-memoized store open; list/add/edit/remove; id minting; `new URL()` summary derivation; param + host-shape validation; safe error mapping (no path leakage); total `list`.
- `src/core/connection-registry.test.ts` (new) -- full I/O-matrix + patch-guard coverage.
- `src/core/rpc.ts` -- `RpcContext.connections`; four `connections.*` handlers with param validation; symbol-branded preformed-reply dispatch.
- `src/core/rpc.test.ts` -- connections dispatch + validation tests.
- `src/core/server.ts` -- registry constructed in `startCore` (mode-gated, lazy open); `not_found → 404` status mapping.
- `src/ui/rpc/client.ts` (new) -- typed `/rpc` client with 10s timeout + envelope-shape validation.
- `src/ui/settings/connections-model.ts` (new, pure) + test -- draft/list view-model + validation.
- `src/ui/settings/SettingsPanel.tsx` (new) -- Connections management UI.
- `src/ui/workspace/Workspace.tsx` -- rail-bottom pinned Settings toggle (not a TabKind).
- `src/core/ui-bundle.generated.ts` -- regenerated (gitignored artifact).

**Review findings:** 9 patches applied (0 high / 3 medium / 6 low), 0 deferred, 3 rejected, 0 intent_gap, 0 bad_spec. No review repair loopback. Details in the Review Triage Log above.

**Verification:**
- `bunx tsc --noEmit` -- clean (exit 0).
- `bun test` -- 329 pass / 0 fail, 759 assertions, 21 files.
- `bun test src/core/connection-registry.test.ts src/core/rpc.test.ts src/ui/settings/connections-model.test.ts` -- 46+ pass, deterministic, self-cleaning.
- `bun run build` -- succeeded; UI bundle regenerated.

**Follow-up review recommended:** true — the patch batch spans 6 files and includes a core-path change (symbol-branded RPC dispatch), a trust-boundary fix (error-detail path leakage), and a totality fix (`list`); breadth and consequence warrant an independent follow-up pass.

**Residual risks:** No React render/DOM test harness exists (project convention), so the Settings/Connections UI wiring is verified via the build embedding the bundle and pure-model tests, not rendered-component tests — the final AC (rail-bottom Settings reachability) rests on manual inspection. Boot-time keychain/passphrase unlock UX is intentionally out of scope (Story 2.3/2.5); a store that cannot open surfaces `internal_error` with a safe label.

---

### Follow-up review pass (2026-07-08)

An independent follow-up review (Blind Hunter + Edge Case Hunter, no prior context) was run over the full baseline→HEAD diff. Both reviewers converged on one finding with real teeth; the rest were low-consequence.

**Patches applied (4: 0 high / 1 medium / 3 low):**
- `[medium]` `edit()` totality gap: unguarded `toSummary` on the rename-only/empty-patch read-back threw on a legacy malformed-url record — and in the rename path the write had already committed, so on-disk state diverged from an `internal_error` reply. Fixed via a shared `safeSummary` (degrade-not-throw) now used by both `edit` returns and `list`. `src/core/connection-registry.ts` (+ regression tests).
- `[low]` `SettingsPanel` mutation-against-phantom-list after a failed mount list: added a `listLoaded` gate on Add/Edit/Remove. `src/ui/settings/SettingsPanel.tsx`.
- `[low]` `checkUrl` persisted the untrimmed url: now returns the trimmed value. `src/core/connection-registry.ts` (+ test).
- `[low]` Trust-boundary tests strengthened with exact key-set assertions on `list`/`edit` summaries. `src/core/connection-registry.test.ts`.

**Rejected (7, all low):** success-memoize staleness (by-design), no length bound (out of scope, local single-user), client-side `err.message` (does not cross the Core→UI boundary), `EditRow` prop-staleness (no realistic trigger), duplicated url validation (intentional layered defense), `list` broad catch (serves totality), `not_found` echoing caller's own id (not a leak). No intent_gap, no bad_spec, nothing deferred.

**Verification:** `bunx tsc --noEmit` clean (exit 0); `bun test` 332 pass / 0 fail (771 assertions, 21 files); `bun run build` regenerated the UI bundle cleanly.

**Follow-up recommended:** false — the fixes are localized (1 medium + 3 low), each backed by a regression test, with no contract/API/security/data-loss impact. The prior pass's follow-up recommendation is now discharged.
