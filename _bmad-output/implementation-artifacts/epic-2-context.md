# Epic 2 Context: Persistent Mode & Credential Store

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn the Ephemeral, URL-only tool from Epic 1 into a persistent daily driver by letting a developer save their everyday database connections once and have them ready on the next launch. This epic delivers an encrypted credential store, a safe fallback for machines without an OS keychain, connection management, and the general persistence substrate (a single OS-convention app directory) that later epics reuse to save ERD layouts, panel state, and Reports. It is sequenced second — right after the skeleton — because the product's core value (replacing a tool like DBeaver) is not real if the developer must re-enter a connection URL every launch. The crypto path carries an isolated platform risk that must be de-risked before the store is built.

## Stories

- Story 2.1: Spike — validate the OS-keychain library under Bun on Windows and Linux
- Story 2.2: Encrypted credential store at rest, key in OS keychain
- Story 2.3: Keychain-unavailable passphrase fallback
- Story 2.4: Manage Connections (add, edit, remove)
- Story 2.5: Persist and restore Workspace state

## Requirements & Constraints

- Persistent-mode secrets (Connections, and later Provider keys) must be stored encrypted at rest; plaintext must never be written to disk — not even as a fallback.
- The store file must reveal no readable credential material when opened directly, and must not contain its own encryption key.
- A saved Connection must survive across launches and be usable without re-entry; removing a Connection must delete its credentials from the store.
- When no usable OS keychain exists, the app must surface the condition and offer a passphrase-based unlock; if the developer declines, no credential is written anywhere in plaintext.
- All persistent artifacts (store, layouts, reports, panel/session state, logs) must live under one OS-convention directory. In Ephemeral mode nothing is ever written to disk — no store, no restored state.
- Secrets must never be logged.
- The keychain library's behavior under Bun is not guaranteed to be identical across platforms; this must be proven per-platform before the crypto design is committed, and the outcome recorded as a repeatable smoke test plus a per-platform go/no-go decision record.

## Technical Decisions

- Encryption: AES-256-GCM store file with a 32-byte key. In keychain mode the key is held by the OS keychain (Windows Credential Manager / Linux Secret Service via `@napi-rs/keyring`); in fallback mode the key is passphrase-derived. Ephemeral-mode keys are session-only and in-memory.
- App directory: Windows `%APPDATA%\quick-studio`; Linux `$XDG_DATA_HOME/quick-studio`, else `~/.local/share/quick-studio`.
- Trust boundary: the credential store, decrypted credentials, and all crypto live only inside Ring 1 (the Core, `src/core/`). Ring 2 (UI) never holds a credential or a key — it issues typed, session-token-authenticated RPCs over `127.0.0.1` and receives results. Every RPC reply is a typed result or a single error envelope (`code` / `message` / `detail`).
- The `@napi-rs/keyring` version is pinned at 1.3.0; NAPI parity under Bun is the known risk that Story 2.1 exists to retire. The passphrase fallback is the designed safety net if a platform fails the spike.
- Workspace-state persistence (panel sizes, open Tabs) reuses this same app directory and the Ephemeral-writes-nothing rule; it completes the restore half of the resizable-Panels behavior scaffolded in Epic 1.

## Cross-Story Dependencies

- Story 2.1 (keychain spike) gates 2.2 and 2.3: its per-platform outcome decides whether the store defaults to the keychain path or the passphrase path on each platform.
- Story 2.2 (encrypted store) is the substrate for 2.4 (manage Connections) and for storing Provider keys in Epic 5.
- Story 2.3 (passphrase fallback) is the alternate unlock path for the same store when 2.1 finds no usable keychain.
- Epic 2 depends only on Epic 1 (three-ring skeleton, connection/driver interface, Tabs/Panels shell, session token).
- Downstream: Epic 4 persists ERD layout, Epic 5 protects Provider keys, and Epic 1's resizable-Panels restore all depend on this epic's persistence substrate.
