# Handoff for Claude Code

Last updated: 2026-09-27. This is a continuation brief for the **private** `idanmann10/persona-onboarding` repository, not a release claim.

## What Idan wants

Build Persona as a ChatGPT-like chat with a Call button for a browser voice conversation. Text and voice share durable user state, a small knowledge graph, provenance labels, corrections, and recovery from interruptions. The agent should understand the user's present need and use psychology to be helpful without a rigid onboarding script or engagement traps. Gmail and Calendar are optional paths when useful. After a *confident* identity match, Persona may automatically research relevant public professional context through Context.dev; an uncertain match must not trigger enrichment. Idan asked to design scenarios and evals before release, to start in a new private GitHub repo, and to make it public only at the end with his approval.

The [architecture review](superpowers/specs/2026-09-27-persona-architecture-review.md) is the product contract. It was written before implementation, so its proposal language is historical. The [roadmap](roadmap.md) and [implementation status](implementation-status.md) show the current build.

## Git state and review

- Repository: `https://github.com/idanmann10/persona-onboarding` (**private**).
- Branch: `feat/foundation`, currently pushed at `39131b0` before this handoff commit.
- Draft PR: `https://github.com/idanmann10/persona-onboarding/pull/1` against `main`. Continue the draft; do not merge or publish as a release yet.
- Local worktree used by Codex: `/Users/idanmann/Projects/persona-onboarding/.worktrees/foundation`. A different machine can clone the repo and check out `feat/foundation` with a GitHub account that has access.
- Earlier Claude session shared by Idan: `https://claude.ai/code/session_01XfABv38Vu99PgjNSbFhAcn`. This handoff and the repo are sufficient to continue even if that session is unavailable.

## Implemented

- Next.js 16 / React 19 / TypeScript / Bun / Postgres foundation and responsive chat UI.
- Guest-session cookie; persisted streaming text turns; retry deduplication; failed-send draft recovery.
- Browser WebRTC GPT-Live session plumbing, captions and transcript fragments, hangup/drop states, shared text/voice context, and a Postgres lease to prevent overlapping calls. **No live GPT-Live call has been validated.**
- Append-only events and evidence-labelled graph facts with provenance, correction, and supersession.
- Versioned need-led prompt (`understand-user/v2`).
- Guarded Context.dev People Enrichment candidate matching followed by narrow Answers research on professional role/company context. Public results remain tentative. **No live Context.dev calls have been validated.**
- Optional Composio Gmail/Calendar OAuth connection UI and callback checks; bounded read-only agent tools; disconnect and conversation deletion with provider revocation requested first. **No live OAuth/provider account test has been validated.**
- Per-session quotas, 48 synthetic scenario seeds, boundary and Postgres integration tests, an unscored prompt trace runner, and CI workflow.

The exact behavior and remaining gaps are in [implementation status](implementation-status.md). Do not infer release readiness from code or a fluent model trace.

## Verification at handoff

On the pushed code before this documentation update, Codex ran `bun run db:migrate`, `bun run test` (62 passing), `bun run typecheck`, and `bun run build` locally. Desktop and 390px mobile UI were inspected. Re-run after code changes. GitHub Actions never started its job because GitHub reported an account payment/spending-limit problem; this is an infrastructure blocker, not a test result. Idan owns that GitHub setting.

```sh
bun install --frozen-lockfile
cp .env.example .env.local
# Set DATABASE_URL for a local Postgres database.
bun run db:migrate
bun run test
bun run typecheck
bun run build
```

For live text and voice, configure `OPENAI_API_KEY` and `OPENAI_TEXT_MODEL` in the ignored `.env.local` or the host's secret manager. Voice needs GPT-Live access. Context.dev needs `CONTEXT_DEV_API_KEY`. Composio needs `COMPOSIO_API_KEY` plus `COMPOSIO_CALENDAR_AUTH_CONFIG_ID` and `COMPOSIO_GMAIL_AUTH_CONFIG_ID` for the two optional integrations. Set `APP_BASE_URL` to the exact running origin. The integration suite can use `TEST_DATABASE_ADMIN_URL` to target a disposable Postgres server. Idan said he can configure provider credentials and a test Google account; **do not ask him to paste secrets into chat**. See `.env.example` and `README.md`.

The prompt-only trace runner is `bun run eval:text --id entry_intent_01` or `bun run eval:text --all --repeats 3`. It writes ignored, **unscored** traces to `evals/results/`. It does not test app state, tools, voice, OAuth, or completed actions. Follow [the eval rubric](../evals/rubric.md) for release evaluation.

## Next work, in order

1. Review the architecture contract and code; fix any concrete correctness or privacy gaps found. Preserve the need-led, non-compulsive interaction model and hard server gates.
2. With provider credentials configured outside Git, run live OpenAI text and GPT-Live calls, Context.dev candidate/Answers tests, and Composio Calendar/Gmail OAuth with a dedicated evaluator Google account. Inspect identity false matches, scope boundaries, callback account collisions, source quality, mobile microphone permissions, and hangup/reconnect behavior.
3. Build app-level scenario replay with provider fixtures and scoring. Cover all 48 seeds, permutations, cross-channel interruptions, corrections, wrong-account cases, failed provider actions, and voice listening. Record model/prompt/fixture versions, reviewer, latency, and cost. No hard invariant failures before release.
4. Implement the single approved recurring task from the roadmap with durable scheduling, preview, explicit approval, Run now, disable, and proof of execution. Add account write capabilities only after a separate preview/confirmation path.
5. Add hosted preview infrastructure, stronger sign-in, edge-level abuse limits, retention/deletion policy, observability, and privacy/legal review for automatic public-person research. Resolve GitHub Actions billing and verify CI. Keep the repository private until Idan approves publication.

Do not silently treat an API response, transcript fragment, or tool call request as a completed action. Preserve source labels and user corrections across text and voice. Work in small reviewable commits, update `docs/implementation-status.md` and the draft PR description when behavior changes, and report tested versus untested behavior plainly.
