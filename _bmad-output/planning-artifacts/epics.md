---
stepsCompleted: ["step-01-validate-prerequisites", "step-02-design-epics", "step-03-create-stories"]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-quick-studio-2026-07-06/prd.md
  - _bmad-output/planning-artifacts/architecture/architecture-quick-studio-2026-07-06/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/briefs/brief-quick-studio-2026-07-06/brief.md
  - _bmad-output/planning-artifacts/briefs/brief-quick-studio-2026-07-06/addendum.md
  - _bmad-output/specs/spec-quick-studio/SPEC.md
  - _bmad-output/specs/spec-quick-studio/glossary.md
---

# quick-studio - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for quick-studio, decomposing the requirements from the PRD, Architecture Spine, Product Brief, and SPEC kernel into implementable stories. quick-studio is a lightweight, local-first database manager (PostgreSQL + MySQL) that installs and runs with a single command, serves a fast web UI on `127.0.0.1`, and folds in a multi-provider AI chat with executable-JS MDX blocks and local report generation. Windows + Linux, v1.

**Architectural spine:** the whole product is a **three-ring trust model** — Ring 1 Trusted Core (Bun backend: DB, credentials, SQL executor, Provider caller), Ring 2 Semi-trusted UI (React/shadcn), Ring 3 Untrusted Sandbox (cross-origin iframe for LLM-generated JS). Data flows outward only; capability never flows inward. This invariant governs every epic below.

## Requirements Inventory

### Functional Requirements

**Install & Launch (§4.1)**
- **FR-1:** One-command install — a developer can install quick-studio with a single documented command on their platform, with no interactive multi-step wizard. Realizes UJ-1.
- **FR-2:** One-command run with mode selection — a single command starts quick-studio and selects a Run Mode; passing a database URL starts an Ephemeral session (nothing written to disk), starting without a URL (or with a persistent flag) starts a Persistent session backed by a Credential Store; the server binds `127.0.0.1` by default. Realizes UJ-1, UJ-2.
- **FR-3:** Clean shutdown — stopping the process (Ctrl-C or UI stop control) terminates the server within a small bounded time [≤2s]; no orphaned process remains and system shutdown is never stalled. Realizes UJ-1.

**Run Modes & Credential Store (§4.2)**
- **FR-4:** Encrypted Credential Store — in Persistent mode, Connections and credentials are stored encrypted at rest; never plaintext; the store file reveals no readable credential material; the encryption key lives in the OS keychain, not in the store file. Realizes UJ-2.
- **FR-5:** Keychain-unavailable fallback — when no OS keychain is available, the app surfaces the condition and offers a passphrase-based unlock; declining writes no credential in plaintext. Realizes UJ-2 (edge case).
- **FR-6:** Manage Connections — in Persistent mode, a developer can add, edit, and remove Connections; a saved Connection is available next launch; removing a Connection deletes its credentials from the store. Realizes UJ-2.

**Connections — Relational (§4.3)**
- **FR-7:** Connect to PostgreSQL and MySQL — a developer can open a working Connection via URL or stored Connection; a valid Postgres/MySQL target connects and lists its schema; a failed connection returns a clear, actionable error (host/auth/network distinguished). NoSQL out of scope.

**Data & Schema Workspace (§4.4)**
- **FR-8:** Browse and edit data — view table rows (paginated), edit cell values, insert and delete rows, committed to the database; an edited cell persists on reload; a new row appears on reload; deletion requires confirmation.
- **FR-9:** Create tables — create a table (columns, types, primary key, basic constraints); a created table appears in the schema and the ERD without manual refresh.
- **FR-10:** Inspect indexes — view a table's indexes; each index lists its columns and uniqueness.
- **FR-11:** Run ad-hoc SQL — write and run arbitrary SQL in a query Tab; a SELECT returns a paginated result grid; a destructive statement requires explicit confirmation before executing.

**Interactive ERD (§4.5)**
- **FR-12:** Render relational ERD — view an interactive ERD; tables render as nodes with columns, foreign keys render as edges; navigable (pan/zoom) and responsive to at least 60–70 tables.
- **FR-13:** Persist ERD layout — in Persistent mode, a rearranged ERD layout is saved and restored on next launch. Schema editing *through* the ERD is out of scope (v2).

**AI Chat (§4.6)**
- **FR-14:** Configure Providers — configure Anthropic, OpenAI, and/or Google (Gemini) with the user's own API key; a configured Provider is selectable for a chat; keys are protected like Credentials (FR-4) in Persistent mode, session-only and never written to disk in Ephemeral mode.
- **FR-15:** Natural-language to query + execution — ask a question in natural language, receive a query, and run it from the chat; the generated query targets the schema of the chat's explicitly-bound Connection; running from chat matches running in a query Tab; destructive statements are never auto-executed and require explicit confirmation. Realizes UJ-3.
- **FR-16:** Streaming responses with visible reasoning — responses stream token-by-token; reasoning is visually distinguished from the final answer. Realizes UJ-3.
- **FR-17:** Rich MDX rendering — the AI Chat renders MDX Blocks combining Markdown, embedded executable JS, and charts; a chart spec renders an interactive chart; embedded JS executes only within the security boundary (§11-R1 / AD-3). **Hard-gated by the sandbox prerequisite — not shippable until the sandbox model is in place.**

**Report Generation (§4.7)**
- **FR-18:** Build a Report from query results — assemble a Report from one or more query results, mixing narrative, charts, and tabular data (MDX Blocks). Realizes UJ-4.
- **FR-19:** Test-to-production targeting — build a Report against one database and re-target it at another; re-targeting re-runs the Report's queries against the new target without rebuilding the layout. Realizes UJ-4.
- **FR-20:** Export as static Snapshot or Live Report — export a Report as HTML, choosing a static Snapshot (frozen data, renders offline) or a Live Report (re-queries its target on view via a viewer-supplied connection); generation and export send no data to any external service. Realizes UJ-4.

**Local Security & Port-Exposure Warning (§4.8)**
- **FR-21:** Localhost-by-default binding — the server binds `127.0.0.1` unless explicitly overridden; with defaults it is not reachable from another host.
- **FR-22:** Port-exposure detection and warning — binding/exposure beyond localhost raises a prominent Port-Exposure Warning that explains the risk and how to revert to localhost-only. Realizes UJ-5.

**UI Shell (§4.9)**
- **FR-23:** Tabs — open and close Tabs for tables, queries, ERDs, chats, and reports; multiple Tabs open at once; closing one leaves the others intact.
- **FR-24:** Resizable Panels — resize the Workspace's Panels; in Persistent mode panel sizes are restored on next launch [ASSUMPTION].

### NonFunctional Requirements

- **NFR-1 (Idle footprint):** at idle with connections open, resident memory and CPU stay low enough to run all day alongside an IDE and browser — accepted ceiling ≤ ~200 MB resident, CPU ~0% at idle. Validates SM-4.
- **NFR-2 (Startup):** from run command to interactive Workspace in ≤2s cold.
- **NFR-3 (Shutdown):** instant, non-blocking; no orphan process or lingering daemon (ties to FR-3).
- **NFR-4 (Interaction latency):** common actions (open table, switch Tab, resize Panel, first query paint) feel instant — UI response <100ms; first result paint bounded by the DB, not the tool.
- **NFR-5 (Large results):** result grids and the ERD stay responsive under large schemas/result sets via Core pagination/virtualization rather than degrading.
- **NFR-6 (Streaming smoothness):** AI Chat streaming and MDX rendering never jank the UI thread.

### Additional Requirements

Derived from the Architecture Spine (ADs, constraints R1–R6, stack, distribution, structural seed). These are cross-cutting build constraints that shape stories across all epics.

**Trust model & security boundary (root invariants)**
- **AR-1 (Three-ring trust model — AD-1):** every runtime unit belongs to exactly one ring (`src/core/`, `src/ui/`, `src/sandbox/`); data passes outward only; capability/requests cross only to the ring immediately inward via a defined, authenticated channel. No feature may widen its ring's powers. **This governs every story.**
- **AR-2 (Core is sole secret-holder, SQL executor, Provider caller — AD-2):** DB connections, decrypted credentials, and Provider keys exist only in the Core process; all SQL executes there; every outbound Provider call is made there. UI/Sandbox issue typed requests and receive results.
- **AR-3 (Single guarded executor, confirmation by request shape — AD-4):** every mutation passes through one Core executor — the sole classifier of statement risk; a UI dialog is UX only, never the gate. Two request shapes: **(a) structured operations** — typed, parameterized UI-builder requests (single-row grid DML addressed by primary key, and the create-table builder); the Core composes the SQL, and the path can express only a single-row INSERT/UPDATE/DELETE or CREATE TABLE — never DROP/TRUNCATE/ALTER, raw, multi-row, or multi-statement; INSERT + single-row UPDATE + CREATE TABLE auto-commit, row DELETE always confirms. **(b) raw SQL text** — query Tab / AI; UPDATE/DELETE/DROP/TRUNCATE/ALTER default-deny and always confirmed, multi-statement rejected or split; DROP/TRUNCATE/ALTER can arrive only on this path. The invariant holds: all mutation flows through the one executor, always parameterized — only the confirmation policy differs by shape.
- **AR-4 (Cross-origin sandbox for executable JS — AD-3, R1):** MDX-embedded JS runs in an iframe from a separate origin, `sandbox="allow-scripts"` without `allow-same-origin`, CSP `default-src 'none'` / `connect-src 'none'`; postMessage is one-way for data (Ring 2 pushes frozen data in; sandbox emits only render-lifecycle/interaction signals out); the sandbox cannot request data or trigger a query. In-process isolation (SES/QuickJS/ShadowRealm) is never the boundary. **Hard prerequisite for FR-17.**
- **AR-5 (Caller authentication — AD-12):** the Core rejects every RPC lacking the current session capability token and validates Origin/Host to block DNS-rebinding; the UI is handed the token at boot; a Live Report is authorized only as an explicit second caller.
- **AR-6 (Provider boundary — AD-7, R5):** the only outbound channel is the user-configured Provider, called by the Core via a typed, inspectable payload with schema metadata and any row sample as distinct fields; schema-only is the default; rows leave only via explicit, per-query, visibly-indicated opt-in.

**Data & persistence**
- **AR-7 (Encrypted store model — AD-5, R2):** AES-256-GCM store; 32-byte key in OS keychain (Windows Credential Manager / Linux Secret Service); passphrase-derived key when no keychain; plaintext never written; Ephemeral keys session-only in memory.
- **AR-8 (Ephemeral writes nothing — AD-8):** in Ephemeral mode nothing persists (no store, ERD layout, Report, or panel state); all state in-memory, gone at exit; no daemon outlives the process.
- **AR-9 (One OS-convention app directory — AD-15):** in Persistent mode the store, ERD layouts, Reports, panel/session state, and logs live under one directory (Windows `%APPDATA%\quick-studio`; Linux `$XDG_DATA_HOME/quick-studio` else `~/.local/share/quick-studio`).
- **AR-10 (Engine-dialect isolation — AD-14):** all engine-specific SQL, introspection, and pagination live only in the Core behind one uniform driver interface; Rings 2/3 see a single engine-neutral shape; the Core owns pagination/virtualization and never ships a whole live result set.
- **AR-11 (Canonical frozen-data shape — AD-13):** one shared, versioned frozen-data schema (in `shared/`) is the only shape pushed to the Sandbox and embedded in a Snapshot; ISO-8601 UTC dates and typed values on every boundary.

**Reports, streaming, charts**
- **AR-12 (Live Report carries no credential — AD-9):** a Snapshot embeds frozen data and renders fully offline; a Live Report contains no credential and no DB runtime — it re-queries only by targeting a running quick-studio Core on `127.0.0.1` that explicitly authorizes it and supplies the connection.
- **AR-13 (Streaming is SSE, reasoning a distinct channel — AD-11):** Core→UI streaming (AI tokens, reasoning, large result pages) uses SSE over the localhost HTTP channel; reasoning is a channel visually distinct from the answer.
- **AR-14 (Charting split by ring — AD-10):** in-app charts (Ring 2) use Recharts / shadcn charts; Sandbox charts (Ring 3) use Observable Plot; TradingView lightweight-charts is not used.

**Localhost & exposure**
- **AR-15 (Localhost default + exposure watcher — AD-6):** server binds `127.0.0.1` unless overridden; a watcher detects any non-loopback binding and raises the Port-Exposure Warning.

**Distribution & stack**
- **AR-16 (Dual distribution — AD-16):** two install paths yield the same one-command run: a standalone `bun build --compile` binary per platform (Windows + Linux) via releases, and an npm/bun global package for developers who already have a runtime.
- **AR-17 (Stack seed):** Bun 1.2.x runtime; TypeScript 5.x; React 19.x + shadcn/ui; Vercel AI SDK (`ai` 7.0.15 + `@ai-sdk/anthropic`/`openai`/`google` 4.0.8) as the unified multi-provider AI layer (Providers never called directly); postgres.js 3.x; mysql2 3.22.5; @napi-rs/keyring 1.3.0; Recharts 3.9.2; Observable Plot 0.6.17. Exact React/TS/shadcn majors confirmed at scaffold.
- **AR-18 (Source topology):** `src/core/`, `src/ui/`, `src/sandbox/`, dependency-free `src/shared/` (typed RPC + frozen-data contracts imported by all rings), `bin/` (CLI entry: parse mode, boot Core, open browser).
- **AR-19 (Wire & logging conventions):** every Core RPC reply is a typed result or a single error envelope `code/message/detail`; DB identifiers mirror the live database verbatim; secrets are never logged; logging is minimal, to stderr, terse/off by default.
- **AR-20 (Keychain parity risk — Deferred/Open):** `@napi-rs/keyring` NAPI parity under Bun is "almost, not 100%" — smoke-test on Windows and Linux before locking; the passphrase fallback (AR-7) is the safety net.

### UX Design Requirements

No dedicated UX design contract exists (no `ux-designs/` folder). These UX-DRs are extracted from PRD §12 (Aesthetic & Tone) and the Architecture Consistency Conventions — the UX quality is explicitly part of the product's identity, not decoration.

- **UX-DR1:** shadcn/ui aesthetic — clean, modern, restrained; **dark-first** theme for a dev tool. Anti-reference: DBeaver's dense, Eclipse-era UI.
- **UX-DR2:** Fast/fluid over ornate — motion serves feedback only (state changes, streaming), never decoration; consistent with the "lightweight" identity and counter-metric SM-C1.
- **UX-DR3:** Streaming UX — model reasoning is rendered as a channel visually distinct from the final answer (AD-11); streaming/MDX render never janks the UI thread (NFR-6).
- **UX-DR4:** Destructive-action UX — a clear confirmation surface for destructive operations: **row deletes**, and any **raw or AI-generated** mutating/DDL statement (DELETE/DROP/TRUNCATE/UPDATE/ALTER) from the query Tab or chat, shared across data workspace, query Tab, and chat (FR-8/FR-11/FR-15). Routine inline grid edits and inserts (structured single-row DML — AD-4 path (a)) **auto-commit without a dialog** — the fast-path exemption that keeps daily editing fluid. Note: the dialog is UX only; the Core executor is the real gate (AR-3).
- **UX-DR5:** Port-Exposure Warning — a prominent, unmistakable UI alert that explains the risk and the exact steps to revert to localhost-only (FR-22).
- **UX-DR6:** Result-grid & ERD responsiveness UX — paginated/virtualized result grids and a pan/zoom ERD that stay fluid on large schemas (60–70 tables) and large result sets (NFR-5).
- **UX-DR7:** Workspace shell UX — freely openable/closable Tabs and resizable Panels, restored in Persistent mode; tuned to feel instant (<100ms interactions, NFR-4).

### FR Coverage Map

- **FR-1:** Epic 1 — One-command install
- **FR-2:** Epic 1 — One-command run + mode select (Ephemeral)
- **FR-3:** Epic 1 — Clean, instant shutdown
- **FR-4:** Epic 2 — Encrypted Credential Store
- **FR-5:** Epic 2 — Keychain-unavailable passphrase fallback
- **FR-6:** Epic 2 — Manage Connections
- **FR-7:** Epic 1 — Connect to PostgreSQL and MySQL
- **FR-8:** Epic 3 — Browse and edit data
- **FR-9:** Epic 3 — Create tables
- **FR-10:** Epic 3 — Inspect indexes
- **FR-11:** Epic 3 — Run ad-hoc SQL
- **FR-12:** Epic 4 — Render relational ERD
- **FR-13:** Epic 4 — Persist ERD layout (requires Epic 2 persistence)
- **FR-14:** Epic 5 — Configure Providers
- **FR-15:** Epic 5 — Natural-language to query + execution
- **FR-16:** Epic 5 — Streaming responses with visible reasoning
- **FR-17:** Epic 5 — Rich MDX rendering (gated by sandbox, AR-4)
- **FR-18:** Epic 6 — Build a Report from query results
- **FR-19:** Epic 6 — Test-to-production targeting
- **FR-20:** Epic 6 — Export as static Snapshot or Live Report
- **FR-21:** Epic 1 — Localhost-by-default binding
- **FR-22:** Epic 1 — Port-exposure detection and warning
- **FR-23:** Epic 1 — Tabs
- **FR-24:** Epic 1 — Resizable Panels (restore behavior enabled by Epic 2 persistence)

## Epic List

### Epic 1: One-Command Workspace & Live Connection
A developer runs `quick-studio` with a database URL and, within seconds, has a localhost Workspace open in the browser, connected to a PostgreSQL or MySQL database with its schema visible — then closes it and nothing lingers. This epic delivers UJ-1 end-to-end and establishes the three-ring skeleton (Core / UI / Sandbox host / shared / bin) that every later epic sits on: Ephemeral run mode, one-command install + dual distribution, `127.0.0.1`-by-default binding with the active Port-Exposure Warning, the Core session-capability token, the engine-neutral driver interface, and the Tabs/Panels shell. Security is resolved first, as the PRD requires.
**FRs covered:** FR-1, FR-2, FR-3, FR-7, FR-21, FR-22, FR-23, FR-24
**NFRs:** NFR-2 (startup ≤2s), NFR-3 (shutdown), NFR-4 (interaction <100ms)
**Governing ARs:** AR-1, AR-2, AR-5, AR-10, AR-11, AR-15, AR-16, AR-17, AR-18, AR-19
**Standalone:** complete spin-up + inspect loop; enables all future epics, requires none.
**Note (roundtable):** the canonical frozen-data contract (AR-11 / AD-13) is born here in `src/shared/`, not in Epic 5 — it is the shape both AI Chat (E5) and Reports (E6) import, and defining it under a feature's pressure would bias its consumers. It is unit-testable in isolation (frozen-data fixtures, ISO-8601 dates) with no iframe or LLM in the loop.

### Epic 2: Persistent Mode & Credential Store
A developer saves their everyday connections once (UJ-2): an encrypted AES-256-GCM Credential Store with its key in the OS keychain, a passphrase fallback when no keychain exists, and add/edit/remove Connection management. Establishes the persistence substrate (one OS-convention app directory) that later epics use to save ERD layouts, panel state, and Reports. Isolated crypto risk boundary — placed second (right after the skeleton) because the switch test (SM-1) is not real without saved connections; a daily driver that re-prompts for a URL every launch does not replace DBeaver.
**FRs covered:** FR-4, FR-5, FR-6 (enables FR-13, FR-24 restore, FR-14 key protection)
**Governing ARs:** AR-7 (encrypted store), AR-8 (Ephemeral writes nothing), AR-9 (app directory), AR-20 (keychain parity smoke-test)
**Note (roundtable):** the FIRST story is a `@napi-rs/keyring`-under-Bun spike on Windows AND Linux (AR-20) — parity is "almost, not 100%", and the whole crypto path forks on the result; the passphrase fallback is the safety net if a platform fails. De-risk before building the store.
**Standalone:** turns the Ephemeral tool into a persistent one; depends only on Epic 1.

### Epic 3: Data & Schema Workspace
A developer does the daily database work that defines the switch test (SM-1): browse table rows with pagination, edit cell values, insert and delete rows, create tables, inspect indexes, and run ad-hoc SQL — all routed through the single guarded Core executor that classifies statement risk and confirms every mutating statement. Builds on Epic 1's connection/shell and Epic 2's saved connections.
**FRs covered:** FR-8, FR-9, FR-10, FR-11
**NFRs:** NFR-5 (large results responsive via pagination)
**Governing ARs:** AR-3 (single guarded executor, default-deny mutations), AR-10 (engine-dialect isolation), UX-DR4 (destructive-action confirmation UX)
**Note (roundtable):** the FIRST story stands up the single guarded Core executor (AR-3) *with* its adversarial test battery — before any row-editing UI. Confirmation policy is set by request shape (AD-4): raw SQL from the query Tab / AI (path b) has UPDATE/DELETE/DROP/TRUNCATE/ALTER default-deny with multi-statement smuggling rejected, while structured single-row grid DML (path a) auto-commits edits/inserts and confirms only deletes — keeping daily editing fluid without weakening the guard. This executor is the sole system-wide risk classifier; it is contained and proven the moment it exists, not hardened at the end.
**Standalone:** full daily-driver value; depends on Epic 1 + Epic 2.

### Epic 4: Interactive ERD
A developer reads the connected schema visually: tables render as nodes with their columns, foreign keys render as edges, the diagram pans/zooms fluidly to 60–70 tables, and — with Persistent mode on — the rearranged layout is restored next launch.
**FRs covered:** FR-12, FR-13
**NFRs:** NFR-5 (ERD responsive on large schemas)
**Governing ARs:** AR-10 (Core schema introspection), AR-14 (in-app rendering), AR-9 (layout persistence)
**Standalone:** complete visual-schema value; depends on Epic 1 (schema) and Epic 2 (FR-13 persist only).

### Epic 5: AI Chat with Executable-JS Sandbox
A developer asks a question in natural language, receives a query bound to the active Connection's schema, runs it from the chat, watches the model's reasoning and answer stream in, and sees rich MDX Blocks (charts + executable JS) render safely. This epic owns the single highest-risk capability in v1 — the cross-origin, pure-render sandbox (§11-R1 / AR-4). Stories are ordered so value arrives incrementally: chat plumbing → Provider config → NL→query + execution → streaming → **[sandbox]** → MDX rendering. The sandbox is the hard gate for FR-17 only; FR-14–16 ship without it.
**FRs covered:** FR-14, FR-15, FR-16, FR-17
**NFRs:** NFR-6 (streaming never janks the UI thread)
**Governing ARs:** AR-4 (cross-origin sandbox — hard prereq), AR-6 (Provider boundary, schema-only default), AR-11 (frozen-data shape, defined in E1), AR-13 (SSE streaming, reasoning channel), AR-14 (charts split by ring), UX-DR3
**Note (roundtable):** the sandbox (AR-4 / §11-R1) is the single highest-risk item in v1 and it gates FR-17 *and* Epic 6. The sandbox story is de-risked early within this epic and shipped WITH its adversarial containment tests (cross-origin escape attempts, `postMessage` one-way enforcement, CSP `default-src 'none'` / `connect-src 'none'`, no data-request/query path inward) — the ring is not the boundary until someone tried to cross it and failed. FR-14–16 ship without the sandbox; only FR-17 waits on it.
**Standalone:** full conversational database work; depends on Epic 1 + Epic 3 (executor), Epic 2 for persistent Provider keys (Ephemeral session-only otherwise).

### Epic 6: Local Report Generation
A developer turns query results into an exportable HTML Report — the marquee differentiator (UJ-4). They assemble a Report from one or more query results with narrative and charts, build it against a test database and re-target it at production, and export it as a static Snapshot (frozen data, renders offline) or a Live Report (re-queries a viewer-supplied connection through a running quick-studio) — with no data ever sent to an external service. Reuses the Epic 5 sandbox and charting.
**FRs covered:** FR-18, FR-19, FR-20
**Governing ARs:** AR-11 (canonical frozen-data shape), AR-12 (Live Report carries no credential), AR-14 (charting), AR-4 (reuses sandbox render), AR-5 (Live Report authorized as explicit caller)
**Standalone:** complete report workflow; depends on Epic 3 (query results) and Epic 5 (sandbox + MDX + charts).

## Epic 1: One-Command Workspace & Live Connection

A developer runs `quick-studio` with a database URL and, within seconds, has a localhost Workspace connected to a PostgreSQL or MySQL database with its schema visible — then closes it and nothing lingers. Establishes the three-ring skeleton every later epic sits on. **FRs:** FR-1, FR-2, FR-3, FR-7, FR-21, FR-22, FR-23, FR-24.

### Story 1.1: Walking skeleton — the Core boots on localhost and the UI connects with a session token

As a developer,
I want the three-ring skeleton to boot with the Core serving an authenticated UI on `127.0.0.1`,
So that every later feature has a secure Core↔UI channel to build on.

**Acceptance Criteria:**

**Given** the `src/core`, `src/ui`, `src/shared`, and `bin/` structure exists
**When** I launch the entry point
**Then** the Core process binds `127.0.0.1`, serves the Ring-2 UI, and mints a session capability token handed to the UI at boot
**And** the `shared/` module defines the typed RPC + frozen-data contract (ISO-8601 UTC dates, typed values), unit-tested against fixtures with no browser or LLM in the loop

**Given** the Core is running
**When** an RPC arrives without the current session token, or with a foreign `Origin`/`Host` header
**Then** the Core rejects it (AR-5 / AD-12 — loopback is not an auth boundary)

**Given** a valid authenticated RPC from the UI
**When** it hits the Core
**Then** the reply is a typed result or a single error envelope `code / message / detail` (AR-19)

### Story 1.2: One-command run with mode selection

As a developer,
I want to start quick-studio with a single command and pick Ephemeral or Persistent,
So that I can either spin up disposably from a URL or run against my saved setup.

**Acceptance Criteria:**

**Given** a database URL passed on the command line
**When** I run quick-studio
**Then** an Ephemeral session starts, the default browser opens on the Workspace, and nothing is written to disk during or after the session (AR-8)

**Given** no URL (or an explicit persistent flag)
**When** I run quick-studio
**Then** a Persistent session is selected (Credential Store wiring delivered in Epic 2)

**Given** either mode
**When** the server starts
**Then** it binds `127.0.0.1` by default

### Story 1.3: Connect to PostgreSQL and MySQL through one engine-neutral driver interface

As a developer,
I want to open a working connection to a Postgres or MySQL database and see its schema,
So that I can start inspecting a database immediately (UJ-1).

**Acceptance Criteria:**

**Given** a valid PostgreSQL target (URL or, later, stored Connection)
**When** I connect
**Then** the Core opens it through one uniform driver interface and lists the schema; Ring 2 sees a single engine-neutral shape (AR-10)

**Given** a valid MySQL target
**When** I connect
**Then** it connects and lists its schema the same engine-neutral way

**Given** a bad target
**When** the connection fails
**Then** the error clearly distinguishes host vs auth vs network

### Story 1.4: Workspace shell — open/close Tabs and resizable Panels

As a developer,
I want a Workspace of openable/closable Tabs and resizable Panels,
So that I can hold multiple pieces of work at once in a fast, fluid surface.

**Acceptance Criteria:**

**Given** the Workspace is open
**When** I open Tabs for a table, a query, an ERD, a chat, and a report
**Then** multiple Tabs are open at once and closing one leaves the others intact (FR-23)

**Given** the Workspace layout
**When** I drag a Panel divider
**Then** the Panel resizes (FR-24; restore-on-launch delivered with Epic 2 persistence)

**Given** common interactions (open a Tab, switch Tabs, resize a Panel)
**When** I perform them
**Then** they respond in <100ms (NFR-4), in a dark-first shadcn aesthetic (UX-DR1)

### Story 1.5: Clean, instant shutdown

As a developer,
I want quick-studio to stop instantly and leave nothing behind,
So that it never taxes or stalls my machine.

**Acceptance Criteria:**

**Given** a running session
**When** I press Ctrl-C or use the UI stop control
**Then** the server terminates within ≤2s (NFR-3) and no orphaned process remains

**Given** quick-studio has been closed
**When** the OS shuts down
**Then** quick-studio never stalls shutdown, and no daemon outlives the session

### Story 1.6: Localhost-by-default binding + Port-Exposure Warning

As a developer,
I want quick-studio bound to localhost and to be warned loudly if the port is ever exposed,
So that my databases never become reachable off-machine without my knowing (UJ-5).

**Acceptance Criteria:**

**Given** default settings
**When** the server runs
**Then** it is not reachable from another host on the network (FR-21)

**Given** the server is bound or exposed to a non-loopback address
**When** the exposure watcher detects it
**Then** a prominent Port-Exposure Warning appears explaining the risk and the exact steps to revert to localhost-only (FR-22, UX-DR5)

### Story 1.7: One-command install via dual distribution

As a developer (including a colleague without a JS runtime),
I want to install quick-studio with a single command,
So that there is no installer ceremony on Windows or Linux.

**Acceptance Criteria:**

**Given** a platform (Windows or Linux)
**When** I install via the standalone `bun build --compile` binary from releases
**Then** I get a runnable `quick-studio` with no multi-step wizard (FR-1, AR-16)

**Given** a developer who already has a JS runtime
**When** they install the npm/bun global package
**Then** they get the same one-command run

## Epic 2: Persistent Mode & Credential Store

A developer saves their everyday connections once (UJ-2): an encrypted AES-256-GCM Credential Store with its key in the OS keychain, a passphrase fallback when no keychain exists, and add/edit/remove Connection management, plus the persistence substrate later epics reuse. Placed second because the switch test is not real without saved connections. **FRs:** FR-4, FR-5, FR-6.

### Story 2.1: Spike — validate `@napi-rs/keyring` under Bun on Windows and Linux

As a builder,
I want to prove the OS-keychain path works under Bun on both target platforms before building the store,
So that the whole crypto design isn't built on a library that silently fails on one platform (AR-20).

**Acceptance Criteria:**

**Given** Bun on Windows
**When** I store and retrieve a test secret via `@napi-rs/keyring` (Windows Credential Manager)
**Then** it round-trips correctly, or the failure is documented and the passphrase fallback is confirmed as the path for that platform

**Given** Bun on Linux (Secret Service)
**When** I run the same smoke test
**Then** the result is recorded as a go/no-go per platform, committed as a repeatable smoke test

**Given** the spike outcome
**When** I close it
**Then** a short decision record states the chosen key-management path per platform (keychain vs passphrase-first)

### Story 2.2: Encrypted Credential Store at rest, key in OS keychain

As a developer,
I want my Connections stored encrypted at rest with the key held by the OS keychain,
So that my credentials are never exposed on disk (UJ-2).

**Acceptance Criteria:**

**Given** Persistent mode
**When** a Connection is saved
**Then** it is written to an AES-256-GCM store under the OS-convention app directory (Windows `%APPDATA%\quick-studio`; Linux `$XDG_DATA_HOME/quick-studio` else `~/.local/share/quick-studio`) — AR-9

**Given** the store file
**When** it is opened directly
**Then** it reveals no readable credential material, and it does **not** contain its own encryption key

**Given** the encryption key
**When** the store is unlocked
**Then** the 32-byte key is read from the OS keychain (AR-7); credentials are never written in plaintext

### Story 2.3: Keychain-unavailable passphrase fallback

As a developer on a keychain-less machine,
I want a passphrase-based unlock instead of plaintext storage,
So that I can still use Persistent mode safely (UJ-2 edge case).

**Acceptance Criteria:**

**Given** a machine with no usable OS keychain
**When** I start Persistent mode
**Then** the app surfaces the condition and offers a passphrase-derived key to unlock the store (FR-5)

**Given** I decline the passphrase fallback
**When** the flow ends
**Then** no credential is written in plaintext anywhere

### Story 2.4: Manage Connections (add, edit, remove)

As a developer,
I want to add, edit, and remove my saved Connections,
So that my everyday databases are one launch away (UJ-2).

**Acceptance Criteria:**

**Given** Persistent mode
**When** I add or edit a Connection
**Then** it is saved to the encrypted store and available on the next launch without re-entry (FR-6)

**Given** a saved Connection
**When** I remove it
**Then** its credentials are deleted from the store

### Story 2.5: Persist and restore Workspace state

As a developer,
I want my Panel sizes and open Tabs restored on next launch in Persistent mode,
So that I return to the Workspace exactly as I left it.

**Acceptance Criteria:**

**Given** Persistent mode and a rearranged Workspace
**When** I relaunch
**Then** Panel sizes and session state are restored from the app directory (FR-24 restore half, AR-9)

**Given** Ephemeral mode
**When** I relaunch
**Then** nothing is restored — no Workspace state was ever written to disk (AR-8)

## Epic 3: Data & Schema Workspace

A developer does the daily database work that defines the switch test (SM-1): browse/edit/insert/delete rows, create tables, inspect indexes, and run ad-hoc SQL — all routed through the single guarded Core executor. **FRs:** FR-8, FR-9, FR-10, FR-11.

### Story 3.1: Single guarded Core executor — two request shapes, confirmation by shape, with adversarial guard

As a developer,
I want every database mutation to pass through one Core executor that classifies risk by request shape and blocks raw destructive statements by default,
So that no query — hand-written or AI-generated — can silently mutate or drop data, while routine inline data edits stay fast (AR-3, AD-4, R4).

The executor accepts exactly two request shapes and sets confirmation policy by shape (AD-4): **(a) structured operations** — typed, parameterized UI-builder requests the Core composes into SQL; **(b) raw SQL text** — opaque text from the query Tab or an AI-generated query. The invariant holds: all mutation flows through this one executor, always parameterized.

**Acceptance Criteria:**

**Given** a `SELECT` (raw SQL path)
**When** it runs through the Core executor
**Then** it returns a paginated result grid

**Given** raw SQL text carrying a mutating statement (`UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`) — from a query Tab or an AI-generated query (path (b))
**When** it is submitted
**Then** it is default-deny — never auto-run, always requiring explicit confirmation; the Core executor is the sole classifier, a UI dialog is never the gate

**Given** a structured operation from a UI builder (path (a)) — a single-row data-grid DML request (one table, one primary-key-addressed row, column/value pairs) or a create-table request
**When** it reaches the executor
**Then** the Core composes the parameterized statement itself; the request can carry no raw SQL, no multiple statements, and no arbitrary DDL; an `INSERT`, a single-row `UPDATE`, or a `CREATE TABLE` auto-commits, and a row `DELETE` requires explicit confirmation

**Given** multi-statement input like `SELECT 1; DROP TABLE users` on the raw SQL path (b)
**When** it is submitted
**Then** it is rejected or split so no destructive statement rides behind a safe one

**Given** an attempt to smuggle raw SQL, extra statements, arbitrary DDL, or an unfiltered/multi-row mutation through the structured path (a)
**When** it is submitted
**Then** the executor rejects it — path (a) can only ever produce one parameterized primary-key-addressed row-level statement (or a `CREATE TABLE`); `DROP`/`TRUNCATE`/`ALTER` and raw/multi-row mutations are unreachable on this path

**Given** the guard
**When** the story ships
**Then** it ships with an adversarial test battery covering bypass attempts on **both** paths (statement smuggling, casing, comment tricks on path (b); structured-field injection, primary-key tampering, DDL/multi-row escalation attempts on path (a))

### Story 3.2: Browse table rows with pagination

As a developer,
I want to open a table and browse its rows,
So that I can inspect data quickly without it taxing the machine (UJ-1).

**Acceptance Criteria:**

**Given** a connected database
**When** I open a table
**Then** it opens in a Tab showing its rows with pagination (FR-8 view)

**Given** a large table
**When** I page through it
**Then** it stays responsive via Core pagination/virtualization rather than degrading (NFR-5, AR-10)

### Story 3.3: Edit, insert, and delete rows

As a developer,
I want to edit cell values and insert or delete rows,
So that I can fix and manage data inline (UJ-1).

All grid mutations flow through the Story 3.1 executor as **structured single-row DML** (AD-4 path (a)) — typed and parameterized by primary key, never raw SQL — so routine edits stay fast while the Core still owns and gates every mutation.

**Acceptance Criteria:**

**Given** an open table
**When** I edit a cell value
**Then** the change is committed as a parameterized single-row `UPDATE` through the Core executor and **auto-commits without a confirmation dialog** (structured single-row DML, Story 3.1 path (a)), and is reflected on reload

**Given** an open table
**When** I insert a new row
**Then** it is committed as a parameterized `INSERT` through the Core executor, auto-commits without a dialog, and appears on reload

**Given** a selected row
**When** I delete it
**Then** it is committed as a parameterized single-row `DELETE` through the Core executor, which **requires explicit confirmation** before executing (the dialog is UX only; the executor is the gate — UX-DR4, Story 3.1 path (a))

**Given** any of the edit / insert / delete grid affordances
**When** it acts
**Then** the request carries only table + primary key + column/value fields — never raw SQL, DDL, or multiple statements — so it can never widen into a destructive statement (AD-4 path (a))

### Story 3.4: Create tables

As a developer,
I want to create a table with columns, types, a primary key, and basic constraints,
So that I can shape a schema without leaving the tool.

**Acceptance Criteria:**

**Given** a connected database
**When** I create a table (columns, types, primary key, basic constraints)
**Then** the request is composed by the Core executor as a structured `CREATE TABLE` (AD-4 path (a) — no raw SQL from Ring 2), auto-commits, and the table appears in the schema without a manual refresh (and in the ERD once Epic 4 is present)

### Story 3.5: Inspect indexes

As a developer,
I want to view the indexes on a table,
So that I can understand its access paths.

**Acceptance Criteria:**

**Given** a table
**When** I inspect its indexes
**Then** each index lists its columns and its uniqueness

### Story 3.6: Run ad-hoc SQL in a query Tab

As a developer,
I want to write and run arbitrary SQL and see results,
So that I can go beyond the point-and-click surface when I need to (UJ-1).

**Acceptance Criteria:**

**Given** a query Tab
**When** I run a `SELECT`
**Then** I get a paginated result grid

**Given** a query Tab
**When** I run a destructive statement
**Then** it requires explicit confirmation before executing, via the shared Story 3.1 guard (FR-11)

## Epic 4: Interactive ERD

A developer reads the connected schema visually: tables as nodes, foreign keys as edges, pan/zoom fluid to 60–70 tables, and — with Persistent mode on — the layout is saved. **FRs:** FR-12, FR-13.

### Story 4.1: Render and navigate the relational ERD

As a developer,
I want an interactive ERD of the connected schema I can pan and zoom,
So that I can read the structure of a database visually (UJ-1).

**Acceptance Criteria:**

**Given** a connected database
**When** I open the ERD
**Then** tables render as nodes with their columns, and foreign-key relationships render as edges (FR-12)

**Given** the ERD is open
**When** I pan and zoom
**Then** it stays navigable and responsive on a schema of at least 60–70 tables (FR-12, NFR-5)

**Given** the schema comes from either engine
**When** the ERD renders
**Then** it consumes the single engine-neutral schema shape from the Core (AR-10) — identifiers mirror the live database verbatim

### Story 4.2: Persist and restore ERD layout

As a developer,
I want my rearranged ERD layout saved,
So that the diagram opens the way I left it (UJ-1).

**Acceptance Criteria:**

**Given** Persistent mode and a rearranged ERD layout
**When** I relaunch
**Then** the layout is restored from the app directory (FR-13, AR-9)

**Given** Ephemeral mode
**When** I close the session
**Then** no ERD layout is written to disk (AR-8)

## Epic 5: AI Chat with Executable-JS Sandbox

A developer asks in natural language, runs the resulting query, watches reasoning stream, and sees rich MDX render safely. This epic owns the single highest-risk capability in v1 — the cross-origin sandbox. Internal order: config → chat/boundary → NL→query → streaming → **[sandbox]** → MDX. **FRs:** FR-14, FR-15, FR-16, FR-17.

### Story 5.1: Configure AI Providers with user-supplied API keys

As a developer,
I want to configure Anthropic, OpenAI, and/or Google (Gemini) with my own API keys,
So that I can use AI on my own account with no backend or hosted cost (R6).

**Acceptance Criteria:**

**Given** a Provider
**When** I supply my own API key
**Then** it becomes selectable for a chat, reached through the unified AI layer (AR-17), never called from Ring 2/3

**Given** Persistent mode
**When** a Provider key is stored
**Then** it is protected under the same encryption as Credentials (FR-4)

**Given** Ephemeral mode
**When** a key is supplied
**Then** it is session-only, in memory, and never written to disk (FR-14, AR-8)

### Story 5.2: Chat Q&A with the Core as sole Provider caller, schema-only by default

As a developer,
I want to ask about a database and get an answer, with only schema metadata leaving my machine by default,
So that I get help without silently shipping my data to a third party (R5).

**Acceptance Criteria:**

**Given** a chat bound to one explicitly selected Connection
**When** I ask a question
**Then** the Core (holder of the Provider key) makes the only outbound call, assembled as a typed, inspectable payload with schema metadata and any row sample as **distinct fields** (AR-6 / AD-7)

**Given** the default policy
**When** the payload is assembled
**Then** it carries schema only (table/column names, types, foreign keys) — no rows ride along except via an explicit, per-query, visibly-indicated opt-in

### Story 5.3: Natural-language to query + execution from chat

As a developer,
I want to ask in plain language, get a query, and run it from the chat,
So that I don't hand-write the JOIN or juggle a separate AI tab (UJ-3).

**Acceptance Criteria:**

**Given** a chat bound to a Connection
**When** I ask a question in natural language
**Then** I receive a query targeting that Connection's schema (FR-15)

**Given** a generated query
**When** I run it from the chat
**Then** it produces the same result as running it in a query Tab, executed through the Story 3.1 guarded executor

**Given** a generated destructive statement
**When** I try to run it from chat
**Then** it is never auto-executed and requires explicit confirmation (AR-3, R4)

### Story 5.4: Streaming responses with visible reasoning

As a developer,
I want responses to stream token-by-token with the model's reasoning shown as it works,
So that the assistant feels alive and I can follow its thinking (UJ-3).

**Acceptance Criteria:**

**Given** a chat response
**When** the model responds
**Then** output appears incrementally over SSE, not only on completion (FR-16, AR-13)

**Given** a streaming response
**When** it renders
**Then** the reasoning is a channel visually distinct from the final answer (UX-DR3)

**Given** streaming and rendering
**When** they run
**Then** they never jank the UI thread (NFR-6)

### Story 5.5: Cross-origin executable-JS sandbox with adversarial containment

As a builder,
I want LLM-generated JavaScript to run only inside a quarantined cross-origin iframe that can do nothing but draw,
So that the single highest-risk capability in v1 can never reach the host, filesystem, network, backend, credentials, or database (R1, AR-4).

**Acceptance Criteria:**

**Given** the sandbox iframe
**When** it is served
**Then** it comes from a **separate origin** with `sandbox="allow-scripts"` and **without** `allow-same-origin`, under CSP `default-src 'none'` and `connect-src 'none'`

**Given** the `postMessage` channel
**When** data crosses it
**Then** it is one-way for data: Ring 2 pushes already-frozen data in; the sandbox emits out only render-lifecycle/interaction signals (ready, height, datum-clicked) and can never request data or trigger a query

**Given** adversarial guest code
**When** the sandbox ships
**Then** an adversarial test battery proves containment: cross-origin escape attempts, `connect-src` egress attempts, and inward data/query-request attempts all fail

### Story 5.6: Rich MDX rendering (Markdown + executable JS + charts)

As a developer,
I want the chat to render MDX Blocks combining Markdown, embedded executable JS, and interactive charts,
So that answers can show rich, interactive output — the capability that justifies the sandbox's cost (FR-17, SM-5).

**Acceptance Criteria:**

**Given** a response containing a chart spec
**When** it renders in the sandbox
**Then** an interactive chart appears, drawn with Observable Plot (Ring 3 has no React host — AR-14)

**Given** an MDX Block with embedded JS
**When** it executes
**Then** it runs only within the Story 5.5 security boundary — never with access to host, filesystem, network, or credentials

**Given** data pushed to the sandbox
**When** it is rendered
**Then** it uses the single canonical frozen-data shape from `shared/` (AR-11, defined in Epic 1) — ISO-8601 UTC dates, typed values

## Epic 6: Local Report Generation

A developer turns query results into an exportable HTML Report — the marquee differentiator (UJ-4): assemble from query results, build against test and re-target production, export as a static Snapshot or a Live Report, all local. **FRs:** FR-18, FR-19, FR-20.

### Story 6.1: Build a Report from query results

As a developer,
I want to assemble a Report from one or more query results with narrative and charts,
So that I can answer an ambushed "send me a report on the database" request locally (UJ-4).

**Acceptance Criteria:**

**Given** one or more query results
**When** I build a Report
**Then** it can contain results from more than one query (FR-18)

**Given** a Report
**When** I compose it
**Then** it can mix charts, prose, and tabular data as MDX Blocks — in-app charts drawn with Recharts (Ring 2, AR-14)

**Given** report building and preview
**When** it runs
**Then** no data is sent to any external service (R5)

### Story 6.2: Test-to-production Report targeting

As a developer,
I want to build a Report against a test database and re-target it at production,
So that I can develop safely and then run the finished report against real data (UJ-4).

**Acceptance Criteria:**

**Given** a Report built against one database
**When** I re-target it at another
**Then** its queries re-run against the new target (FR-19), executed through the Core (AR-2)

**Given** re-targeting
**When** it happens
**Then** it does not require rebuilding the Report's layout

### Story 6.3: Export as a static Snapshot

As a developer,
I want to export a Report as a static HTML Snapshot with the data frozen at build time,
So that I can hand someone a self-contained report that needs no database (UJ-4).

**Acceptance Criteria:**

**Given** a Report
**When** I export it as a static Snapshot
**Then** it renders identical data when reopened later, fully disconnected from any database (FR-20)

**Given** the Snapshot's embedded data
**When** it is written
**Then** it uses the single canonical frozen-data shape from `shared/` (AR-11) — the same shape the sandbox consumes

**Given** export
**When** it runs
**Then** it sends no data to any external service (R5)

### Story 6.4: Export as a Live Report

As a developer,
I want to export a Report as a Live Report that re-queries its target when viewed,
So that the report stays current without me rebuilding it (UJ-4).

**Acceptance Criteria:**

**Given** a Live Report export
**When** it is generated
**Then** it contains **no credential and no DB runtime** (AR-12)

**Given** a Live Report being viewed
**When** it re-queries
**Then** it does so only by targeting a running quick-studio Core on `127.0.0.1`, which explicitly authorizes it as a second caller (AR-5 / AD-9) and supplies the viewer-supplied connection

**Given** a Live Report
**When** it is opened without a running quick-studio to authorize it
**Then** it cannot reach any database on its own

## Epic 7: UI Redesign — Neutral (ChatGPT look)

> **Pivot.** The whole UI moves from the coral/monospace "TablePlus" spine to a neutral, ChatGPT-style language: near-black surfaces, an **ink** (white/black) accent, **no coral**. Color is kept ONLY where it is functional — data-type column colors, ok/warn/err state semantics, a blue chart data-series, and red on destructive actions. The prototypes in `design-artifacts/*.html` are the **visual source of truth** for every story here and **supersede** any coral rule still described in DESIGN.md/EXPERIENCE.md (being rewritten separately). `src/ui/styles/globals.css` already carries the neutral tokens (`--coral` is now ink `#ececec`). Each story **ports the prototype's look** onto the existing React components while preserving all logic, RPC contracts, and passing tests — presentation only.

### Story 7.1: Redesign the workspace shell to neutral — rail, tabs, schema tree, status

As a user,
I want the app shell to match the neutral prototype,
So that the rail, tabs, tree and status read like a finished tool, not a skeleton.

**Acceptance Criteria:**

**Given** the app is open
**When** I look at the launcher rail
**Then** it shows a compact vertical icon rail (brand mark + Tables/Query/ERD/Chat/Report and a pinned Settings) with no clipped or wrapped text, matching `design-artifacts/workspace.html` and `ai-chat-chatgpt.html`

**Given** open tabs
**When** I view the tab strip and left region
**Then** tabs use the neutral Chrome-tab look (active tab fused into the content panel, close ×, new-tab +), and the schema tree + status bar match the prototype (mono, ink accent, connection dot, no coral)

### Story 7.2: Redesign the Tables data grid to neutral

As a developer,
I want the Tables grid to match the neutral prototype,
So that browsing data feels polished, not raw.

**Acceptance Criteria:**

**Given** a table open in a data tab
**When** I view its rows
**Then** the grid matches `design-artifacts/workspace.html`: mono type-colored headers with a PK key-icon, tabular-nums numeric cells right-aligned, status/bool rendered as pills, money/amount columns formatted for humans, NULL faint-italic, zebra rows, hover/selection in ink — no coral

**Given** the result area
**When** I use it
**Then** a live client-side row filter, a row-count·latency readout, Export/Add-Row ghost buttons, and Prev/Next pagination are present and styled per the prototype, without changing the existing `table.rows`/mutation RPC behavior

### Story 7.3: Redesign the Query editor + destructive confirm to neutral

As a developer,
I want the Query editor and destructive-confirm dialog to match the neutral prototypes,
So that writing SQL and confirming dangerous actions feel consistent and calm.

**Acceptance Criteria:**

**Given** the Query tab
**When** I edit SQL
**Then** it shows neutral type-colored syntax highlighting and a Run control in the ink style per `design-artifacts/workspace.html` — the run (⌘↵) and guarded-execute RPC behavior unchanged

**Given** a destructive statement
**When** the confirmation appears
**Then** it matches `design-artifacts/confirm-destructive.html`: no top color line, red only on functional bits (icon, affected-rows badge, statement border, confirm button), a neutral modal frame, a concise one-line description, the dependent-FK line, and type-to-confirm — the Core executor remaining the real gate

### Story 7.4: Redesign the ERD to neutral

As a developer,
I want the ERD to match the neutral prototype,
So that the diagram reads clearly with type-coded columns and clean relations.

**Acceptance Criteria:**

**Given** the ERD tab on a connected schema
**When** it renders
**Then** table nodes match `design-artifacts/erd.html`: card header with table name (mono) + row count, columns with PK (ink key) and FK (blue link) markers and type-colored type labels, FK relations drawn as edges, on a neutral canvas — no coral

**Given** the ERD
**When** I interact
**Then** pan, zoom-to-cursor, drag-a-table (edges follow), and hover-to-highlight-relations are styled per the prototype, preserving the existing layout-persistence behavior

### Story 7.5: Redesign the AI Chat to neutral

As a user,
I want the AI Chat to match the neutral prototype,
So that the conversation reads like the ChatGPT-style mold we chose.

**Acceptance Criteria:**

**Given** the Chat tab
**When** I view a turn
**Then** it matches `design-artifacts/ai-chat-chatgpt.html`: right-aligned grey user bubble, a collapsible reasoning channel, a generated-SQL block, inline KPIs + mini result table, an action row, and the ink composer pill with the "schema only — no rows leave the Core" note — no coral

**Given** streaming
**When** the assistant responds
**Then** the streaming caret + reasoning treatment match the prototype without changing the schema-only Provider/sandbox RPC behavior

### Story 7.6: Redesign the Report to neutral

As a developer,
I want the Report to match the neutral prototype,
So that reports look like clean, exportable dashboards.

**Acceptance Criteria:**

**Given** a built report
**When** I view it
**Then** it matches `design-artifacts/report.html`: KPI cards with ok/err deltas, charts drawn with a blue data-series (not coral), a results table with type-colored headers and status pills, and Export snapshot / Export live in the ink style — no coral

**Given** charts
**When** they render
**Then** they use the neutral chart accent and preserve the existing report-state / export-snapshot / export-live behavior

### Story 7.7: Redesign Settings/Connections to neutral

As a user,
I want Settings/Connections to match the neutral prototype,
So that connecting and managing credentials feels consistent.

**Acceptance Criteria:**

**Given** the Connections settings
**When** I add or edit a connection
**Then** it matches `design-artifacts/connect.html`: engine picker with an ink selected-state, form fields, Test-connection with ok/err result, and the encrypted credential-store panel — the primary/Connect button in ink with legible text, no coral and no white-on-white

**Given** the Providers settings
**When** I view them
**Then** they follow the same neutral language, preserving the existing connection/provider RPC + credential-store behavior

## Epic 8: UI Refinements — Artifact Fidelity & Interaction Polish

> **Refinement pass.** Epic 7 moved the whole UI to the neutral / ChatGPT-style language, but several surfaces DRIFTED from the `design-artifacts/*.html` prototypes — most visibly the Chrome-style tabs, whose concave "feet" a review pass removed to dodge an `overflow-y` clipping bug, and which shipped without a live visual render. This epic RESTORES that fidelity and adds the interaction polish the prototypes imply. The prototypes remain the **visual source of truth**. Two build decisions were made up front: dropdowns use **shadcn/ui + Radix** (introduced in 8.1 — the project previously carried only the shadcn token layer, no components), and the SQL editor uses **CodeMirror 6**. Every story preserves logic, RPC contracts, a11y roles, and passing tests unless it explicitly changes behavior, and each REQUIRES a live visual check against its prototype at `http://127.0.0.1:6061` (the gap that let Epic 7 drift).

### Story 8.1: shadcn/ui + Radix foundation

As a developer,
I want a shadcn/ui + Radix foundation styled with the existing neutral tokens,
So that later stories replace native selects with consistent custom dropdowns.

**Acceptance Criteria:**

**Given** the app (Bun + Tailwind v4 + custom `scripts/build-ui.ts`, not Next.js)
**When** shadcn/ui + Radix are added — the `cn()` util plus `src/ui/components/ui/*` base primitives (button, select, popover, command, dialog) authored against the EXISTING tokens
**Then** `bunx tsc --noEmit`, `bun test`, and `bun run build` all stay green and NO existing surface changes look or behavior — foundation only

**Given** the custom bundler
**When** the new components are built
**Then** they render with the neutral tokens and are ready to consume in 8.5 and 8.6

### Story 8.2: Chrome-tab fidelity + content-panel fusion

As a user,
I want the top tabs to match the Chrome-style prototype,
So that the workspace reads like a finished tool, not a skeleton.

**Acceptance Criteria:**

**Given** open tabs
**When** I view the tab strip
**Then** tabs match `design-artifacts/ai-chat-chatgpt.html`: Chrome-style concave feet, the active tab fused seamlessly into the content panel (no dividing line), a reduced tab height with no spurious vertical scroll, and a centered close ×; inactive-tab hover renders as a chip/pill, not a tab shape

**Given** the active tab's content panel
**When** it renders
**Then** it has rounded TOP corners only and a square bottom flush to the window (no gap, no rounded bottom), with `role`/`aria-selected`/keyboard operability preserved

### Story 8.3: Custom scrollbars + remove left-panel divider

As a user,
I want custom scrollbars and no stray panel divider,
So that the chrome reads clean like the prototype.

**Acceptance Criteria:**

**Given** any scroll container
**When** it overflows
**Then** it shows a custom neutral scrollbar (not the browser default) in both Chromium and Firefox

**Given** the left schema panel
**When** I view its edge
**Then** there is NO divider line — the boundary comes from surface contrast alone — while the resizable-panel drag behavior stays intact

### Story 8.4: Render Markdown/MDX in chat message bubbles

As a user,
I want assistant messages rendered as markdown,
So that code and formatting read properly instead of raw syntax.

**Acceptance Criteria:**

**Given** an assistant message containing a ```sql fenced block
**When** it renders
**Then** the fence markers are not visible and the code shows as a styled neutral code block — markdown rendered safely via micromark (no raw-HTML/XSS), matching `design-artifacts/ai-chat-chatgpt.html`

**Given** the schema-only chat
**When** messages render as markdown
**Then** the Provider/sandbox RPC, streaming, and chat-model behavior are unchanged

### Story 8.5: Chat provider auto-select + shadcn dropdown

As a user,
I want the chat provider selected for me,
So that I don't have to re-pick it every time I open a chat.

**Acceptance Criteria:**

**Given** a chat opens
**When** there is a last-used provider or a single connected provider
**Then** it is auto-selected (last-used preferred; the sole connected provider otherwise) and the selection persists across reopen

**Given** the provider picker
**When** I open it
**Then** it is a custom shadcn dropdown (from 8.1), not a native `<select>`, styled per the prototype with the schema-only exposure note preserved

### Story 8.6: Settings as a singleton tab

As a user,
I want Settings to be a normal singleton tab,
So that I can move between it and my work without an overlay.

**Acceptance Criteria:**

**Given** I open Settings
**When** it appears
**Then** it is a normal tab in the strip (not an overlay), routed through the tab model like any other tab

**Given** a Settings tab is already open
**When** I click Settings again
**Then** the existing tab is focused (no duplicate, no parallel settings), with the credential/provider behavior inside preserved

### Story 8.7: Surface the active connection in Settings/Connections

As a user,
I want to see the connection I'm actually using in Settings,
So that Connections reflects reality, not just the persisted store.

**Acceptance Criteria:**

**Given** the app running with an active (ephemeral) connection
**When** I open Settings → Connections
**Then** the active connection appears as a read-only "current connection" entry (engine/host/db/mode), distinct from saved connections, with NO secret shown, styled per `design-artifacts/connect.html`

**Given** the ephemeral-vs-persisted root cause
**When** surfacing the active connection needs a Core signal
**Then** it is exposed without leaking credentials and preserves the schema-only / security guarantees

### Story 8.8: SQL editor — CodeMirror 6 syntax highlighting + autocomplete

As a developer,
I want a real SQL editor with highlighting and schema autocomplete,
So that writing queries feels like a proper SQL editor.

**Acceptance Criteria:**

**Given** the Query tab
**When** I type SQL
**Then** keywords are syntax-highlighted via CodeMirror 6, themed to the neutral tokens per `design-artifacts/workspace.html`

**Given** a schema/table/column prefix
**When** I press Ctrl+Space (or continue typing)
**Then** matching schemas/tables/columns from the loaded schema are suggested and insert on select; ⌘↵ still runs and the guarded-execute RPC behavior is unchanged

## Epic 9: Polish, Chat-Driven Reports & Workspace Ergonomics

> **Post-redesign iteration.** Epics 7–8 brought the UI to the neutral language and restored artifact fidelity; this epic acts on a fresh round of hands-on feedback from running the app. Three visual-polish items (9.1–9.3) were hand-tuned live and committed as the fixed visual direction — the loop implements the remaining feature and structural work (9.4–9.7) against that look rather than guessing it. The neutral prototypes remain the visual source of truth. shadcn/ui + Radix (from 8.1) and the existing neutral tokens are the component baseline; no coral, no new palette.

### Story 9.1: Shell control icons — centered glyphs + a real Settings gear

As a user,
I want the tab close, new-tab, and Settings controls to look correct,
So that the chrome reads as finished rather than slightly off.

**Acceptance Criteria:**

**Given** the tab strip and the rail
**When** I view the close (`×`), new-tab (`+`), and Settings controls
**Then** the close and new-tab glyphs are centered SVGs (not off-center text characters) and the Settings control shows a real lucide cog — NOT the previous circle-plus-rays mark that read as a sun — on both the rail toggle and the Settings tab's leading icon

> Status: DONE (hand-tuned visual pass, committed). The loop only verifies/regression-tests this; no re-implementation.

### Story 9.2: Report view — shadcn controls across the toolbar and blocks

As a user,
I want the Report view's controls to match the rest of the app,
So that it doesn't look like a different, rougher screen.

**Acceptance Criteria:**

**Given** a Report tab
**When** I view the toolbar (target picker + export/add buttons) and each block's controls (run, table/chart toggle, chart mark/x/y/series pickers, reorder/remove)
**Then** every native `<select>` is a shadcn `Select` and every button is a shadcn `Button`, consistent in height, spacing, and treatment with the rest of the app — no bespoke mono/ink classes, no browser-default select chrome

> Status: DONE (hand-tuned visual pass, committed). Radix Select forbids empty item values, so `__default__`/`__none__` sentinels map to null/"". The loop only verifies/regression-tests this.

### Story 9.3: Borderless SQL console

As a user,
I want the query editor to blend into its panel,
So that the console feels integrated, not boxed-in.

**Acceptance Criteria:**

**Given** the Query tab's SQL editor
**When** I view it
**Then** the editor has no border/rounded/background box (`recuadro`) — it sits directly on the card surface and reads as part of the panel — while CodeMirror highlighting, autocomplete, ⌘↵ run, and the guarded-execute RPC are unchanged

> Status: DONE (hand-tuned visual pass, committed). The loop only verifies/regression-tests this.

### Story 9.4: Create Table as a tab

As a user,
I want New Table to open as a normal tab,
So that I can move between it and my work without an overlay hiding the tab strip.

**Acceptance Criteria:**

**Given** the rail's Create-table control
**When** I click it
**Then** a Create-table surface opens as a normal tab in the strip (routed through the same tab model as every other tab — open/activate/close/persist), NOT as an overlay that hides the tab strip and the new-tab `+`

**Given** the CreateTablePanel's behavior (schema pickers, DDL compose, the create RPC, its confirm/guard flow, testids, and `role="alert"` lines)
**When** it is relocated into a tab body
**Then** all of it is preserved verbatim — this is a relocation (overlay → tab), mirroring how Settings moved in Story 8.6, not a rewrite

**Given** the create flow completes (a table is created) or is closed
**When** it resolves
**Then** the tab closes (or stays, per the least-surprising choice) through the normal `closeTab` path and the created table is reflected in the schema tree

### Story 9.5: ERD hover — column detail, PK/FK, and relationship highlight

As a user,
I want hovering a table in the ERD to show something useful,
So that the diagram is explorable, not just a static picture.

**Acceptance Criteria:**

**Given** the ERD
**When** I hover a table node
**Then** its connected relationships/edges are visually highlighted (the related tables stand out from the rest) AND a tooltip/panel shows the table's columns with their types and PK/FK badges — resolving the current "empty" hover feel

**Given** the hover ends
**When** the pointer leaves the node
**Then** the highlight and tooltip clear cleanly (no stale highlight if the node set changes mid-hover), and existing ERD pan/zoom/layout-persist behavior is unchanged

### Story 9.6: Persist AI provider API keys across sessions

As a user,
I want my AI provider API key to be remembered,
So that I don't have to re-enter it every time.

**Acceptance Criteria:**

**Given** I have entered and saved an AI provider API key in persistent mode
**When** I close and reopen the app (persistent mode)
**Then** the provider key is restored from the encrypted provider-key store (never plaintext, never logged) and the provider shows as configured without re-entry — the credential trust boundary (Ring 1, keychain/passphrase-derived key) is preserved

**Given** the Settings AI-providers surface
**When** a key is already persisted
**Then** it clearly indicates the provider is configured (masked, never revealing the key) with an explicit remove/replace affordance, and the schema-only exposure note is preserved

### Story 9.7: Generate reports from the chat (open, view, and edit)

As a user,
I want to ask the chat to build a report and then open, view, and edit it,
So that I can go from a question to an editable report without hand-assembling blocks.

**Acceptance Criteria:**

**Given** the AI chat with a connected provider
**When** I ask it to build a report (e.g. "make a report of revenue by country")
**Then** the chat produces a report the Core assembles into a Report tab (prose + query blocks) that opens for viewing — the Core stays the sole Provider caller and sole risk gate (schema-only context by default; SQL runs through the guarded executor), and no data leaves the machine

**Given** a chat-generated report is open in a Report tab
**When** I edit it
**Then** I can re-run its queries and edit its prose/charts with the SAME full editing affordances as a hand-built report (Story 9.2's shadcn controls), and the result exports via the existing snapshot/live-report paths

**Given** the chat cannot produce a valid report (provider error, empty result, malformed spec)
**When** it fails
**Then** it degrades with a clear message and opens nothing half-built — never a partial or broken Report tab
