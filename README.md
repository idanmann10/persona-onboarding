# Persona onboarding

Private development repository for Persona's adaptive chat and browser voice onboarding.

The [architecture review](docs/superpowers/specs/2026-09-27-persona-architecture-review.md) is the product contract. Persona follows the user's goal rather than a fixed onboarding sequence. While it helps, it tries to learn the trial brief's four things: a name for itself, the user's name, what they need, and whether they want Gmail connected. It offers one browser call for the last three. Its prompt chooses what to ask or do; server code owns permissions, identity, durable state, and proof of completed actions.

See [implementation status](docs/implementation-status.md) for what is verified and what still needs provider credentials. For another coding agent taking over, start with [the Claude handoff](docs/CLAUDE-HANDOFF.md); Claude Code will also read the root `CLAUDE.md`.

## Run locally

Requires Bun 1.3, Node 22.6 or newer, and PostgreSQL. Create a local database named `persona_dev` and copy `.env.example` to `.env.local`.

```sh
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

Open `http://localhost:3000`. Set `APP_BASE_URL` to the exact app origin; it's used for OAuth callbacks and deletion requests.

Provider keys go in the ignored `.env.local` or the host's secret manager, never in Git:
- **Text:** `OPENAI_API_KEY` and `OPENAI_TEXT_MODEL` (`gpt-6-luna`).
- **Browser calls:** a key with GPT-Live access.
- **Gmail and Calendar:** Composio needs `COMPOSIO_API_KEY` plus one managed-auth config ID per toolkit.
- **Public research:** Context.dev needs `CONTEXT_DEV_API_KEY`.

Without an OpenAI key the UI still loads: Persona's greeting shows, unsent text stays as a draft, and the Call button reads "setup needed".

To inspect the timeline cards without keys, open the app once, then run `bun scripts/seed-demo.ts`. It seeds the newest local session with a named assistant, a call offer, a call that ended mid-sentence, the follow-up text, and a Connect Gmail card, and it refuses non-local databases.

## Verify

```sh
bun run test        # unit + Postgres integration (TEST_DATABASE_ADMIN_URL targets a disposable server)
bun run typecheck
bun run build
```

Evaluations (see [the eval rubric](evals/rubric.md)):

```sh
bun run eval:app --all --repeats 3   # app-level replay of the brief scenarios, hard invariants checked
bun run eval:app --all --base        # also replays the 48 seed cases
bun run eval:text --id entry_intent_01   # prompt-only trace, unscored
```

The repository stays private until the owner approves publication.
