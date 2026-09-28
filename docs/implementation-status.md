# Implementation status

> **Historical.** This page records the foundation as it stood on the morning of 2026-09-27, before the build went live. For the current state, read [the handoff](CLAUDE-HANDOFF.md). It covers production, prompt v4, sign-in, avatars, verified tools and next work.

Build status for the private preview branch (`feat/foundation`, draft PR #1). The [architecture review](superpowers/specs/2026-09-27-persona-architecture-review.md) remains the product contract; its "proposed design" heading records the pre-build decision point. Last updated 2026-09-27.

## What the product does now

- **Opening.** Persona opens every new conversation with a versioned greeting that invites a name for itself (the one item the trial brief settles in text) and says a task can come first.
- **Prompt `understand-user/v3`.** It keeps the need-led, task-first contract and adds Persona's texting style. Along the way it pursues the brief's four items contextually: a name for the assistant, the user's name, what they want help with, and Gmail. It makes one well-timed call offer and lets the user graduate early. A progress block built from durable state stops the model re-asking anything said or declined.
- **Tools.** The model decides when to call them; server code decides whether each is allowed.
  - `remember` saves assistant_name, preferred_name or current_need. Values are `user_said` and `confirmed` only when they appear in the user's own words (typed or spoken); a user name the user never said is rejected; declines are recorded.
  - `note_decline` records a typed or spoken "no" to a call, Gmail or Calendar.
  - `offer_call` puts an Answer button in the chat. The call still needs a tap and microphone permission, and the tool refuses after a decline unless the user brings calling up again.
  - `show_connection` puts an inline Connect Gmail/Calendar card in the chat, with the same decline rule.
  - The bounded read-only Gmail and Calendar reads are exposed only for an account request in the last two user messages, or a short "yes" to the assistant's own offer.
- **Browser voice (GPT-Live).** Checked against the published docs, not a live call:
  - **Setup:** the server exchanges the SDP offer with the project key. After `session.started` the client sends a greeting instruction so the assistant speaks first.
  - **Seeded history:** a developer context message plus recent turns, capped under the documented 8,192-token / 128-message limits.
  - **Tools:** Responses delegation to `gpt-6-luna` with remember / note_decline / show_connection / search_gmail / read_calendar_window. The browser forwards each function call to `/api/voice/tool`, which runs the same actions and gates as text.
  - **Quiet line:** check-in, goodbye and `inactive` close; wrap-up near a 12-minute cap; timers pause during Google sign-in.
  - **Transcripts and typing:** fragments are batched and flushed before tool calls; text typed during a call is saved and sent into the call.
  - **End reasons:** every way a call ends is recorded (hang-up, remote hang-up, drop, closed page via keepalive, quiet line, time limit, setup failure). The server infers `lost` when a lease expires without a report.
- **Human follow-ups.** After a call ends or an account connects, `/api/agent/follow-up` runs one assistant turn from server state only: the end reason, the duration, and possibly cut-off last words. It may text ("looks like we got cut off, you were saying...") or stay silent after a natural goodbye. Each trigger runs exactly once and is released for retry if the model fails. The session snapshot lists follow-ups still owed, so closing the tab mid-call still gets a reply on return.
- **Gmail and Calendar.** Composio managed OAuth runs in a popup, so a live call survives. The callback notifies the opener and closes, or falls back to a redirect, and records connected / failed for the assistant to react to. Composio's real Gmail shape (`sender`, `preview`, `messageId`, nested wrappers) is parsed.
- **Timeline and UI.** One timeline in Persona's visual language:
  - text bubbles;
  - call cards with duration, how the call ended, and the transcript;
  - incoming-call cards and Connect cards (a card created mid-turn sits after that turn's reply);
  - connection notices;
  - a live call bar with captions.
  Checked at desktop width and at 375px.
- **Recurring task (one per session).**
  - `propose_automation` previews a daily / weekday / weekly task at a local time. Only Approve schedules it, recording the browser's time zone.
  - Runs use the same turn builder and gates as chat, with the task's accounts opened read-only. The result posts as a message tagged `automation`, with a `ran` event as proof.
  - A unique run row per occurrence makes it execute once. Due work is claimed with `FOR UPDATE SKIP LOCKED`, the next run advances with daylight-saving changes handled, and failures never claim work.
  - The UI has Run now and Turn off. The page runs whatever is due for its session on load; a hosting cron can call `/api/automations/run-due` with `CRON_SECRET`.
- **Per-network limits.** New sessions, chat turns, call starts, voice tool calls and follow-ups count against a per-client window keyed by a salted hash of the address, so churning cookies cannot mint unlimited billed calls. Raw IPs are never stored.
- **Carried over from the previous slice.** Guarded Context.dev identity research; disconnect and conversation deletion (provider revocation first); per-session quotas; the 48 seed cases and the prompt-only trace runner.

## Verified locally (Windows, 2026-09-27)

Commands run against a real Postgres 18 (embedded) at the head of this branch:
- `bun run db:migrate`
- `bun run test`: 32 files, 148 tests passing. These include 27 Postgres integration tests covering:
  - follow-ups running once, silence, and retry after a failed run;
  - lost calls, voice tool gates, typing during a call, and declines;
  - per-network limits;
  - approving a recurring task in the browser's time zone, with one active per session;
  - a due run executing once across two racing requests, run now, disable, the failure path, and the cron secret.
- `bun run typecheck`
- `bun run build`

An independent read-only review of every change on the branch (server; call client and UI) found no cross-session access. It confirmed the GPT-Live session payload against the docs, and raised 25 correctness issues, all fixed with tests: stuck follow-up reservations, relevance context, a transcript fold that could drop a user's "yeah", spoofable per-network keys, callback revisits, lost-call dating, empty automation runs, ended-call events, close() races, typed-text limits, and others (see the two `fix:` commits).

App-level replay (`bun run eval:app`, see [the eval rubric](../evals/rubric.md)) is built and its harness is tested with a scripted model. Those tests confirm the gates, follow-ups, fixture reads, and that each hard invariant catches its failure class.

A browser check without provider keys used `scripts/seed-demo.ts` for timeline cards. It covered the greeting, graceful 503 handling that keeps the draft, the call card and transcript, the follow-up bubble, the Connect card and its "Not now", the menu, and the 375px layout.

GitHub Actions still does not start (account billing / spending limit); that is Idan's setting.

## Needs provider credentials (not yet exercised)

- **OpenAI text:** live `gpt-6-luna` turns, including whether it calls `remember`, `note_decline`, `offer_call` and `show_connection` at the right moments. Run `bun run eval:app --all --repeats 3` and review traces.
- **GPT-Live:** a real browser call. Check the greeting, delegation tool round-trip, audio quality, interruption, the quiet-line timers, mobile microphone permissions, and each end reason. Confirm the session payload is accepted, especially `delegation.responses.tools` and `reasoning.effort`.
- **Composio:** OAuth with a dedicated evaluator Google account, the popup callback on desktop and mobile, the actual Gmail/Calendar payloads against the new parser, the scopes Composio's managed auth requests, and wrong-account and missing-scope behaviour.
- **Context.dev:** candidate and Answers calls.

## Still open

- **Hosted preview and ops:** hosted Postgres, a cron for due recurring tasks, account sign-in, retention policy, observability, and privacy/legal review for automatic public-person research. Per-network limits are in the app; add edge limits at the host if abuse appears.
- **Voice hardening:** `session.client.data_channel` permissions for the browser channel (left out until a live call can verify the field), and a sideband connection if the server must observe calls independently of the tab.
- **Evals:** human rubric scoring of live traces, voice listening, and scenario permutations.

The repository remains private. The draft PR is for review, not a release approval.
