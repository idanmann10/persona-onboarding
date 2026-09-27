# Persona Foundation and Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a persistent, need-led text conversation with a runnable synthetic eval corpus before adding voice or external accounts.

**Architecture:** A slim Next.js app uses AI SDK streaming. A guest session cookie owns an append-only event stream; a pure projection derives current user state and task-relevant graph facts. The backend agent receives versioned instructions and compact sourced state, while server code enforces permissions. Tests exercise the projection and authorization before UI implementation.

**Tech Stack:** Next.js 16, React 19, TypeScript, AI SDK 7, OpenAI provider, Postgres, Vitest, Playwright for browser checks.

---

## File map

- `app/page.tsx`: conversation screen and Call control shell.
- `app/api/chat/route.ts`: authenticated text-stream entry point.
- `app/api/session/route.ts`: guest session and stored conversation snapshot.
- `lib/agent/prompts.ts`: versioned Persona core and `understand-user` module.
- `lib/domain/events.ts`: validated event types.
- `lib/domain/project.ts`: pure projection from events to current state.
- `lib/domain/knowledge.ts`: sourced fact/edge selection.
- `lib/domain/permissions.ts`: action authorization.
- `lib/db/schema.sql`: durable event and projection tables.
- `lib/db/store.ts`: Postgres event persistence and idempotent append.
- `evals/cases/base.json`: 48 synthetic input traces with expected invariants.
- `evals/cases/schema.ts`: fixture validation.
- `tests/domain/*.test.ts`: state, graph, and authorization behavior.

## Task 1: Establish the app and toolchain

**Files:** `package.json`, `tsconfig.json`, `next.config.ts`, `app/layout.tsx`, `app/globals.css`, `vitest.config.ts`.

- [ ] Create a minimal Next.js TypeScript package with pinned major versions, `dev`, `build`, `typecheck`, and `test` scripts. Install only Next, React, AI SDK, OpenAI provider, Postgres client, Zod, Vitest, and required type packages. Do not copy the Vercel Chatbot template's artifact editor or broad dependencies.
- [ ] Run `pnpm install` and `pnpm typecheck`. Expected: exit 0.
- [ ] Add a smoke test for the app's main page using Playwright only after the page exists. Expected: heading, composer, and Call control are visible at mobile and desktop widths.
- [ ] Commit with `chore: bootstrap slim Persona app`.

## Task 2: Define the 48-case eval corpus first

**Files:** `evals/cases/base.json`, `evals/cases/schema.ts`, `tests/evals/corpus.test.ts`.

- [ ] Write `base.json` with eight groups of six cases: entry/intent, pace/trust, channel switch, identity, connection, tool action, correction/memory, and automation/abuse. Every case has `id`, `group`, `turns`, `expected`, and `critical` fields. Cases are synthetic; never include real private inbox contents.
- [ ] Write a failing Vitest check for exactly 48 unique IDs, six per group, and nonempty expected outcomes. Run `pnpm test tests/evals/corpus.test.ts`; expected failure because the schema validator is absent.
- [ ] Implement `parseCorpus` in `schema.ts` using Zod. It rejects duplicate IDs, unknown groups, and empty expectations. Re-run the focused test; expected pass.
- [ ] Commit with `test: define Persona scenario corpus`.

## Task 3: Pure event and current-state contract

**Files:** `lib/domain/events.ts`, `lib/domain/project.ts`, `tests/domain/project.test.ts`.

- [ ] Write failing tests for: a direct task before naming; a corrected name superseding an earlier name; a declined call not reopening automatically; partial voice transcript surviving hangup; duplicate event ID ignored. Run the focused test and verify it fails for missing projection behavior.
- [ ] Implement typed events and `projectSession(events)` with `confirmed`, `tentative`, `declined`, and `superseded` evidence states. The projection stores the user's words separately from model interpretation. Re-run focused tests; expected pass.
- [ ] Add a property-style test that replaying the same event list produces the same projection. Run full tests; expected pass.
- [ ] Commit with `feat: project user state from events`.

## Task 4: Knowledge and permission contract

**Files:** `lib/domain/knowledge.ts`, `lib/domain/permissions.ts`, `tests/domain/knowledge.test.ts`, `tests/domain/permissions.test.ts`.

- [ ] Write failing tests that an inferred identity cannot become `matched_for_research` without corroboration, a source URL is retained for a researched fact, a superseded need is excluded from active recall, and an unconfirmed Gmail write is denied.
- [ ] Implement `selectRelevantFacts` and `authorizeAction` as pure functions. A model inference never grants permission. A completed-action claim requires a successful matching tool result. Re-run focused tests; expected pass.
- [ ] Commit with `feat: enforce evidence and action permissions`.

## Task 5: Durable guest session and text chat

**Files:** `lib/db/schema.sql`, `lib/db/store.ts`, `lib/agent/prompts.ts`, `app/api/session/route.ts`, `app/api/chat/route.ts`, `app/page.tsx`, `tests/integration/session.test.ts`.

- [ ] Write a failing integration test for an opaque HttpOnly session cookie, event append idempotency, and reload returning the same conversation. Use a disposable local Postgres or PGlite database; the test must exercise actual SQL rather than a mock-only store.
- [ ] Add SQL tables for sessions, events, user state, graph facts, and unique idempotency keys. Implement append/read methods and the guest cookie. Run the integration test; expected pass.
- [ ] Write a failing agent-contract test asserting the prompt contains the current task, source-labeled state, capability inventory, and prompt version, without demanding the next onboarding field. Implement the prompt builder and re-run the test; expected pass.
- [ ] Implement `/api/chat` with AI SDK streaming and a persisted user message. On stream completion, persist the assistant response and tool events. Add a test using a deterministic fake model response; expected pass.
- [ ] Implement the responsive chat UI with a Call button that is visibly marked as a later slice. Verify local typing, streaming, reload, keyboard submit, and mobile layout in Playwright.
- [ ] Commit with `feat: deliver persistent Persona text chat`.

## Completion check for this plan

- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm build` exit 0.
- [ ] All 48 fixtures parse and at least the text-relevant cases execute through the agent harness.
- [ ] A direct task, correction, refusal, reload, and duplicate event each have inspected traces.
- [ ] No required production secret is committed. Document any missing provider credential before starting voice or external-account slices.
