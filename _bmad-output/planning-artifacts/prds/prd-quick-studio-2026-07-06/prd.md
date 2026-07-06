---
title: quick-studio
status: final
created: 2026-07-06
updated: 2026-07-06
---

# PRD: quick-studio
*Working title — confirm.*

## 0. Document Purpose

This PRD is for the builder (Juanelo) and any future contributor or downstream workflow (architecture, UX, epics). It builds directly on the Product Brief at `_bmad-output/planning-artifacts/briefs/brief-quick-studio-2026-07-06/brief.md` (status: ready) and its `addendum.md` (competitive landscape + technical prior art) — it does not duplicate them. Vocabulary is anchored in §3 Glossary; features are grouped in §4 with globally numbered FRs nested under them; inferred decisions are tagged inline `[ASSUMPTION]` and collected in §9. Implementation-level "how" (frameworks, sandboxing mechanism, packaging) is deliberately kept out and belongs in the architecture doc — three high-risk items are flagged in §8 and §11 for architecture to resolve first.

## 1. Vision

quick-studio is a lightweight, local-first database manager that installs and runs with a single command and presents itself as a fast web UI on `127.0.0.1`. It exists because the incumbent tools are too heavy: they fight the developer's real work for RAM and CPU, bury the five things you use daily under features you don't, and are slow to open and painful to close. quick-studio's identity is **lightweight**; its felt promise is **fast**.

On top of the daily database work — connect, browse, edit, create tables, inspect indexes, read the schema through a relational ERD — quick-studio folds in an AI chat that turns natural-language questions into queries, explains what's in a database, and generates rich, exportable reports directly from query results. That reporting layer, done locally without shipping data to a third party, is the marquee differentiator: it turns the recurring, dreaded "can you send me a report on the database?" request into a quick local job.

This is a personal-use-first, portfolio-grade product that the builder also wants to share with colleagues (some on Linux), with the door open to open source if it proves itself. Sharing means distributing the tool, not hosting it — every install stays a local, single-operator Workspace. Success is measured by one honest test: the builder stops using DBeaver.

*Honest caveat (carried from the brief):* the moat here is execution and taste, not a defensible technical secret — stated plainly so downstream phases build the product, not an over-claimed market position.

## 2. Target User

### 2.1 Jobs To Be Done

- **Daily driver, out of the way.** When developing across several projects at once, I want a database tool I can leave open all day without it taxing my machine, so I can check and edit data without friction or a heavyweight process I can't kill.
- **Query without context-switching.** When I need a query, I want to ask in plain language and get (and run) it inside the same tool, so I don't juggle a separate AI tab and a separate client.
- **Answer report requests locally.** When someone asks me for a report on a database — usually with no warning — I want to build and export it locally, so I never paste sensitive data into an external AI.
- **Builder's framing.** This is for me first: I want to replace DBeaver with something that respects my machine and my taste.

**Secondary user:** developers on small teams (the builder's colleagues, some on Linux) who get ad-hoc "send me a report on the database" requests and want a fast, private, local way to produce something sharp — without a heavyweight BI stack.

### 2.2 Non-Users (v1)

- Teams needing real-time collaboration, shared cloud workspaces, or multi-user access control. (Sharing the *tool* with colleagues is supported; sharing a *live workspace/session* is not.)
- NoSQL-primary users (MongoDB/DynamoDB) — deferred to v2.
- DBAs doing deep production tuning (query planners, replication, deep index diagnostics) — the intentional bloat quick-studio refuses.
- Users wanting a full BI/analytics platform (scheduled dashboards, org-wide report distribution).

### 2.3 Key User Journeys

Single-operator tool, so journeys are lightweight but concrete — they carry the persona context that downstream UX and architecture need.

- **UJ-1. Juanelo spins up on a new project in one command.** Working on a fresh service, he runs `quick-studio` with a database URL (Ephemeral mode). The web UI opens on localhost in a browser tab; he's browsing the schema seconds later; nothing is written to disk. **Climax:** first query result on screen without any setup ceremony. **Resolution:** closes the tab and the process is gone — no lingering daemon.

- **UJ-2. Juanelo saves his connections once.** In Persistent mode he adds his everyday Postgres and MySQL connections; credentials land in an encrypted local Credential Store keyed to the OS keychain. Next launch, they're just there. **Edge case:** on a machine without an available keychain, the app tells him and offers a passphrase-based fallback rather than storing anything in plaintext.

- **UJ-3. Juanelo asks a question instead of writing SQL.** In the AI Chat he types "which users signed up last week but never placed an order?". The model streams its reasoning, produces a query, and he runs it from the chat; results render inline, with an optional chart. **Climax:** the right rows appear without him hand-writing the JOIN. **Edge case:** a destructive statement (DELETE/DROP) is never auto-run — it requires explicit confirmation.

- **UJ-4. Juanelo gets ambushed for a report.** Someone asks for "a report on the database" by end of day. He builds it in quick-studio against a test database, arranges the query results into an HTML Report, and exports it. He can hand over a static Snapshot (frozen data) or point the same report at production as a Live Report. **Climax:** a sharp report delivered in minutes, with no data sent to any external service.

- **UJ-5. Juanelo exposes the port by accident.** He binds the server beyond localhost while fiddling with a config. quick-studio detects it and shows a clear, prominent Port-Exposure Warning explaining the risk and how to revert. **Resolution:** he's warned before anything sensitive is reachable off-machine.

## 3. Glossary

- **Connection** — a configured link to one database (engine, host, credentials, database name). Belongs to at most one Credential Store; used by Tabs and the AI Chat.
- **Run Mode** — how a session launches. One of **Ephemeral** or **Persistent**.
- **Ephemeral (Run Mode)** — launched with a database URL; nothing is persisted to disk; no Credential Store is created or read.
- **Persistent (Run Mode)** — launched against a local Credential Store; Connections, ERDs, and Reports are saved.
- **Credential Store** — an encrypted local file holding Connections and saved artifacts. Encryption key is held by the OS keychain (see §11).
- **Workspace** — the running UI: the set of open Tabs and Panels for the current session.
- **Tab** — an openable/closable unit of work in the Workspace (a table view, a query editor, an ERD, a chat, a report).
- **Panel** — a resizable region of the Workspace layout.
- **ERD** — the interactive relational entity-relationship diagram of a connected database's schema.
- **AI Chat** — the assistant surface; connects to a Provider via a user-supplied API key.
- **Provider** — an AI vendor: Anthropic, OpenAI, or Google (Gemini).
- **MDX Block** — rich chat/report content combining Markdown, embedded executable JS, and charts.
- **Report** — an exportable HTML document built from query results.
- **Snapshot (static Report)** — a Report frozen with the data captured at build time.
- **Live Report (dynamic Report)** — a Report that re-queries a target database when viewed.
- **Port-Exposure Warning** — the alert raised when the server is reachable beyond `127.0.0.1`.

## 4. Features

### 4.1 Install & Launch

**Description:** quick-studio is installed with a single command and run with a single command. Running it starts a local HTTP server bound to `127.0.0.1` and opens the Workspace in the default browser. There is no background daemon that outlives the session and no multi-step installer. Realizes UJ-1.

**Functional Requirements:**

#### FR-1: One-command install
A developer can install quick-studio with a single command on their platform. Realizes UJ-1.
**Consequences (testable):**
- A single documented command results in an available `quick-studio` executable/entry point.
- No interactive multi-step wizard is required to complete installation.

#### FR-2: One-command run with mode selection
A developer can start quick-studio with a single command and select Ephemeral or Persistent Run Mode. Realizes UJ-1, UJ-2.
**Consequences (testable):**
- Passing a database URL starts an Ephemeral session; no files are written to disk during or after it.
- Starting without a URL (or with an explicit persistent flag) starts a Persistent session backed by a Credential Store.
- The server binds to `127.0.0.1` by default.

#### FR-3: Clean shutdown
A developer can stop quick-studio instantly, and closing it never blocks the OS. Realizes UJ-1.
**Consequences (testable):**
- Stopping the process (Ctrl-C or closing the UI's stop control) terminates the server within a small bounded time [ASSUMPTION: ≤2s].
- No orphaned process remains after shutdown; system shutdown is never stalled by quick-studio.

### 4.2 Run Modes & Credential Store

**Description:** Ephemeral mode is a zero-footprint session from a URL. Persistent mode manages an encrypted Credential Store so Connections and saved artifacts survive across launches. The store is encrypted at rest, with the key held by the OS keychain and a passphrase fallback when no keychain is available. Realizes UJ-2.

**Functional Requirements:**

#### FR-4: Encrypted Credential Store
In Persistent mode, a developer's Connections and credentials are stored encrypted at rest. Realizes UJ-2.
**Consequences (testable):**
- Credentials are never written to disk in plaintext.
- The store file, if opened directly, reveals no readable credential material.
- The encryption key is stored in the OS keychain; the store file does not contain the key.

#### FR-5: Keychain-unavailable fallback
When no OS keychain is available, a developer is offered a passphrase-based unlock instead of plaintext storage. Realizes UJ-2 (edge case).
**Consequences (testable):**
- On a machine with no usable keychain, the app surfaces the condition and offers a passphrase fallback.
- Declining the fallback does not result in any credential being written in plaintext.

#### FR-6: Manage Connections
In Persistent mode, a developer can add, edit, and remove Connections. Realizes UJ-2.
**Consequences (testable):**
- A saved Connection is available on the next launch without re-entry.
- Removing a Connection deletes its credentials from the store.

### 4.3 Connections (Relational)

**Description:** quick-studio connects directly to PostgreSQL and MySQL without any ORM dependency (no Prisma required). It reads live schema and data. Realizes UJ-1, UJ-3.

**Functional Requirements:**

#### FR-7: Connect to PostgreSQL and MySQL
A developer can open a working Connection to a PostgreSQL or MySQL database via URL or stored Connection.
**Consequences (testable):**
- A valid PostgreSQL target connects and lists its schema.
- A valid MySQL target connects and lists its schema.
- A failed connection returns a clear, actionable error (host/auth/network distinguished).
**Out of Scope:** NoSQL engines (see §5, §6.2).

### 4.4 Data & Schema Workspace

**Description:** The core daily-driver surface: browse and edit rows, create tables, inspect indexes, and read the schema. Kept intentionally lean — the essentials, not deep DBA tooling. Realizes UJ-1.

**Functional Requirements:**

#### FR-8: Browse and edit data (view, edit, insert, delete rows)
A developer can view table rows, edit cell values, and insert and delete rows, with changes committed to the database.
**Consequences (testable):**
- A table opens in a Tab showing its rows with pagination for large tables.
- An edited cell is persisted to the database and reflected on reload.
- A new row can be inserted and appears on reload.
- A selected row can be deleted; deletion requires confirmation (shared guardrail with FR-11/FR-15).

#### FR-9: Create tables
A developer can create a table (columns, types, primary key, basic constraints).
**Consequences (testable):**
- A created table appears in the schema and the ERD without a manual refresh.

#### FR-10: Inspect indexes
A developer can view the indexes on a table.
**Consequences (testable):**
- Each index lists its columns and uniqueness.

#### FR-11: Run ad-hoc SQL
A developer can write and run arbitrary SQL in a query Tab and see results.
**Consequences (testable):**
- A SELECT returns a paginated result grid.
- A destructive statement requires explicit confirmation before executing (shared guardrail with FR-15).

### 4.5 Interactive ERD

**Description:** A relational ERD renders the connected schema, highlighting the most important structural aspects (tables, keys, relationships) visually. In v1 the ERD is viewable and navigable and saved when persistence is on; deep visual editing is deferred. Realizes UJ-1.

**Functional Requirements:**

#### FR-12: Render relational ERD
A developer can view an interactive ERD of the connected database.
**Consequences (testable):**
- Tables render as nodes with their columns; foreign-key relationships render as edges.
- The diagram is navigable (pan/zoom) and stays responsive on a schema of at least 60–70 tables (schemas rarely exceed this).

#### FR-13: Persist ERD layout
In Persistent mode, a developer's ERD layout is saved and restored.
**Consequences (testable):**
- A rearranged ERD layout is restored on the next launch.
**Out of Scope:** creating/altering schema *through* the ERD (deferred to v2 — see §6.2).

### 4.6 AI Chat

**Description:** A multi-provider assistant that turns natural language into queries, answers questions about a database, runs queries on request, and renders rich MDX Blocks (Markdown + embedded executable JS + charts). Responses stream, and the model's reasoning is shown as it works. Providers are configured with the user's own API keys. Realizes UJ-3. **This feature contains the single highest-risk capability in v1 (executable embedded JS) — see §8/§11.**

**Functional Requirements:**

#### FR-14: Configure Providers
A developer can configure Anthropic, OpenAI, and/or Google (Gemini) by supplying their own API key.
**Consequences (testable):**
- A configured Provider can be selected for a chat.
- API keys are stored under the same protection as Credentials (FR-4) in Persistent mode; in Ephemeral mode they are session-only and never written to disk.

#### FR-15: Natural-language to query + execution
A developer can ask a question in natural language, receive a query, and run it from the chat. Realizes UJ-3.
**Consequences (testable):**
- The generated query targets the schema of the AI Chat's active Connection; when multiple Connections are open, the chat is bound to one explicitly selected Connection.
- Running the query from chat produces the same result as running it in a query Tab.
- Destructive statements are never auto-executed; they require explicit confirmation.

#### FR-16: Streaming responses with visible reasoning
A developer sees responses stream token-by-token, including the model's reasoning. Realizes UJ-3.
**Consequences (testable):**
- Output appears incrementally, not only on completion.
- Reasoning is visually distinguished from the final answer.

#### FR-17: Rich MDX rendering
The AI Chat renders MDX Blocks combining Markdown, embedded executable JS, and charts.
**Consequences (testable):**
- A response containing a chart spec renders an interactive chart.
- Embedded JS executes within a security boundary (see §11) — never with unrestricted access to the host, filesystem, or credentials.
**Notes:** `[NOTE FOR PM]` The execution-sandbox mechanism is a hard architecture prerequisite; FR-17 is not shippable until §11-R1 is resolved.

### 4.7 Report Generation

**Description:** The marquee differentiator. A developer turns query results into an exportable HTML Report — building against a test database, then optionally pointing the same report at production. Reports export as a static Snapshot (data frozen at build time) or a Live Report (re-queries on view). All local; data never leaves for a third party. Realizes UJ-4.

**Functional Requirements:**

#### FR-18: Build a Report from query results
A developer can assemble a Report from one or more query results, including narrative and charts (MDX Blocks). Realizes UJ-4.
**Consequences (testable):**
- A Report can contain results from more than one query.
- A Report can include charts and prose alongside tabular data.

#### FR-19: Test-to-production targeting
A developer can build a Report against one database (e.g. test) and re-target it at another (e.g. production). Realizes UJ-4.
**Consequences (testable):**
- Re-targeting re-runs the Report's queries against the new target.
- Re-targeting does not require rebuilding the Report's layout.

#### FR-20: Export as static Snapshot or Live Report
A developer can export a Report as HTML, choosing a static Snapshot or a Live Report. Realizes UJ-4.
**Consequences (testable):**
- A Snapshot renders identical data when opened later, disconnected from any database.
- A Live Report re-queries its target when viewed, via a connection the viewer supplies.
- Report generation and export send no data to any external service.

### 4.8 Local Security & Port-Exposure Warning

**Description:** quick-studio binds to localhost by design and actively watches for exposure beyond the local machine, warning the user prominently if the port becomes externally reachable. Realizes UJ-5.

**Functional Requirements:**

#### FR-21: Localhost-by-default binding
The server binds to `127.0.0.1` unless the developer explicitly overrides it.
**Consequences (testable):**
- With default settings, the server is not reachable from another host on the network.

#### FR-22: Port-exposure detection and warning
If the server is bound or exposed beyond localhost, a developer sees a prominent Port-Exposure Warning. Realizes UJ-5.
**Consequences (testable):**
- Binding to a non-loopback address raises the warning in the UI.
- The warning explains the risk and how to revert to localhost-only.

### 4.9 UI Shell

**Description:** A shadcn-style Workspace: openable/closable Tabs and resizable Panels, tuned to feel fast and fluid. The UX quality is part of the product's identity, not decoration.

**Functional Requirements:**

#### FR-23: Tabs
A developer can open and close Tabs for tables, queries, ERDs, chats, and reports.
**Consequences (testable):**
- Multiple Tabs can be open at once; closing one leaves the others intact.

#### FR-24: Resizable Panels
A developer can resize the Workspace's Panels.
**Consequences (testable):**
- Panel sizes can be adjusted; in Persistent mode they are restored on next launch [ASSUMPTION].

## 5. Non-Goals (Explicit)

- **Not a heavyweight, do-everything DBA suite.** Deep tuning, query-plan analysis, and rarely-used administrative tooling are deliberately excluded — that breadth is exactly what makes the incumbents heavy.
- **Not "connect to absolutely anything" in v1.** Relational only (Postgres, MySQL). Chasing every engine is the bloat trap.
- **Not a multi-user or cloud product.** No shared workspaces, no accounts, no collaboration, no hosted service. Local-first, single operator.
- **Not a data pipeline / BI platform.** No scheduled jobs, no ETL, no org-wide dashboard distribution.
- **Not an ORM.** quick-studio connects directly; it does not require or manage Prisma or any ORM.

## 6. MVP Scope

### 6.1 In Scope (v1 — deliberately broad, builder's eyes-open choice)

- **Platforms: Windows and Linux** (builder on Windows; colleagues on Linux). macOS not required for v1.
- One-command install; one-command run with Ephemeral and Persistent Run Modes.
- Encrypted Credential Store (OS-keychain key + passphrase fallback).
- Direct Connections to PostgreSQL and MySQL.
- Data & schema workspace: browse/edit rows, create tables, inspect indexes, run ad-hoc SQL.
- Interactive relational ERD (view + navigate; persisted layout).
- Full AI Chat: multi-provider (Anthropic/OpenAI/Gemini via user keys), NL→query, query execution, streaming with visible reasoning, MDX Blocks (Markdown + embedded executable JS + charts).
- Report generation: build from query results, test→production targeting, static Snapshot or Live Report, HTML export, fully local.
- Localhost binding + Port-Exposure Warning.
- shadcn-style UI: Tabs, resizable Panels, fast/fluid feel.

### 6.2 Out of Scope for MVP

- **NoSQL engines (MongoDB, DynamoDB)** — different paradigm (no fixed schema, no classic ERD, different query model) deserving a dedicated UX pass. Deferred to v2. `[NOTE FOR PM]` emotionally load-bearing — the original vision was multi-paradigm; revisit right after v1 lands.
- **Deep visual ERD editing** (creating/altering schema through the diagram) — v1 views and highlights only. Deferred to v2.
- **Fine-grained animation polish and extreme fluidity tuning** — v1 aims for fast/fluid; the last-mile polish is a later pass.

### 6.3 Scope Note (carried from the brief)

Folding the *full* AI Chat and Report generation into v1 — rather than shipping a smaller query-helper first — was a deliberate, eyes-open choice by the builder. It makes v1 substantially larger and pulls the costliest, riskiest component (MDX with executable embedded JS, §11-R1) into the first release. Recorded so the tradeoff stays visible through downstream phases.

## 7. Success Metrics

Qualitative and personal by design — this is a tool built to be used.

**Primary**
- **SM-1: The switch test.** The builder stops using DBeaver entirely for daily work. Validates the product as a whole (FR-1–FR-13, FR-23–FR-24). *Target: DBeaver not opened for daily tasks over a sustained stretch [ASSUMPTION: 4 consecutive weeks].*
- **SM-2: Reports that land.** Real reports get generated and produce useful conclusions, with no data pasted into an external AI. Validates FR-18–FR-20.

**Secondary**
- **SM-3: Conversational database work.** Asking about a database in natural language reliably yields the right query or the needed information. Validates FR-15, FR-16.
- **SM-4: Invisible footprint.** quick-studio stays open all day across multiple projects without being felt, and closes instantly. Validates FR-3 and §10 performance budgets.
- **SM-5: Rich output earns its risk.** In-chat charts and MDX Blocks actually get used in real sessions — justifying the sandbox cost of §11-R1. Validates FR-17. If they go unused, the executable-JS risk was not worth it.

**Counter-metrics (do not optimize)**
- **SM-C1: Feature count.** More features is *not* the goal — every added surface is measured against the "lightweight" identity. Counterbalances the temptation to answer SM-1 by matching DBeaver feature-for-feature.
- **SM-C2: AI reach.** Do not expand what embedded JS / the AI can touch to make demos flashier; the security boundary (§11-R1) outranks capability. Counterbalances SM-2/SM-3.

## 8. Open Questions

1. **TradingView charting fit.** Chosen for aesthetics, but its library targets financial time-series (OHLC) and may be a poor fit for generic database data (counts, distributions, categorical). Validate at architecture; a general charting approach may be needed instead. (From brief open questions.)
2. **Executable-JS sandbox mechanism.** How exactly embedded JS in MDX Blocks executes safely is unresolved and gates FR-17 — see §11-R1.
3. **Live Report data path.** The viewer supplies the connection (confirmed, §9); the open question is how a Live Report authenticates and reaches that target when viewed outside quick-studio (FR-20). Architecture decision.
4. **Per-platform install delivery.** v1 targets are decided (Windows + Linux; macOS out). Remaining architecture question: how the one-command install is delivered on each (packaging, distribution to colleagues).
5. **Data-volume ceilings.** Practical limits for result-grid size, ERD table count, and report data size before performance degrades (ties to §10 budgets).
6. **Positioning freshness.** Competitive claims informing the differentiator (who already ships AI chat, who does report-generation) rest on research that may age; re-verify before making public positioning claims. (From brief addendum staleness flags.)

## 9. Assumptions Index

- §4.1 FR-3 — clean shutdown within ≤2s.
- §4.6 FR-14 — Ephemeral-mode API keys are session-only.
- §4.9 FR-24 — Panel sizes restored in Persistent mode.
- §7 SM-1 — "switch test" measured over ~4 weeks.
- §10 NFR-1 — idle RAM/CPU budgets (to set at architecture).
- §10 NFR-2 — startup ≤2s cold.
- §10 NFR-4 — UI response <100ms; first result paint bounded by DB.
- §12 — dark-first UI theme.

*Confirmed by builder (no longer assumptions): platforms Windows + Linux; ERD fluid to 60–70 tables; Live Reports use a viewer-supplied connection. Perf budgets are accepted as starting points but remain `[ASSUMPTION]` pending architecture (§10).*

## 10. Cross-Cutting NFRs & Performance Budgets

Performance is not a feature here — it is the identity. These budgets are load-bearing and should be treated as acceptance criteria, not aspirations. Concrete numbers are `[ASSUMPTION]` starting points to confirm.

- **NFR-1 (Idle footprint).** At idle with connections open, quick-studio's resident memory and CPU stay low enough to run all day alongside an IDE and browser without being noticed. `[ASSUMPTION: idle RAM budget to set at architecture; CPU ~0% at idle.]` Validates SM-4.
- **NFR-2 (Startup).** From run command to interactive Workspace in a small bounded time. `[ASSUMPTION: ≤2s cold.]`
- **NFR-3 (Shutdown).** Instant, non-blocking (FR-3).
- **NFR-4 (Interaction latency).** Common actions (open table, switch Tab, resize Panel, first query paint) feel instant. `[ASSUMPTION: UI response <100ms; first result paint bounded by DB, not the tool.]`
- **NFR-5 (Large results).** Result grids and the ERD stay responsive under large schemas/result sets via pagination/virtualization rather than degrading.
- **NFR-6 (Streaming smoothness).** AI Chat streaming and MDX rendering do not jank the UI thread.

## 11. Constraints & Guardrails

### 11.1 Security *(highest priority — resolve first)*

- **§11-R1 (Executable-JS sandbox) — HARD PREREQUISITE for FR-17.** Embedded JS from LLM-generated MDX must execute inside a strict boundary with no unrestricted access to the host, filesystem, network, or Credential Store. This is the single largest security and engineering risk in v1. Architecture must define the sandbox model before FR-17 is built.
- **§11-R2 (Credential Store model).** Encryption at rest with the key in the OS keychain; passphrase fallback; no plaintext ever (FR-4, FR-5). Must work across both v1 platforms — **Windows Credential Manager** and **Linux Secret Service** — which raises the importance of the passphrase fallback (FR-5) for headless/keychain-less Linux setups. Prior art to evaluate: Cloudflare Wrangler (AES-256-GCM + 32-byte key in OS keychain). **Anti-pattern to beat:** plaintext credential files (`.pgpass`, default Wrangler TOML) — never acceptable, even as a fallback.
- **§11-R3 (Network exposure).** Localhost-by-default; active Port-Exposure Warning on any non-loopback binding (FR-21, FR-22). Prior art: browsers treat `http://localhost` as a secure context (no TLS cert needed); mkcert is the option if local HTTPS is ever wanted.
- **§11-R4 (Destructive-statement guardrail).** DELETE/DROP/TRUNCATE and similar are never auto-executed from chat or generated queries without explicit confirmation (FR-11, FR-15).

### 11.2 Privacy

- **§11-R5 (Local-first data).** Query results, schemas, and report data never leave the machine for a third-party service. The only outbound calls are to the user-configured AI Provider, and those carry only what the user's prompt/query intentionally includes. `[NOTE FOR PM]` The boundary of what the AI Chat sends to a Provider (schema? sample rows?) needs an explicit, user-visible policy — define at architecture.

### 11.3 Cost

- **§11-R6 (User-funded AI).** AI usage runs on the user's own Provider API keys; quick-studio incurs no hosted/inference cost and requires no backend account.

## 12. Aesthetic & Tone

- **Visual language:** shadcn/ui aesthetic — clean, modern, restrained. Dark-first is likely for a dev tool `[ASSUMPTION]`.
- **Feel:** fast and fluid over ornate. Motion serves feedback (state changes, streaming), never decoration for its own sake — consistent with the "lightweight" identity and SM-C1.
- **Anti-reference:** DBeaver's dense, Eclipse-era UI. If a screen starts to feel like that, it's wrong.

---

### Notes for downstream phases
- **Architecture must resolve §11-R1 (JS sandbox) and Open Questions 1 & 3 before those features are built.** These gate FR-17 and FR-20.
- Tech-how (frameworks, packaging, sandbox implementation, charting library choice) intentionally omitted here — it belongs in the architecture doc and `addendum.md`.
