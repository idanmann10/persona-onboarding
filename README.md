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
