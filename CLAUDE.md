# Persona: start here

Read [the handoff](docs/CLAUDE-HANDOFF.md), then the [architecture review](docs/superpowers/specs/2026-09-27-persona-architecture-review.md), [implementation status](docs/implementation-status.md), and [eval rubric](evals/rubric.md). The handoff records the current branch, verification, release gaps, and next work.

This is a **private** repository. Keep it private until Idan explicitly approves publication. Work on the existing `feat/foundation` branch and draft PR #1, or branch from it if a separate review is useful. Do not put provider credentials in Git, PR text, or chat.

The product follows the user's need rather than a fixed onboarding sequence. The model can choose a conversational next step; server code enforces identity confidence, permissions, durable state, and proof of actions. Public person research requires a confident identity match. Gmail and Calendar access must be optional, scoped, and relevant to the current request. Any account write or recurring task requires a preview and explicit approval.
