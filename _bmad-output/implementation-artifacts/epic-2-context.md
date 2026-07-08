# Epic 2 Context: Persistent Mode & Credential Store

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic turns quick-studio from a disposable, URL-in-every-launch tool into a real daily driver by letting a developer save their everyday database Connections once and have them ready on the next launch. It delivers an encrypted-at-rest Credential Store keyed by the OS keychain (with a passphrase fallback when no keychain exists), add/edit/remove Connection management, and the broader persistence substrate — one OS-convention app directory — that later epics reuse to persist ERD layouts, panel/session state, Reports, and Provider keys. It is placed immediately after the walking-skeleton epic because the core "switch away from DBeaver" test is not real until connections survive a restart; a tool that re-prompts for a URL every launch cannot replace an established manager. Because it introduces the product's only cryptographic risk boundary, it is isolated and de-risked first.

## Stories

- Story 2.1: Spike — validate the OS-keychain library under Bun on Windows and Linux
- Story 2.2: Encrypted Credential Store at rest, key in OS keychain
- Story 2.3: Keychain-unavailable passphrase fallback
- Story 2.4: Manage Connections (add, edit, remove)
- Story 2.5: Persist and restore Workspace state

## Requirements & Constraints

- Persistent mode must store Connections and credentials encrypted at rest; plaintext credential material is never written anywhere, not even as a fallback. The store file must reveal no readable credential when opened directly, and must not contain its own encryption key.
- The encryption key lives in the OS keychain, not the store file. When no usable keychain exists, the app must surface that condition and offer a passphrase-derived unlock; if the user declines, nothing is written in plaintext.
- Managing Connections means add, edit, and remove; a saved Connection is available on next launch without re-entry, and removing one deletes its credentials from the store.
- Ephemeral mode is the hard inverse contract: nothing persists — no store, no ERD layout, no Report, no panel/session state — all state is in-memory and gone at exit, with no daemon outliving the process. Every persistence path in this epic must no-op in Ephemeral mode.
- This epic enables downstream behavior it does not itself own: ERD-layout persistence, Tabs/Panel restore-on-launch, and encrypted Provider-key storage all depend on the substrate built here.
- Keychain library parity under Bun is a known open risk ("almost, not 100%"); the passphrase fallback is the safety net and the spike outcome gates the crypto design. Secrets are never logged.

## Technical Decisions

- **Encrypted store model:** AES-256-GCM store file with a 32-byte key. In keychain mode the key is held by the OS keychain (Windows Credential Manager / Linux Secret Service via `@napi-rs/keyring`, pinned 1.3.0); in fallback mode the key is passphrase-derived. Ephemeral-mode keys are session-only in memory.
- **Core is the sole secret-holder:** the store, decrypted credentials, and all crypto live only inside Ring 1 (the Core, `src/core/`). Ring 2 (UI) never holds a credential or key — it issues typed, session-token-authenticated RPCs over `127.0.0.1` and receives results. Every RPC reply is a typed result or a single error envelope `code / message / detail`.
- **One app directory (Persistent mode only):** the store, ERD layouts, Reports, panel/session state, and logs all live under a single OS-convention directory — Windows `%APPDATA%\quick-studio`; Linux `$XDG_DATA_HOME/quick-studio` else `~/.local/share/quick-studio`.
- **Spike-first sequencing:** Story 2.1 is a go/no-go smoke test of the keychain path on both platforms, committed as a repeatable test plus a short per-platform decision record (keychain vs passphrase-first). Build the store only after the path is proven; the passphrase fallback is the designed net if a platform fails.
- **Workspace-state persistence** (panel sizes, open Tabs) reuses the same app directory and the Ephemeral-writes-nothing rule; it completes the restore half of the resizable-Panels behavior scaffolded in Epic 1.

## UX & Interaction Patterns

- **Where connection management lives:** a **Settings** surface pinned at the bottom of the launcher rail holds Connections (alongside Providers, theme, and exposure controls). This is the home for the add/edit/remove Connection flow. Do not invent surfaces beyond the defined six.
- **Connection header (schema tree, 232px):** shows a status dot (`ok` color with a soft 3px halo when connected), the db name, `host · engine` in mono, and a **run-mode chip** reading `persistent` or `ephemeral` — the always-visible signal of which mode the session is in.
- **Security is stated, not decorated:** the status bar carries terse mono stamps such as `encrypted store · OS keychain` and `127.0.0.1 only`. Microcopy is mono, technical, lowercase, terse — a status line, not marketing (say `encrypted store · OS keychain`, never "Credentials protected"). DB identifiers render verbatim from the live database, never re-cased.
- **Connection errors** surface through the Core error envelope and must visually distinguish host vs auth vs network, terse and mono.
- **Aesthetic:** dark-first shadcn/ui, restrained; motion serves feedback only. Depth comes from tonal surface layering and borders, not shadows.

## Cross-Story Dependencies

- Epic 2 depends only on Epic 1 (three-ring skeleton, run-mode selection, engine-neutral connection/driver interface, Tabs/Panels shell, session token); it requires no later epic.
- Story 2.1 (keychain spike) gates 2.2 and 2.3: its per-platform outcome decides whether the store defaults to the keychain path or the passphrase path on each platform.
- Stories 2.2/2.3 (the store) precede 2.4 (Manage Connections), which persists into that store; 2.3 is the alternate unlock path for the same store.
- Downstream: Epic 4 ERD-layout persistence (FR-13), Epic 1's Tabs/Panel restore-on-launch (FR-24 restore half, delivered here as Story 2.5), and Epic 5 encrypted Provider-key storage (FR-14) all depend on this epic's persistence substrate.
