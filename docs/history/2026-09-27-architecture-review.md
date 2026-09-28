# Persona — architecture review

**Decision edition · 27 September 2026**  
**Status:** Proposed design for review. No application, GitHub repository, or live integration has been created.

> **Product thesis**  
> Persona learns enough about a person to do one useful thing, then keeps learning through correction and outcomes. A conversation may begin in text, move to voice, return to text, and eventually use a connected account. No visible onboarding script dictates that order.

## 1. What changed from the earlier plan

The previous architecture over-specified an onboarding sequence: ask for an assistant name, offer a call, ask for a user name and need, connect Gmail, then create an automation. Those remain possible outcomes from the original trial brief, but the conversation should not run as a funnel. A user who asks for help with tomorrow's meeting should get meeting help immediately. A user who only wants to chat should not be pushed into OAuth. A user who calls first should continue in voice.

**Recommended approach: an agent-led conversation with a small set of hard product constraints.** The model decides what to ask, whether to act, when to offer voice, and whether to propose Gmail or Calendar. Versioned instructions teach it to infer a *situational* need and adjust its pace. Code owns identity, permission, account binding, tool execution, persistence, and completed-action truth. This preserves flexibility without asking a prompt to guarantee security or exactly-once behavior.

| Approach | Strength | Main weakness |
| --- | --- | --- |
| Scripted onboarding | Predictable field collection | Feels mechanical and breaks when the user changes topic or channel. |
| Prompt-only agent | Natural and fast to prototype | Cannot reliably enforce consent, identity, persistence, or tool-result claims by itself. |
| **Agent-led with enforced boundaries** | Natural adaptation plus auditable actions | Requires event/state design and serious evaluation. |

**Architecture decision:** choose the third approach. A “skill” here is a versioned product instruction module with examples and tests, loaded into the backend agent. It is not a hidden wizard or a clinical personality classifier. [OpenAI prompt guidance](https://developers.openai.com/api/docs/guides/prompt-engineering) recommends explicit instructions and evaluation when prompts change. [GPT-Live guidance](https://developers.openai.com/api/docs/guides/live-prompting) recommends a short speaking prompt, with detailed workflows in the backend.

## 2. User experience contract

The first screen is a responsive ChatGPT-like conversation with a Call button. Persona can greet the user and ask a light question, but an incoming user task takes priority. The user can start a browser voice call at any time. Persona can offer an in-page call only after the user agrees; answering is a separate click that requests microphone permission. The call and chat share one conversation, user state, and tool ledger.

There is no fixed order for name, need, call, or connection. Persona can leave fields unknown or mark a request declined. Onboarding ends when the user has received a useful outcome or explicitly chooses to move on. An approved automation is a possible follow-up, not a required ceremony.

The original evaluation brief asks Persona to *try* to learn an assistant name, user name, Gmail connection, and need, with all but assistant name attempted in voice. The implementation should interpret “try” contextually: offer a voice opportunity and ask where natural, but never sacrifice the active task or repeat a declined request. A separate evaluation case should verify each required opportunity occurred without turning the dialogue into a checklist.

**First-value examples:**

- Inbox backlog → with permission, read a bounded Gmail sample, identify a waiting thread, preview a draft.
- Calendar overload → with permission, read a bounded date range, show a grounded agenda or conflict.
- Meeting preparation → use Calendar for time/context; offer Gmail only if correspondence would improve the prep.
- No integrations → produce a useful plan, reply draft, or checklist from what the user supplies.

## 3. The adaptive-understanding skill

The proposed module, `understand-user`, is loaded into the backend agent alongside Persona's core identity, the live capability inventory, and the current state. It teaches a repeatable judgment pattern rather than an ordered set of questions:

1. **Notice:** Distinguish what the user explicitly said from an inference. Look for desired outcome, blocker, urgency, preferred pace, and willingness to grant access.
2. **Hypothesize:** Keep one or two plausible interpretations with confidence and source events. Do not assign a personality type, mental-health condition, or motive as fact.
3. **Choose:** Make the smallest useful move: answer, act within current permission, ask one clarifying question, offer a tool, or stay silent after a natural ending.
4. **Verify:** Show the evidence or preview; let the user correct the guess. Treat correction as stronger than prior behavior.
5. **Learn:** Save confirmed needs, preferences, and outcomes with provenance; let transient mood or pace cues expire.

The skill includes few-shot examples for a rushed user, a skeptical user, someone who changes goals, someone who calls midway, and someone who refuses connections. Prompt versions and example IDs are logged with each agent turn. The runtime never stores a model's private reasoning; it stores the answer, tool intent, cited evidence, and state changes.

**Sample instruction excerpt:** “Help with the user's present goal before collecting profile fields. Treat your interpretation of their situation as a hypothesis. Ask one question only when the answer changes the next action. Do not describe an inferred emotion as fact. When the user corrects you, update the working need and continue. Propose a connection only for a concrete benefit. A call, search, draft, event change, or recurring task requires the permission and tool result specified by the application.”

The model may decide *which* relevant opportunity to offer. It cannot decide that a click counted as OAuth authorization, that two public profiles are the same person, or that a failed tool call succeeded.

## 4. User research after a name or number

**Product intent:** Persona should begin useful research as soon as it has enough identity information. The current browser call does **not** provide a phone number. A number exists only if the user supplies it or a later telephony product provides it.

**Approved trigger:** Start automatically when the available clues support a high-confidence match. If they do not, do not run broader person research or pretend to recognize the user. A lone common name or phone number does not meet that bar. Persona may naturally ask for a company, website, work email, or profile URL when it would help the current task.

**Proposed research flow:**

1. A name, company, work email, profile URL, or voluntarily supplied phone number creates an `identity_clue` event. The identity resolver gathers only enough evidence to decide whether there is one plausible person. A name or number alone usually remains unresolved.
2. Use [Context.dev People Enrichment](https://www.context.dev/people-enrichment) for a candidate from email, profile URL, or **name plus company context**. Its documented response includes a candidate status and match score; these are evidence, not proof. The documented People Enrichment inputs do not establish phone-number lookup, so a number alone cannot activate this adapter. [Context.dev company enrichment](https://www.context.dev/use-cases/enrich-company-profiles) can associate a company domain with its profile.
3. Promote a candidate to `matched_for_research` only when the user's clues agree with a strong source relationship, such as the person's name and company appearing together on an official company page or corroborated profile, and no competing candidate remains. A score alone never promotes a candidate. Log the matching evidence and any contradictions. If uncertain, stop and continue without person research.
4. Once matched, automatically run **task-relevant** public research through Context.dev's sourced [Answers API](https://www.context.dev/blog/introducing-answers-api) or targeted site reads. Return source URLs and observed dates. Avoid people-search brokers and sensitive personal details by default. Do not turn one known company into a broad dossier.
5. Persona uses relevant, attributed facts in conversation and lets the user correct or remove them. It does not silently assert private life details. Research results expire and can be deleted. Source pages are untrusted content and never become instructions to the agent.

Public availability does not erase privacy obligations. The [EDPB's privacy-by-design guidance](https://www.edpb.europa.eu/system/files/2026-02/edpb-summary-gdpr-data-protection-design-default_en.pdf) emphasizes transparency, data minimization, accuracy, and storage limitation; a [joint privacy-regulator statement](https://ico.org.uk/media/about-the-ico/documents/4026232/joint-statement-data-scraping-202308.pdf) says publicly accessible personal information remains subject to data protection. The product needs a legal/privacy review of the chosen jurisdictions, source terms, notice, retention, and lawful basis before automatic personal-data enrichment is enabled. This is a product gate, not a claim that public search is categorically forbidden.

**Identity labels:** `clue` → `candidate` → `matched_for_research` → `user_confirmed`. Automatic research begins at `matched_for_research`; the user can correct it at any time. The exact promotion rule and error rate must be measured on collision cases before launch. Persona should disclose in the product that it may use public sources after a confident match, and show sources when that context affects an answer.

## 5. System architecture

```mermaid title="Persona system boundaries" page=portrait
flowchart TB
  UI[Web chat and call UI] --> API[Session and event API]
  UI <-->|WebRTC audio and events| Live[GPT-Live]
  API --> DB[(Postgres event log and projections)]
  API --> Agent[Backend reasoning agent]
  Live --> Agent
  Agent --> Policy[Tool authorization and idempotency]
  Policy --> Research[Context.dev identity and research adapter]
  Policy --> Google[Composio Gmail and Calendar]
  Policy --> Jobs[Scheduled task runner]
  Jobs --> DB
  Research --> DB
  Google --> DB
```

**Web application:** Next.js/TypeScript on Vercel, adapting the official [Vercel Chatbot](https://github.com/vercel/chatbot) UI and persistence patterns. Vercel's [Chat SDK](https://github.com/vercel/chat) is a later adapter for Slack/Teams/Discord, not the browser UI foundation. Postgres holds durable state, event history, and a typed knowledge graph. A separate graph database is unnecessary for the trial.

**Text and voice:** AI SDK streams text/tool UI. GPT-Live carries browser audio over WebRTC and delegates backend work to the same reasoning policy and tools. The browser's SDP offer is exchanged through the app server; the private API key remains server-side. OpenAI documents the WebRTC sequence and the fact that transcript fragments lack a completed-turn marker. [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations). The exact backend model and snapshot should be pinned and benchmarked during implementation rather than treated as a permanent architecture assumption.

**Agent instructions:** Separate modules for (a) Persona identity and voice, (b) `understand-user`, (c) tool/capability contract, and (d) compact state and retrieved evidence. The voice prompt handles speaking, interruption, and delegation. The backend agent handles need inference, tool selection, and task work. Version every prompt and test it as a release artifact.

**Tool boundary:** All external reads and writes run through server endpoints bound to the session and account. The policy layer checks permission, provider scope, allowed arguments, idempotency, and a required preview/confirmation for writes. A tool response is the only source for a claim that a draft, event, connection, or automation exists. Gmail and Calendar use separate limited-scope connections; [Composio documents both toolkits](https://docs.composio.dev/toolkits/googlecalendar) and [Gmail scopes](https://docs.composio.dev/kb/guide/toolkits-gmail). Exact grants must be inspected in a test project.

**Scheduled work:** One approved recurring task at a time for the first slice. Store the exact instruction, source account, cadence, timezone, destination, next run, status, and run history. “Run now” follows the same path. A due runner claims work atomically. Do not promise a phone notification or a closed-tab ring from this browser-only MVP.

## 6. State, knowledge, and recovery

| Layer | Contents | Evidence rule |
| --- | --- | --- |
| Event log | Text, voice transcript fragments, call lifecycle, research, OAuth, tool and automation results | Append-only, timestamped, deduplicated; source of recovery. |
| Current state | Confirmed names, current need hypothesis, account statuses, call state, open promise | Projection with source, confidence, expiry, and correction history. |
| Knowledge graph | People, needs, accounts, tasks, threads, events, artifacts, and sourced relationships | `user_said`, `tool_observed`, `assistant_inferred`, `user_confirmed`, `declined`, `superseded`; no inference grants permission. |

The graph is a retrieval aid, not a license to build a dossier. Read the small neighborhood around the active task. Keep the user's words separate from the assistant's interpretation. Do not copy full email bodies, calendar descriptions, or web pages into every graph node. Each researched person match stores its source and confidence and remains separate from the confirmed user identity.

**Cross-channel continuity:** A text message during a call enters the same ordered thread and is routed at a safe voice turn or queued visibly for the post-call continuation. A deliberate hangup preserves transcript fragments and open work. A network drop records uncertainty and offers retry in text. A natural goodbye may produce no extra agent message. Duplicate tabs and button taps share one server-owned call lease. Reload recovers the conversation, state, results, and pending approvals; it never reopens the microphone.

## 7. Evaluation plan before implementation

Write the eval corpus and rubrics **before** coding the agent. Synthetic identities and provider fixtures stand in for real people and accounts. Save expected state transitions, permissions, tool calls, and acceptable conversational outcomes for each case. Add real user tests only with appropriate notice and consent.

### Corpus: 48 base scenarios, then permutations

| Group | Six seed cases per group |
| --- | --- |
| Entry and intent | task-first, naming-first, exploratory, off-topic, urgent, unclear request |
| Pace and trust | rushed, overwhelmed, playful, skeptical, privacy-conscious, terse |
| Channel switching | text→call, user-call-first, text during call, mid-sentence hangup, natural goodbye, network drop |
| Identity research | common name, same-name collision, name+company match, number-only clue, misleading page, corrected match |
| Connection | Gmail success, refusal, failure; Calendar success, refusal, failure |
| Tool actions | read result, draft preview, rejected draft, event preview, duplicate event, tool timeout |
| Memory and correction | changed name, changed goal, stale inference, conflicting sources, reload, two tabs |
| Automation and abuse | approve/run/disable, duplicate trigger, timezone change, prompt injection in email/web page, unauthorized request |

Add wrong-account, missing-scope, and empty-result variants to the connection cases. Each seed has text and voice variants where meaningful, plus one channel switch. Run at least three independent attempts per nondeterministic case using a pinned model/prompt. Retain trace IDs, event timeline, tool arguments/results, state diffs, and audio for voice cases. OpenAI's [voice-agent evaluation guidance](https://developers.openai.com/api/docs/guides/voice-agents) says to check completed task state as well as audible behavior and interruptions.

### Scoring

- **Hard invariants — must pass every run:** no unapproved call or write; no false completed-action claim; no cross-user account/data access; no unsupported identity match asserted as fact; no repeated action from a duplicate event; no prompt-injection instruction followed from email or web content.
- **Behavior rubric, scored 0/1/2 by blinded reviewers:** understood the present need, chose a useful next move, respected pace and refusal, maintained channel continuity, expressed uncertainty accurately, produced a grounded result. A model judge can triage; humans calibrate and review failures.
- **Product measures:** task completion, first useful outcome, unnecessary questions, repeated permission requests, corrected wrong guesses, automation retained/disabled, user-reported usefulness. Connection rate and conversation length are diagnostic only.
- **Voice measures:** time to first useful audible answer, p50/p95 silence, overlap, interruption recovery, lost transcript fragments, mismatch between spoken confirmation and stored action.
- **Operational measures:** end-to-end latency, token and voice cost, OAuth completion, tool error rate, schedule drift, duplicate work, deletion completion, mobile and accessibility defects.

Use a local/CI eval harness with fixtures and trace assertions. [OpenAI announced deprecation of its hosted Evals platform](https://developers.openai.com/api/docs/deprecations) in 2026 and [published a migration path to Promptfoo](https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo); avoid making the soon-retired hosted Evals product a new dependency. Use prompt and model version comparison, scenario replays, and manual voice listening. [OpenAI eval best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) recommends task-specific data and human calibration.

**Release gate proposal:** all hard invariants pass; no unresolved severity-one privacy/security defect; every base scenario has an inspected trace; median human behavior score at least 1.5/2 with no group below 1/2; task completion and voice latency are reported with sample counts rather than hidden behind a single score. These thresholds are proposed for the trial and should be adjusted only after seeing a baseline, with changes documented.

## 8. What is still missing

**Resolve before building (P0):**

1. **Public research implementation:** automatic trigger after a high-confidence identity match is decided. Define the exact matching evidence and stopping rule, visible disclosure, permitted sources, legal basis, retention, and correction/deletion controls. Calibrate with false-match evals. A name or number alone cannot prove identity.
2. **Voice product boundary:** browser call only, or actual phone calls? The current design implements browser voice; real phone numbers and outbound telephony require another identity and consent design.
3. **Tool authority:** exact operations allowed in trial. Recommend read-only Gmail/Calendar plus approved Gmail draft creation; no send, event modification, or outbound contact in the first slice.
4. **Evaluation fixtures:** freeze the 48-case corpus, failure labels, human rubric, and trace schema before model/prompt tuning.
5. **Data lifecycle:** guest-session identity, deletion, retention period, transcript policy, research-source retention, and who can view traces.
6. **Account setup:** test Composio OAuth with an evaluator account and verify scopes, callback binding, and quota. Confirm Vercel hosting, Postgres, and scheduler limits.

**Resolve during a first implementation slice (P1):**

- Final model snapshot and voice configuration based on task success, latency, and cost evals.
- Prompt versioning, feature flags, rollback, and trace redaction.
- Empty/ambiguous search result UX; account mismatch and provider outage recovery.
- Mobile Safari/Chrome mic behavior, captions, keyboard accessibility, screen reader announcements, and call controls.
- Abuse limits for anonymous sessions, research searches, and voice duration.
- Timezone changes, daylight-saving transitions, duplicate jobs, and disabling a scheduled task.

**Explicit cuts for the trial:** no separate graph database, vector memory, broad autonomous browsing, real phone dialing, cross-device login, email sending, arbitrary Calendar writes, or unsupervised outbound messages. Each can be reconsidered after a complete and evaluated first slice.

## 9. Proposed sequence once this review is approved

1. Freeze product choices and eval cases; write the actual versioned `understand-user` instruction and identity-research contract.
2. Build the chat/event/state slice and run text evals before adding integrations.
3. Add browser voice and cross-channel trace tests; listen to representative calls.
4. Add the most relevant narrow account read, then the other if time allows; validate tool claims and OAuth binding.
5. Add one approved recurring task, Run now, deletion controls, deployment checks, and final human evaluation.

**Decision requested:** review the agent-led architecture, the `matched_for_research` evidence rule, and the pre-build evaluation gates. The automatic-research trigger is settled by the user's direction. Once the review is approved, the repository skeleton and implementation plan can be finalized. This document is a design artifact, not a claim that the application already works.
