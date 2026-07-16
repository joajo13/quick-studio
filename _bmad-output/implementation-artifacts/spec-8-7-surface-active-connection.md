---
title: 'Surface the active connection in Settings/Connections — read-only "current connection" entry for the in-memory Ephemeral target'
type: 'bug'
created: '2026-07-16'
status: 'backlog'
context:
  - '{project-root}/bin/quick-studio.ts'
  - '{project-root}/src/core/cli-args.ts'
  - '{project-root}/src/core/connection.ts'
  - '{project-root}/src/core/connection-registry.ts'
  - '{project-root}/src/core/server.ts'
  - '{project-root}/src/core/rpc.ts'
  - '{project-root}/src/shared/contract.ts'
  - '{project-root}/src/ui/settings/SettingsPanel.tsx'
  - '{project-root}/src/ui/settings/connections-model.ts'
  - '{project-root}/src/ui/rpc/client.ts'
  - '{project-root}/design-artifacts/connect.html'
---

<intent-contract>

## Intent

**Problem (user complaint, item 13):** "When I'm in Settings, the connection I already have open doesn't appear in Connections. You ran the app, it's running, I have a DB connected that I'm looking at, but it doesn't show up in connections. Is that a bug?"

**Confirmed root cause — EXPECTED behavior, not a defect.** The session was launched in **Ephemeral mode** by passing the connection string as a **positional CLI argument**. On that path the url is held **only in Core memory** and is **NEVER persisted** to the encrypted credential store, whereas Settings → Connections lists exclusively from that **persisted** store — which is empty in Ephemeral mode. There are two distinct Core-side holders and they never cross:

- **The active connection (the DB the user is browsing)** lives in the boot **connection *manager*** closure. `parseCliArgs` maps a bare url positional to `mode = "ephemeral"` and `databaseUrl = urlArg` (`src/core/cli-args.ts:104-117`, comment: *"Carried in memory for Story 1.3; never persisted."*). `bin/` threads it into `startCore` as `databaseUrl` (`bin/quick-studio.ts:63-70`, comment: *"Held only in Core memory — never persisted, never logged here."*). `startCore` hands it to `createConnectionManager({ databaseUrl })` (`src/core/server.ts:254-257`), which keeps it in a closure (`const databaseUrl = deps.databaseUrl ?? null;` — `src/core/connection.ts:78`) and never writes it anywhere.
- **The saved-connections list (what Settings renders)** comes from the separate connection **registry** over the credential store (`createConnectionRegistry({ storeDeps: { mode, … } })` — `src/core/server.ts:271-273`). In Ephemeral mode the store's open/flush is an in-memory no-op, so `connections.list` returns `[]` (`src/core/connection-registry.ts:246-256`). The panel loads solely via `rpc("connections.list")` on mount (`src/ui/settings/SettingsPanel.tsx:222-238`).

So the active Ephemeral target never lands in the store, the store is what Connections shows, and therefore the connection the user is looking at is legitimately absent. **This is the designed Ephemeral no-write guarantee doing its job — not a bug.** The real defect is a *UX gap*: the app gives the user no read-only way to SEE what they are currently connected to.

**Approach:** Surface the currently-active connection as a **read-only "active connection" entry** at the top of Settings → Connections, visually distinct from the saved (persisted) connections and styled per `design-artifacts/connect.html`'s neutral `.conv.rich` saved-row treatment. It shows only **non-sensitive** metadata — **engine**, **host** (host:port), and **mode** (`ephemeral` / `persistent`) — and carries **no edit/remove actions** (it is not a stored record). Because the active target is Core-memory-only, exposing it requires a small, additive **Core RPC** (`connection.active`): the connection manager gains a pure `describe()` that derives `{ engine, host }` from the in-memory url via `new URL()` (protocol + `URL.host` only — never userinfo), and a new handler returns that alongside the run mode. **This deliberately crosses the Epic-7 "presentation-only" boundary — it is an allowed behavior addition for THIS bug story — but it preserves every existing security/trust guarantee: schema-only stays schema-only, credentials never leave Ring 1, the credential store and the `connect`/`connections.*` behavior are untouched, and every existing test keeps passing.**

## Boundaries & Constraints

**Always:**
- Treat the ephemeral-vs-persisted split as CORRECT: the credential store staying empty in Ephemeral mode is the intended no-write guarantee, not something to "fix." This story ADDS a read-only view of the in-memory target; it does NOT persist the ephemeral connection.
- Derive the active-connection descriptor in Core from the in-memory url using `new URL()` and expose ONLY `engine` (the protocol with the trailing colon stripped, e.g. `postgres`) and `host` (`URL.host` = host[:port]), plus the session `mode`. These fields are credential-free BY CONSTRUCTION (`URL.protocol`/`URL.host` never contain userinfo).
- Keep the url itself inside the connection-manager closure. `describe()` returns the derived summary only; the raw url, `username`, and `password` never escape Ring 1 — mirroring the `ConnectionSummary` credential-flow-directional boundary already established in Story 2.4.
- Render the active-connection entry as READ-ONLY and visually distinct from saved connections: no edit button, no remove button, no add affordances. Style it per `connect.html`'s `.conv.rich` row (engine glyph + name/host mono line) with a mono mode tag mirroring `.model-btn .mode`, using the neutral ink tokens already in `globals.css` (no coral, no new hex).
- `connection.active` must be a pure read: it derives from the already-held url and MUST NOT open the driver, force a `connect`, or mutate any cached connection state.
- Keep the mode literal (`"ephemeral" | "persistent"`) defined inline in the ring-neutral `contract.ts`; do NOT import the Core `RunMode` type into `contract.ts` (it must stay dependency-free). The Core `RunMode` is structurally assignable to that literal, so `server.ts` passes `mode` through directly.
- Preserve the existing saved-connections surface verbatim: the `connections.list/add/edit/remove` RPC, the credential store, the `connect` capability, the `busy`/`loading`/`listLoaded` gates, `envelopeText`/`role="alert"`, and `data-testid="settings-panel"` all stay exactly as they are.

**Block If:**
- Surfacing the active connection would require echoing the url, user, password, database path, or any secret across the Ring 1 → Ring 2 boundary (only engine/host/mode are permitted — if the design cannot stay credential-free, stop).
- It would require persisting the ephemeral target to the credential store, opening the store in Ephemeral mode, or otherwise weakening the no-write guarantee.
- It would require forcing a live `connect`/driver open just to render Settings (the descriptor must be derivable without a round-trip to the database).

**Never:**
- Never display or transmit the password, the user/userinfo, the full connection url, or the database name if doing so would leak a secret — the active entry shows engine + host + mode ONLY (a non-sensitive database name is optional; userinfo and password are forbidden).
- Never modify `credential-store.ts`, `crypto.ts`, `store-key.ts`, the connection **registry**'s list/add/edit/remove semantics, or the `connect` RPC's `ConnectResult` behavior.
- Never merge the active entry into the saved list or make it editable/removable — it is a distinct, read-only, memory-only item.
- Never regress or rewrite the existing passing tests; the change is additive (new type, new manager method, new handler, new UI block) and must leave every current suite green.
- Never introduce coral or a hardcoded accent hex; consume the existing neutral ink tokens via Tailwind utilities, consistent with the Epic-7 neutral redesign.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Trust / Error Handling |
|----------|--------------|---------------------------|------------------------|
| Ephemeral boot against a DB | `mode="ephemeral"`, `databaseUrl` set (positional arg) | `connection.active` → `{ mode:"ephemeral", connection:{ engine, host } }`; Settings → Connections shows a read-only "active connection" entry (engine · host · `ephemeral` tag) above the saved list | Reply bytes carry no url/user/password |
| Persistent boot, no ephemeral url | `mode="persistent"`, `databaseUrl` null | `connection.active` → `{ mode:"persistent", connection:null }`; NO active entry rendered (or a muted "no active connection" line); saved list renders exactly as before | No error; nothing to surface |
| Active + saved both present | ephemeral url AND N saved records | active entry shown DISTINCTLY above the N saved rows; not merged, not duplicated, not counted among saved | Read-only; saved rows keep edit/remove |
| Credential-free byte check | any `connection.active` reply | raw response bytes contain no password, no user/userinfo, no full url — only `engine`, `host`, `mode` (+ optional non-sensitive `database`) | Boundary preserved (mirrors `ConnectionSummary`) |
| No forced connect | `connection.active` invoked | `describe()` derives engine/host from the in-memory url only; the driver is NOT opened, `connect`/schema cache is untouched | Pure read; no DB round-trip, no side effect |
| Unparseable in-memory url (defensive) | url that fails `new URL()` | `describe()` returns `null` → `connection:null` → no active entry; never throws | CLI already shape-validates the positional url, so unreachable in practice; degrade-not-throw regardless |
| Active entry actions | render active entry | no edit, no remove, no confirm — read-only display only | Distinct from `ConnectionRow` |
| Saved-connection flows | add / edit / remove over `connections.*` | byte-identical to Story 2.4: same RPC, same registry, same store, same gates | Existing tests stay green |
| RPC transport failure on `connection.active` | fetch throws / times out | client resolves a synthetic `internal_error` envelope (existing `rpc` client behavior); panel surfaces nothing catastrophic — active entry simply absent | `busy`/list flow unaffected (independent load) |
| Light + dark theme | `data-theme` light/dark | active entry legible in both (neutral ink tokens); mode tag + host mono readable; no white-on-white / dark-on-dark | Consistent with Epic-7 neutral surface |

</intent-contract>

## Code Map

- `src/shared/contract.ts` — ADD the credential-free result type for the new method. A ring-neutral mode literal plus the descriptor:
  ```ts
  export type ConnectionMode = "ephemeral" | "persistent";
  export type ActiveConnectionInfo = {
    readonly mode: ConnectionMode;
    /** Non-sensitive derived identity of the in-memory active target, or null when none is configured. */
    readonly connection: {
      readonly engine: string;   // URL.protocol without the trailing colon (e.g. "postgres")
      readonly host: string;     // URL.host (host[:port]) — never userinfo
      readonly database?: string; // optional, non-sensitive (URL.pathname sans leading slash); NEVER user/password
    } | null;
  };
  ```
  Keep `contract.ts` dependency-free — define the mode literal inline here; do NOT import the Core `RunMode`. (The Core `RunMode` in `run-mode.ts` is structurally `"persistent" | "ephemeral"`, assignable to `ConnectionMode`.)
- `src/core/connection.ts` — ADD a pure, synchronous `describe(): { engine: string; host: string; database?: string } | null` to `ConnectionManager`. It reads the closure-held `databaseUrl`; when null it returns `null`; otherwise `new URL(databaseUrl)` and returns `{ engine: protocol.replace(/:$/,""), host: URL.host, database: pathname.slice(1) || undefined }` — mirroring the registry's `toSummary` derivation (`connection-registry.ts:152-160`). Guard the parse (`try/catch` → `null`) so it is total. The raw url, `username`, and `password` never leave the closure. Do NOT touch `connect`/`getSchema`/`query`/caching/`close` — `describe()` opens no driver.
- `src/core/rpc.ts` — EXTEND `RpcContext` with `readonly activeConnection: () => ActiveConnectionInfo;` and ADD a `HANDLERS["connection.active"]` entry returning `ctx.activeConnection()` (a plain domain payload → `dispatch` wraps it in `okReply`; no `preformed` needed, no params to validate). NOTE the deliberate SINGULAR `connection.active` namespace (the one live/active connection) vs the PLURAL `connections.*` (the saved-connection registry) — two distinct namespaces.
- `src/core/server.ts` — in `startCore`, wire the capability onto `rpcContext` (alongside `connect`/`connections`): `activeConnection: () => ({ mode, connection: connectionManager.describe() })`. `mode` is the already-resolved run mode (`server.ts:248`); `connectionManager` already exists (`server.ts:254-257`). No new store, no boot connect, no teardown change.
- `src/ui/settings/SettingsPanel.tsx` — on mount within the Connections section, ALSO issue `rpc<ActiveConnectionInfo>("connection.active")` (independent of the existing `connections.list` load; its failure must not break the saved list). When the reply's `connection !== null`, render a READ-ONLY "active connection" block at the TOP of the Connections section, styled per `connect.html`'s `.conv.rich` row: an engine glyph, a name/host mono line (`host` + `engine` verbatim via the existing `HostEngine` mono idiom), and a mono mode tag (`ephemeral` / `persistent`) mirroring `.model-btn .mode`. NO edit/remove/confirm controls. Keep the add-form, saved-list rendering, `ConnectionRow`/`EditRow`, error-envelope surfacing, gates, and `data-testid="settings-panel"` unchanged. Use neutral ink tokens (`text-muted-foreground`, `border-border`, `bg-card`, `font-mono`) — no coral, no hardcoded hex.
- `src/ui/rpc/client.ts` — NO CHANGE. The typed `rpc<T>(method, params?)` already dispatches any method string and returns `RpcReply<T>`; `rpc<ActiveConnectionInfo>("connection.active")` works as-is.
- `src/ui/settings/connections-model.ts` — NO CHANGE. Pure saved-connections view-model (validation + `applyAdded/Edited/Removed` reducers over `ConnectionSummary`). The active-connection entry is read-only display derived from a separate reply — it is NOT part of the saved-list state, so no reducer/validation change is warranted.
- `bin/quick-studio.ts` / `src/core/cli-args.ts` / `src/core/connection-registry.ts` — NO CHANGE. Referenced as the confirmed root-cause evidence: the ephemeral positional-arg path (in-memory, never persisted) and the separate credential-store-backed registry the saved list reads from.
- `design-artifacts/connect.html` — reference only (visual source of truth). The `.conv.rich` saved-row (engine `#ico-postgres`/`#ico-mysql` glyph + `.conv-name` + `.conv-host` mono) is the template for the read-only active-connection entry; `.model-btn .mode` (mono, `--text-faint`) is the template for the `ephemeral`/`persistent` mode tag. The `--coral` token is neutral ink here — consume the app's ink tokens, never a coral hex.
- Regenerate the UI bundle via `bun run build` so `src/core/ui-bundle.generated.ts` reflects the new Settings block.

## Acceptance Criteria

- Given the app running in **Ephemeral mode** against a live DB (connection string passed as a positional CLI arg), when the user opens Settings → Connections, then a **read-only "active connection" entry** appears showing the **engine**, **host** (host:port), and **mode = `ephemeral`**, visually distinct from saved connections and carrying no edit/remove actions. **Verify live at http://127.0.0.1:6061.**
- Given any `connection.active` reply, when its raw bytes are inspected, then they contain **no password, no user/userinfo, and no full url** — only `engine`, `host`, `mode` (and, if included, a non-sensitive `database` name).
- Given a **Persistent** boot with no ephemeral url, when Settings → Connections opens, then **no active-connection entry** is rendered (or a muted "no active connection" note), and the saved-connections list renders exactly as before.
- Given the active-connection entry, then it is **read-only** (no edit, no remove) and rendering it does **not** force a driver `connect` or a database round-trip.
- Given the saved-connection flows (add / edit / remove) and the `connections.*` RPC + credential store, when exercised, then behavior is **byte-identical** to before this story and the **existing test suite passes** with no test changes required to pass.
- Given the active-connection entry, then it matches the neutral, ink-accented look of `design-artifacts/connect.html`'s `.conv.rich` row (engine glyph + name/host mono + mode tag), uses only the neutral ink tokens, and stays legible in both light and dark themes — no coral, no hardcoded accent hex.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors (new `ActiveConnectionInfo`/`ConnectionMode` type; new `RpcContext.activeConnection`; new `ConnectionManager.describe()`).
- `bun test` — expected: all existing suites stay green, plus new coverage:
  - `src/core/connection.test.ts` — `describe()` returns `{ engine, host }` for a configured url (assert engine/host derived, and that no `username`/`password` string appears in the returned object); returns `null` when `databaseUrl` is absent; returns `null` (never throws) on an unparseable url; `describe()` opens no driver (fake-driver `connect` spy not called).
  - `src/core/rpc.test.ts` — `connection.active` dispatches to `okReply` with `{ mode, connection }`; the serialized reply contains no password/user/full-url substring (credential-free byte assertion, mirroring the Story 2.4 trust-boundary tests); unknown-method path unaffected.
  - Server-wiring check (in `server.ts`'s test surface if present) — `connection.active` returns `mode:"ephemeral"` + a derived `connection` when booted with a `databaseUrl`, and `connection:null` when booted without one.
- `bun run build` — expected: OK; `src/core/ui-bundle.generated.ts` regenerates with the new Settings block.

**Manual checks:**
- Launch the app in **Ephemeral mode** against a real DB with the connection string as a positional arg (browser opens at http://127.0.0.1:6061). Open Settings → Connections and confirm: the **active connection** appears as a read-only entry (engine · host · `ephemeral`), distinct from any saved connections, with **no password or url shown** and **no edit/remove** controls. Toggle the theme and confirm the entry stays legible (no white-on-white / dark-on-dark).
- Launch in **Persistent mode** with no ephemeral url: confirm no active-connection entry (or a muted note) and that the saved list still adds/edits/removes exactly as before.
