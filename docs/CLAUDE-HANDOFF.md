# Handoff for Claude Code

Last updated: 2026-09-28, 07:45 UTC, by the Claude Code session on Idan's Windows machine. This brief describes the **private** `idanmann10/persona-onboarding` repository as it runs in production. Read it before changing anything.

## Where things stand

- **Live:** https://persona-onboarding-five.vercel.app.
  - The agent log is at `/inspect`. It shows only the viewer's own session, read from the cookie.
- **`main` is what is deployed.** Every `feat/*` branch is merged into it, so nothing lives anywhere else. Work on `main`, or on a short branch that you merge into it.
- **Deploys are manual.** The Vercel project has no Git integration, so a push does not deploy. From a checkout that is linked to Vercel, run `npx -y vercel@latest deploy --prod --yes`. The installed Vercel CLI 41 is too old.
- **The deadline is Monday 2026-09-28, 8pm ET.** Submit through the form at https://forms.gle/SqJBoKGY7y8TEMkH6. It asks for:
  - the email Idan applied with;
  - a link to try;
  - a link to the code;
  - the time taken;
  - decisions, cuts and next steps.
- **The reviewer is Zach Yadegari.** He cannot open this private repo until Idan either invites him or approves publishing it. Idan decides which; never publish on your own.
- **Production health** (snapshot 2026-09-28 07:30 UTC):
  - 16 sessions: 10 conversations, and 6 visitors who left after the greeting.
  - 31 replies, none failed, no stalls. Median 2.3 s, p95 5.0 s, first token 1.8 s.
  - 36 tool calls, none failed.
  - 1 recurring-task run, which succeeded.
- **Local CI on `main`:** typecheck, 317 tests in 53 files, and the build all pass.
- **Phone view of every conversation:** Idan's private page at https://claude.ai/artifact/3VvHgg87C9syu58ob7LoVk.
  - It shows each conversation with the agent's full trace under every message, plus a failure summary at the top.
  - To refresh it, run `bun run trace:export <out.html>` against production, then republish to that URL with the Artifact tool, passing it as `url`.

## The brief

Persona's CTO trial asks for an onboarding that collects four things:
- a name for the agent;
- what to call the user;
- a connected Gmail;
- something the user needs.

The brief's other requirements:
- Attempt a call for everything except the agent name, and adapt to text when the user won't talk.
- Withstand hang-ups.
- Never feel like a form.
- Let the user graduate early.

Idan's standing direction:
- **Stay on the goal.** A session ends with the four items known, or with the user choosing to skip ahead.
- **Brand:** use yourpersona.com's look, which is Apple-clean. Ink `#1d1d1f`, muted `#6e6e73`, surface `#f5f5f7`, hairline `#d2d2d7`, iMessage blue `#0a84ff`, SF/Inter type, and the Persona mark. He hates gradient orbs.
- **Looks and personality:**
  - Avatars are painted portraits, like Meta's Muse.
  - The default personality is fun, not formal.
  - The greeting is short.
- **No settings or setup screens.** The agent customizes itself through tools. The Apps sheet is the one pop-up, used to connect accounts.
- **Evals only when they help.** Ask Idan before running them. Three specific live tests beat 24 random ones.

## How it works now

```text
Browser chat (app/page.tsx, app/thread.tsx) ──► /api/chat (lib/http/chat.ts) ──► lib/agent/turn.ts ──► gpt-6-luna
       │                                            │                               │
       └── WebRTC ──► GPT-Live-1 ──► /api/voice/tool └── Postgres: append-only events, facts, traces
```

- **Setup as server state.**
  - `setupStatus` in `lib/domain/onboarding.ts` derives what is still open from the events:
    - `assistant_name`;
    - the `call`, which comes right after the name while anything else is open;
    - `preferred_name`, `need` and `gmail`.
  - Its `stage` is `active`, `complete` or `graduated`.
  - `repliesSinceSetupMoved` counts ignored asks. The prompt reacts in three steps:
    1. one casual ask;
    2. an explicit finish-or-skip choice;
    3. silence.
- **Prompt `understand-user/v4`** lives in `lib/agent/prompts.ts`. `bun run prompt:show` prints it. It has three layers:
  - the persona;
  - the goal and the first win;
  - a progress block with a single "Next up".
- **Tools.** The model chooses when to call them and the server gates each one, in `lib/agent/actions.ts`, `account-tools.ts` and `turn.ts`:
  - `remember`, `customize`, `note_decline` and `graduate` (offered only while setup is active);
  - `offer_call`, which puts up an Answer card;
  - `show_connection`, which puts up a Gmail or Calendar card;
  - `propose_automation`, which proposes one recurring task. The user must Approve it.
  - `search_gmail` and `read_calendar_window` are read-only, and offered only when the request needs them;
  - `resolve_identity` is available only with `CONTEXT_DEV_API_KEY`, which is not set.
- **Model runtime** (`lib/agent/runtime.ts`):
  - up to 6 steps per turn, with no tools on the last step;
  - a 45 s step timeout with one retry;
  - the turn stops once a card tool has run and the reply is written.
- **Voice.** Calls run over GPT-Live-1 WebRTC in the browser (`lib/voice`, `app/api/voice`), with `gpt-6-luna` delegation. `/api/voice/tool` re-checks every voice tool call.
  - Hang-ups get one follow-up built from server state. It may choose to stay silent.
- **Sign-in and apps.**
  - Connecting Gmail signs the user in. `GMAIL_GET_PROFILE` gives a verified address, and `persona_users` maps it to one main session. The header shows Sign in, or the email and Sign out.
  - Sign-in from another browser is behind `PERSONA_CROSS_BROWSER_SIGN_IN=on`.
  - Each OAuth callback carries a one-time key, stored only as a hash.
  - The Apps sheet connects any Composio toolkit, but the agent acts only in Gmail and Calendar.
- **Persona customization** (`lib/domain/persona.ts`):
  - a name;
  - a look: one of 6 painted defaults in `public/avatars`, or a portrait painted on request with `chatgpt-image-latest`;
  - a personality: Fun (the default), Direct, Playful or Polished;
  - a call voice.
- **Observability** (`lib/observability`):
  - The `persona_traces` table records every turn, step, tool input and result, call and voice tool, with timings.
  - `/inspect` shows a single session.
  - `bun run trace:export` writes all sessions, or one, as a single phone-friendly page.

### State and permission rules to keep

- Keep provenance on every fact:
  - Provenance is `user_said`, `tool_observed`, `assistant_inferred` or `user_confirmed`.
  - Evidence is `tentative`, `confirmed`, `declined` or `superseded`.
  - An inferred preference never grants a tool permission.
- A name or phone number alone does not prove identity. Research needs a confident match.
- A model suggestion never starts a call. The user taps Answer and grants the microphone.
- Gmail and Calendar are optional, read-only, and scoped to the owning session.
- Never claim an action happened without both its tool result and its event. Duplicate tabs, callbacks and cron runs must not duplicate an action.

## Verified live, and not yet

**Verified in production (2026-09-27, in Idan's Chrome, with traces):**
- `customize`: name, a default look, a painted portrait (7.9 s), personality and voice;
- `offer_call` and `note_decline`;
- `remember` for the user's name and need;
- `show_connection`, followed by "Not now" and then "You're all set up";
- `propose_automation`, then Approve, then Run now, which posted a real recurring-task message;
- `graduate`.

**Not yet exercised:**
- `search_gmail` and `read_calendar_window` on a real inbox;
- a real GPT-Live call with audio, including a mid-sentence hang-up;
- signing in from a second browser;
- `resolve_identity`.

The first three need Idan's Google login or microphone; `resolve_identity` needs a Context.dev key.

## Next work, in order

1. **Test 3, with Idan:** a voice call that he hangs up mid-sentence. Check:
   - the end reason;
   - the saved transcript;
   - the follow-up text.
2. **Test 4, with Idan:** the account path. Check that:
   - he connects Gmail and a real inbox answer appears (first value);
   - a recurring task can be proposed and approved;
   - he can sign in from an Incognito window;
   - Sign out works.

   Idan types his own Google credentials. Never create accounts or type passwords for him.
3. **After each test,** run `bun run trace:export` against production and republish the phone page. Fix what it shows, and add a unit or integration test for every fix.
4. **Help Idan submit the form.** The README is written for the evaluator: how to try it, how to try to break it, what's real, the numbers and the decisions.

## Open questions for Idan

- **Zach's access:** invite him to the private repo, or publish it.
- **Context.dev:** whether to add `CONTEXT_DEV_API_KEY` for people lookup. It is optional.
- **GitHub Actions:** it won't start until the account's billing limit is fixed, so CI runs locally for now.
- **Looks named after a name:** calling the assistant after a default look (Nova, Sunny, Sage, Pixel, Fox, Bloom) also switches it to that look. In the live run, "Nova" became the Nova robot. The model chose it, and `customize` allows self-chosen looks. Should it?
- **Portrait size:** painted portraits are stored at 1024 px, about 0.9 MB, and shown at 36 px. They are cached for a year, but a thumbnail made at save time would load faster the first time.
- **Figma:** the design pass was deferred.

## Commands

```sh
bun install --frozen-lockfile
bun run typecheck
TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5433/postgres bun run ci:local   # install, typecheck, test, build
bun run prompt:show                     # the exact system prompt
bun run eval:app -- --all               # the 24 live brief scenarios (needs OPENAI and COMPOSIO keys); ask Idan first
bun run eval:sim                        # 16 Claude-played users judged by TypeSafe Jev (needs ANTHROPIC and TYPESAFE keys); ask Idan first
bun run trace:export <out.html>         # every production session with full traces (needs DATABASE_URL)
bun run trace:export <session-id> <out.html>
bun run funnel                          # the onboarding funnel over recent sessions
```

`ci:local` needs a disposable Postgres server. On this machine that is the embedded one on port 5433. Create databases as UTF-8, because the Windows default encoding breaks on emoji. If a test run reports "the database system is in recovery mode", restart that server.

**Latest eval numbers (2026-09-27):**
- 17 live scenarios: no hard-rule failures, 64 of 66 expectations met.
- 16 simulated users: 15 stayed, 13 reached the goal, 11 activated.
- The judge scored form-likeness 0.36 and humanness 3.9 out of 5.

## Infrastructure (no secrets)

- **Vercel:** project `persona-onboarding`, team `idanmann10s-projects`.
- **Production environment variables** (names only):
  - `OPENAI_API_KEY`
  - `OPENAI_TEXT_MODEL=gpt-6-luna`
  - `OPENAI_REASONING_EFFORT=low`
  - `COMPOSIO_API_KEY`
  - `COMPOSIO_GMAIL_AUTH_CONFIG_ID`
  - `COMPOSIO_CALENDAR_AUTH_CONFIG_ID`
  - `TYPESAFE_API_KEY`
  - `DATABASE_URL`
  - `APP_BASE_URL`
  - `CRON_SECRET`
  - `IP_HASH_SALT`
  - `ADMIN_SECRET`
  - `PERSONA_CROSS_BROWSER_SIGN_IN=on`
- **Postgres:** Railway project `persona-onboarding`, service `Postgres`, reached through its public TCP proxy.
  - Build the URL from `railway variables --service Postgres --json`.
  - Pass it to commands in memory only. Never write production secrets to disk, into Git, or into chat.
  - `bun run db:migrate` applies `lib/db/schema.sql`. Every statement in it is idempotent.
- **Commits:** use `git -c user.name=idanmann10 -c user.email=idanmann10@gmail.com commit …`.

Keep the repository private until Idan approves publication. Report what was tested and what wasn't, plainly.
