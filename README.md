# Persona onboarding

**Try it:** https://persona-onboarding-five.vercel.app

Open **Agent log** in the header (it opens in a new tab) and keep it next to the chat. It shows every turn live: what triggered it, each model step and tool call with its timing, tokens, the reply, and the exact system prompt the model was given.

## What it does

One assistant, one conversation, in text and voice. It learns the brief's four things (a name for itself, what to call you, what you need, and your Gmail) without feeling like a form. You can skip ahead at any time ("just let me in").

- **Name, then a call.** It opens by asking for a name, the one item settled in text, then offers a short call for the rest. Tap Answer and it's a browser call (GPT-Live-1). Say no and it stays in text for good.
- **Tasks come first.** Ask for something and it helps right away. Then it comes back for the next missing item, at most twice. After that it offers to "finish setup in 30 seconds or skip it for now", and then it stops asking.
- **Hang-ups and drops.**
  - Hang up mid-sentence and it texts you where you left off ("you were saying the investor updates…").
  - If the line drops, it offers to call back.
  - Say goodbye and it stays quiet.
- **Real Gmail.** Connecting Gmail runs through Composio's managed OAuth, works with any Google account, and is read-only. It comes back with something real from your inbox, plus a one-tap recurring rundown (for example, every weekday at 8) that actually runs.
- **Make it yours.** Rename it, change its look, or change its personality or call voice, just by asking. Looks are painted portraits: describe any look and it paints one.
- **Apps.** Connect any app Composio offers from the Apps sheet. Gmail and Calendar are the two it reads today.
- **Sign in with Google first.** One tap, and Google shares only your name, email and photo (Gmail stays a separate, optional connection). One Google account is one conversation, on any browser.

## Try to break it

| Try this | What should happen |
| --- | --- |
| Answer the greeting with "Max." | It takes the name and puts an Answer button up for a short call |
| Answer the call, start a sentence, hang up | A text picks up where you left off |
| Say "no calls" | It stays in text and doesn't offer again |
| Say "I'd rather not say" when it asks your name | It moves on and never re-asks |
| Say "just let me in" | Setup ends; no more setup questions |
| Connect Gmail | Something real from your inbox, then a recurring-task preview |
| Ask it to become "a fox in a hoodie" | It paints a new avatar |
| Tap Start over | A fresh session, with any connected accounts disconnected |

## What's real, and what isn't

- **Real:**
  - GPT-Live-1 browser calls, with `gpt-6-luna` handling the tools.
  - Gmail and Calendar reads with your own Google account.
  - Recurring tasks that run.
  - Per-network rate limits.
  - The agent log.
- **Not included:**
  - **A phone number.** It's a browser call, which the brief allows.
  - **Sending email or changing calendars.** Accounts are read-only by design.
  - **Acting in apps other than Gmail and Calendar.** They connect, and the assistant says it can't act in them yet.

## How it works

```
browser chat + GPT-Live call ──► Next.js API (Vercel) ──► Postgres (append-only session events)
                                     │
                                     ├─ projectSession(): what's known, what's open, the one next setup item
                                     ├─ prompt understand-user/v4 (onboarding is one section of the assistant)
                                     ├─ gpt-6-luna turns; tools chosen by the model, gated by the server
                                     ├─ Composio: Gmail/Calendar reads, any app's OAuth
                                     └─ agent log: every turn's steps, tools, timing and tokens
```

- **One memory for everything.** Text, voice and follow-ups share one event log. That's how a hang-up follow-up can say what you were in the middle of.
- **The server tracks the goal.** It knows which setup items are still open and which one comes next. Each tool result tells the model the next step. If a few messages pass without progress, the assistant asks once, then offers to finish or skip, then stops.
- **The model proposes, the server decides.** A name you never said can't be saved as yours. A declined call can't be offered again. A Gmail read only happens for an email request. An account link only completes in the browser that consented.

## Numbers

| What | Result |
| --- | --- |
| 17 live scenarios from the brief (`bun run eval:app`, gpt-6-luna) | 17/17 with no hard-rule failures; 64/66 expectations |
| 16 simulated first-time users (`bun run eval:sim`: Claude plays each person, Jev judges) | Stayed 15/16. Goal met 13/16 (11 finished setup, 2 skipped ahead). Activated 11/16. Judge: form-like 0.36, pushy 0.23, human 3.9/5 |
| Same simulation before the "come back for the next item" steering | Goal met 6/16, stayed 12/16, activated 9/16 |
| Automated tests | 313 (unit, UI, eval harness, Postgres integration) |

GitHub Actions doesn't run on this account, so CI runs locally with `bun run ci:local --post-status`. It runs the same jobs and posts each result to the pull request as a `local-ci/*` status.

## Decisions, cuts, and what's next

- **Browser call, not a phone number.** The brief allows it, and there's nothing to set up. Next: a real number over Telnyx. Arlo already runs GPT-Live over Telnyx in production.
- **One assistant, not a wizard.** Onboarding is a section of the assistant's prompt, plus a setup status the server works out. The model picks the words; the server decides what's allowed.
- **Activation is the first recurring task.** In Arlo's data, users who set up a scheduled task on day one stayed 66.7% of the time, against 17.1% for those who didn't. Connecting an account alone didn't move retention. So the flow goes from a real Gmail result straight to a one-tap recurring rundown.
- **Read-only accounts.** Next: drafting replies, with an approval card before anything is sent.
- **Cut:**
  - Acting in apps other than Gmail and Calendar. They connect, but the assistant can't use them yet.
  - Painting a new look during a call.
  - Scheduling from a call.
  - Per-person inbox fixtures in the simulation. Every simulated user reads the same inbox.

## Run locally

Requires Bun 1.3, Node 22.6 or newer, and PostgreSQL. Create a local database named `persona_dev` and copy `.env.example` to `.env.local`.

```sh
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

Open `http://localhost:3000`. Set `APP_BASE_URL` to the exact app origin; it's used for OAuth callbacks and deletion requests.

Provider keys go in the ignored `.env.local` or the host's secret manager, never in Git:
- **Sign-in:** a Google OAuth web client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with the redirect URI `$APP_BASE_URL/api/auth/google/callback`. For local end-to-end tests without Google, `E2E_TEST_LOGIN=on` enables `/api/auth/test-login` under `bun run dev` on localhost only.
- **Text:** `OPENAI_API_KEY` and `OPENAI_TEXT_MODEL` (`gpt-6-luna`).
- **Browser calls:** a key with GPT-Live access.
- **Gmail and Calendar:** Composio needs `COMPOSIO_API_KEY` plus one managed-auth config ID per toolkit.
- **Public research:** Context.dev needs `CONTEXT_DEV_API_KEY`.

Without an OpenAI key the UI still loads: Persona's greeting shows, unsent text stays as a draft, and pressing Call shows the server's error instead of connecting.

To inspect the timeline cards without keys, sign in once, then run `bun scripts/seed-demo.ts`. It seeds the newest local session with a named assistant, a call offer, a call that ended mid-sentence, the follow-up text, and a Connect Gmail card, and it refuses non-local databases.

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

```sh
bun run eval:sim --all --concurrency 4   # 16 simulated first-time users, scored and judged
bun run eval:show                         # read the latest scenario run as transcripts
bun run prompt:show                       # print the exact prompts the app builds
bun run ci:local --post-status            # the CI jobs, run locally, reported to the PR
```
