# Implementation status

This is the build status for the private preview branch. The architecture review remains the product contract; its original “proposed design” heading records the pre-build decision point.

## Implemented and verified locally

- Responsive chat shell, guest session cookie, persistent text turns, retry deduplication, and reload recovery.
- Browser WebRTC call client, server SDP exchange, call lifecycle, transcript fragments, and text continuation context. The provider call itself has not been exercised without a project key.
- Versioned need-led instruction and graph facts with provenance, source URL, and correction history.
- Context.dev candidate lookup after a direct first-person name plus company claim. A confident match triggers a narrow Answers request for professional role and company context with source URLs. The adapter keeps the result tentative and clears prior research when identity changes. Neither provider call has been exercised with a live key yet.
- Optional Gmail and Calendar Composio connection flow. The callback checks the stored attempt, owning session, connected account ID, auth config, toolkit, and active status. Agent tools expose at most ten primary-calendar event summaries in a 30-day window or five Gmail message summaries for a relevant current request. No send or calendar write tool is exposed.
- Disconnect and delete-conversation controls. Provider account deletion with upstream revocation is requested before local state removal. SQL cascades messages, graph facts, and connection records.
- 48 synthetic scenario seeds, hard-boundary tests, a prompt-only trace runner, Postgres integration tests, and CI configuration.

## Unverified or incomplete

- Live OpenAI text and GPT-Live behavior, including mobile microphone handling, because no project key is configured here.
- Context.dev and Composio live contracts, OAuth scopes, and callback behavior with evaluator accounts, because keys and auth configs are not configured here.
- Live sourced Answers quality, source-to-field checking, and a retention policy for researched facts.
- Full scenario replay with provider fixtures, human scoring, voice listening, and wrong-account collision evals. The prompt-only runner is unscored and cannot establish release readiness.
- Durable approved automation, hosted Postgres, deployment preview, account-level sign-in, abuse limits, retention policy, observability, and privacy/legal review for automatic personal research.

The repository remains private. The draft PR is for architecture and code review, not a release approval.
