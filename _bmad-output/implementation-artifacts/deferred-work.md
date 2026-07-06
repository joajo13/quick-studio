# Deferred Work

Append-only ledger of issues surfaced during review that are intentionally deferred (not caused by the current story, or out of its scope). Triaged later by focused attention.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-walking-skeleton.md`
  summary: Harden the per-boot token against same-machine processes and add a Content-Security-Policy (with a nonce for the inline token script) once stories render database content.
  evidence: The token is served in cleartext at the ungated `GET /` (the spec's chosen browser handoff), so any local process can scrape it; and `window.__QS_TOKEN__` is script-readable, so a future stored-XSS in rendered DB data could exfiltrate it. Both matter only once data rendering (Epic 3/5) exists; the walking skeleton renders no untrusted data.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-walking-skeleton.md`
  summary: When data-carrying RPCs arrive, have the server map `decode()` failures on untrusted peer FrozenData to a typed `bad_request` (400) instead of letting them throw into the catch-all `internal_error` (500).
  evidence: `decode` enforces producer-side invariants by throwing `TypeError`; that is correct for internal producers but wrong for untrusted inbound wire data. No RPC decodes untrusted FrozenData in story 1.1, so it is latent until Epic 3.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-walking-skeleton.md`
  summary: Story 1.2's browser-open must target `http://127.0.0.1:<port>`, NOT `http://localhost:<port>`, or the Origin/Host gate rejects every RPC.
  evidence: `validateOrigin` requires an exact `127.0.0.1:<port>` Host match and treats `localhost` as a distinct (rejected) origin — per the spec's deliberate design. A `localhost` launch URL would make the app appear broken end-to-end with only a `forbidden_origin` error.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-walking-skeleton.md`
  summary: Decouple the Ring-2 UI build from Ring-1 Core availability and stop rebuilding the UI on every boot (bundle at build time / cache) to protect the epic's ≤2s cold-start target.
  evidence: `startCore` awaits `buildUiBundle()`, so any UI TypeScript/build error currently aborts the whole Core (including the health channel), and every boot re-bundles. Acceptable for a skeleton; a cost/robustness concern for the run-mode and packaging stories (1.2, 1.7).

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-walking-skeleton.md`
  summary: Decide the canonical frozen-date sub-second precision policy (truncate-to-ms vs preserve) before real DB timestamps arrive; the current ISO regex + calendar round-trip only support millisecond precision.
  evidence: `ISO_UTC_RE` allows only 1–3 fractional digits and `assertIsoUtc` re-serializes through a JS `Date` (millisecond resolution), so Postgres/MySQL microsecond timestamps (`.123456Z`) would throw. No timestamps flow until Epic 1 story 1.3 / Epic 3, and fixing it correctly is a precision-policy decision, not a one-line regex widen.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-walking-skeleton.md`
  summary: Optionally add a max request-body guard (Content-Length limit) on `POST /rpc`.
  evidence: `await req.json()` buffers an unbounded body. Low risk for a single-user localhost tool (you would only DoS yourself), but a cheap hardening once multi-caller scenarios (Live Reports, Epic 6) appear.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-walking-skeleton.md`
  summary: When story 1.2 makes the port user-configurable, handle the scheme-default ports (80/443) in `validateOrigin` — browsers omit the default port from `Host`/`Origin`, so the exact `host:port` authority match rejects every RPC.
  evidence: `validateOrigin` builds `expectedAuthority` as `${host}:${port}`, but a browser loading `http://127.0.0.1` (QS_PORT=80) sends `Host: 127.0.0.1` and `Origin: http://127.0.0.1` with no `:80`, so both comparisons fail and every RPC is rejected `forbidden_origin` (app dead-on-arrival). Story 1.1 defaults to ephemeral ports, so this is latent until 1.2 lets the user pin a port.
