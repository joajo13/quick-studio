# Deferred Work

Append-only ledger of issues surfaced during review that are intentionally deferred (not caused by the current story, or out of its scope). Triaged later by focused attention.

### DW-1: Follow-up review still recommended for 4-2-persist-erd-layout after the review budget was exhausted
origin: review-budget-followup
source_spec: `spec-4-2-persist-erd-layout.md`
severity: low
reason: Review budget (3 cycles) was exhausted with the story finalized (status: done, verify green) while the review pass kept recommending an independent follow-up. The work was committed by bmad-loop run 20260710-224752-6cf5; this entry preserves the lingering follow-up recommendation for a deliberate later review.
status: open

### DW-2: Harden the per-boot token against same-machine processes and add a Content-Security-Policy (with a nonce for the inline token script) once stories render database content

origin: migrated from legacy ledger (code review of spec-1-1-walking-skeleton.md), 2026-07-12
location: `src/core/server.ts` (GET / token handoff, `window.__QS_TOKEN__`)
reason: The token is served in cleartext at the ungated `GET /` (the spec's chosen browser handoff), so any local process can scrape it; and `window.__QS_TOKEN__` is script-readable, so a future stored-XSS in rendered DB data could exfiltrate it. Both matter only once data rendering (Epic 3/5) exists; the walking skeleton renders no untrusted data.
status: open

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
status: open

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
status: open

### DW-11: Validate the macOS keychain path for `@napi-rs/keyring` under Bun (a `macos-latest` CI leg + a decision-record row) before the product ships a signed macOS build that relies on the keychain key-management path

origin: migrated from legacy ledger (code review of spec-2-1-keyring-spike.md), 2026-07-12
location: CI matrix / `@napi-rs/keyring` (macos-latest leg, keychain round-trip)
reason: The product targets macOS (`bun.lock` ships all `@napi-rs/keyring-darwin-*` binaries) but Story 2.1's CI matrix is deliberately `ubuntu + windows` per spec, so the macOS Keychain round-trip and compiled-binary native load are unproven. GitHub macOS runners have notoriously locked keychains, making it exactly the leg most likely to need special provisioning; leaving it unvalidated means a macOS user could silently land on the passphrase fallback (or worse) with no per-platform go/no-go on record.
status: open

### DW-12: Decide, in Story 2.2's key-load path, whether a keychain entry that round-trips as an empty string (`""`) should be treated as a valid key or rejected as effectively `not-found`; the Ring-1 wrapper currently returns `found` with `value: ""`

origin: migrated from legacy ledger (code review of spec-2-1-keyring-spike.md), 2026-07-12
location: `getSecret` (keyring spike wrapper)
reason: `getSecret` only maps `null`/`undefined` to `not-found`, so a stored empty string surfaces as a legitimate `found` result. That is faithful for a generic wrapper, but an empty AES-256 key is never valid; the guard belongs in Story 2.2's key validation, not in the spike wrapper (patching it here would risk masking a legitimately-stored empty value). Latent until the real store loads keys.
status: open

### DW-13: In Story 2.2's durable keychain API, distinguish an invalid-argument error (e.g. empty/blank `service` or `account` making `new Entry()` throw) from a genuine backend-unavailable condition, rather than letting the wrapper's catch-all classify every non-not-found throw as `unavailable`

origin: migrated from legacy ledger (code review of spec-2-1-keyring-spike.md), 2026-07-12
location: `setSecret` / `getSecret` / `deleteSecret` (keyring spike wrapper)
reason: `setSecret`/`getSecret`/`deleteSecret` route any thrown error that isn't recognized as not-found straight to `unavailable`, so a programming error (bad service/account) would masquerade as a missing keychain backend and silently trigger Story 2.3's passphrase fallback instead of surfacing the bug. Harmless in Story 2.1 (service/account are hardcoded non-empty constants), but once 2.2 accepts caller-supplied identifiers an argument bug would be indistinguishable from a real keychain outage.
status: open

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
status: open

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
status: open

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
status: open

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
status: open

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
status: open

### DW-29: Project the Postgres `Driver.query` read path from positional column descriptors instead of a name-keyed row object, so duplicate/aliased column names in a future raw-SQL result are not collapsed (MySQL's `rowsAsArray` path already returns positional arrays)

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `driver-postgres.ts` (`query`, `cols.map(c => row[c.name])`)
reason: `driver-postgres.ts` `query` builds each row via `cols.map(c => row[c.name])` on postgres.js's name-keyed row object; two same-named result columns collapse to one value, and the two engines diverge (mysql2 uses `rowsAsArray:true`). The browse SELECT can never trigger it (single-table columns are unique), but `Driver.query`/`quoteIdent` is the shared seam the Story 3.6 raw-SQL path will reuse, where aliased/duplicate columns are common. Latent until raw SQL exists; the fix is an engine-adapter change (postgres.js `.values()`), not a browse-behavior bug.
status: open

### DW-30: Type-color and align result-grid columns by their SQL `dataType` (numeric/decimal/bigint → number), not only by the neutral `FrozenCell` kind, so string-encoded numeric columns are not rendered as TEXT — the same SQL-type plumbing the deferred `t-json` color needs

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `naturalKind` (`frozen-map.ts`); `DataGrid.tsx`
reason: postgres.js returns `numeric`/`decimal`/`int8` and mysql2 returns `DECIMAL`/`BIGINT` as JS strings (and `bigint` is deliberately forced to string for precision), so `naturalKind` in `frozen-map.ts` classifies them `string`; `DataGrid.tsx` then labels them `TEXT`, left-aligns, and drops `tabular-nums`. Values are correct — only the header type/alignment is wrong. The spec deliberately colors by neutral kind (and already defers `t-json` for the same reason); fixing both needs the SQL `dataType` carried alongside the result columns, a contract/plumbing decision beyond this story.
status: open

### DW-31: Report a composite `SchemaTableInfo.primaryKey` in the key's own ordinal order (`ORDER BY ordinal_position` in both PK introspection queries) rather than in table-column order

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `assembleSchema` (`driver.ts`, PK introspection queries)
reason: `assembleSchema` builds `primaryKey` by pushing PK column names in the columns query's schema/table/ordinal order gated by a membership Set, and neither the Postgres nor MySQL PK query orders by `ordinal_position`. For a composite PK whose key order differs from column order (PK `(b,a)` with `a` earlier in the table), `primaryKey` is `["a","b"]` — misreported. Pagination stays correct (the ORDER BY set is still total/deterministic) and the grid PK icon (membership-based) is unaffected, so it is invisible in Story 3.2; it matters once a consumer relies on PK column order (e.g. Story 3.3 row edit/where-clause construction).
status: open

### DW-32: Acknowledge (and, if desired, mitigate with keyset/snapshot pagination) that the `table.rows` COUNT and page SELECT are two non-atomic round-trips, so `total` and page contents can disagree — and OFFSET pages can drift — under concurrent writes to the browsed table

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `tableRows` (`server.ts`)
reason: `server.ts` `tableRows` issues `connectionManager.query(countSql)` then `query(selectSql)` with no shared snapshot/transaction; a concurrent insert/delete between them (or before the offset) makes `total` inconsistent with the returned page and shifts OFFSET-based pages. This is inherent to OFFSET pagination rather than a defect in the composition, and this is a read-only browse of a live DB (staleness is expected), so it is a known-limitation note rather than a Story 3.2 bug; keyset (seek) pagination on the PK is the durable fix if it becomes user-visible.
status: open

### DW-33: Make the keyless-table (no-PK) browse ordering robust — the static `UNORDERABLE_TYPE_PREFIXES` heuristic in `table-rows.ts` can both silently omit `ORDER BY` (rows overlap/skip across pages) and emit an `ORDER BY` the engine rejects (hard `internal_error`, blank grid), depending on the table's column types

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `isOrderable` / `UNORDERABLE_TYPE_PREFIXES` (`src/core/table-rows.ts`)
reason: `isOrderable` classifies orderability by a hardcoded type-prefix denylist. For a PK-less table it either (a) filters out every column and omits `ORDER BY` entirely — so two separate page requests can return rows in different physical orders (overlap/skip, silent corrupt paging even with no concurrent writes) — or (b) passes a column that *looks* orderable but has no default ordering operator (Postgres `USER-DEFINED`/composite/`record`/`tsvector`/`pg_lsn`, `ARRAY`, or MySQL variants the prefix list misses such as `mediumblob`), so the composed `ORDER BY` throws at the DB and the whole page collapses to `internal_error` instead of degrading. Only affects keyless tables with exotic column types (PK tables order by the PK and are unaffected); the robust fix is a design decision — engine-aware orderability (which would leak ordering semantics into the driver seam), catch-and-degrade, or keyset pagination — not a mechanical widening of the prefix list. Distinct from the non-atomic COUNT/SELECT drift entry (that is concurrent-write staleness; this is a non-total page order / hard failure under zero writes).
status: open

### DW-34: Decide how a `timestamp without time zone` value should be represented in the neutral FrozenCell model — `rowsToFrozenData` stamps a UTC `Z` ISO string on every JS `Date`, so a tz-less wall-clock timestamp is displayed as though it were UTC

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `rowsToFrozenData` / `toIsoUtc` (`frozen-map.ts`)
reason: `frozen-map.ts` routes any `Date` through `toIsoUtc`, which serializes with a `Z`/UTC suffix. A Postgres `timestamp without time zone` (and MySQL `DATETIME`) carries no timezone, but postgres.js/mysql2 hand it back as a JS `Date`; tagging it UTC asserts a timezone the column does not have, shifting displayed times for any non-UTC-intending data. Genuine `timestamptz` round-trips correctly; the gap is representational and only visible for naive-timestamp columns. Correcting it needs a contract decision (carry a naive-vs-aware distinction, or the SQL `dataType`) rather than a one-line mapper tweak — adjacent to the deferred SQL-`dataType`-aware typing item.
status: open

### DW-35: Preserve MySQL `BIGINT` precision in the browse read path — the mysql2 connection uses default numeric handling, so a `BIGINT` above 2^53 comes back as a precision-lossy JS number and is displayed rounded

origin: migrated from legacy ledger (code review of spec-3-2-browse-rows-pagination.md), 2026-07-12
location: `driver-mysql.ts`; `naturalKind` (`frozen-map.ts`)
reason: `driver-mysql.ts` opens the connection without `supportBigNumbers`/`bigNumberStrings`, so mysql2 decodes `BIGINT` columns to JS `number`; `frozen-map.ts` `naturalKind` then classifies the finite number as `"number"` and emits it verbatim, so a value like `9007199254740993` renders as `…992`. The mapper's bigint→string safety net only fires when the driver returns an actual `bigint`, which this config never produces for `BIGINT`. Rare (values beyond 2^53) and a driver-config/typing decision (enable big-number strings, or carry the SQL `dataType`) rather than a browse-composition bug; postgres.js already returns `int8` as a string and is unaffected.
status: open

### DW-36: Bound the FETCH (not just the display slice) for auto-classified raw reads — push a `LIMIT MAX_RESULT_ROWS + 1` or use a server cursor so a `SELECT * FROM huge_table` cannot materialize the whole result set into Core memory before the 1000-row cap applies

origin: migrated from legacy ledger (code review of spec-3-1-guarded-core-executor.md), 2026-07-12
location: `executeRaw` / `toRowsResult` (`executor.ts`)
reason: Reviewer severity: medium. `executor.ts` `executeRaw` read path runs `runReadOnly(stmt, [])` then `toRowsResult` slices to `MAX_RESULT_ROWS` AFTER the driver (postgres.js / mysql2) has already buffered every row in memory. The Core-side cap only bounds the response payload, not the fetch, so a large read OOMs the Core process. Story 3.1 explicitly scopes DB-side pagination/`LIMIT` to Story 3.2 ("a Core-side row cap is the only responsiveness measure here"), so this is a known-limitation deferral to the pagination story, not a 3.1 defect — but the current cap gives no memory protection.
status: open

### DW-37: Make the structured `createTable` type/constraint allowlist engine-aware — postgres-only tokens (`UUID`, `JSONB`, `TIMESTAMPTZ`, `SERIAL`, …) and bare `VARCHAR` (no length) compose invalid DDL on MySQL and fail opaquely at the engine

origin: migrated from legacy ledger (code review of spec-3-1-guarded-core-executor.md), 2026-07-12
location: `CREATE_TABLE_TYPES` / `executeCreateTable` (`executor.ts`)
reason: Reviewer severity: low. `executor.ts` `CREATE_TABLE_TYPES` is a single engine-blind allowlist; `executeCreateTable` emits the validated token verbatim. On MySQL a "valid" structured `createTable` carrying `UUID`/bare `VARCHAR` composes DDL the engine rejects → `internal_error`. Not a safety hole (values are still parameterized, identifiers quote-escaped, and it fails closed at the engine with no raw-text echo), purely a contract-quality gap; the fix is to gate/map type tokens per engine.
status: open

### DW-38: Map postgres raw-read result rows positionally (array row-mode) rather than by column name, so a `SELECT` with duplicate output column names (`SELECT id, id`, `a.id, b.id`) does not collapse same-named columns to a single (last) value

origin: migrated from legacy ledger (code review of spec-3-1-guarded-core-executor.md), 2026-07-12
location: `driver-postgres.ts` (`query`, pre-existing from Story 3.2)
reason: Reviewer severity: low. The postgres adapter (`driver-postgres.ts`, pre-existing from Story 3.2's `query`) builds row values keyed by column name; a raw `SELECT` can produce duplicate output names, and the object-keyed mapping then shows the last value for every duplicate, losing the distinct columns' data. Invisible for Story 3.2 browse (real table columns are unique); Story 3.1 exposes it by routing arbitrary raw `SELECT`s through the same mapping. Fix: use postgres.js array/`values()` row mode and align to the ordered column metadata (mysql already uses `rowsAsArray`).
status: open

### DW-39: Document (or make configurable) the raw-SQL splitter's assumption of default session SQL modes — it assumes postgres `standard_conforming_strings = on` and MySQL default `sql_mode` (no `NO_BACKSLASH_ESCAPES`, no `ANSI_QUOTES`); non-default modes shift string/identifier boundaries

origin: migrated from legacy ledger (code review of spec-3-1-guarded-core-executor.md), 2026-07-12
location: `executor.ts` (raw-SQL splitter)
reason: Reviewer severity: low. `executor.ts` splitter activates backslash-escaping only for mysql strings and postgres `E'…'` strings. Under postgres `standard_conforming_strings=off`, plain `'…'` strings become backslash-active → splitter over-counts (valid statement falsely rejected — fail-safe). Under MySQL `NO_BACKSLASH_ESCAPES`, `'\''` is `\` + close-quote → splitter could under-count, but this is backstopped by the now-unconditional `multipleStatements:false`. All divergences are either over-reject (safe) or backstopped, and require a non-default server session config; the durable options are to read the session settings or document the assumption. No live exploit at default configs.
status: open

### DW-40: Bind bigint/int8/numeric columns without JS `Number` precision loss on both the write value and the PK address — a value beyond `Number.MAX_SAFE_INTEGER` is silently truncated on edit/insert, and a lossy PK read makes `WHERE pk = <lossy>` address the wrong row (or none) on update/delete

origin: migrated from legacy ledger (code review of spec-3-3-edit-insert-delete-rows.md), 2026-07-12
location: `coerceValue` / `pkForRow` / `cellToValue` (`row-mutations.ts`)
reason: Reviewer severity: high (two independent review passes flagged it as the highest-consequence item in the diff). `row-mutations.ts` `coerceValue("number")` uses `Number(raw)` and `pkForRow`/`cellToValue` read the PK from `FrozenCell` as a JS `number` (`cell.value`). The precision loss originates upstream in Story 3.2's `FrozenCell` number representation (bigint already arrives as a lossy JS number from the browse read); Story 3.3 is the first to WRITE with it, exposing a silent wrong-value / wrong-row data-corruption path with no error surfaced. Story 3.3 explicitly scopes DB-type-aware editors via `SchemaColumnInfo` out (deferred) and documents the kind-inference limitation, so the durable fix (thread column types + carry wide integers as strings/bigint across the wire) belongs with that deferred type-threading work, not the 3.3 UI.
status: open

### DW-41: Reset `createdTables` on connect/disconnect so optimistically-created tables don't accumulate across reconnects and shadow the re-introspected schema

origin: migrated from legacy ledger (code review of spec-4-1-render-erd.md), 2026-07-12
location: `src/ui/App.tsx` (`createdTables`)
reason: `src/ui/App.tsx` only ever appends to `createdTables` (never clears it), so after a reconnect a created table appears in both `schemaTables` and `createdTables`, and after connecting to a different database a stale phantom table survives. Pre-existing Epic-3 lifecycle behavior masked by SchemaTree's dedup; the ERD's new dedup patch prevents the duplicate-id crash but the stale phantom node remains until this root cause is fixed.
status: open

### DW-42: Exclude inherited partition FK constraints (`pg_constraint.conparentid <> 0`) from the Postgres FK introspection so partitioned schemas don't render N+1 redundant edges

origin: migrated from legacy ledger (code review of spec-4-1-render-erd.md), 2026-07-12
location: `src/core/driver-postgres.ts` (FK introspection)
reason: `src/core/driver-postgres.ts` filters only `contype='f'`; on a partitioned parent every partition carries an inherited copy of the FK, producing duplicate near-identical edges. Fix is a one-line `AND con.conparentid = 0` but carries a minor Postgres-version-compatibility consideration (conparentid exists in PG 11+), so it warrants focused attention.
status: open

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
status: open

### DW-45: `connectionManager.getSchema()` memoizes the schema at connect and never re-introspects, so chat context (and the "N tables" badge) goes stale after DDL runs (create/drop table)

origin: migrated from legacy ledger (code review of spec-5-2-chat-qa-schema-only.md), 2026-07-12
location: `src/core/connection.ts` (`getSchema`)
severity: medium
reason: `src/core/connection.ts` returns `cached.schema` fixed at first connect; Story 3.4/3.x DDL mutates the live DB but no re-introspection path exists. Surfaced by 5.2 which now feeds that cached schema to the AI provider.
status: open

### DW-46: Provider-key redaction in the chat error path is exact-substring only (`rawCause.split(apiKey).join("***")`), so a key echoed in a non-literal form (URL-encoded, base64, truncated, or nested in a structured error object) would still reach stderr

origin: migrated from legacy ledger (code review of spec-5-4-streaming-reasoning.md), 2026-07-12
location: `answer()` / `answerStream` (chat provider redaction path)
severity: high
reason: Inherited from Story 5.2's `answer()` redaction and reused verbatim by 5.4's `answerStream` (including the SDK-emitted `error`-part path). No current provider (Anthropic/OpenAI/Google) echoes the API key in error bodies, so this is latent; a stronger guarantee (redact encoded/partial forms, or emit a fixed generic cause) is preferable given the "key NEVER in any log" invariant.
status: open

### DW-47: Scripted same-frame navigation (`window.location = "http://host/?" + data`) bypasses `connect-src 'none'`, so a hostile guest can still exfiltrate the user's private `FrozenData`; the "already-public frozen data" comments understate this

origin: migrated from legacy ledger (code review of spec-5-5-crossorigin-js-sandbox.md), 2026-07-12
location: sandbox `pushData` / CSP (spec-5-5 crossorigin JS sandbox)
severity: high
reason: CSP fetch directives (`connect-src`, `img-src`) do not govern top-level/self navigation, and `sandbox="allow-scripts"` without `allow-top-navigation` still permits a frame to navigate ITSELF. The pushed `FrozenData` is the user's real query output, not public data. Closing this is a genuine architectural/security decision (e.g. gating `pushData` on a confirmed handshake so data never lands in a navigated-away frame, and/or a documented residual) rather than a trivial patch — the `pushData(frame, "*")` target-origin is deliberately `"*"` against the guest's opaque origin.
status: open

### DW-48: In exposed mode (`QS_HOST=0.0.0.0`) the sandbox server binds the same wildcard host as Core (LAN-exposing the tokenless guest) while the injected `__QS_SANDBOX_ORIGIN__` is normalized to `127.0.0.1:<port>`, which is unreachable for a remote browser — the sandbox silently fails to load off-host

origin: migrated from legacy ledger (code review of spec-5-5-crossorigin-js-sandbox.md), 2026-07-12
location: `startCore` (sandbox `Bun.serve`, `bindHost`); `deriveOpenUrl`
severity: medium
reason: `startCore` passes `bindHost` straight into the sandbox `Bun.serve`, and `deriveOpenUrl` rewrites the injected origin to loopback. The intent-contract Block-If explicitly reserves the exposure model as a human security decision, so the correct exposed-mode posture (loopback-only sandbox + documented "visualization unavailable when exposed", or a reachable remote origin) is a deliberate call, not an unattended patch.
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
status: open

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
status: open

### DW-55: The new client-side CSV Export does not guard against CSV/formula injection — a string cell beginning with `=`, `+`, `-`, or `@` is written verbatim and executes as a formula when the exported file is opened in Excel/Sheets

origin: review of spec-7-2-redesign-tables-grid-neutral.md, 2026-07-15
source_spec: `spec-7-2-redesign-tables-grid-neutral.md`
location: `src/ui/data/grid-view.ts` (`csvField`/`rowsToCsv`)
severity: medium
reason: `rowsToCsv`'s `csvField` quotes only fields containing `,`/`"`/newline (exactly the escaping the spec prescribed) — it does not neutralize leading formula sigils. Because a DB browser exports arbitrary row content, a cell like `=SUM(A1)`/`+cmd`/`-2+3`/`@foo` becomes a live formula in a spreadsheet app. This is a genuine (well-known) export vulnerability, but the fix is a policy decision the presentation-only spec deliberately did not scope: the common mitigation (prefixing a `'` or tab) MUTATES exported data and many DB tools intentionally preserve fidelity instead. Worth a focused decision + follow-up rather than silently altering export output in an unattended pass.
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
status: open

### DW-66: `hoveredNodeId` is never reconciled against the live node set — if the hovered table is removed (and its `tableId` later reused) while the pointer is over it and `onNodeMouseLeave` never fires, a stale id can spuriously highlight a different table's edges

origin: review of spec-7-4-redesign-erd-neutral.md, 2026-07-15
source_spec: `spec-7-4-redesign-erd-neutral.md`
location: `src/ui/workspace/ErdTabView.tsx` (`hoveredNodeId` state; edges `useMemo` deps `[graph.edges, hoveredNodeId]`; no reset effect on `nodes` change)
severity: low
reason: The hover highlight is pure presentation over the derived edges, driven by `onNodeMouseEnter`/`onNodeMouseLeave`. In the narrow case where the exact hovered table is dropped/recreated (via a `tables` change) without a mouseleave, `hoveredNodeId` persists; because node ids are the NUL-joined `schema\0name`, a later table reusing that id would inherit the highlight until the next hover. Very low probability (table create/remove rarely coincides with hovering that same node) and self-correcting on the next pointer move; edge/position derivation and persistence are unaffected. A one-line reconciling effect (`if hoveredNodeId not in nodes → clear`) is the fix; deferred as low-consequence.
status: open

### DW-67: ERD type labels (`text-[10px]`, `--t-text` muted) and the type legend (`text-[10.5px]`, 9px swatches) render sub-11px muted-on-tonal text with no verified contrast in either theme

origin: review of spec-7-4-redesign-erd-neutral.md, 2026-07-15
source_spec: `spec-7-4-redesign-erd-neutral.md`
location: `src/ui/workspace/ErdTabView.tsx` (`ErdTableNode` type label; `ErdLegend`)
severity: low
reason: The tiny muted type labels and legend faithfully reproduce `design-artifacts/erd.html` (the visual source of truth), but sub-11px muted foreground on a tonal `--card`/`--background` surface is a real WCAG legibility risk, and nothing in the tests checks contrast in light or dark. This is an epic-wide neutral-redesign concern (cf. DW-58, the Epic 7 light-theme/contrast work), not specific to the ERD — folded here so the ERD's small-text surfaces are covered when the epic does a contrast/a11y pass.
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
