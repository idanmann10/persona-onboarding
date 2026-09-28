# Persona: start here

Persona's CTO-trial onboarding: an adaptive chat with browser voice calls. It collects a name for the assistant, what to call the user, a connected Gmail and something they need, or it lets them skip ahead. It is live at https://persona-onboarding-five.vercel.app and the brief is due Monday 2026-09-28 at 8pm ET.

Read [the handoff](docs/CLAUDE-HANDOFF.md) first. It covers the current state, what is verified live and what isn't, the next work in order, open questions for Idan, commands and infrastructure. The [architecture review](docs/superpowers/specs/2026-09-27-persona-architecture-review.md) is the original product contract. [The eval rubric](evals/rubric.md) explains the scoring.

- **Branch and deploys.** `main` is what is deployed, and every feature branch is merged into it. Deploys are manual through the Vercel CLI; a push does not deploy.
- **Privacy and credentials.** This is a **private** repository: keep it private until Idan explicitly approves publication. Do not put provider credentials in Git, PR text or chat. Idan types his own Google logins.
- **Evals.** Ask Idan before running them. Prefer a few specific live tests with traces.

The product follows the user's need rather than a fixed script. The model chooses the next conversational step; server code enforces the rules:
- identity confidence;
- permissions;
- durable state;
- proof that an action really happened.

Gmail and Calendar access must be optional, scoped and relevant to the current request. Any account write or recurring task needs a preview and explicit approval.
