import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDatabase } from '../lib/db/client';
import { createStore } from '../lib/db/store';
import type { CallEndReason, SessionEvent } from '../lib/domain/events';
import type { SetupItem } from '../lib/domain/onboarding';
import { AVATARS, PERSONALITIES, VOICES, isAvatarId, personalityFrom, personaSettings } from '../lib/domain/persona';
import { projectSession, type SessionProjection } from '../lib/domain/project';
import { buildAgentLog, type CallItem, type LogSummary, type StepView, type ToolView, type TurnItem } from '../lib/observability/log';

/**
 * Export conversations with their full agent traces as one self-contained HTML page that reads well on a
 * phone. It opens with a health summary (failed turns, stalls, failed tool calls, dropped calls, tools that
 * have never run), then shows each session's conversation as the user saw it. Under every message is what
 * the agent did: the exact system prompt, each model step, every tool call's full input and result, and
 * timings. Read-only.
 *
 *   bun scripts/export-trace.ts <out.html>                                    every session, newest first
 *   bun scripts/export-trace.ts <session-id> <out.html>                       one session
 *   bun scripts/export-trace.ts --latest-with "<text a user typed>" <out.html>
 *   --note "<text>"                                                           a line for the summary (repeatable)
 */
const args = process.argv.slice(2);
const notes: string[] = [];
const positional: string[] = [];
let latestWith: string | undefined;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--note') notes.push(args[++index] ?? '');
  else if (args[index] === '--latest-with') latestWith = args[++index];
  else positional.push(args[index]);
}
const out = positional.at(-1) ?? '';
if (!out.endsWith('.html')) {
  console.error('Usage: bun scripts/export-trace.ts [<session-id> | --latest-with "<text>"] [--note "<text>"] <out.html>');
  process.exit(2);
}

// Tool results that mean the tool itself broke, as opposed to a guard declining to repeat or overstep.
const FAILED = new Set(['failed', 'error', 'invalid_arguments', 'invalid', 'no_result']);
const OK = new Set(['saved', 'unchanged', 'shown', 'proposed', 'offered', 'ok', 'ran', 'confirmed', 'done']);
const ACCOUNT_TOOLS = new Set(['search_gmail', 'read_calendar_window', 'resolve_identity']);
type Tone = 'ok' | 'held' | 'failed';
/** An account read reports `unavailable` when the read threw; a card tool reports it when the feature is off. */
const toolTone = (name: string, status: string): Tone =>
  FAILED.has(status) || (status === 'unavailable' && ACCOUNT_TOOLS.has(name)) ? 'failed' : OK.has(status) ? 'ok' : 'held';

const ENDINGS: Record<CallEndReason, string> = {
  user_hangup: 'they hung up', remote_hangup: 'the assistant hung up', connection_lost: 'the connection dropped',
  inactive: 'silence timeout', max_duration: 'hit the time limit', expired: 'the session expired', content: 'stopped by the content filter',
  page_closed: 'they closed the page', lost: 'lost with no end report', setup_failed: 'the call could not start',
};
const ending = (reason?: string) => (reason && reason in ENDINGS ? ENDINGS[reason as CallEndReason] : reason) ?? 'no end report';
const TOOLKITS = { gmail: 'Gmail', calendar: 'Google Calendar' } as const;
const OPEN_LABELS: Record<SetupItem, string> = { assistant_name: 'assistant name', call: 'call', preferred_name: 'their name', need: 'need', gmail: 'Gmail' };

interface Problem { anchor: string; what: string }
interface SessionView {
  id: string;
  events: SessionEvent[];
  state: SessionProjection;
  turns: TurnItem[];
  calls: CallItem[];
  summary: LogSummary;
  userMessages: number;
  firstAt: string;
  lastAt: string;
  avatar: string;
  problems: Problem[];
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pretty = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };
const ms = (value?: number) => (value === undefined ? '–' : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const anchorId = (value: string) => value.replace(/[^A-Za-z0-9._~-]/g, '-');
/** A time the page rewrites into the reader's own time zone; UTC until the script runs. */
const time = (iso: string | undefined, style: 'time' | 'datetime' = 'time') =>
  iso ? `<time data-at="${esc(iso)}" data-style="${style}">${esc(style === 'datetime' ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : `${iso.slice(11, 19)} UTC`)}</time>` : '';
function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function main(): Promise<void> {
  const sql = getDatabase();
  try {
    const store = createStore(sql);
    let ids: string[];
    if (latestWith !== undefined) {
      const rows = await sql`SELECT session_id FROM persona_events WHERE payload->>'type' = 'message' AND payload->>'speaker' = 'user' AND payload->>'text' = ${latestWith} ORDER BY created_at DESC LIMIT 1`;
      if (!rows[0]) throw new Error('No session has a user message with that text');
      ids = [rows[0].session_id as string];
    } else if (positional.length > 1) {
      ids = [positional[0]];
    } else {
      ids = (await sql`SELECT id FROM persona_sessions ORDER BY created_at DESC`).map((row) => row.id as string);
    }

    // Portraits are embedded once each, as CSS classes, so a look used by many sessions costs its bytes once.
    const portraits = new Map<string, string>();
    async function portraitClass(avatar: string): Promise<string> {
      const key = avatar.startsWith('img:') ? avatar.slice(4) : isAvatarId(avatar) ? avatar : 'default';
      const className = `pt-${anchorId(key)}`;
      if (portraits.has(className)) return className;
      let data: string | undefined;
      try {
        const image = avatar.startsWith('img:')
          ? await store.getAvatar(key)
          : { mime: 'image/webp', bytes: new Uint8Array(await readFile(join(process.cwd(), 'public', 'avatars', `${key}.webp`))) };
        if (image) {
          // A painted portrait is stored at 1024 px (about 1 MB); the page shows it at 44 px, so embed a thumbnail.
          const thumbnail = await import('sharp').then(({ default: sharp }) => sharp(image.bytes).resize(128, 128).webp({ quality: 75 }).toBuffer()).catch(() => undefined);
          data = thumbnail ? `data:image/webp;base64,${thumbnail.toString('base64')}` : `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`;
        }
      } catch { /* no portrait: the page shows a plain circle */ }
      portraits.set(className, data ? `.${className}{background-image:url(${data})}` : '');
      return className;
    }

    const views: SessionView[] = [];
    for (const id of ids) {
      const [events, traces] = await Promise.all([store.readEvents(id), store.readTraces(id)]);
      const state = projectSession(events);
      const log = buildAgentLog(state, events, traces);
      const turns = log.items.filter((item): item is TurnItem => item.kind === 'turn');
      const calls = log.items.filter((item): item is CallItem => item.kind === 'call');
      const problems: Problem[] = [];
      const userIds = new Set(events.filter((event) => event.type === 'message' && event.speaker === 'user').map((event) => event.id));
      for (const turn of turns) {
        const anchor = anchorId(`t-${id.slice(0, 8)}-${turn.id}`);
        if (turn.status === 'error' || turn.status === 'timeout') problems.push({ anchor, what: `A turn failed: ${turn.error ?? turn.status}` });
        else if (turn.status === 'ok' && !turn.reply && userIds.has(turn.turnId)) problems.push({ anchor, what: 'A reply came back empty' });
        for (const step of turn.steps) for (const tool of step.tools) {
          if (toolTone(tool.name, tool.status) === 'failed') problems.push({ anchor, what: `${tool.name} returned “${tool.status}”` });
        }
      }
      // A message nobody answered: no assistant message before the next user message or the end.
      let waiting: string | undefined;
      for (const event of events) {
        if (event.type !== 'message') continue;
        if (event.speaker === 'user') {
          if (waiting) problems.push({ anchor: anchorId(`m-${id.slice(0, 8)}-${waiting}`), what: 'A message got no reply' });
          waiting = event.id;
        } else waiting = undefined;
      }
      if (waiting && !turns.some((turn) => turn.turnId === waiting && turn.status === 'running')) problems.push({ anchor: anchorId(`m-${id.slice(0, 8)}-${waiting}`), what: 'The last message got no reply' });
      for (const call of calls) {
        const anchor = anchorId(`c-${id.slice(0, 8)}-${call.callId}`);
        if (call.setup?.status === 'error') problems.push({ anchor, what: `A call could not start: ${call.setup.error ?? 'setup failed'}` });
        else if (call.phase === 'dropped' || call.reason === 'connection_lost' || call.reason === 'lost') problems.push({ anchor, what: `A call dropped (${ending(call.reason)})` });
        for (const tool of call.tools) if (toolTone(tool.name, tool.status) === 'failed') problems.push({ anchor, what: `${tool.name} (on a call) returned “${tool.status}”` });
      }
      for (const event of events) {
        const anchor = anchorId(`e-${id.slice(0, 8)}-${event.id}`);
        if (event.type === 'connection' && event.phase === 'failed') problems.push({ anchor, what: `${TOOLKITS[event.toolkit]} failed to connect${event.reason ? `: ${event.reason}` : ''}` });
        if (event.type === 'automation' && event.phase === 'failed') problems.push({ anchor, what: `Recurring task “${event.title}” failed to run` });
      }
      const settings = personaSettings(state);
      views.push({
        id, events, state, turns, calls, summary: log.summary, problems,
        userMessages: userIds.size,
        firstAt: events[0]?.at ?? '', lastAt: events.at(-1)?.at ?? '',
        avatar: await portraitClass(settings.avatar),
      });
    }

    // ---- Health across every exported session ----
    const allTurns = views.flatMap((view) => view.turns);
    const finished = allTurns.filter((turn) => turn.status !== 'running' && typeof turn.durationMs === 'number');
    const allTools = [
      ...allTurns.flatMap((turn) => turn.steps.flatMap((step) => step.tools)),
      ...views.flatMap((view) => view.calls.flatMap((call) => call.tools)),
    ];
    const byTool = new Map<string, Map<string, number>>();
    for (const tool of allTools) {
      const statuses = byTool.get(tool.name) ?? new Map<string, number>();
      statuses.set(tool.status, (statuses.get(tool.status) ?? 0) + 1);
      byTool.set(tool.name, statuses);
    }
    const offered = new Map<string, number>();
    for (const turn of allTurns) for (const name of turn.toolsOffered) offered.set(name, (offered.get(name) ?? 0) + 1);
    const neverCalled = [...offered].filter(([name]) => !byTool.has(name)).sort((a, b) => b[1] - a[1]);
    const failedTools = allTools.filter((tool) => toolTone(tool.name, tool.status) === 'failed').length;
    const heldTools = allTools.filter((tool) => toolTone(tool.name, tool.status) === 'held').length;
    const turnErrors = allTurns.filter((turn) => turn.status === 'error' || turn.status === 'timeout').length;
    const stalls = allTurns.reduce((sum, turn) => sum + turn.stalls, 0);
    const allEvents = views.flatMap((view) => view.events);
    const callsStarted = views.flatMap((view) => view.calls).filter((call) => call.startedAt || call.utterances.length).length;
    const callOffers = allEvents.filter((event) => event.type === 'call' && event.phase === 'offered').length;
    const callDeclines = allEvents.filter((event) => event.type === 'call' && event.phase === 'declined').length;
    const runs = allEvents.filter((event) => event.type === 'automation' && (event.phase === 'ran' || event.phase === 'failed'));
    const problems = views.flatMap((view) => view.problems.map((problem) => ({ ...problem, view })));
    const conversations = views.filter((view) => view.userMessages > 0);
    const bounced = views.filter((view) => view.userMessages === 0);
    const firstTokens = allTurns.map((turn) => turn.firstTokenMs).filter((value): value is number => typeof value === 'number');

    const stat = (label: string, value: string, detail: string, tone: 'good' | 'bad' | 'plain' = 'plain') =>
      `<div class="stat ${tone}"><span class="stat-label">${esc(label)}</span><b>${esc(value)}</b><span class="stat-detail">${esc(detail)}</span></div>`;
    const verdict = problems.length
      ? `<p class="verdict bad"><span class="dot"></span>${esc(count(problems.length, 'problem'))} to look at</p>`
      : `<p class="verdict good"><span class="dot"></span>Nothing is failing</p>`;
    const health = `
  <section class="health" aria-labelledby="health-title">
    <h2 id="health-title" class="eyebrow">Is anything failing?</h2>
    ${verdict}
    <p class="lede">${esc(`${count(finished.length, 'reply', 'replies')} across ${count(conversations.length, 'conversation')}: ${turnErrors ? count(turnErrors, 'failed turn') : 'no failed turns'}, ${stalls ? count(stalls, 'stall') + ' (retried)' : 'no stalls'}, ${failedTools ? count(failedTools, 'failed tool call') : 'no failed tool calls'}.`)}</p>
    <div class="stats">
      ${stat('Replies', String(finished.length), turnErrors ? `${turnErrors} failed` : 'none failed', turnErrors ? 'bad' : 'good')}
      ${stat('Reply time', ms(percentile(finished.map((turn) => turn.durationMs!), 50)), `median · p95 ${ms(percentile(finished.map((turn) => turn.durationMs!), 95))}`)}
      ${stat('First token', ms(percentile(firstTokens, 50)), 'median')}
      ${stat('Tool calls', String(allTools.length), failedTools ? `${failedTools} failed · ${heldTools} held back` : `none failed · ${heldTools} held back`, failedTools ? 'bad' : 'good')}
      ${stat('Calls', String(callsStarted), `${callOffers} offered · ${callDeclines} declined`)}
      ${stat('Recurring runs', String(runs.length), `${runs.filter((event) => event.type === 'automation' && event.phase === 'ran').length} ok`, runs.some((event) => event.type === 'automation' && event.phase === 'failed') ? 'bad' : 'plain')}
    </div>
    ${problems.length ? `<ul class="problems">${problems.map((problem) => `<li><a href="#${esc(problem.anchor)}">${esc(problem.what)}</a> <span class="muted">· ${esc(title(problem.view))}, ${time(problem.view.firstAt, 'datetime')}</span></li>`).join('')}</ul>` : ''}
    <h3 class="subhead">Tools in production</h3>
    <div class="scroll"><table class="tools">
      <thead><tr><th>Tool</th><th class="num">Calls</th><th>Results</th></tr></thead>
      <tbody>${[...byTool].sort((a, b) => sum(b[1]) - sum(a[1])).map(([name, statuses]) => `<tr><td><code>${esc(name)}</code></td><td class="num">${sum(statuses)}</td><td>${[...statuses].sort((a, b) => b[1] - a[1]).map(([status, n]) => `<span class="pill ${toolTone(name, status)}">${esc(status)} ${n}</span>`).join(' ')}</td></tr>`).join('')}
      ${neverCalled.map(([name, times]) => `<tr class="never"><td><code>${esc(name)}</code></td><td class="num">0</td><td class="muted">offered in ${esc(count(times, 'turn'))}, never called</td></tr>`).join('')}</tbody>
    </table></div>
    ${notes.length ? `<ul class="notes">${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
  </section>`;

    const body = conversations.map(renderSession).join('\n');
    const bouncedList = bounced.length
      ? `<section class="bounced"><h2 class="eyebrow">Left after the greeting · ${bounced.length}</h2><p class="muted">${bounced.map((view) => time(view.firstAt, 'datetime')).join(' · ')}</p></section>`
      : '';
    const generatedAt = new Date().toISOString();
    const html = `<title>Persona conversation log</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
  <style>${CSS}${[...portraits.values()].join('')}</style>
  <main>
    <header class="top">
      <svg class="mark" viewBox="0 0 23.6813 23" aria-hidden="true"><path d="${MARK}"/></svg>
      <div>
        <h1>Conversation log</h1>
        <p class="muted">Production · ${esc(count(views.length, 'session'))} · snapshot ${time(generatedAt, 'datetime')}</p>
      </div>
    </header>
    ${health}
    <h2 class="eyebrow list-title">Conversations · ${conversations.length}</h2>
    <p class="muted hint">Tap a conversation to read it. Under each message, “Trace” shows exactly what the agent did.</p>
    ${body}
    ${bouncedList}
  </main>
  <script>${SCRIPT}</script>`;
    await writeFile(out, html);
    console.log(`wrote ${out}: ${views.length} sessions, ${conversations.length} conversations, ${allTurns.length} turns, ${allTools.length} tool calls, ${problems.length} problems`);
  } finally {
    await sql.end();
  }
}

function sum(statuses: Map<string, number>): number {
  let total = 0;
  for (const n of statuses.values()) total += n;
  return total;
}

function title(view: SessionView): string {
  const { assistantName, preferredName } = view.state.onboarding;
  const assistant = assistantName.value && assistantName.status !== 'declined' ? assistantName.value : 'Unnamed assistant';
  if (preferredName.value && preferredName.status !== 'declined') return `${assistant} with ${preferredName.value}`;
  return `${assistant} · ${preferredName.status === 'declined' ? 'user kept their name' : 'user not named yet'}`;
}

function chips(view: SessionView): string {
  const { onboarding, setup } = view.state;
  const list: Array<[string, 'good' | 'bad' | 'plain']> = [];
  if (setup.stage === 'complete') list.push(['Set up', 'good']);
  else if (setup.stage === 'graduated') list.push(['Skipped ahead', 'plain']);
  else list.push([`Missing: ${setup.open.map((item) => OPEN_LABELS[item]).join(', ')}`, 'plain']);
  const gmail = { connected: ['Gmail connected', 'good'], declined: ['Gmail declined', 'plain'], offered: ['Gmail card shown', 'plain'], failed: ['Gmail failed', 'bad'] } as const;
  if (onboarding.gmail !== 'not_offered') list.push([...gmail[onboarding.gmail]]);
  const call = { happened: ['Talked on a call', 'good'], declined: ['Call declined', 'plain'], offered: ['Call offered', 'plain'] } as const;
  if (onboarding.call !== 'not_offered') list.push([...call[onboarding.call]]);
  const task = { active: ['Recurring task on', 'good'], proposed: ['Task proposed', 'plain'], declined: ['Task declined', 'plain'], disabled: ['Task turned off', 'plain'] } as const;
  if (onboarding.automation.status !== 'none') list.push([...task[onboarding.automation.status]]);
  list.push([`${count(view.summary.turns, 'turn')} · ${ms(view.summary.medianMs)} median`, 'plain']);
  if (view.problems.length) list.push([count(view.problems.length, 'problem'), 'bad']);
  return list.map(([label, tone]) => `<span class="chip ${tone}">${esc(label)}</span>`).join('');
}

function renderSession(view: SessionView): string {
  const need = view.state.onboarding.need.value;
  const name = view.state.onboarding.assistantName.value;
  return `
<details class="session" id="s-${esc(view.id.slice(0, 8))}">
  <summary>
    <span class="portrait ${esc(view.avatar)}" aria-hidden="true">${esc((name ?? 'P').slice(0, 1).toUpperCase())}</span>
    <span class="session-head">
      <span class="session-title"><b>${esc(title(view))}</b><span class="muted">${time(view.firstAt, 'datetime')}</span></span>
      ${need ? `<span class="need">${esc(need)}</span>` : ''}
      <span class="chips">${chips(view)}</span>
    </span>
  </summary>
  <div class="thread">${renderThread(view)}</div>
  <p class="session-foot muted">Session ${esc(view.id)} · ${time(view.firstAt)} to ${time(view.lastAt)}</p>
</details>`;
}

function renderThread(view: SessionView): string {
  const parts: string[] = [];
  const prefix = view.id.slice(0, 8);
  const userIds = new Set(view.events.filter((event) => event.type === 'message' && event.speaker === 'user').map((event) => event.id));
  const used = new Set<TurnItem>();
  const emit = (turns: TurnItem[]) => { for (const turn of turns) if (!used.has(turn)) { used.add(turn); parts.push(renderTurn(turn, prefix)); } };
  const shownCalls = new Set<string>();
  const completedAfter = view.state.timeline.find((item) => item.kind === 'setup_notice' && item.phase === 'completed')?.id.replace(/^setup-complete:/, '');
  const system = (event: SessionEvent, html: string, tone: 'good' | 'bad' | 'plain' = 'plain', detail?: string) =>
    parts.push(`<div class="sys ${tone}" id="${esc(anchorId(`e-${prefix}-${event.id}`))}"><span>${html}</span>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`);
  const seen = new Set<string>();
  for (const event of view.events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    // A turn a trigger started (after a call, after connecting, a recurring run) goes in by time.
    emit(view.turns.filter((turn) => !userIds.has(turn.turnId) && turn.at <= event.at));
    switch (event.type) {
      case 'message': {
        const origin = event.origin === 'greeting' ? 'Greeting' : event.origin === 'follow_up' ? 'Follow-up' : event.origin === 'automation' ? 'Recurring task' : event.channel === 'voice' ? 'On the call' : '';
        parts.push(`<div class="msg ${event.speaker}" id="${esc(anchorId(`m-${prefix}-${event.id}`))}">${origin ? `<span class="origin">${esc(origin)}</span>` : ''}<p class="bubble">${esc(event.text)}</p></div>`);
        if (event.speaker === 'user') emit(view.turns.filter((turn) => turn.turnId === event.id));
        break;
      }
      case 'fact': system(event, factLine(event), event.evidence === 'declined' ? 'plain' : 'good', `${event.evidence} · ${event.provenance.replace(/_/g, ' ')}`); break;
      case 'call': {
        if (event.phase === 'offered') system(event, 'Offered a call (Answer card)');
        else if (event.phase === 'declined') system(event, 'Call declined');
        else if (event.phase === 'accepted' || event.phase === 'started') system(event, event.phase === 'started' ? 'Call started' : 'Call answered', 'good');
        else {
          const call = view.calls.find((item) => item.callId === event.callId);
          if (call && !shownCalls.has(call.callId)) { shownCalls.add(call.callId); parts.push(renderCall(call, prefix)); }
          else system(event, `Call ended: ${esc(ending(event.reason))}`, event.phase === 'dropped' ? 'bad' : 'plain');
        }
        break;
      }
      case 'connection': {
        const name = TOOLKITS[event.toolkit];
        const lines = { offered: [`Showed the ${name} connect card`, 'plain'], declined: [`${name}: not now`, 'plain'], connected: [`${name} connected`, 'good'], failed: [`${name} failed to connect`, 'bad'], disconnected: [`${name} disconnected`, 'plain'] } as const;
        const [label, tone] = lines[event.phase];
        system(event, esc(label), tone, event.reason);
        break;
      }
      case 'automation': {
        const lines = { proposed: ['Proposed a recurring task', 'plain'], approved: ['Recurring task approved', 'good'], declined: ['Recurring task declined', 'plain'], disabled: ['Recurring task turned off', 'plain'], ran: ['Recurring task ran', 'good'], failed: ['Recurring task failed', 'bad'] } as const;
        const [label, tone] = lines[event.phase];
        system(event, `${esc(label)}: <b>${esc(event.title)}</b>`, tone, [event.schedule, event.phase === 'proposed' ? event.instruction : undefined].filter(Boolean).join(' · '));
        break;
      }
      case 'account_read': system(event, `Read ${esc(TOOLKITS[event.toolkit])}: ${esc(count(event.items, 'item'))}`, event.items > 0 ? 'good' : 'plain'); break;
      case 'app_connection': system(event, `${esc(event.name)} ${esc(event.phase)}`, event.phase === 'failed' ? 'bad' : event.phase === 'connected' ? 'good' : 'plain'); break;
      case 'visit': system(event, 'Came back to the conversation'); break;
      case 'onboarding': system(event, 'Skipped the rest of setup', 'plain', event.reason); break;
      case 'decision': system(event, event.outcome === 'silent' ? 'Follow-up: stayed quiet' : 'Follow-up: sent a message'); break;
      case 'voice_fragment': break;
    }
    if (event.id === completedAfter) parts.push(`<div class="sys good done"><span>All set up: name, their name, need and Gmail</span></div>`);
  }
  emit(view.turns);
  for (const call of view.calls) if (!shownCalls.has(call.callId)) parts.push(renderCall(call, prefix));
  return parts.join('');
}

function factLine(event: Extract<SessionEvent, { type: 'fact' }>): string {
  const value = `<b>${esc(event.value)}</b>`;
  const declined = event.evidence === 'declined';
  switch (event.key) {
    case 'assistant_name': return declined ? 'Chose not to name the assistant' : `Named the assistant ${value}`;
    case 'preferred_name': case 'name': return declined ? 'Chose not to share their name' : `Saved their name: ${value}`;
    case 'current_need': return declined ? 'Chose not to say what they need' : `Saved what they need: ${value}`;
    case 'personality': {
      const personality = personalityFrom(event.value);
      return `Personality: <b>${esc(personality.id === 'custom' ? event.value : PERSONALITIES[personality.id].label)}</b>`;
    }
    case 'voice': return `Call voice: <b>${esc(event.value in VOICES ? VOICES[event.value as keyof typeof VOICES].label : event.value)}</b>`;
    case 'avatar': return event.value.startsWith('img:') ? 'Painted a new portrait' : `New look: <b>${esc(isAvatarId(event.value) ? AVATARS[event.value].label : event.value)}</b>`;
    default: return declined ? `Declined: ${esc(event.key.replace(/_/g, ' '))}` : `Saved ${esc(event.key.replace(/_/g, ' '))}: ${value}`;
  }
}

function renderTool(tool: ToolView): string {
  const tone = toolTone(tool.name, tool.status);
  return `<div class="tool ${tone}">
    <p class="tool-head"><code>${esc(tool.name)}</code><span class="pill ${tone}">${esc(tool.status)}</span><span class="muted">${ms(tool.ms)}</span></p>
    <div class="io"><div><span class="label">Input</span><pre>${esc(pretty(tool.input || '{}'))}</pre></div><div><span class="label">Result</span><pre>${esc(pretty(tool.preview ?? ''))}</pre></div></div>
  </div>`;
}

function renderStep(step: StepView, reply?: string): string {
  if (step.status === 'timeout') return `<div class="step stalled"><p class="step-head"><b>Stalled, retried</b><span class="muted">after ${ms(step.durationMs)}</span></p></div>`;
  const text = step.text && step.text !== reply?.replace(/\s+/g, ' ').trim() ? `<p class="step-text"><span class="label">Said in this step</span>${esc(step.text)}</p>` : '';
  return `<div class="step">
    <p class="step-head"><b>${esc(step.name)}</b><span class="muted">${ms(step.durationMs)} · model ${ms(step.modelMs)}${step.toolMs ? ` · tools ${ms(step.toolMs)}` : ''} · ${esc(step.finishReason ?? '')}</span></p>
    <p class="muted small">${esc(`${step.tokensIn.toLocaleString('en-US')} tokens in (${step.cachedIn.toLocaleString('en-US')} cached) · ${step.tokensOut.toLocaleString('en-US')} out${step.reasoningTokens ? ` (${step.reasoningTokens.toLocaleString('en-US')} reasoning)` : ''}`)}</p>
    ${step.tools.map(renderTool).join('')}
    ${text}
  </div>`;
}

function renderTurn(turn: TurnItem, prefix: string): string {
  const tools = turn.steps.flatMap((step) => step.tools);
  const bad = turn.status === 'error' || turn.status === 'timeout' || tools.some((tool) => toolTone(tool.name, tool.status) === 'failed');
  const label = turn.name === 'Reply' ? 'Trace' : `Trace · ${turn.name}`;
  const cached = turn.totals.tokensIn ? Math.round((turn.totals.cachedIn / turn.totals.tokensIn) * 100) : 0;
  return `<details class="trace${bad ? ' bad' : ''}" id="${esc(anchorId(`t-${prefix}-${turn.id}`))}">
  <summary><span class="trace-label">${esc(label)}</span><span class="trace-meta">${ms(turn.durationMs)}${tools.length ? ` · ${esc(tools.map((tool) => tool.name).join(', '))}` : ' · no tools'}${turn.stalls ? ` · ${turn.stalls} stall` : ''}${turn.status === 'running' ? ' · running' : ''}</span></summary>
  <div class="trace-body">
    <p class="muted small">${time(turn.at)} · first token ${ms(turn.firstTokenMs)} · ${esc(count(turn.steps.length, 'step'))} · ${esc(turn.totals.tokensIn.toLocaleString('en-US'))} tokens in (${cached}% cached) · ${esc(turn.totals.tokensOut.toLocaleString('en-US'))} out · ${esc(turn.model ?? '')}</p>
    ${turn.error ? `<p class="error">${esc(turn.error)}</p>` : ''}
    ${turn.trigger ? `<details class="sub"><summary>What woke the agent</summary><pre>${esc(turn.trigger)}</pre></details>` : ''}
    ${turn.steps.map((step) => renderStep(step, turn.reply)).join('')}
    <details class="sub"><summary>System prompt · ${esc(turn.promptVersion ?? '')} · ${esc((turn.instructions ?? '').length.toLocaleString('en-US'))} characters</summary><pre>${esc(turn.instructions ?? '')}</pre></details>
    <details class="sub"><summary>Tools it could use · ${turn.toolsOffered.length}</summary><p class="small">${turn.toolsOffered.map((name) => `<code>${esc(name)}</code>`).join(' ')}</p></details>
    <p class="muted small">${esc(count(turn.messageCount ?? 0, 'message'))} of history sent to the model</p>
  </div>
</details>`;
}

function renderCall(call: CallItem, prefix: string): string {
  const setup = call.setup;
  return `<details class="call${call.phase === 'dropped' || setup?.status === 'error' ? ' bad' : ''}" id="${esc(anchorId(`c-${prefix}-${call.callId}`))}" open>
  <summary><span class="trace-label">Call</span><span class="trace-meta">${call.durationMs === undefined ? call.phase : ms(call.durationMs)}${call.reason ? ` · ended: ${esc(ending(call.reason))}` : ''}${call.tools.length ? ` · ${esc(call.tools.map((tool) => tool.name).join(', '))}` : ''}</span></summary>
  <div class="trace-body">
    ${setup ? `<p class="muted small">Setup ${ms(setup.ms)} · ${esc([setup.model, setup.voice && `voice ${setup.voice}`, setup.delegation && `delegation ${setup.delegation}`, setup.seededMessages !== undefined && `${setup.seededMessages} messages carried in`].filter(Boolean).join(' · '))}</p>` : ''}
    ${setup?.error ? `<p class="error">${esc(setup.error)}</p>` : ''}
    ${call.utterances.map((utterance) => `<div class="msg ${utterance.speaker} voice"><p class="bubble">${esc(utterance.text)}</p></div>`).join('') || '<p class="muted small">No transcript was saved for this call.</p>'}
    ${call.tools.map((tool) => `<p class="muted small">${time(tool.at)}</p>${renderTool(tool)}`).join('')}
  </div>
</details>`;
}

// The Persona mark, from yourpersona.com.
const MARK = 'M23.6813 15.4245C23.3962 12.7186 22.3617 9.73895 20.768 7.0367C19.646 5.13537 18.3108 3.4873 16.9061 2.27142C15.4653 1.0249 13.9827 0.258395 12.6166 0.0555602C12.4676 0.03353 12.3201 0.0182135 12.1743 0.00924973C11.9735 -0.00308324 11.7777 -0.00308324 11.5851 0.00924973C11.4398 0.0182135 11.2911 0.03353 11.142 0.0555602C9.77668 0.258395 8.29352 1.0249 6.85327 2.27142C5.44828 3.48692 4.11259 5.13499 2.99153 7.0367C1.39776 9.73932 0.363216 12.7186 0.0781778 15.4245C-0.228965 18.339 0.375195 20.6534 1.77981 21.941C2.54317 22.64 3.48969 23 4.54858 23C4.78867 23 5.03514 22.9817 5.28572 22.9443C6.65175 22.7415 8.13505 21.9749 9.57516 20.7285C10.3753 20.036 11.1521 19.2044 11.8803 18.265C12.6077 19.2044 13.3849 20.036 14.1854 20.7285C15.6255 21.9749 17.1088 22.7415 18.4741 22.9443C18.7254 22.9817 18.9715 23 19.2117 23C20.2705 23 21.2167 22.6403 21.9796 21.941C23.3839 20.6537 23.9884 18.339 23.6813 15.4245Z';

const CSS = `
:root{--bg:#fff;--surface:#f5f5f7;--raised:#fff;--ink:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--blue:#0a84ff;--on-blue:#fff;--bubble:#e9e9eb;--good:#1a7f37;--good-soft:#e8f5ec;--bad:#c9001a;--bad-soft:#fdecee;--held:#9a5b00;--held-soft:#fdf3e1;--code:#f5f5f7}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#000;--surface:#1c1c1e;--raised:#1c1c1e;--ink:#f5f5f7;--muted:#98989d;--line:#38383a;--bubble:#2c2c2e;--good:#32d74b;--good-soft:#0f2a16;--bad:#ff6961;--bad-soft:#3a1214;--held:#ffb340;--held-soft:#33240a;--code:#141416}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#000;--surface:#1c1c1e;--raised:#1c1c1e;--ink:#f5f5f7;--muted:#98989d;--line:#38383a;--bubble:#2c2c2e;--good:#32d74b;--good-soft:#0f2a16;--bad:#ff6961;--bad-soft:#3a1214;--held:#ffb340;--held-soft:#33240a;--code:#141416}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:760px;margin:0 auto;padding-inline:16px;padding-block:20px 64px;display:flex;flex-direction:column;gap:14px}
h1{font-size:28px;line-height:1.1;letter-spacing:-.02em;margin:0;text-wrap:balance}
h2,h3{margin:0}
.muted{color:var(--muted)}.small{font-size:12.5px}
code,pre{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
code{font-size:12.5px}
.top{display:flex;align-items:center;gap:12px;padding-block:4px 6px}.top p{margin:4px 0 0;font-size:13px}
.mark{width:30px;height:30px;flex:none;fill:var(--ink)}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.health{background:var(--surface);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:12px}
.verdict{margin:0;font-size:22px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
.verdict .dot{width:10px;height:10px;border-radius:50%;flex:none}.verdict.good .dot{background:var(--good)}.verdict.bad .dot{background:var(--bad)}
.lede{margin:0;color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
@media (min-width:640px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}
.stat{background:var(--raised);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;font-variant-numeric:tabular-nums}
.stat b{font-size:20px;letter-spacing:-.01em}.stat-label{font-size:12px;color:var(--muted)}.stat-detail{font-size:12px;color:var(--muted)}
.stat.good .stat-detail{color:var(--good)}.stat.bad .stat-detail{color:var(--bad)}
.problems{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px}.problems a{color:var(--bad);font-weight:600}
.subhead{font-size:15px;margin-top:4px}
.scroll{overflow-x:auto}
.tools{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.tools th{text-align:left;font-size:12px;color:var(--muted);font-weight:500;padding:4px 8px 6px 0;border-bottom:1px solid var(--line)}
.tools td{padding:7px 8px 7px 0;border-bottom:1px solid var(--line);vertical-align:top}.tools .num{text-align:right;padding-right:12px}
.tools tr.never code{color:var(--muted)}
.notes{margin:0;padding-left:18px;font-size:13px;color:var(--muted)}
.pill{display:inline-block;font-size:11.5px;font-weight:600;border-radius:999px;padding:1px 8px;white-space:nowrap}
.pill.ok{background:var(--good-soft);color:var(--good)}.pill.held{background:var(--held-soft);color:var(--held)}.pill.failed{background:var(--bad-soft);color:var(--bad)}
.list-title{margin-top:10px}.hint{margin:-8px 0 0;font-size:13px}
details>summary{list-style:none;cursor:pointer}details>summary::-webkit-details-marker{display:none}
.session{border:1px solid var(--line);border-radius:18px;background:var(--bg);overflow:hidden}
.session>summary{display:flex;gap:12px;padding:14px;align-items:flex-start;min-height:44px}
.session[open]>summary{border-bottom:1px solid var(--line)}
.session>summary:focus-visible,.trace>summary:focus-visible,.call>summary:focus-visible,.sub>summary:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.portrait{width:44px;height:44px;border-radius:50%;flex:none;background:var(--surface) center/cover no-repeat;display:grid;place-items:center;font-weight:600;color:transparent;border:1px solid var(--line)}
.session-head{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}
.session-title{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline}.session-title .muted{font-size:12.5px;font-variant-numeric:tabular-nums}
.need{font-size:13.5px;color:var(--muted);overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:12px;border-radius:999px;padding:2px 9px;background:var(--surface);color:var(--muted);font-variant-numeric:tabular-nums}
.chip.good{background:var(--good-soft);color:var(--good)}.chip.bad{background:var(--bad-soft);color:var(--bad);font-weight:600}
.thread{padding:14px;display:flex;flex-direction:column;gap:8px}
.msg{display:flex;flex-direction:column;max-width:86%}
.msg.user{align-self:flex-end;align-items:flex-end}.msg.assistant{align-self:flex-start;align-items:flex-start}
.bubble{margin:0;padding:8px 13px;border-radius:19px;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.user .bubble{background:var(--blue);color:var(--on-blue)}.msg.assistant .bubble{background:var(--bubble);color:var(--ink)}
.msg.voice .bubble{font-size:14px;padding:6px 11px}
.origin{font-size:11px;color:var(--muted);margin:0 6px 3px;letter-spacing:.02em}
.sys{align-self:center;text-align:center;font-size:12.5px;color:var(--muted);max-width:92%;display:flex;flex-direction:column;gap:1px;padding-block:2px}
.sys b{color:var(--ink);font-weight:600}.sys small{font-size:11px;opacity:.85}
.sys.good span::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--good);margin-right:6px;vertical-align:middle}
.sys.bad{color:var(--bad)}.sys.bad b{color:var(--bad)}
.sys.done{font-weight:600;color:var(--good);padding-block:6px}
.trace,.call{align-self:stretch;border-radius:14px;background:var(--surface)}
.trace.bad,.call.bad{box-shadow:inset 0 0 0 1.5px var(--bad)}
.trace>summary,.call>summary{display:flex;gap:8px;align-items:baseline;padding:9px 12px;min-height:40px;font-size:13px}
.trace>summary::after,.call>summary::after{content:"›";margin-left:auto;color:var(--muted);transition:transform .15s}
.trace[open]>summary::after,.call[open]>summary::after{transform:rotate(90deg)}
.trace-label{font-weight:600;color:var(--blue);flex:none}.trace-meta{color:var(--muted);min-width:0;overflow-wrap:anywhere}
.trace-body{padding:0 12px 12px;display:flex;flex-direction:column;gap:10px}
.trace-body>p{margin:0}
.step{border-left:2px solid var(--line);padding-left:10px;display:flex;flex-direction:column;gap:6px}
.step p{margin:0}.step-head{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;font-size:13px}.step-head .muted{font-size:12px}
.step.stalled{border-left-color:var(--held)}
.step-text{font-size:13px}
.label{display:block;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
.tool{background:var(--raised);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px}
.tool.failed{box-shadow:inset 0 0 0 1.5px var(--bad)}
.tool-head{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tool-head code{font-weight:600;font-size:13px}.tool-head .muted{margin-left:auto;font-size:12px;font-variant-numeric:tabular-nums}
.io{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
@media (min-width:640px){.io{grid-template-columns:repeat(2,minmax(0,1fr))}}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);border-radius:9px;padding:9px;font-size:11.5px;line-height:1.45;max-height:340px;overflow:auto}
.sub{border-top:1px solid var(--line);padding-top:8px}.sub>summary{font-size:13px;color:var(--blue);padding-block:4px}.sub>summary::before{content:"+ ";}.sub[open]>summary::before{content:"− "}.sub pre{margin-top:6px;max-height:420px}.sub p{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:6px}
.error{color:var(--bad);background:var(--bad-soft);border-radius:9px;padding:8px 10px;font-size:13px}
.session-foot{margin:0;padding:0 14px 14px;font-size:11.5px;overflow-wrap:anywhere}
.bounced{display:flex;flex-direction:column;gap:6px;margin-top:6px}.bounced p{margin:0;font-size:13px;font-variant-numeric:tabular-nums}
a{color:var(--blue)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const SCRIPT = `(function(){
  try {
    var dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    var clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    document.querySelectorAll('time[data-at]').forEach(function (el) {
      var at = new Date(el.getAttribute('data-at'));
      if (!isNaN(at)) el.textContent = (el.getAttribute('data-style') === 'datetime' ? dateTime : clock).format(at);
    });
  } catch (e) {}
  function openTarget() {
    var id = location.hash.slice(1);
    var el = id && document.getElementById(id);
    if (!el) return;
    for (var node = el; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    el.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('hashchange', openTarget);
  openTarget();
})();`;

await main();
