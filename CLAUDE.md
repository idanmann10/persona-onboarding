# Persona: start here

Persona's adaptive chat and browser-voice onboarding. Read [README.md](README.md) for what it does and how to run it, and [docs/architecture.md](docs/architecture.md) for how it works. The repository is private until Idan approves publication.

- **Branch**: work on `submission` (or branch from it); don't push without being asked.
- **Hosting**: Railway, project `persona-onboarding`: `persona-app` (the Next.js app, `railway.json`) and `persona-cron` (`ops/railway-cron/`). Deploy with `railway up --service persona-app`. The public address stays on Vercel (`persona-onboarding-five.vercel.app`), which passes every request through to Railway (`vercel.json`); both deploy from `main` on GitHub.
- **Secrets** live in `.env.local` and Railway variables, never in Git, PR text or chat.
- **Where behaviour lives**: who the assistant is and how it talks is in `lib/agent/soul/*.md`; what it can offer is in `lib/agent/company/product.md`; onboarding goals and follow-up judgment are in `lib/agent/soul/onboarding.md`. Keep judgment in prompts and only safety limits in code.
- **Tools** are defined once in `lib/agent/tools/` and shared by chat and calls.
- **Checks**: `bun run typecheck` and `bun run build`. End-to-end tests (`bun run e2e`) and evals (`bun run eval:app`, `eval:sim`) cost time and model calls; run them only when asked.
- The model decides what to say; the server decides what's allowed. Never claim an action happened without the tool result and a durable event.
