---
title: 'Surface the active connection in Settings/Connections — read-only "current connection" entry for the in-memory Ephemeral target'
type: 'bug'
created: '2026-07-16'
status: 'done'
baseline_revision: 'aaaf3d160ca4e861f554cae18ca2872bf787b9b4'
final_revision: '51877591c7a26c550f05331fa29769da2b17ac9c'
review_loop_iteration: 0
followup_review_recommended: false
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
warnings: ['oversized']
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

<!-- Current line numbers reconciled to the post-8-6 tree. -->

- `src/shared/contract.ts` — ADD the credential-free result types. Insert right after `ConnectionSummary` (**lines 364-369**, in the manage-connections section) and before `AddConnectionParams` (**371**):
  ```ts
  export type ConnectionMode = "ephemeral" | "persistent";
  export type ActiveConnectionInfo = {
    readonly mode: ConnectionMode;
    /** Non-sensitive derived identity of the in-memory active target, or null when none is configured. */
    readonly connection: {
      readonly engine: string;    // URL.protocol without the trailing colon (e.g. "postgres")
      readonly host: string;      // URL.host (host[:port]) — never userinfo
      readonly database?: string; // optional, non-sensitive (URL.pathname sans leading slash); NEVER user/password
    } | null;
  };
  ```
  The file is dependency-free of Core/ring types (its only import is the sibling *shared* `chart-spec.ts`) — define the mode literal inline; do NOT import the Core `RunMode`. Every field stays `readonly`, matching `ConnectionSummary`.
- `src/core/connection.ts` — ADD a pure, synchronous `describe(): { engine: string; host: string; database?: string } | null` to `ConnectionManager`. Declare it in the `ConnectionManager` type block (**lines 26-59**) and implement it in the returned object literal (**lines 182-228**), modeled on the existing sync `quoteIdent()` (**204-209**). It reads the closure-held `databaseUrl` (**line 78**); when null it returns `null`; otherwise, in a `try/catch` (→ `null` on parse failure, mirroring `connection-registry.ts`'s `safeSummary` at **172-178**): `const u = new URL(databaseUrl)` and return `{ engine: u.protocol.replace(/:$/, ""), host: u.host, database: u.pathname.slice(1) || undefined }` — reusing the exact `toSummary` derivation (`connection-registry.ts:152-160`). `describe()` needs only `databaseUrl` (not `driver`), so it is safe before any `connect()` and opens NO driver. Do NOT touch `connect`/`getSchema`/`query`/`queryReadOnly`/`quoteIdent`/`close` or any caching.
- `src/core/rpc.ts` — (1) import `type ActiveConnectionInfo` in the contract import block (**lines 9-20**). (2) EXTEND `RpcContext` (**36-74**) with `readonly activeConnection: () => ActiveConnectionInfo;`. (3) ADD a plain-payload `HANDLERS` entry (**after `connect` at line 141**), matching the `connect` handler style (dispatch wraps the return in `okReply`; no `preformed`, no param validation): `"connection.active": (_params, ctx): ActiveConnectionInfo => ctx.activeConnection(),`. NOTE the deliberate SINGULAR `connection.active` namespace (the one live/active connection) vs the PLURAL `connections.*` (the saved-connection registry) — two distinct namespaces. `methodNames()` (**302-304**) derives from `Object.keys(HANDLERS)`, so the new method surfaces automatically (the `rpc.test.ts` snapshot must add it — see Tasks).
- `src/core/server.ts` — in `startCore`, wire the capability onto the per-request `rpcContext` object literal (**lines 429-448**, after `connect` at **435**): `activeConnection: () => ({ mode, connection: connectionManager.describe() })`. `mode` is the already-resolved run mode (**line 248**) and `connectionManager` already exists (**254-257**); both are captured from the enclosing closure. No new store, no boot connect, no teardown change.
- `src/ui/settings/SettingsPanel.tsx` — ADD a SECOND, independent mount effect (right after the existing `connections.list` effect at **222-238**) issuing `rpc<ActiveConnectionInfo>("connection.active")` into its own local state (do NOT touch `loading`/`listLoaded`/`busy` — those gate saved-list mutations; the active entry is read-only and its load failure must not break the saved list). When the reply's `connection !== null`, render a READ-ONLY "active connection" block at the TOP of the Connections body — insert between the error banner (closes **line 349**) and the `{/* Add form */}` (**351**). Build it with the existing neutral idioms: a labelled block ("active connection") wrapping the row shell from `ConnectionRow` (**line 155**: `flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-card px-3 py-2`), a mono host/engine line reusing the `HostEngine` idiom (**42-49**: `font-mono text-xs text-muted-foreground` → `{host} · {engine}`), and a mono mode tag (`font-mono text-[11px] text-muted-foreground` → `ephemeral`/`persistent`, mirroring `.model-btn .mode`). NO edit/remove/confirm controls (distinct from `ConnectionRow`). Keep the add-form (**351-383**), saved-list rendering (**386-412**), `ConnectionRow`/`EditRow`, `ErrorLine`/`envelopeText` surfacing (**204-206, 345-349**), all gates, and `data-testid="settings-panel"` (**299**) unchanged. Import `ActiveConnectionInfo` from `contract.ts`. Use neutral ink tokens only (`text-muted-foreground`, `text-foreground`, `border-border`, `bg-card`, `font-mono`) — no coral, no hardcoded hex.
- `src/ui/rpc/client.ts` — NO CHANGE. `rpc<T>(method: string, params?: unknown): Promise<RpcReply<T>>` (**line 39**) already dispatches any method string and returns a typed envelope; `rpc<ActiveConnectionInfo>("connection.active")` works as-is (no params).
- `src/ui/settings/connections-model.ts` — NO CHANGE. Pure saved-connections view-model (`validateDraft` + `loadConnections`/`applyAdded`/`applyEdited`/`applyRemoved` over `ConnectionSummary`). The active-connection entry is read-only display derived from a SEPARATE reply — not part of the saved-list state, so no reducer/validation change.
- `src/core/connection-registry.ts` — NO CHANGE. Reference only: `toSummary` (**152-160**, engine/host derivation to mirror) and `safeSummary` (**172-178**, the guarded try/catch → degrade pattern). Confirms the ephemeral store-empty behavior is by design.
- `bin/quick-studio.ts` / `src/core/cli-args.ts` — NO CHANGE. Confirmed root-cause evidence (the ephemeral positional-arg in-memory path, never persisted).
- `design-artifacts/connect.html` — reference only (visual source of truth). The `.conv.rich` saved-row (**markup 647-664**, **CSS 218-227**: `.eng-icon` glyph + `.conv-name` + mono `.conv-host`) is the template for the read-only active entry; `.model-btn .mode` (**CSS line 366**: mono, `--text-faint`) is the template for the `ephemeral`/`persistent` tag. Coral tokens in this file are already neutralized to ink (`--coral: #ececec; /* ink — neutral, was coral */`) — consume the app's ink tokens, never a coral hex.
- Regenerate the UI bundle via `bun run build` so `src/core/ui-bundle.generated.ts` reflects the new Settings block.

## Tasks & Acceptance

**Execution:** (ordered by dependency — the contract type lands first so Core and UI both compile against it)

- [x] `src/shared/contract.ts` — add `ConnectionMode` and `ActiveConnectionInfo` after `ConnectionSummary` (364-369). Inline mode literal; no `RunMode` import; all fields `readonly`.
- [x] `src/core/connection.ts` — add a pure sync `describe()` to the `ConnectionManager` type (26-59) and returned literal (182-228): reads closure `databaseUrl` (78); `null` when absent; else `new URL()` in a try/catch (→ null) deriving `{ engine: protocol sans trailing colon, host: URL.host, database: pathname.slice(1) || undefined }`. Opens NO driver; touches no cache/other method.
- [x] `src/core/rpc.ts` — import `type ActiveConnectionInfo`; add `activeConnection: () => ActiveConnectionInfo` to `RpcContext` (36-74); add plain-payload handler `"connection.active"` after `connect` (141), returning `ctx.activeConnection()`. No param validation.
- [x] `src/core/server.ts` — add `activeConnection: () => ({ mode, connection: connectionManager.describe() })` to the `rpcContext` literal (429-448, after 435). Uses existing `mode` (248) + `connectionManager` (254). No store/boot/teardown change.
- [x] `src/ui/settings/SettingsPanel.tsx` — add a second independent `connection.active` mount effect + local state (after 238); render the read-only active-connection block (host · engine mono via the `HostEngine` idiom + mono mode tag + "active connection" label, `ConnectionRow` shell classes, no action buttons) at the top of the Connections body (between 349 and 351) only when `connection !== null`. Neutral ink tokens only. Everything else (gates, add form, saved list, error surfacing, testids) untouched.
- [x] `src/core/connection.test.ts` — EXTEND with `describe()` coverage using the `fakeDriver` spy (29-64): returns `{ engine, host, database }` for a configured url and `JSON.stringify` contains no password/userinfo substring (mirror 97/253); returns `null` when `databaseUrl` absent; returns `null` (never throws) on an unparseable url; asserts `counts.factory === 0` after `describe()` (no driver opened — mirror 123-143). (Covers the I/O-matrix Core rows.)
- [x] `src/core/rpc.test.ts` — EXTEND: add `activeConnection` to `stubCtx` (92-138); add `"connection.active"` to the `methodNames()` snapshot (165-183, right after `"connect"`); add a dispatch test (modeled on the `connect` tests 192-219) asserting `reply.ok` + `{ mode, connection }` shape and that the serialized reply contains no password/user/full-url substring.
- [x] `src/core/server.test.ts` — EXTEND: boot `startCore` with a `databaseUrl` (mirror 347-350) and POST `connection.active` via the token helper (322-328); assert `reply.result.connection` equals the derived `{ engine, host, database }`, `reply.result.mode === "ephemeral"`, and the raw response body does not contain the password substring (mirror 392/514-515/555); a persistent boot with no `databaseUrl` returns `connection: null`.
- [x] `bun run build` — regenerate `src/core/ui-bundle.generated.ts` with the new Settings block.

**Acceptance Criteria:**

- Given the app running in **Ephemeral mode** against a live DB (connection string passed as a positional CLI arg), when the user opens Settings → Connections, then a **read-only "active connection" entry** appears showing the **engine**, **host** (host:port), and **mode = `ephemeral`**, visually distinct from saved connections and carrying no edit/remove actions. **Verify live at http://127.0.0.1:6061.**
- Given any `connection.active` reply, when its raw bytes are inspected, then they contain **no password, no user/userinfo, and no full url** — only `engine`, `host`, `mode` (and, if included, a non-sensitive `database` name).
- Given a **Persistent** boot with no ephemeral url, when Settings → Connections opens, then **no active-connection entry** is rendered (or a muted "no active connection" note), and the saved-connections list renders exactly as before.
- Given the active-connection entry, then it is **read-only** (no edit, no remove) and rendering it does **not** force a driver `connect` or a database round-trip.
- Given the saved-connection flows (add / edit / remove) and the `connections.*` RPC + credential store, when exercised, then behavior is **byte-identical** to before this story and the **existing test suite passes** with no test changes required to pass.
- Given the active-connection entry, then it matches the neutral, ink-accented look of `design-artifacts/connect.html`'s `.conv.rich` row (name/host mono + mode tag), uses only the neutral ink tokens, and stays legible in both light and dark themes — no coral, no hardcoded accent hex.

## Spec Change Log

## Review Triage Log

### 2026-07-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 1
- reject: 5
- addressed_findings:
  - `[low]` `[patch]` `describe()` derived a credential-free descriptor for a parseable-but-hostless url (e.g. `postgres:///shop`), returning `host: ""` that flowed unguarded to the UI as a stray `" · engine"` separator with no host — while the saved-connection path's `checkUrl` (`connection-registry.ts:141`) deliberately rejects hostless urls so its derivation is "always meaningful". Added the mirroring guard `if (u.host.length === 0) return null;` so an empty-host target collapses into the clean "no active entry" path; added an additive `connection.test.ts` case. (`src/core/connection.ts`, `src/core/connection.test.ts`)
  - `[low]` `[patch]` The `ActiveConnectionInfo` doc comment read "the DB the session is browsing", which overpromised: `activeConnection` reflects the in-memory *boot* target only, so a Persistent boot (per-target browsing chosen per-request, Story 6.2) legitimately yields `connection: null`. Tightened the comment to say "the ephemeral boot target held in Core memory … `null` … e.g. a Persistent boot, where per-target browsing is chosen per-request and not surfaced here" — precise, no behavior change (the persistent→null behavior is by the spec's I/O matrix). (`src/shared/contract.ts`)

Rejected (5 — noise / by-design / verified-safe): the once-on-mount load never refreshing (BY DESIGN — the ephemeral boot target is immutable for the session lifetime, so a single load is correct; refresh only matters for the deferred persistent per-target surfacing); the `new URL()` derivation appearing in three sites (`toSummary`, `describe`, the test fake) (deliberate mirroring per the spec's "reuse the `toSummary` derivation" instruction; extracting a shared helper would touch the "never modify" registry file for marginal benefit and is scope creep); no `SettingsPanel` component test for the render branch (the repo has NO component-test harness — SettingsPanel is covered only by pure model tests, matching Story 8-6's accepted posture; the security-critical credential-free boundary is proven at the Core layer by `rpc.test.ts`/`server.test.ts` byte assertions, which is where any leak would originate); a Core error rendering identically to "no active connection" (BY DESIGN — the I/O matrix "RPC transport failure → active entry simply absent"; `rpc()` never rejects); and a percent-encoded/multi-segment `database` showing encoded (the UI does NOT render `database` at all — it shows host · engine + mode only — so there is no visible consumer, and the field is non-sensitive by construction).

Deferred (1): surfacing the active connection in **Persistent** mode's per-target browsing (Story 6.2 `createConnectionTargets` resolves separate managers per saved-connection `connectionId`; the boot manager never sees them, so `connection.active` shows nothing while a saved DB is actively browsed). Out of this story's scope — the intent is explicitly the ephemeral in-memory boot target, and the I/O matrix defines persistent→null as correct. Logged to `deferred-work.md`.

## Design Notes

**Two Core-side holders, one new read-only bridge.** The active target lives in the connection-*manager* closure (in-memory, never persisted); the saved list lives in the connection-*registry* over the credential store (empty in Ephemeral mode). They are correctly disjoint — this story does NOT merge them. It adds a single, additive, read-only bridge (`connection.active`) that derives a credential-free descriptor from the in-memory url and hands it to the UI as a distinct entry. Singular `connection.active` (the one live target) is deliberately a different namespace from plural `connections.*` (the saved registry).

**Credential-free by construction, mirroring `ConnectionSummary`.** `describe()` returns only `engine`/`host`/`database` derived via `URL.protocol`/`URL.host`/`URL.pathname` — none of which can contain userinfo. The raw url, `username`, and `password` never leave the manager closure. This reuses `connection-registry.ts`'s `toSummary` derivation (152-160) and its `safeSummary` guarded-total posture (172-178: try/catch → degrade), so an unparseable url yields `null`, never a throw. The tests assert both the negative (no secret substring in the serialized reply) and positive (exact key set) invariants, matching the Story 2.4 trust-boundary tests.

**No engine glyph is introduced — the shipped UI has none.** `connect.html`'s `.conv.rich` row shows an `.eng-icon` SVG, but the *shipped* Settings UI renders engine identity as neutral mono TEXT via `HostEngine` (`{host} · {engine}`), with no engine sprite anywhere in `src/ui`. To stay convention-matching and avoid porting an unshipped sprite (scope creep), the active entry reuses that same mono text idiom. The intent's "visually distinct" requirement is satisfied by the **"active connection" label + the mono mode tag + read-only (no action buttons)**, not by a glyph the saved rows themselves lack. Porting the sprite would be a purely-cosmetic follow-up, not required here.

**The active-entry load is independent of the saved-list load.** A second mount effect issues `connection.active` into its own state; it deliberately does not touch `loading`/`listLoaded`/`busy`. So a `connection.active` transport failure leaves the active entry simply absent while the saved-connections list (and its mutation gates) behave exactly as before — the two concerns never entangle.

**Example — `describe()` (pure, sync, ~8 lines):**
```ts
describe(): { engine: string; host: string; database?: string } | null {
  if (databaseUrl === null) return null;
  try {
    const u = new URL(databaseUrl);
    return { engine: u.protocol.replace(/:$/, ""), host: u.host, database: u.pathname.slice(1) || undefined };
  } catch {
    return null;
  }
}
```

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors (new `ActiveConnectionInfo`/`ConnectionMode`; new `RpcContext.activeConnection`; new `ConnectionManager.describe()`; the `stubCtx` and `rpcContext` literals gain the member).
- `bun test` — expected: all existing suites stay green, plus new coverage:
  - `src/core/connection.test.ts` — `describe()` derives `{ engine, host, database }` (no `username`/`password` substring in the returned object); `null` when `databaseUrl` absent; `null` (never throws) on an unparseable url; `counts.factory === 0` after `describe()` (no driver opened).
  - `src/core/rpc.test.ts` — `connection.active` dispatches to `okReply` with `{ mode, connection }`; serialized reply contains no password/user/full-url substring; `methodNames()` snapshot updated with `"connection.active"`; unknown-method path unaffected.
  - `src/core/server.test.ts` — end-to-end: `connection.active` returns `mode:"ephemeral"` + derived `connection` when booted with a `databaseUrl` (raw body carries no password), and `connection:null` when booted without one.
- `bun run build` — expected: OK; `src/core/ui-bundle.generated.ts` regenerates with the new Settings block.

**Manual checks (live at http://127.0.0.1:6061):**
- Launch in **Ephemeral mode** against a real DB with the connection string as a positional arg. Open Settings → Connections and confirm: the **active connection** appears as a read-only entry (engine · host · `ephemeral`), distinct from any saved connections, with **no password or url shown** and **no edit/remove** controls. Toggle the theme and confirm the entry stays legible (no white-on-white / dark-on-dark).
- Launch in **Persistent mode** with no ephemeral url: confirm no active-connection entry (or a muted note) and that the saved list still adds/edits/removes exactly as before.

## Auto Run Result

Status: done

**Implemented change:** Closed the UX gap behind user complaint #13 by surfacing the currently-active (Ephemeral, in-memory) connection as a READ-ONLY "active connection" entry at the top of Settings → Connections — without persisting it or weakening any trust boundary. Added a small additive Core RPC `connection.active`: the connection manager gained a pure, synchronous `describe()` that derives a credential-free `{ engine, host, database? }` from the closure-held url via `new URL()` (opening no driver, mutating nothing), and a new handler returns that alongside the run `mode`. The UI loads it via a second, independent mount effect and renders a labelled, action-free neutral-ink row (host · engine mono + mono mode tag), leaving the saved-connections surface byte-identical. The ephemeral-vs-persisted split (the store staying empty in Ephemeral mode) is preserved as the intended no-write guarantee.

**Files changed:**
- `src/shared/contract.ts` — new credential-free types `ConnectionMode` (inline literal, no Core `RunMode` import) + `ActiveConnectionInfo`; doc comment tightened to say the descriptor is the ephemeral boot target (persistent → null).
- `src/core/connection.ts` — pure sync `describe()` on `ConnectionManager`: derives `{ engine, host, database? }` from the in-memory url; returns `null` when no url / unparseable / hostless (host guard mirrors the registry's `checkUrl`); opens no driver.
- `src/core/rpc.ts` — `RpcContext.activeConnection` + plain-payload `HANDLERS["connection.active"]` (singular namespace, distinct from plural `connections.*`).
- `src/core/server.ts` — wired `activeConnection: () => ({ mode, connection: connectionManager.describe() })` onto the rpc context.
- `src/ui/settings/SettingsPanel.tsx` — second independent `connection.active` mount effect + local state; read-only active-connection block at the top of Connections (neutral ink, no edit/remove); saved list, gates, error surfacing, and `data-testid="settings-panel"` untouched.
- `src/core/connection.test.ts`, `src/core/rpc.test.ts`, `src/core/server.test.ts`, `src/core/connection-targets.test.ts` — additive coverage (derivation + credential-free byte assertions + no-driver-opened + null/hostless/persistent cases; `methodNames()` snapshot + `stubCtx` updated; test-double `describe()`).
- `src/core/*-bundle.generated.ts` — regenerated via `bun run build`.

**Review findings breakdown:** 2 patches applied (both low: added the hostless-url guard to `describe()` so an empty host collapses into the clean "no active entry" path, mirroring the registry's `checkUrl`; tightened the `ActiveConnectionInfo` doc comment so it no longer overpromises "the DB the session is browsing"). 1 deferred (surfacing the active connection for Persistent per-target browsing — out of this story's ephemeral scope; logged to `deferred-work.md`). 5 rejected (once-on-mount load = by-design for the immutable ephemeral target; URL-derivation triplication = deliberate mirroring per spec; no component test = no harness exists and the credential boundary is Core-tested; error-≡-empty = by the I/O matrix; encoded `database` = not rendered, non-sensitive). No intent_gap, no bad_spec, no loopback (`review_loop_iteration` stayed 0).

**Verification:** `bunx tsc --noEmit` clean; `bun test` 1167 pass / 0 fail across 70 files (2901 expect() calls); `bun run build` OK (regenerated the UI/sandbox/snapshot/live-report bundles). The credential-free guarantee is asserted at the Core boundary (`rpc.test.ts` + `server.test.ts` byte checks: no password / user / full-url on the wire) and `describe()` is proven to open no driver (`counts.factory === 0`). Live visual/interaction check at http://127.0.0.1:6061 (the epic's fidelity gate — theme legibility, distinctness from saved rows) NOT performed in this unattended run (no DB/launcher on this box) — deferred to manual verification.

**Residual risks:** Low. The change is additive and the security-critical boundary is Core-tested. The unattended run cannot self-confirm (a) the live visual fidelity against `design-artifacts/connect.html` in light + dark themes, and (b) the deferred Persistent-mode per-target surfacing (by design out of scope). The read-only entry reuses the shipped `HostEngine` mono text idiom rather than porting `connect.html`'s engine glyph (no engine sprite exists in the shipped UI) — distinctness comes from the "active connection" label + mode tag + absence of action controls.
