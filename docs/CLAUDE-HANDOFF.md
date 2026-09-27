# Handoff for Claude Code

Last updated: 2026-09-27 (Claude Code session on Windows, after the Codex foundation). This is a continuation brief for the **private** `idanmann10/persona-onboarding` repository, not a release claim.

## Exact goal

> Build Persona's adaptive chat and browser voice onboarding in a new private GitHub repository, including confident Context.dev user research, need-led Gmail/Calendar paths, durable state and knowledge graph, and pre-release evaluations; keep the repository private until Idan approves making it public.

Claude Code took this over on 2026-09-27 at Idan's request and continued draft PR #1. The repository and draft PR already exist; there is no need to create another repository.

## What Idan wants

Build Persona as a ChatGPT-like chat with a Call button for a browser voice conversation. Text and voice share durable user state, a small knowledge graph, provenance labels, corrections, and recovery from interruptions. The agent should understand the user's present need and use psychology to be helpful without a rigid onboarding script or engagement traps. Gmail and Calendar are optional paths when useful. After a *confident* identity match, Persona may automatically research relevant public professional context through Context.dev; an uncertain match must not trigger enrichment. Idan asked to design scenarios and evals before release, to start in a new private GitHub repo, and to make it public only at the end with his approval.

The [architecture review](superpowers/specs/2026-09-27-persona-architecture-review.md) is the product contract. It was written before implementation, so its proposal language is historical. The [roadmap](roadmap.md) and [implementation status](implementation-status.md) show the current build.

## Architecture in one view

```text
Browser chat UI ───────────────► Next.js session/chat API ──────► Postgres
       │                               │                            │
       └── WebRTC audio ──► GPT-Live   └── backend agent           ├─ sessions
                    │                  │                            ├─ append-only events
                    └── voice events ──┘                            ├─ graph facts + evidence
                                       │                            ├─ connection attempts
                                       ├─ identity gate ─► Context.dev
                                       ├─ relevant read ─► Composio Gmail/Calendar
                                       └─ policy boundary ─► future approved actions
```

The browser and backend share one session. Postgres is the durable source for message events, call lifecycle, identity clues, graph facts, connection state, and action evidence. The graph is a small, task-relevant projection with source labels; it is not a separate graph database. A model may choose the next conversational move, while server code owns identity promotion, authorization, account binding, idempotency, and whether an action truly completed. Full architecture, product decisions, scenario matrix, and proposed release thresholds are in [the architecture review](superpowers/specs/2026-09-27-persona-architecture-review.md).

### Repository skeleton

| Path | Responsibility |
| --- | --- |
| `app/page.tsx`, `app/thread.tsx`, `app/globals.css` | Persona-styled thread: bubbles, call/offer/connect cards, live call bar, popup OAuth, follow-up requests. |
| `app/api/chat`, `lib/agent/*`, `lib/http/chat.ts` | Streaming text turn, prompt `understand-user/v3`, server-checked tools (`actions.ts`), shared turn builder (`turn.ts`), model runtime. |
| `app/api/agent/follow-up`, `lib/agent/follow-up.ts`, `lib/http/follow-up.ts` | One assistant turn after a call ends or an account connects, derived from server state, exactly once, may stay silent. |
| `app/api/voice/*`, `lib/voice/*`, `lib/http/voice*.ts`, `lib/http/call-offer.ts` | GPT-Live session config and greeting, browser call client, transcript batches, voice tool calls, end reasons, call lease, call-offer decline. |
| `lib/domain/*` | Event, knowledge, permission, capability, and projected-state contracts. |
| `lib/db/schema.sql`, `lib/db/store.ts` | Postgres schema and durable event/graph/connection persistence. |
| `lib/research/*` | Direct identity claim parsing, Context.dev candidate gate, narrow sourced Answers research. |
| `lib/integrations/*`, `app/api/connections/*` | Composio OAuth, bounded Gmail/Calendar reads, connection and deletion lifecycle. |
| `evals/cases/*.json`, `evals/app/*`, `evals/run-app.ts`, `evals/rubric.md` | 48 seed cases plus 12 brief scenarios, app-level replay with fixtures and automatic invariants, prompt-only runner, scoring rules. |
| `tests/*`, `.github/workflows/ci.yml` | Unit/integration tests and CI. |
| `docs/*` | Architecture, implementation status, roadmap, and this handoff. |

### Key state and permission rules

- Store `user_said`, `tool_observed`, `assistant_inferred`, and `user_confirmed` separately. Mark facts tentative, confirmed, declined, or superseded and preserve correction history. An inferred preference never grants tool permission.
- A name or phone number alone does not prove identity. The implemented research trigger requires a direct first-person full name plus company claim and a corroborated high-confidence candidate. If uncertain, stop enrichment. Research is limited to relevant public professional context, with URLs and tentative labels.
- Browser calls require the user's gesture and microphone permission. A model suggestion does not start a call. Voice/text share context, but a dropped call does not imply that speech or an action completed.
- Gmail and Calendar are optional and currently read-only. A connected account is scoped to the owning session and toolkit. Never expose a send or write operation without a separate preview and explicit confirmation contract.
- A tool result and durable event are needed before Persona says it created a draft, event, connection, or automation. Duplicate requests, tabs, callbacks, and scheduler attempts must not produce duplicate actions.

### Cross-channel cases to preserve

| Scenario | Expected behavior |
| --- | --- |
| Text → user taps Call → hangs up mid-sentence | Save transcript fragments and call end; resume in text without inventing the unfinished answer. |
| Agent offers Call → user says yes → user answers | Obtain a separate browser click/microphone permission; continue the same conversation and finish the task. |
| User types during a call | Add the text to the same ordered history; deliver as voice context at a safe turn or visibly queue it. |
| Network drop or reload | Keep state and open work; offer retry in text; never reopen the microphone automatically. |
| Identity collision or correction | Leave identity unresolved or invalidate stale public facts; do not keep researching the wrong person. |
| Wrong Google account/callback | Reject the mismatch without binding it to the session. |
| Natural goodbye | Close the call and persist state without manufacturing a needless follow-up. |

The 48-case corpus and its permutations cover these and more. The spec's release thresholds are proposals; verify against actual provider traces and human voice listening before treating them as met.

## Git state and review

- Repository: `https://github.com/idanmann10/persona-onboarding` (**private**).
- Branch: `feat/foundation`; draft PR: `https://github.com/idanmann10/persona-onboarding/pull/1` against `main`. Continue the draft; do not merge or publish as a release yet.
- Commits after the Codex foundation (2026-09-27), in order:
  1. The Composio payload fix.
  2. The event model (call end reasons, connections, decisions, timeline, progress).
  3. Prompt v3 with the server-checked tools.
  4. The GPT-Live contract, voice tools and hang-up follow-ups.
  5. The Persona UI.
  6. `note_decline`.
  7. The app-level replay harness.
  8. A documentation update.
  9. Per-network limits.
  10. One approved recurring task.
  11. This documentation update.
- Local clone used by Claude: `C:\Users\idan mann\Desktop\persona-onboarding` (Windows). Codex's Mac worktree was `/Users/idanmann/Projects/persona-onboarding/.worktrees/foundation`.

## Implemented

See [implementation status](implementation-status.md) for the full list. In short:
- **Brief-led assistant.** It has a greeting and prompt `understand-user/v3`, and pursues the brief's four items with server-checked tools (`remember`, `note_decline`, `offer_call`, `show_connection`) plus the bounded Gmail/Calendar reads.
- **GPT-Live browser calls, built to the published docs:**
  - a greeting so the assistant speaks first;
  - bounded seeded history;
  - `gpt-6-luna` delegation with the same tools and gates as text;
  - quiet-line and duration limits;
  - batched transcripts;
  - typing into the call;
  - recorded end reasons.
- **Human follow-ups** after hang-ups, drops and connections, derived from server state, exactly once, and allowed to stay silent. Follow-ups still owed are replayed on return.
- **Popup OAuth** that survives a live call. Composio Gmail payloads are parsed in the shape the API really returns.
- **App-level scenario replay** with fixtures and automatic hard invariants.
- **One approved recurring task.** A preview card is created by `propose_automation`. Approve records the browser's time zone. Each occurrence runs once (unique run row plus `SKIP LOCKED` claim), and every run leaves proof: an `automation` message and a `ran` event. Run now and Turn off are in the UI; the cron entry point needs `CRON_SECRET`.
- **Per-network limits** on sessions, chat, calls, voice tools and follow-ups, keyed by salted address hashes.

**Decisions made in this session, and why:**
- **Onboarding opportunities.** The architecture review's "interpret *try* contextually" is encoded as a progress block from durable state, not a script. The model sees what is known or declined and is told never to re-ask it.
- **Browser voice path.** Calls use GPT-Live Responses delegation driven by the browser, not a sideband. It fits Vercel (no long-lived server), and `/api/voice/tool` re-validates everything the browser forwards. A sideband is the upgrade path if calls must be observed independently of the tab.
- **Follow-ups.** They run on request from the page (after a call ends or an account connects, and for any still owed at load), not on a server clock. That fits the browser-only MVP's "no closed-tab ring" rule. The trigger is built from server state, so the client cannot inject text.
- **Voice utterances.** They are a derived view of the fragments (grouped by speaker run, with backchannels folded away); fragments stay the evidence.
- **Voice data-channel permissions.** `session.client.data_channel` permissions are not sent yet: the field is documented but unverified live, and a wrong field would break every call.

## Verification at handoff

On Windows with an embedded PostgreSQL 18.4, at this branch's head:
- `bun run db:migrate`
- `bun run test`: 31 files, 134 tests. These include 24 Postgres integration tests and the replay harness tests run against a scripted model.
- `bun run typecheck` (ignore stale `.next/types` from a running dev server)
- `bun run build`

A browser check at desktop width and at 375px used `scripts/seed-demo.ts`. GitHub Actions still does not start because of the account billing/spending limit.

```sh
bun install --frozen-lockfile
cp .env.example .env.local
# Set DATABASE_URL for a local Postgres database.
bun run db:migrate
bun run test
bun run typecheck
bun run build
```

**No provider call has been exercised yet** (no keys in this workspace). Needed next, configured outside Git:
- **Text:** `OPENAI_API_KEY` with `OPENAI_TEXT_MODEL=gpt-6-luna`.
- **Voice:** the same key with GPT-Live access. `OPENAI_VOICE`, `OPENAI_VOICE_BACKEND_MODEL` and `OPENAI_VOICE_DELEGATION` are optional.
- **Gmail and Calendar:** `COMPOSIO_API_KEY` plus `COMPOSIO_GMAIL_AUTH_CONFIG_ID` / `COMPOSIO_CALENDAR_AUTH_CONFIG_ID`, created as managed auth in a Composio project separate from Arlo's.
- **Research:** `CONTEXT_DEV_API_KEY` (optional).
- `APP_BASE_URL` set to the exact origin.

Idan said he can configure credentials and a test Google account; **do not ask him to paste secrets into chat**.

## Next work, in order

1. **With keys configured, run a live pass.**
   - `bun run eval:app --all --repeats 3`, then review traces against the rubric; hard invariants must be zero.
   - A real browser call:
     - check that the greeting plays and the session payload is accepted (delegation tools, `reasoning.effort`);
     - have Persona save your name on the call and put the Gmail button on screen;
     - try typing mid-call and staying quiet until the goodbye;
     - hang up mid-sentence and read the follow-up;
     - drop the network;
     - close the tab and reopen.
   - Composio OAuth with an evaluator account: popup and redirect fallback, a wrong account, missing scopes, and the real Gmail payload against the parser.
2. **Fix what the live pass finds.** Most likely areas: GPT-Live event shapes (nested `response.event` types, transcript fields), prompt wording for tool timing, and mobile popup/microphone behaviour.
3. **Hosted preview.** Vercel plus hosted Postgres (for example, Neon through the Vercel integration). Set `APP_BASE_URL` and the Composio callback URL to the preview origin, and set `CRON_SECRET` with a Vercel Cron on `/api/automations/run-due`; sub-daily crons need a paid plan, otherwise due tasks run when the page opens. This gives the trial's "link to try".
4. **Recurring task, live:** with keys, approve a task, use Run now, and check the scheduled run and the cron route on the host.
5. **Remaining release gates:** sign-in, retention/deletion policy, observability, privacy/legal review for automatic person research, GitHub Actions billing, and CI verification. Keep the repository private until Idan approves publication.

Do not silently treat an API response, transcript fragment, or tool call request as a completed action. Preserve source labels and user corrections across text and voice. Work in small reviewable commits, update `docs/implementation-status.md` and the draft PR description when behavior changes, and report tested versus untested behavior plainly.
