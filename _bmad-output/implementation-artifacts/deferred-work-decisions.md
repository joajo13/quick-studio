# Deferred Work — Human-Triaged Decisions (2026-07-21)

This register captures the 2026-07-21 human-triaged resolutions for the deferred-work ledger's "decision"-needed items — the open `DW-N` entries in `deferred-work.md` that could not be resolved unattended because they required a genuine judgment call (design/UX/security/product tradeoff), not just a mechanical fix.

Each row's decision has also been inserted verbatim (prefixed `decision: [2026-07-21, user] …`) directly above the corresponding item's `status:` line in `deferred-work.md`. The `status:` there is left as `open` — the decision makes the item actionable, it does not close it. These decisions are to be implemented by the bmad-loop post-epic sweep, RUN 2.

DW-41, DW-45, and DW-54 are NOT in this register: they were folded into Epic 10 (Story 10.4 / 10.5) separately on 2026-07-21 and are already marked `status: folded into Epic 10 (...)` in the ledger.

## Decisions

| DW # | Problem (1 line) | Decision | Notes / residual |
|------|-------------------|----------|-------------------|
| DW-1 | Review budget was exhausted on story 4-2 with a lingering independent-follow-up recommendation still outstanding. | Do a single focused follow-up review of story 4-2 during the post-epic sweep. | Cheap; closes the lingering budget-exhaustion recommendation. |
| DW-2 | The per-boot token is served in cleartext and `window.__QS_TOKEN__` is script-readable once DB content renders. | Add a strict Content-Security-Policy NOW (`default-src 'self'`, `connect-src 'self'`, a nonce for the inline token script, no inline eval). | Same-machine token hardening is a SEPARATE, lower-priority concern — explicitly not part of this item. |
| DW-6 | The frozen-date model only supports millisecond precision; real DB timestamps may carry microseconds. | Truncate sub-second to milliseconds explicitly and DOCUMENT the policy. | ms is sufficient for a browse/inspection tool; keeps the frozen-date model simple. |
| DW-10 | The keychain not-found/unavailable classifier is an English-substring heuristic, locale-fragile. | Replace it with typed error codes/kinds from `@napi-rs/keyring`, observing real per-platform error shapes in CI. | Robust, locale-proof; requires observing actual CI error shapes per platform. |
| DW-12 | A keychain entry that round-trips as `""` is currently treated as a valid `found` key. | Treat an empty-string round-trip as effectively not-found; reject it and fall back to re-create/passphrase. | An empty AES-256 key is never legitimate. |
| DW-30 | Numeric/decimal/bigint columns (returned as strings by the DB drivers) are classified and rendered as TEXT in the result grid. | Plumb each column's SQL `dataType` into the result contract and classify numeric/decimal/bigint → number (right-align + number color), decoupled from the neutral `FrozenCell` kind. | Resolves the previously-stuck "datatype-result-contract" plumbing gap; also the seam the deferred `t-json` color needs. |
| DW-32 | `table.rows` COUNT and page SELECT are two non-atomic round-trips; `total`/page contents can disagree under concurrent writes. | Accept for now — DOCUMENT that total/page are a best-effort snapshot (local single-user browse tool). | No code fix beyond documentation; revisit with keyset pagination only if it bites in practice. |
| DW-33 | Keyless-table ordering heuristic can both silently omit `ORDER BY` (page overlap/skip) and emit one the engine rejects (hard failure). | Use a physical row locator when the engine has one (Postgres `ctid`) for keyless-table ordering; otherwise order by the full set of orderable columns, and never emit an `ORDER BY` the engine will reject (pre-validate by column type). | Most-correct option; touches the driver/orderability seam. |
| DW-34 | `timestamp without time zone` values are stamped with a UTC `Z` suffix, asserting a timezone the column doesn't have. | Represent a `timestamp without time zone` as its literal wall-clock value (no `Z`, no UTC shift), distinct from tz-aware timestamps. | Adjacent to the DW-30 SQL-dataType-aware typing work. |
| DW-35 | mysql2 default numeric handling decodes `BIGINT` above 2^53 to a precision-lossy JS number, displayed rounded. | Carry large integers (bigint/int8/numeric above 2^53) as exact STRINGS end-to-end — read AND write AND PK addressing. | Shared resolution/intent with DW-40; nothing silently truncated. |
| DW-40 | Editing/inserting bigint/int8/numeric values (and reading the PK for update/delete) loses precision via JS `Number`, risking wrong-row addressing. | SAME as DW-35 — exact-string end-to-end for large integers on both the write value and the PK address (`WHERE pk = <exact string>`). | Update/delete can never address the wrong row via a lossy `Number`; implement together with DW-35. |
| DW-39 | The raw-SQL statement splitter assumes default session SQL modes (`standard_conforming_strings=on`, no `NO_BACKSLASH_ESCAPES`/`ANSI_QUOTES`); non-default modes shift string/identifier boundaries. | **[AGAINST RECOMMENDATION]** Detect the session's actual SQL modes and adapt the splitter's string/identifier parsing accordingly. | User chose the most-correct (detect-and-adapt) option over the cheaper document-and-force default recommended by the review. |
| DW-44 | Cross-database MySQL foreign keys are silently dropped from the ERD as "absent table" edges. | Draw the cross-database MySQL FK as a DISTINCT edge (dashed / labeled with the target database) to an external node or annotation, marked as cross-database. | Do not silently drop it. |
| DW-47 | Scripted same-frame navigation in the sandbox can bypass `connect-src 'none'` and exfiltrate the user's private `FrozenData`. | **[AGAINST RECOMMENDATION]** ACCEPT the risk (guest-visible data is already the user's own); document as out-of-scope, mirroring the DW-36 Option-A posture. | User chose accept-the-risk over the recommended sandbox-navigation block. RESIDUAL recorded explicitly: a hostile/shared report could still exfiltrate FrozenData via scripted same-frame navigation; revisit if untrusted/shared reports are ever introduced. |
| DW-48 | In exposed mode (`QS_HOST=0.0.0.0`) the sandbox binds the same wildcard host as Core (LAN-exposing the tokenless guest), while the injected origin is normalized to loopback (unreachable remotely). | Keep the sandbox bound to LOOPBACK even when the Core is exposed — never LAN-expose the tokenless guest — and document that report visualizations only render on the host machine in exposed mode. | Closes the LAN-exposure risk; avoids the false-success of a "works but silently fails off-host" fix. |
| DW-55 | CSV export does not guard against CSV/formula injection — cells starting with `=`, `+`, `-`, `@` execute as formulas when opened in Excel/Sheets. | Prefix-guard the CSV export — prepend a `'` to any cell starting with `= + - @` (and tab/CR). | Standard OWASP formula-injection mitigation. |
| DW-58 | The redesigned Confirm button paints white text on `--err` fill at ~3:1 contrast, below WCAG AA (4.5:1). | Darken the `--err` fill (or the on-err text) so the Confirm button label reaches ≥4.5:1 WCAG AA. | Small token tweak, no design-language change. |
| DW-65 | An ERD column that is both PK and FK shows only the PK badge; the FK-ness gets no per-column marker. | Show BOTH markers — the PK key badge PLUS a distinct FK link marker (blue-link glyph) — so a composite PK+FK column reads as both. | Cosmetic; the FK edge itself was already drawn correctly. |
| DW-67 | ERD muted type-label and legend text render sub-11px with no verified contrast in either theme. | Adjust the ERD muted type-label + legend text to a token/size that verifies ≥AA contrast in BOTH dark and light themes (minimal change to `--t-text`/size). | Checked with a measurement, not just visual judgment. |

## Went against the review's recommendation

- **DW-39** — chose detect-and-adapt (session SQL mode detection) over the cheaper document-and-force default.
- **DW-47** — chose accept-the-risk over the recommended sandbox same-frame-navigation block.

## Remaining open items — mechanical, no decision needed

These ~13 remaining `status: open` items in `deferred-work.md` are mechanical fixes (small, unambiguous, no judgment call required) and also go to the post-epic sweep, RUN 2, without a recorded decision:

DW-53, DW-56, DW-57, DW-59, DW-60, DW-61, DW-62, DW-63, DW-64, DW-66 — mechanical — sweep, no decision needed.

(DW-48 is decided above, not mechanical.)
