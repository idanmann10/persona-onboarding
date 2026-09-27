# Persona onboarding

Private development repository for Persona's adaptive chat and browser voice onboarding.

The [architecture review](docs/superpowers/specs/2026-09-27-persona-architecture-review.md) is the current product contract. Persona follows the user's goal rather than a fixed onboarding sequence. Its prompt may choose what to ask or do; server code owns permissions, identity, durable state, and proof of completed actions.

## Build order

1. Freeze the eval corpus and state/tool contracts.
2. Build a durable text conversation and need-led agent.
3. Add browser WebRTC calls with cross-channel recovery.
4. Add confident Context.dev identity research.
5. Add bounded Gmail and Calendar reads, then an approved recurring task.
6. Run scenario, voice, security, accessibility, and deployment evaluations.

The repository stays private until the owner approves publication. No production credentials belong in Git.

See [implementation status](docs/implementation-status.md) for verified behavior and release gaps.
For another coding agent taking over, start with [the Claude handoff](docs/CLAUDE-HANDOFF.md); Claude Code will also read the root `CLAUDE.md`.

## Run locally

Requires Bun 1.3, Node 22.6 or newer, and PostgreSQL. Create a local database named `persona_dev`, copy `.env.example` to `.env.local`, and set a project `OPENAI_API_KEY` plus `OPENAI_TEXT_MODEL` for live text and browser voice. The key needs GPT-Live access for calls.

```sh
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

Open `http://localhost:3000`. Set `APP_BASE_URL` to the exact app origin for OAuth callbacks and deletion requests. Optional Context.dev and Composio keys are listed in `.env.example`; each Composio toolkit needs its own auth config ID. Without an OpenAI key, the UI shows the chat shell and keeps unsent text as a draft; the Call button stays disabled. `bun run test`, `bun run typecheck`, and `bun run build` are the verification commands. The integration suite uses a disposable Postgres database and accepts `TEST_DATABASE_ADMIN_URL` to target a test server.

Run an unscored prompt trace with `bun run eval:text --id entry_intent_01`, or `--all --repeats 3` for the full corpus. See [the eval rubric](evals/rubric.md). The runner needs an OpenAI key and does not exercise voice, OAuth, or completed actions.

The current branch implements text persistence, browser WebRTC plumbing, guarded Context.dev candidate lookup, and optional Composio Gmail/Calendar connection and bounded reads. Account automation, hosted deployment, and live provider checks remain on the [roadmap](docs/roadmap.md).
