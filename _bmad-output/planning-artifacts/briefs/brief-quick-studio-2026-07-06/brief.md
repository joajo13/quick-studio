---
title: "Product Brief: quick-studio"
status: ready
created: 2026-07-06
updated: 2026-07-06
---

# Product Brief: quick-studio

## Executive Summary

**quick-studio** is a lightweight, local-first database manager that spins up with a single command and runs as a local web UI on localhost. It exists for one reason: today's database tools are too heavy — they fight your real work for RAM and CPU, bury the everyday essentials under features you don't need mid-development, and are slow to open and painful to close. quick-studio inverts that: it stays out of your way, lives quietly in the background while you work, and does the daily job fast.

Beyond day-to-day browsing and editing, quick-studio folds in an AI chat that turns natural-language questions into queries, explains what's in a database, and generates rich, exportable reports directly from query results — turning the recurring, dreaded "can you send me a report on the database?" request into a quick, local job.

The wager is simple and honest: **lightweight is the identity, fast is the promise.** A developer tool that respects your machine, ships the essentials cleanly, and adds an AI reporting layer nobody else does well — without the bloat that made the incumbents unbearable.

## The Problem

A developer working across several projects at once needs to touch databases constantly — create a table, check an index, inspect some rows, write a quick query. The tools built for this get in the way:

- **They eat the machine.** Running a heavyweight manager alongside an IDE, browsers, and services means it's another process fighting for RAM and CPU. It can't just stay open. Closing it drags — sometimes it stalls the whole machine shutdown.
- **They're bloated for the daily job.** The advanced features are genuinely useful when you sit down to *tune* a database — but during normal development they're noise around the five things you actually use.
- **The work is fragmented.** Browsing data, writing queries, getting AI help, and building a report each happen in a different tool. Non-relational connections are often locked behind paywalls or a painful setup.
- **Reports arrive by ambush.** Someone asks for a report on a database or its data, and the current fallback — handing the database to an external AI — is friction *and* a data-exposure problem no one is comfortable with.

The cost of the status quo is a constant low-grade tax: a slow, greedy tool you tolerate, and a report workflow that forces sensitive data out the door.

## The Solution

A single command installs quick-studio; a single command runs it. It launches a local web UI — served strictly on `127.0.0.1`.

- **Two run modes.** *Ephemeral*: pass a database URL, connect, touch nothing on disk. *Persistent*: quick-studio manages an encrypted local store of connections and credentials, so your setup is there next time.
- **The daily essentials, cleanly.** Connect, browse and edit data, create tables, inspect indexes, and read the schema through an interactive relational **ERD** that highlights what matters visually.
- **An AI chat that does real work.** Ask a question in plain language and get a query; ask about a database and get an explanation; run queries from the conversation, watch the model's reasoning and answer stream in. The chat renders rich MDX with embedded interactive content and charts.
- **Reports from your data.** Turn query results into exportable HTML reports — build against test data, then point at production; deliver as a static snapshot of a moment, or as a live/dynamic view.
- **Security you can see.** Bound to localhost by design, with an active warning if the port is ever exposed beyond the local machine.

The whole thing is tuned to feel fast and fluid — a shadcn-style UI with tabs you open and close freely and resizable panels.

## What Makes This Different

- **Lightweight is the whole point, not a nice-to-have.** The competitor set splits cleanly: the pretty, fast tools (TablePlus, Beekeeper) cover fewer databases; the broad tools (DBeaver) are heavy and slow. quick-studio's unfair advantage is refusing that trade — the essentials, done fast, without the weight.
- **AI reporting from results, done locally.** Natural-language-to-SQL is now table stakes — nearly every tool has it. What almost none do well is *generating reports and charts from the results*, and doing it without shipping data to a third party. That combination is the marquee differentiator.
- **Connect to anything, own nothing.** No dependence on Prisma or a specific ORM — connect directly, use whatever you already use.
- **One command, web-native, disposable.** No installer ceremony, no lingering process you can't kill. Spin it up, use it, close it.

*Honest caveat:* this is a broad v1 by choice (see Scope). The moat here is execution and taste, not a defensible technical secret.

## Who This Serves

**Primary: the working developer juggling multiple projects** — the author first. Someone who lives in Postgres daily, reaches for MySQL sometimes, and is starting to pick up NoSQL. They want a get-out-of-my-way tool for the 90% case, AI help for queries, and a way to answer report requests without a heavyweight BI stack. Success for them is simple: they stop opening the old tool.

**Secondary:** developers on small teams who get ad-hoc "send me a report on the database" requests and want a fast, private way to produce something sharp.

## Success Criteria

Qualitative and personal, by design — this is a tool built to be used, judged by whether it earns daily use:

- **The switch test:** the author stops using DBeaver entirely. (Falling back to DBeaver = failure.)
- **Reports that land:** real reports get generated and produce useful conclusions.
- **Conversational database work:** asking about a database in natural language reliably yields the right query or the information needed.
- **Invisible footprint:** it can stay open all day across multiple projects without being felt — and it closes instantly.

## Scope

**In — v1 (a deliberately broad first version):**
- Connections to **PostgreSQL** (primary) and **MySQL**.
- **Ephemeral** (database URL) and **persistent** (encrypted local credential store) run modes.
- Local web UI bound to `127.0.0.1` with **port-exposure detection and warning**.
- Browse/edit data, create tables, inspect indexes, read schema.
- **Interactive relational ERD**, saved when persistence is on.
- **Full AI chat** — multi-provider (Anthropic / OpenAI / Gemini via user API keys): natural-language-to-query, database Q&A, query execution, streaming responses with visible reasoning, **MDX rendering with embedded interactive JS and charts**.
- **Report generation** — build from query results, test-data → production targeting, static-snapshot or live/dynamic output, exportable as HTML.
- **shadcn-style UI:** open/close tabs, resizable panels.

**Out — deferred to v2+:**
- **NoSQL engines** (MongoDB, DynamoDB) — a different paradigm (no fixed schema, no classic ERD, different query model) that deserves its own dedicated UX pass.
- Deep visual **ERD editing** (v1 views and highlights; full visual editing comes later).
- Fine-grained animation polish and extreme fluidity tuning.

**Explicit boundary:** v1 is relational-only and does *not* chase "connect to absolutely anything" — that ambition is exactly what makes the incumbents heavy, and it is consciously held back.

> **Scope note:** folding the full AI chat and report generation into v1 (rather than a smaller query-helper first) was a deliberate, eyes-open choice by the author. It makes v1 substantially larger and pulls the costliest, riskiest component — MDX with executable embedded JS — into the first release. Recorded here so the tradeoff stays visible.

## Vision

quick-studio starts as a tool the author actually uses every day and a portfolio piece that shows taste and range, with the door open to being released as open source if it proves itself. If it lands, the natural path is outward: first-class NoSQL support, a genuinely great interactive ERD, and a reporting layer polished enough that "send me a report on the database" becomes a thirty-second job instead of a dreaded one — a lightweight manager people reach for *because* it respects their machine.

---

### Open questions
- **TradingView charting** — chosen for aesthetics, but its library targets financial time-series (OHLC) and may be a poor fit for generic database data. Flagged for validation at the architecture stage, not decided here.
