# Architecture

How Persona works today. The original design review from before the build is kept in [history/](history/2026-09-27-architecture-review.md); where they differ, this file is current.

## Runtime

- **Public address on Vercel** (`persona-onboarding-five.vercel.app`): `vercel.json` builds nothing and passes every request through to Railway. `APP_BASE_URL` is this address, and origin checks accept it (`lib/http/origin.ts`).
- **One Next.js app on Railway** (`persona-app`), a long-running Node server: pages, API routes and background work (`after()`) share one process, so nothing is cut off by a function timeout.
- **Postgres on Railway** holds an append-only event log per conversation (`persona_events`) plus a few tables for accounts, logins, connections, automations, runs, reservations and rate limits (`lib/db/schema.sql`, migrated on every start).
- **Scheduler**: `persona-cron` (`ops/railway-cron/`) calls `GET /api/automations/run-due` with `CRON_SECRET` every 5 minutes. It runs due recurring tasks (each occurrence once: a unique run row plus `FOR UPDATE SKIP LOCKED`) and check-ins the assistant scheduled.
- **Sign-in first** (`proxy.ts`, `lib/auth/`): Google (authorization code + PKCE, `openid email profile` only) or email and password (scrypt). One account is one main conversation on any browser. Every user-data route resolves the conversation from the login, never from a client value.

## State

Every turn rebuilds the state from the log (`lib/domain/project.ts`, `lib/domain/user-state.ts`):

- **Identity**: sign-in facts (name, email, locale, time zone) and, when Exa finds a single clear match, a public profile line. Names stay tentative until the user confirms what to call them.
- **Setup**: each onboarding item (a name for the assistant, what to call them, their need, Gmail, the call) as unknown / asked (count, when) / answered / declined.
- **Needs and open loops**, accounts and what was read, calls and how each ended, engagement, **activation** (first real result, the recurring task) and **lifecycle**: onboarding until the first recurring task is approved or 7 days pass, then active.
- **Labels**: short tags about the user with confidence and evidence; never used for permissions.

## Prompt

`lib/agent/prompts.ts` assembles, with a token budget per section (`lib/agent/budget.ts`):

1. **Soul** (`lib/agent/soul/assistant.md`): who it is, taste, texting and spoken style, honesty, anti-slop. Plus its own **soul notes**, short lines it learned about being this user's assistant.
2. **Rules**: permissions and truth rules; they win over the soul.
3. **Company file** (`lib/agent/company/product.md`): what works today and what's coming soon. Never trimmed.
4. **State and memories**: the pinned profile, then the memories ranked for this turn, the rolling summary, and other facts with their evidence labels.
5. **Onboarding prompt** (`lib/agent/soul/onboarding.md`), only during onboarding: the goals in order (the basics, the first win, the first recurring task), pacing, and how to handle wake-ups.

## Agents

- **Main assistant** (`gpt-6-luna`, AI SDK) answers chat turns, writes the first message (`lib/agent/first-message.ts`), runs recurring tasks, and handles wake-ups.
- **Calls**: GPT-Live (`gpt-live-1`) speaks with its own instructions built from the same soul, company file, state and memories, plus the call's goals (`lib/voice/session-config.ts`). It delegates tool work to `gpt-6-luna` with the full prompt. The browser (`lib/voice/client.ts`) forwards each tool call to `/api/voice/tool`, which runs the same tools and gates as chat. The hello is sent as speakable commentary the moment the call starts; `end_call` hangs up after a goodbye.
- **Memory subagent** (`lib/agent/subagents/memory.ts`), in the background after each reply and wake-up: saves, merges and corrects typed, labeled memories grounded in what was just said, and compacts history into a dated summary once it passes the budget.
- **Wake-ups** (`lib/agent/follow-ups.ts`), onboarding only: a call ending, an account connecting or failing, a task running, the user returning or a scheduled check-in wakes the main assistant with a plain note of what happened. It writes one message or calls `stay_quiet`. Code keeps only safety limits: an explicit "stop", a live call, 2 unprompted messages a day, quiet hours (22:00–08:00 their time), and each trigger decided once.

## Tools

Every tool is defined once in `lib/agent/tools/` (schema, description, server gate, action) and offered to chat and calls alike: `remember`, `customize`, `note_decline`, `graduate`, `offer_call`, `show_connection`, `propose_automation`, `search_gmail`, `read_calendar_window`, `resolve_identity`, `save_memory`, `recall_memory`, `forget_memory`, `soul_note`, `stay_quiet`, `schedule_check_in`, and `end_call` (calls only). Gates enforce, among others: facts come from the user's own words, declines are honoured, accounts are read only for a request that needs them, and email or web content is data, never instructions.

## Memory

Each memory is an event: type (fact, preference, decision, person, need, routine, context), 1–4 labels (a small fixed vocabulary plus free tags), source, provenance, confidence, and the event it came from. Corrections and merges point at what they replace; forgotten memories stay in the log but are never shown. Recall ranks memories by word and topic overlap with the recent conversation, recency, confidence and type, and fills the section's budget (smaller on calls). Once replayed history passes its budget, a background call summarizes the older part, keeping names, decisions, commitments, open questions and dates; a forget also rewrites the summary.

## Identity and research

At sign-in, for a Google-verified email only, the assistant looks the person up once with Exa: a work email by full name and the domain's company (a single profile with that exact name mentioning the company), a personal email by its handle and full name (only pages carrying both). A match becomes tentative facts the first message can use. A name and company the user states later go through `resolve_identity` with the same gate, and a confident match can be researched with Context.dev Answers.

## Observability

`/inspect` (the Agent log) shows each turn's trigger, prompt, model steps, tool calls, timings, tokens and context budget; memory saves, merges, corrections, forgets and compactions; wake-up decisions; and scheduled check-ins. `bun run trace:export` writes a session's trace as one HTML page.
