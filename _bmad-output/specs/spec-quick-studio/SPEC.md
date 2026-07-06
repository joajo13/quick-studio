---
id: SPEC-quick-studio
companions:
  - glossary.md
  - ../../planning-artifacts/architecture/architecture-quick-studio-2026-07-06/ARCHITECTURE-SPINE.md
sources:
  - ../../planning-artifacts/prds/prd-quick-studio-2026-07-06/prd.md
  - ../../planning-artifacts/briefs/brief-quick-studio-2026-07-06/brief.md
  - ../../planning-artifacts/briefs/brief-quick-studio-2026-07-06/addendum.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# quick-studio

## Why

A **vision to realize**, first for the builder and then for colleagues. A developer working across several projects touches databases constantly — create a table, check an index, inspect rows, write a quick query — and the incumbent tools tax the machine for it: they fight the IDE and browser for RAM and CPU, bury the daily essentials under features used only when *tuning*, and are slow to open and painful to close. On top of that, "send me a report on the database" arrives by ambush, and today's fallback — handing data to an external AI — is both friction and an exposure problem. quick-studio is a lightweight, local-first database manager that installs and runs with a single command, serves a fast web UI on `127.0.0.1`, and folds in an AI chat that turns questions into queries and — the marquee differentiator — generates rich, exportable reports locally, without shipping data to a third party. **Lightweight is the identity; fast is the promise.** It is a personal-use-first, portfolio-grade product, shared with colleagues (some on Linux), with the door open to open source. The moat is execution and taste, not a defensible secret.

## Capabilities

- **CAP-1 — One-command install & run with mode select**
  - **intent:** A developer installs and starts quick-studio each with a single command, choosing Ephemeral or Persistent Run Mode.
  - **success:** A single documented command yields a runnable quick-studio with no multi-step wizard; passing a database URL starts an Ephemeral session, starting without one (or with an explicit flag) starts a Persistent session; the server binds `127.0.0.1` by default.

- **CAP-2 — Clean, instant shutdown**
  - **intent:** A developer can stop quick-studio instantly without it ever blocking the OS.
  - **success:** Ctrl-C or the UI stop control terminates the server within a small bounded time (~2s); no orphaned process remains; system shutdown is never stalled.

- **CAP-3 — Encrypted Credential Store with keychain key + passphrase fallback**
  - **intent:** In Persistent mode a developer's Connections and Provider keys are stored encrypted at rest and available on the next launch.
  - **success:** Credentials are never written to disk in plaintext and the store file reveals no readable secret; the encryption key lives in the OS keychain; on a keychain-less machine a passphrase fallback is offered and declining writes nothing; a saved Connection is present next launch; removing a Connection deletes its credentials.

- **CAP-4 — Connect to PostgreSQL and MySQL**
  - **intent:** A developer opens a working Connection to a PostgreSQL or MySQL database via URL or stored Connection.
  - **success:** A valid PostgreSQL target connects and lists its schema; a valid MySQL target does the same; a failed connection returns an actionable error distinguishing host / auth / network.

- **CAP-5 — Data & schema workspace**
  - **intent:** A developer can browse, edit, insert, and delete rows; create tables; inspect indexes; and run ad-hoc SQL.
  - **success:** A table opens in a Tab with pagination; an edited cell persists on reload; insert and delete work (delete requires confirmation); a created table appears in the schema and ERD without manual refresh; each index lists its columns and uniqueness; a SELECT returns a paginated grid; any destructive statement requires explicit confirmation.

- **CAP-6 — Interactive relational ERD**
  - **intent:** A developer can view and navigate an interactive ERD of the connected schema, with its layout saved in Persistent mode.
  - **success:** Tables render as nodes with columns and foreign keys render as edges; pan/zoom stays fluid to 60–70 tables; a rearranged layout is restored on the next launch in Persistent mode.

- **CAP-7 — Configure AI Providers**
  - **intent:** A developer configures Anthropic, OpenAI, and/or Google (Gemini) with their own API keys.
  - **success:** A configured Provider is selectable for a chat; keys are protected like Credentials in Persistent mode and are session-only, never written to disk, in Ephemeral mode.

- **CAP-8 — Natural-language to query + execution**
  - **intent:** A developer asks a question in natural language, receives a query, and runs it from the chat.
  - **success:** The generated query targets the schema of the chat's explicitly-bound Connection; running it from chat produces the same result as a query Tab; destructive statements are never auto-executed and require explicit confirmation.

- **CAP-9 — Streaming responses with visible reasoning**
  - **intent:** A developer sees responses stream incrementally, including the model's reasoning.
  - **success:** Output appears token-by-token rather than only on completion; reasoning is visually distinguished from the final answer.

- **CAP-10 — Rich MDX rendering (executable JS + charts)**
  - **intent:** The AI Chat renders MDX Blocks combining Markdown, embedded executable JavaScript, and charts.
  - **success:** A response containing a chart spec renders an interactive chart; embedded JS executes only within the security boundary (see Constraints) with no access to host, filesystem, network, or credentials. *Not shippable until the sandbox constraint is met.*

- **CAP-11 — Build a Report from query results**
  - **intent:** A developer assembles a Report from one or more query results, including narrative and charts.
  - **success:** A Report can contain results from more than one query and mix charts, prose, and tabular data.

- **CAP-12 — Test-to-production Report targeting**
  - **intent:** A developer builds a Report against one database and re-targets it at another.
  - **success:** Re-targeting re-runs the Report's queries against the new target without rebuilding its layout.

- **CAP-13 — Export as static Snapshot or Live Report**
  - **intent:** A developer exports a Report as HTML, choosing a static Snapshot or a Live Report.
  - **success:** A Snapshot renders identical data when reopened, disconnected from any database; a Live Report re-queries its target via a viewer-supplied connection through a running quick-studio; report generation and export send no data to any external service.

- **CAP-14 — Localhost binding + Port-Exposure Warning**
  - **intent:** quick-studio binds to localhost by default and warns prominently if the port becomes reachable off-machine.
  - **success:** With default settings the server is unreachable from another host; binding to a non-loopback address raises a prominent warning explaining the risk and how to revert.

- **CAP-15 — UI shell: Tabs and resizable Panels**
  - **intent:** A developer opens and closes Tabs (tables, queries, ERDs, chats, reports) and resizes Panels in a fast, fluid Workspace.
  - **success:** Multiple Tabs are open at once and closing one leaves the others intact; Panels resize and, in Persistent mode, are restored on the next launch.

## Constraints

- **Three-ring trust model governs everything** (`ARCHITECTURE-SPINE.md` AD-1): data flows outward only, capability never inward. Every runtime unit is Core, UI, or Sandbox; no feature may build a path that lets less-trusted code reach DB connections, credentials, or Provider keys.
- **Executable JS runs only in a cross-origin sandbox, pure-render, fed one-way** (AD-3): `allow-scripts` without `allow-same-origin`, CSP `default-src 'none'`; no host, filesystem, network, backend, credential, or SQL access; it cannot request data or trigger a query. This is a **hard prerequisite for CAP-10**.
- **All SQL passes through one guarded Core executor** (AD-4): the Core is the sole classifier of statement risk; UPDATE / DELETE / DROP / TRUNCATE / ALTER are default-deny and always confirmed; multi-statement input is rejected or split; a UI dialog is never the gate.
- **Credentials are never written in plaintext, even as fallback** (AD-5): AES-256-GCM store, 32-byte key in the OS keychain (Windows Credential Manager / Linux Secret Service), passphrase-derived key when no keychain.
- **The Core authenticates every caller** (AD-12): a session capability token on every RPC plus Origin/Host anti-rebinding — loopback alone is not an authentication boundary; a Live Report is authorized only as an explicit second caller.
- **The only outbound channel is the user-configured Provider, called by the Core via a typed inspectable payload** (AD-7): schema metadata by default; row data leaves only through an explicit, per-query, visibly-indicated opt-in.
- **Ephemeral mode writes nothing to disk** (AD-8); no daemon outlives the process; Persistent state lives under one OS-convention app directory (AD-15).
- **AI runs on the user's own Provider keys** — no backend account, no hosted inference cost.
- **Performance budgets are acceptance criteria, not aspirations:** idle RAM ≤ ~200 MB ceiling, cold start ≤ 2 s, common UI interaction < 100 ms, large results responsive via Core pagination, streaming never janks the UI thread. Lightweight is the identity.
- **v1 is Windows + Linux, relational-only (PostgreSQL + MySQL), no ORM dependency** — quick-studio connects directly.
- **Build-level topology (HOW) is fixed in the adopted `ARCHITECTURE-SPINE.md`, not this kernel:** full TypeScript / Bun, dual distribution (standalone binary + npm package), charting split by ring (Recharts in-app, Observable Plot in the sandbox), unified multi-provider AI layer. Downstream reads the spine for build detail.

## Non-goals

- **Not a heavyweight, do-everything DBA suite** — deep tuning, query-plan analysis, and rarely-used admin tooling are excluded; that breadth is the incumbent bloat.
- **Not a multi-user or cloud product** — no shared workspaces, accounts, collaboration, or hosted service. Sharing the *tool* with colleagues is supported; sharing a live *workspace/session* is not.
- **Not a data pipeline / BI platform** — no scheduled jobs, ETL, or org-wide dashboard distribution. **Not an ORM.**
- **Out for v1:** NoSQL engines (MongoDB, DynamoDB) — deferred to v2; deep visual ERD editing (creating/altering schema through the diagram) — deferred to v2; macOS support.

## Success signal

The **switch test**: the builder stops using DBeaver entirely for daily work over a sustained stretch (falling back to DBeaver = failure). And **reports that land**: real reports get generated locally and produce useful conclusions, with no data pasted into an external AI.

## Assumptions

- Performance numbers are confirmable starting points, not yet measured: cold start ≤ 2 s, UI interaction < 100 ms, idle RAM ceiling ~200 MB, switch test measured over ~4 consecutive weeks.
- The UI is dark-first (shadcn aesthetic for a dev tool).
- Panel sizes are restored in Persistent mode.

## Open Questions

- **Data-volume ceilings** (PRD Open Q5): practical limits for result-grid size, ERD table count (target 60–70), and report data size before performance degrades — to refine against real measurement.
- **Keychain parity under Bun:** `@napi-rs/keyring` NAPI parity is "almost, not 100%" — smoke-test on Windows and Linux before locking; the passphrase fallback is the safety net.
- **Positioning freshness** (PRD Open Q6): re-verify competitive claims before making public positioning claims — non-architectural.
