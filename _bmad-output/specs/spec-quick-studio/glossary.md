# Glossary — quick-studio

Canonical vocabulary for the SPEC and every downstream consumer. Terms are load-bearing: capabilities, constraints, and architecture invariants all resolve against these definitions.

- **Connection** — a configured link to one database (engine, host, credentials, database name). Belongs to at most one Credential Store; used by Tabs and the AI Chat.
- **Run Mode** — how a session launches. One of **Ephemeral** or **Persistent**.
- **Ephemeral (Run Mode)** — launched with a database URL; nothing is persisted to disk; no Credential Store is created or read.
- **Persistent (Run Mode)** — launched against a local Credential Store; Connections, ERDs, and Reports are saved.
- **Credential Store** — an encrypted local file holding Connections and saved artifacts. Encryption key is held by the OS keychain (passphrase fallback when none is available).
- **Workspace** — the running UI: the set of open Tabs and Panels for the current session.
- **Tab** — an openable/closable unit of work in the Workspace (a table view, a query editor, an ERD, a chat, a report).
- **Panel** — a resizable region of the Workspace layout.
- **ERD** — the interactive relational entity-relationship diagram of a connected database's schema.
- **AI Chat** — the assistant surface; connects to a Provider via a user-supplied API key.
- **Provider** — an AI vendor: Anthropic, OpenAI, or Google (Gemini).
- **MDX Block** — rich chat/report content combining Markdown, embedded executable JavaScript, and charts. Executable JS runs only inside the cross-origin Sandbox.
- **Report** — an exportable HTML document built from query results.
- **Snapshot (static Report)** — a Report frozen with the data captured at build time; renders offline.
- **Live Report (dynamic Report)** — a Report that re-queries a target database when viewed, via a viewer-supplied connection through a running quick-studio.
- **Port-Exposure Warning** — the alert raised when the server is reachable beyond `127.0.0.1`.

## Architecture terms (from the adopted `ARCHITECTURE-SPINE.md`)

- **Trusted Core (Ring 1)** — the backend process; sole holder of DB connections, decrypted credentials, and Provider keys; the only SQL executor and Provider caller.
- **Semi-trusted UI (Ring 2)** — the main browser origin (React/shadcn); orchestrates the Workspace, holds no credential, asks the Core over `127.0.0.1` with a session token.
- **Untrusted Sandbox (Ring 3)** — a cross-origin iframe where LLM-generated MDX JavaScript runs; pure-render, fed one-way.
