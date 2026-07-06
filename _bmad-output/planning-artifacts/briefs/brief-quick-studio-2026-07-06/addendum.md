# Addendum — quick-studio

Downstream depth captured during the brief conversation. Belongs in PRD / architecture, not the 1-2 page brief.

## Competitive Landscape (web research, 2026-07-06)

| Tool | Form factor | Strength | Weakness / gap |
|------|-------------|----------|----------------|
| DBeaver | Java desktop | Universal DB coverage; free | Bloated, slow startup (3-5s), Eclipse-ugly. Has AI Assistant extension. Loudest "bloat" complaint in reviews. |
| Drizzle Studio | Local web (`drizzle-kit studio`) | Clean, TS-native, runs as local server | Tied to Drizzle ORM/schema; thin feature set |
| TablePlus | Native desktop | Sub-second launch, beautiful, big result sets | Closed-source, paid per-device |
| Beekeeper Studio | OSS Electron desktop | Fast, uncluttered "80%" | Lacks advanced/enterprise features |
| Outerbase / Outerbase Studio | Cloud web + OSS local | AI-native (EZQL NL→SQL), dashboards, multi-DB | Acquired by Cloudflare 2024; status may be stale post-2025 |
| postgres.new → database.build | In-browser (PGlite/WASM) | AI chat → SQL + **charts & reports from results** | Browser-only, Postgres-only |
| Supabase Studio | Web (bundled) | AI Assistant for SQL/RLS | Tied to Supabase projects |
| DataGrip | JetBrains desktop IDE | Very powerful | Paid, heavy, IDE-shaped |
| Metabase | Self-hosted web server | Dashboards/reports + NL query (Metabot) | BI-focused, not a dev DB manager |
| phpMyAdmin | Web (PHP) | Ubiquitous | Dated UI, no AI, MySQL-only |

**Already do AI chat:** DBeaver, Outerbase, Supabase Studio, database.build, DataGrip, Metabase.
**Run as local web server:** Drizzle Studio, Supabase Studio, Metabase, phpMyAdmin, Outerbase Studio.

## Gaps / Opportunities (whitespace)

- **Fast + pretty + multi-DB + NoSQL-first-class** rarely coexist. Pretty tools (TablePlus, Beekeeper) skimp on breadth; broad tools (DBeaver) are ugly. NoSQL (Mongo/DynamoDB) underserved in the pretty tools — clear whitespace.
- **DBeaver bloat/slowness** is the loudest repeated dev complaint.
- **Price/licensing friction** on TablePlus (per-device) and DataGrip (subscription) drives "free alternative" searches.
- **Setup friction**: devs want one-command run, not installers/config (Drizzle Studio / postgres.new popularity).
- **AI report/chart generation from results is rare** — only database.build and Metabase stand out. NL→SQL alone is now table stakes and commoditized. A schema-aware chat that *also renders reports* is the differentiator.

## Technical Prior Art

- **Localhost security**: bind `127.0.0.1` (not `0.0.0.0`); browsers treat `http://localhost` as secure context (no cert). mkcert for local HTTPS if needed. Warn on external exposure.
- **Encrypted local credential store**: Cloudflare **Wrangler** `--use-keyring` = AES-256-GCM-encrypted file with the 32-byte key stored in the OS keychain. Near-exact model for the "encrypted local JSON" pattern. DBeaver uses local encryption behind a master password. Plaintext (`.pgpass`, default Wrangler TOML) is the anti-pattern to beat.

**Staleness flags (post Jan-2026 cutoff):** Outerbase post-Cloudflare status, postgres.new→database.build rebrand, and specific AI-feature availability — verify before locking positioning claims.
