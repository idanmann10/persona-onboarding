# Build roadmap

## Slice 1 — foundation and text

Guest session, append-only events, current-state projection, graph facts with provenance, 48 synthetic evaluation cases, versioned `understand-user` prompt, text chat, and reload recovery. Exit when task-first and correction scenarios work without provider accounts.

## Slice 2 — voice

Browser WebRTC call, persisted transcript deltas, answer/end/drop states, and contextual text continuation. Exit when cross-channel cases pass and the agent never claims speech or actions that did not complete.

## Slice 3 — research

Context.dev candidate lookup from supported identifiers, corroborated identity promotion, task-relevant sourced research, correction/deletion, and false-match evals. An uncertain candidate never triggers enrichment.

## Slice 4 — accounts and automation

Managed Gmail and Calendar connections bound to the guest session. Add bounded reads tied to a stated need, approved draft creation, and one approved recurring watch or agenda with Run now and disable. Writes require a preview and a distinct confirmation.

## Slice 5 — release gates

Deploy preview, test with evaluator accounts, run all invariants and representative voice playback, check mobile/accessibility, verify deletion and rate limits, then document actual cuts. Keep GitHub visibility private until the owner explicitly requests publication.

## Dependencies to settle during implementation

- OpenAI API project with GPT-Live access and a tested backend model.
- Separate Composio project with Gmail/Calendar OAuth settings and scopes.
- Context.dev key and confirmed People Enrichment/Answers contracts.
- Hosted Postgres and a durable scheduler compatible with the Vercel account.
