# Epic 1 Context: One-Command Workspace & Live Connection

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic delivers the end-to-end "spin up and inspect" loop and lays the structural foundation every later epic builds on. A developer installs quick-studio with a single command, runs it with a database URL, and within seconds has a localhost Workspace open in the browser — connected to a PostgreSQL or MySQL database with its schema visible — then closes it and nothing lingers on the machine. Along the way it establishes the three-ring skeleton (Core / UI / Sandbox host / shared / bin), the Ephemeral run mode, `127.0.0.1`-by-default binding with an active port-exposure warning, the Core session-capability authentication, the engine-neutral driver interface, the canonical frozen-data contract, and the Tabs/Panels shell. Security is resolved first, as the product requires: loopback is not treated as an auth boundary.

## Stories

- Story 1.1: Walking skeleton — Core boots on localhost, UI connects with a session token
- Story 1.2: One-command run with mode selection (Ephemeral vs Persistent)
- Story 1.3: Connect to PostgreSQL and MySQL through one engine-neutral driver
- Story 1.4: Workspace shell — open/close Tabs and resizable Panels
- Story 1.5: Clean, instant shutdown
- Story 1.6: Localhost-by-default binding + Port-Exposure Warning
- Story 1.7: One-command install via dual distribution

## Requirements & Constraints

- **One-command install and run.** A single documented command installs the tool per platform (Windows + Linux) with no interactive wizard, and a single command starts it. Passing a database URL selects an Ephemeral session; running with no URL (or an explicit persistent flag) selects a Persistent session (the credential store itself lands in a later epic).
- **Ephemeral mode writes nothing.** In Ephemeral mode no store, layout, report, panel, or session state is ever persisted; all state is in-memory and gone at exit. No daemon outlives the process.
- **Localhost by default.** The server binds `127.0.0.1` unless explicitly overridden; with defaults it is unreachable from any other host. Any non-loopback binding must raise a prominent, unmistakable warning explaining the risk and the exact steps to revert to localhost-only.
- **Relational connections only.** Connect to PostgreSQL and MySQL via URL (later also stored connection). A valid target connects and lists its schema; a failed connection returns a clear error that distinguishes host vs auth vs network. NoSQL is out of scope.
- **Workspace shell.** Multiple Tabs (tables, queries, ERDs, chats, reports) open at once; closing one leaves the others intact. Panels are resizable (restore-on-launch is deferred to the persistence epic).
- **Performance targets.** Cold start from run command to interactive Workspace in ≤2s. Shutdown is instant and non-blocking, terminating within ≤2s with no orphaned process and never stalling OS shutdown. Common interactions (open a table, switch Tabs, resize a Panel) respond in <100ms. Idle footprint must stay low (target ≤~200 MB resident, ~0% CPU) so it runs all day beside an IDE and browser.

## Technical Decisions

- **Three-ring trust model (governs every story).** Every runtime unit lives in exactly one ring: `src/core/` (trusted), `src/ui/` (semi-trusted React/shadcn), `src/sandbox/` (untrusted). Data flows outward only; capability/requests cross only to the ring immediately inward via a defined, authenticated channel. No feature widens its ring's powers.
- **Core is the sole secret-holder, SQL executor, and provider caller.** DB connections, credentials, and provider keys exist only in the Core process; all SQL executes there. UI issues typed requests and receives results.
- **Caller authentication.** The Core mints a session capability token handed to the UI at boot, and rejects every RPC that lacks the current token or carries a foreign Origin/Host header (DNS-rebinding defense). Loopback is explicitly not an auth boundary.
- **Engine-dialect isolation.** All engine-specific SQL, introspection, and pagination live only in the Core behind one uniform driver interface; the UI sees a single engine-neutral schema/result shape. The Core owns pagination/virtualization and never ships a whole live result set. DB identifiers mirror the live database verbatim.
- **Canonical frozen-data contract is born here.** The shared, versioned frozen-data schema lives in `src/shared/` (dependency-free, imported by all rings) alongside the typed RPC contract — ISO-8601 UTC dates and typed values on every boundary. It is defined here, not under a later feature's pressure, and is unit-testable in isolation with no browser or LLM in the loop.
- **Wire conventions.** Every Core RPC reply is either a typed result or a single error envelope `{ code, message, detail }`. Secrets are never logged; logging is minimal, to stderr, terse/off by default.
- **Source topology.** `src/core/`, `src/ui/`, `src/sandbox/`, `src/shared/`, and `bin/` (CLI entry: parse mode, boot Core, open browser).
- **Dual distribution.** Two install paths yield the same one-command run: a standalone `bun build --compile` binary per platform via releases, and an npm/bun global package for developers who already have a runtime.
- **Stack seed.** Bun 1.2.x; TypeScript 5.x; React 19.x + shadcn/ui; postgres.js 3.x; mysql2 3.22.5. Exact React/TS/shadcn majors confirmed at scaffold.

## UX & Interaction Patterns

- **Aesthetic:** clean, modern, restrained shadcn/ui, dark-first for a dev tool. Anti-reference: dense, Eclipse-era DBeaver UI.
- **Motion serves feedback only** (state changes, streaming), never decoration — consistent with the "lightweight" identity.
- **Workspace shell** feels instant (<100ms interactions); freely openable/closable Tabs and resizable Panels.
- **Port-Exposure Warning** is a prominent, unmistakable alert stating the risk and the precise steps to return to localhost-only.

## Cross-Story Dependencies

- Story 1.1 (walking skeleton + `shared/` contract) is the foundation for every other story in this epic and every later epic.
- Story 1.3 (connection + schema) depends on the engine-neutral driver established via the skeleton.
- Persistence-dependent behavior is intentionally split out: restoring Panel sizes/session state (FR-24 restore half) is delivered by Epic 2, not here. Epic 1 delivers only the resize behavior and Ephemeral (no-write) mode.
- This epic requires no other epic and unblocks all of them.
