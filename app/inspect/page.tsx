'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CallItem, EventItem, LogItem, LogSummary, StepView, ToolView, TurnItem } from '@/lib/observability/log';
import './inspect.css';

/*
 * The agent log, laid out like Vercel's Logs page: a facet rail on the left (here, what the agent
 * knows), a dense row list in the middle, and the selected row's detail on the right, whose trace
 * waterfall follows Vercel's span view (a time ruler, the turn as the root span, steps and tool
 * calls nested under it). Colours and type are Persona's.
 */

type Slot = { status: string; value?: string };
interface Settings { assistantName?: string; avatarUrl?: string; personality: { id: string; label: string; text?: string }; voice: string }
interface Inspection {
  state: {
    progress: { assistantName: Slot; preferredName: Slot; need: Slot; gmail: string; call: string; automation: { status: string; title?: string; schedule?: string } };
    settings: Settings;
    connections: Record<string, string>;
    facts: Array<{ key: string; value: string; evidence: string; provenance: string }>;
    user?: {
      lifecycle: { stage: string; day: number }; labels: Array<{ label: string; confidence: string }>; coach: { focus: string; guidance: string } | null;
      profile?: Array<{ id: string; label: string; value: string; status: string }>;
      memories?: Array<{ id: string; text: string; kind: string; labels: string[] }>;
      memoryCounts?: { live: number; replaced: number; forgotten: number };
      summary?: { text: string; lines: number };
    };
    soulNotes?: Record<string, string[]>;
  };
  summary: LogSummary;
  items: LogItem[];
  generatedAt?: string;
}

type Tone = 'ok' | 'running' | 'bad' | 'neutral';
interface Status { tone: Tone; label: string }

const ms = (value?: number) => value === undefined ? '–' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
const count = (value: number) => value >= 10_000 ? `${(value / 1000).toFixed(0)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const clock = (iso?: string) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
const humanize = (value: string) => value.replace(/[_-]+/g, ' ');
const sentence = (value: string) => { const text = humanize(value); return text.charAt(0).toUpperCase() + text.slice(1); };
const BAD_TOOL = /error|fail|invalid|refused|unavailable|rate|timeout|denied/;

function statusOf(item: LogItem): Status {
  if (item.kind === 'turn') {
    if (item.status === 'ok') return { tone: 'ok', label: 'Done' };
    if (item.status === 'running') return { tone: 'running', label: 'Running' };
    return { tone: 'bad', label: item.status === 'timeout' ? 'Timed out' : 'Error' };
  }
  if (item.kind === 'call') {
    if (item.setup?.status === 'error') return { tone: 'bad', label: 'Failed' };
    if (item.endedAt) return { tone: 'ok', label: 'Ended' };
    return item.startedAt ? { tone: 'running', label: 'On the call' } : { tone: 'neutral', label: sentence(item.phase) };
  }
  return item.tone === 'bad' ? { tone: 'bad', label: 'Problem' } : item.tone === 'good' ? { tone: 'ok', label: 'Done' } : { tone: 'neutral', label: 'Event' };
}

/** How long the item took, or for one still running, how long it has run so far (server clock). */
function elapsedOf(item: LogItem, serverNow: number): number | undefined {
  if (item.kind === 'turn') return item.status === 'running' ? Math.max(0, serverNow - Date.parse(item.at)) : item.durationMs;
  if (item.kind === 'call') return statusOf(item).tone === 'running' && item.startedAt ? Math.max(0, serverNow - Date.parse(item.startedAt)) : item.durationMs;
  return undefined;
}

function rowText(item: LogItem): { text: string; quiet?: boolean } {
  if (item.kind === 'turn') {
    if (item.userText) return { text: item.userText };
    // A background agent's row reads as its decision, not its JSON input.
    if (item.agent) return { text: `${item.name} · ${(item.reply ?? '').replace(/[{}"\s]+/g, ' ').trim()}`, quiet: true };
    if (item.trigger) return { text: item.trigger, quiet: true };
    return { text: item.reply ?? sentence(item.name), quiet: true };
  }
  if (item.kind === 'call') {
    const parts = [item.reason && sentence(item.reason), item.utterances.length ? `${item.utterances.length} lines` : undefined].filter(Boolean);
    return { text: parts.length ? parts.join(' · ') : sentence(item.phase) };
  }
  return { text: item.detail ? `${item.label} · ${item.detail}` : item.label };
}

function PersonaMark() {
  return (
    <svg className="ins-mark" viewBox="0 0 23.6813 23" fill="currentColor" aria-hidden="true">
      <path d="M23.6813 15.4245C23.3962 12.7186 22.3617 9.73895 20.768 7.0367C19.646 5.13537 18.3108 3.4873 16.9061 2.27142C15.4653 1.0249 13.9827 0.258395 12.6166 0.0555602C12.4676 0.03353 12.3201 0.0182135 12.1743 0.00924973C11.9735 -0.00308324 11.7777 -0.00308324 11.5851 0.00924973C11.4398 0.0182135 11.2911 0.03353 11.142 0.0555602C9.77668 0.258395 8.29352 1.0249 6.85327 2.27142C5.44828 3.48692 4.11259 5.13499 2.99153 7.0367C1.39776 9.73932 0.363216 12.7186 0.0781778 15.4245C-0.228965 18.339 0.375195 20.6534 1.77981 21.941C2.54317 22.64 3.48969 23 4.54858 23C4.78867 23 5.03514 22.9817 5.28572 22.9443C6.65175 22.7415 8.13505 21.9749 9.57516 20.7285C10.3753 20.036 11.1521 19.2044 11.8803 18.265C12.6077 19.2044 13.3849 20.036 14.1854 20.7285C15.6255 21.9749 17.1088 22.7415 18.4741 22.9443C18.7254 22.9817 18.9715 23 19.2117 23C20.2705 23 21.2167 22.6403 21.9796 21.941C23.3839 20.6537 23.9884 18.339 23.6813 15.4245ZM11.4762 14.8135C11.1713 15.3308 10.8502 15.8239 10.518 16.2893C8.74856 18.7674 6.66262 20.4465 4.95011 20.7012C4.27703 20.801 3.74365 20.6601 3.31889 20.2713C2.46938 19.4932 2.11242 17.8129 2.33941 15.6614C2.59149 13.2704 3.51853 10.6163 4.95161 8.18651C5.69662 6.92314 6.53489 5.80363 7.40124 4.88695C8.78041 3.42789 10.2285 2.48508 11.4777 2.29943C11.5747 2.28486 11.6694 2.27515 11.7612 2.27142C11.7679 2.27067 11.7742 2.26993 11.7811 2.26993C11.811 2.26842 11.8413 2.26768 11.8705 2.26768H11.8882C11.9181 2.26768 11.9485 2.26842 11.9777 2.26993C11.9844 2.26993 11.9908 2.26993 11.9975 2.27142C12.4331 2.29421 12.7991 2.44586 13.1085 2.72863C13.9572 3.50672 14.3142 5.18691 14.088 7.33852C13.8602 9.49651 13.0819 11.87 11.8792 14.0981C11.7503 14.3387 11.6159 14.577 11.4762 14.8135ZM20.4402 20.2713C20.0146 20.6605 19.4812 20.801 18.809 20.7012C17.0961 20.4461 15.0086 18.7674 13.2403 16.2886C13.307 16.1809 13.3718 16.0723 13.4366 15.9632C15.0304 13.2607 16.0648 10.282 16.35 7.57533C16.4522 6.60824 16.4537 5.70688 16.3582 4.88695C17.2246 5.80363 18.0629 6.92314 18.8079 8.18651C20.2398 10.6163 21.1679 13.2704 21.42 15.6614C21.6459 17.8126 21.2889 19.4932 20.4402 20.2713Z" />
    </svg>
  );
}

/** The assistant's picture, or a grey circle with its initial while there is none (or it fails to load). */
function Avatar({ url, name, size = 24 }: { url?: string; name?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initial = (name?.trim().charAt(0) || 'A').toUpperCase();
  if (url && !broken) {
    // eslint-disable-next-line @next/next/no-img-element -- a user-chosen image from any origin, shown at 24-36 px
    return <img className="ins-avatar" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} />;
  }
  return <span className="ins-avatar fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{initial}</span>;
}

function Badge({ status, duration }: { status: Status; duration?: number }) {
  return (
    <span className={`ins-badge ${status.tone}`}>
      <span className="ins-dot" aria-hidden="true" />
      {status.label}{duration !== undefined && <span className="ins-badge-ms">{ms(duration)}</span>}
    </span>
  );
}

function DetailHead({ eyebrow, title, status, duration }: { eyebrow: string; title: string; status: Status; duration?: number }) {
  return (
    <header className="ins-dhead">
      <div className="ins-dhead-main">
        <span className="ins-eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <Badge status={status} duration={duration} />
    </header>
  );
}

function KeyValues({ rows }: { rows: Array<[string, ReactNode, boolean?]> }) {
  return (
    <dl className="ins-kv">
      {rows.map(([label, value, bad]) => (
        <div key={label} className={bad ? 'bad' : undefined}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Where a step's tool calls begin: they run after the model finishes its part of the step. */
const toolStart = (step: StepView) => step.offsetMs + (step.status === 'timeout' ? step.durationMs : step.modelMs);

function Waterfall({ turn, elapsed }: { turn: TurnItem; elapsed?: number }) {
  const running = turn.status === 'running';
  const turnMs = turn.durationMs ?? elapsed ?? 0;
  const end = Math.max(1, turnMs, ...turn.steps.map((step) => step.offsetMs + step.durationMs), ...turn.steps.flatMap((step) => step.tools.map((tool) => toolStart(step) + (tool.ms ?? 0))));
  const pct = (value: number) => Math.min(100, Math.max(0, (value / end) * 100));
  const bar = (left: number, width: number) => ({ left: `${pct(left)}%`, width: `${Math.min(pct(width), 100 - pct(left))}%` });
  return (
    <div className="ins-wf">
      <div className="ins-wf-row ins-wf-ruler" aria-hidden="true">
        <span className="ins-wf-label">Span</span>
        <span className="ins-wf-track">{[0, 0.25, 0.5, 0.75, 1].map((f) => <i key={f} style={{ left: `${f * 100}%` }}>{f === 0 ? '0' : ms(f * end)}</i>)}</span>
      </div>
      <ol className="ins-wf-rows" aria-label="Trace">
        <li className="ins-wf-row root">
          <span className="ins-wf-label"><b>Turn</b><small>{ms(turnMs)}</small></span>
          <span className="ins-wf-track">
            <span className={`ins-bar root ${running ? 'running' : ''} ${turn.status === 'error' || turn.status === 'timeout' ? 'bad' : ''}`} style={bar(0, turnMs)} title={`turn ${ms(turnMs)}`} />
            {turn.firstTokenMs !== undefined && <span className="ins-ttft" style={{ left: `${pct(turn.firstTokenMs)}%` }} title={`first token at ${ms(turn.firstTokenMs)}`} />}
          </span>
        </li>
        {turn.steps.map((step) => {
          const stall = step.status === 'timeout';
          const modelShare = step.durationMs ? Math.min(100, (step.modelMs / step.durationMs) * 100) : 100;
          const cached = step.cachedIn ? ` (${Math.round((step.cachedIn / Math.max(step.tokensIn, 1)) * 100)}% cached)` : '';
          const detail = stall ? 'stalled, retried once'
            : `model ${ms(step.modelMs)} · tools ${ms(step.toolMs)} · ${count(step.tokensIn)} in${cached} · ${count(step.tokensOut)} out${step.reasoningTokens ? ` · ${count(step.reasoningTokens)} reasoning` : ''}${step.finishReason ? ` · ${humanize(step.finishReason)}` : ''}`;
          return [
            <li key={`s${step.index}`} className={`ins-wf-row step ${stall ? 'bad' : ''}`} title={detail}>
              <span className="ins-wf-label">
                <b>{stall ? 'Stall' : `Step ${step.index}`}<em>{stall ? 'retried once' : `${count(step.tokensIn)} in · ${count(step.tokensOut)} out`}</em></b>
                <small>{ms(step.durationMs)}</small>
              </span>
              <span className="ins-wf-track">
                <span className={`ins-bar ${stall ? 'bad' : ''}`} style={bar(step.offsetMs, step.durationMs)}>
                  {!stall && <><span className="ins-bar-model" style={{ width: `${modelShare}%` }} /><span className="ins-bar-tool" style={{ width: `${100 - modelShare}%` }} /></>}
                </span>
              </span>
            </li>,
            ...step.tools.map((tool, index) => (
              <li key={`s${step.index}t${index}`} className={`ins-wf-row tool ${BAD_TOOL.test(tool.status) ? 'bad' : ''}`} title={`${tool.name} → ${humanize(tool.status)}${tool.ms !== undefined ? ` in ${ms(tool.ms)}` : ''}`}>
                <span className="ins-wf-label"><b>{tool.name}</b><small>{ms(tool.ms)}</small></span>
                <span className="ins-wf-track"><span className="ins-bar toolcall" style={bar(toolStart(step), tool.ms ?? 0)} /></span>
              </li>
            )),
          ];
        })}
      </ol>
      <div className="ins-legend" aria-hidden="true">
        <span><i className="model" />Model</span><span><i className="tool" />Tools</span><span><i className="ttft" />First token</span>
        {turn.stalls > 0 && <span><i className="stall" />Stall</span>}
      </div>
    </div>
  );
}

/** Indented JSON when the text is JSON (a clipped value stays as it is). */
function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function ToolCalls({ tools }: { tools: ToolView[] }) {
  return (
    <ul className="ins-calls">
      {tools.map((tool, index) => {
        const bad = BAD_TOOL.test(tool.status);
        return (
          <li key={index}>
            <details className={`ins-call ${bad ? 'bad' : ''}`}>
              <summary>
                <span className="ins-dot" aria-hidden="true" />
                <span className="ins-call-name">{tool.name}</span>
                <span className="ins-call-input">{tool.input || '{}'}</span>
                <span className="ins-call-status">{humanize(tool.status)}</span>
                <span className="ins-call-ms">{ms(tool.ms)}</span>
              </summary>
              <div className="ins-call-body">
                <div><span>Input</span><pre className="ins-pre">{pretty(tool.input || '{}')}</pre></div>
                {tool.preview && <div><span>Result</span><pre className="ins-pre">{pretty(tool.preview)}</pre></div>}
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="ins-sec">
      <h3>{title}{note && <span>{note}</span>}</h3>
      {children}
    </section>
  );
}

function AssistantLine({ settings, children }: { settings: Settings; children: ReactNode }) {
  return (
    <div className="ins-msg">
      <Avatar key={settings.avatarUrl ?? 'none'} url={settings.avatarUrl} name={settings.assistantName} />
      <div className="ins-msg-body"><span className="ins-msg-name">{settings.assistantName || 'Assistant'}</span>{children}</div>
    </div>
  );
}

function TurnDetail({ turn, serverNow, settings }: { turn: TurnItem; serverNow: number; settings: Settings }) {
  const running = turn.status === 'running';
  const elapsed = elapsedOf(turn, serverNow);
  const tools = turn.steps.flatMap((step) => step.tools);
  const prompt = (turn.promptVersion ?? '').split('/').pop() || undefined;
  return (
    <>
      <DetailHead eyebrow={`Turn · ${clock(turn.at)}`} title={sentence(turn.name)} status={statusOf(turn)} duration={elapsed} />
      <KeyValues rows={[
        ['Duration', running ? `${ms(elapsed)} so far` : ms(turn.durationMs)],
        ['First token', ms(turn.firstTokenMs)],
        ['Model', turn.model ?? '–'],
        ['Prompt', prompt ?? '–'],
        ['Messages', turn.messageCount ?? '–'],
        ['Tokens', turn.totals.tokensIn ? `${count(turn.totals.tokensIn)} in · ${count(turn.totals.tokensOut)} out` : '–'],
        ['Cached', turn.totals.tokensIn ? `${Math.round((turn.totals.cachedIn / turn.totals.tokensIn) * 100)}%` : '–'],
        ['Steps', `${turn.steps.length}${turn.stalls ? ` · ${turn.stalls} stalled` : ''}`, turn.stalls > 0],
      ]} />
      {turn.context && (
        <details className="ins-fold">
          <summary>Context budget<span>~{count(Number(turn.context.total) || 0)} tokens · memories {String(turn.context.memories ?? '–')} · {String(turn.context.replayed ?? '')}</span></summary>
          <div className="ins-chips">{Object.entries(turn.context).map(([key, value]) => <code key={key}>{key} {typeof value === 'number' ? count(value) : value}</code>)}</div>
        </details>
      )}
      {turn.error && <p className="ins-error" role="alert">{turn.error}</p>}
      {(turn.userText || turn.trigger) && (
        <Section title={turn.userText ? 'User said' : 'Trigger'}>
          {turn.userText ? <p className="ins-bubble user">{turn.userText}</p> : <pre className="ins-pre trigger">{turn.trigger}</pre>}
        </Section>
      )}
      <Section title="Trace" note={turn.steps.length ? `${turn.steps.length} step${turn.steps.length === 1 ? '' : 's'} · ${tools.length} tool call${tools.length === 1 ? '' : 's'}` : undefined}>
        {turn.steps.length || running ? <Waterfall turn={turn} elapsed={elapsed} /> : <p className="ins-quiet">No model steps were recorded for this turn.</p>}
      </Section>
      {tools.length > 0 && <Section title="Tool calls" note={String(tools.length)}><ToolCalls tools={tools} /></Section>}
      <Section title="Reply">
        <AssistantLine settings={settings}>
          {running ? <p className="ins-bubble pending">Thinking <span>{ms(elapsed)}</span></p>
            : turn.reply ? <p className="ins-bubble">{turn.reply}</p>
            : <p className="ins-bubble quiet">{turn.status === 'ok' ? 'Stayed silent' : 'No reply'}</p>}
        </AssistantLine>
      </Section>
      {turn.instructions && (
        <details className="ins-fold">
          <summary>System prompt<span>{[prompt, `${turn.instructions.length.toLocaleString()} chars`].filter(Boolean).join(' · ')}</span></summary>
          <pre className="ins-pre prompt">{turn.instructions}</pre>
        </details>
      )}
      {turn.toolsOffered.length > 0 && (
        <details className="ins-fold">
          <summary>Tools offered<span>{turn.toolsOffered.length}</span></summary>
          <div className="ins-chips">{turn.toolsOffered.map((name) => <code key={name}>{name}</code>)}</div>
        </details>
      )}
    </>
  );
}

function CallDetail({ call, serverNow, settings }: { call: CallItem; serverNow: number; settings: Settings }) {
  const setup = call.setup;
  return (
    <>
      <DetailHead eyebrow={`Call · ${clock(call.at)}`} title={call.reason ? sentence(call.reason) : 'Voice call'} status={statusOf(call)} duration={elapsedOf(call, serverNow)} />
      <KeyValues rows={[
        ['Phase', sentence(call.phase)],
        ['Started', call.startedAt ? clock(call.startedAt) : '–'],
        ['Ended', call.endedAt ? clock(call.endedAt) : '–'],
        ['Setup', ms(setup?.ms), setup?.status === 'error'],
        ['Model', setup?.model ?? '–'],
        ['Voice', setup?.voice ?? '–'],
        ['Delegation', setup?.delegation ?? '–'],
        ['Seeded messages', setup?.seededMessages ?? '–'],
        ['Instructions', setup?.instructionsChars !== undefined ? `${setup.instructionsChars.toLocaleString()} chars` : '–'],
      ]} />
      {setup?.error && <p className="ins-error" role="alert">{setup.error}</p>}
      {call.tools.length > 0 && <Section title="Tool calls" note={String(call.tools.length)}><ToolCalls tools={call.tools} /></Section>}
      <Section title="Transcript" note={call.utterances.length ? `${call.utterances.length} lines` : undefined}>
        {call.utterances.length === 0 ? <p className="ins-quiet">Nothing said yet.</p> : (
          <div className="ins-transcript">
            {call.utterances.map((line, index) => line.speaker === 'assistant'
              ? <AssistantLine key={index} settings={settings}><p className="ins-bubble">{line.text}</p></AssistantLine>
              : <div key={index} className="ins-msg"><span className="ins-avatar fallback user" aria-hidden="true">U</span><div className="ins-msg-body"><span className="ins-msg-name">User</span><p className="ins-bubble user">{line.text}</p></div></div>)}
          </div>
        )}
      </Section>
    </>
  );
}

function EventDetail({ event }: { event: EventItem }) {
  return (
    <>
      <DetailHead eyebrow={`Event · ${clock(event.at)}`} title={event.label} status={statusOf(event)} />
      <KeyValues rows={[['At', clock(event.at)], ['Kind', event.tag ? sentence(event.tag) : '–']]} />
      {event.detail && <Section title="Detail"><p className={`ins-bubble ${event.tone === 'bad' ? 'bad' : ''}`}>{event.detail}</p></Section>}
    </>
  );
}

function Knows({ data }: { data: Inspection['state'] }) {
  const fact = (key: string) => data.facts.find((item) => item.key === key);
  const row = (label: string, value: string | undefined, tag?: string) => (
    <div className="ins-know" key={label}>
      <dt>{label}</dt>
      <dd className={value ? '' : 'empty'}>{value ?? 'Not yet'}{tag && <span className="ins-tag">{humanize(tag)}</span>}</dd>
    </div>
  );
  const slot = (label: string, value: Slot, key: string) => {
    const saved = fact(key);
    return row(label, value.status === 'declined' ? 'Declined to share' : value.value, saved ? saved.provenance : value.status !== 'unknown' ? value.status : undefined);
  };
  const { progress, settings } = data;
  const automation = progress.automation;
  const personality = settings.personality.id === 'custom' ? settings.personality.text : settings.personality.label;
  return (
    <div className="ins-side-in">
      <div className="ins-who">
        <Avatar key={settings.avatarUrl ?? 'none'} url={settings.avatarUrl} name={settings.assistantName} size={36} />
        <div><strong>{settings.assistantName || 'Unnamed assistant'}</strong><small>{personality ?? 'Default personality'}</small></div>
      </div>
      <h2>What the agent knows</h2>
      <dl>
        {slot('Assistant name', progress.assistantName, 'assistant_name')}
        {slot('User name', progress.preferredName, fact('preferred_name') ? 'preferred_name' : 'name')}
        {slot('Need', progress.need, 'current_need')}
        {row('Gmail', progress.gmail === 'not_offered' ? undefined : sentence(progress.gmail))}
        {row('Call', progress.call === 'not_offered' ? undefined : sentence(progress.call))}
        {row('Recurring task', automation.status === 'none' ? undefined : `${automation.title ?? 'Task'}${automation.schedule ? ` · ${automation.schedule}` : ''}`, automation.status === 'none' ? undefined : automation.status)}
        {row('Personality', personality, fact('personality')?.provenance ?? 'default')}
        {row('Voice', settings.voice, fact('voice')?.provenance ?? 'default')}
        {data.user && row('Stage', `${sentence(data.user.lifecycle.stage)} · day ${data.user.lifecycle.day}`)}
        {data.user && row('Coach focus', data.user.coach ? `${humanize(data.user.coach.focus)}: ${data.user.coach.guidance}` : undefined)}
        {data.user && row('Labels', data.user.labels.length ? data.user.labels.map((label) => `${label.label} (${label.confidence})`).join(', ') : undefined)}
        {data.user?.profile && row('Profile', data.user.profile.length ? data.user.profile.map((item) => `${item.label}: ${item.value} (${item.status})`).join(' · ') : undefined, 'pinned')}
        {data.user?.memories && row('Memories', data.user.memories.length ? data.user.memories.map((memory) => `${memory.text} [${[memory.kind, ...memory.labels].join(', ')}]`).join(' · ') : undefined,
          data.user.memoryCounts ? `${data.user.memoryCounts.live} live, ${data.user.memoryCounts.replaced} merged or corrected, ${data.user.memoryCounts.forgotten} forgotten` : undefined)}
        {data.user && row('Summary', data.user.summary ? `${data.user.summary.text}` : undefined, data.user.summary ? `covers ${data.user.summary.lines} lines` : undefined)}
        {Object.entries(data.soulNotes ?? {}).map(([agent, notes]) => row(`${sentence(agent)} soul notes`, notes.length ? notes.join(' · ') : undefined))}
      </dl>
    </div>
  );
}

function Stats({ summary }: { summary: LogSummary }) {
  const stats: Array<[string, string, string?]> = [
    ['Turns', String(summary.turns)],
    ['Median reply', ms(summary.medianMs), summary.p95Ms !== undefined ? `p95 ${ms(summary.p95Ms)}` : undefined],
    ['First token', ms(summary.medianFirstTokenMs), 'median'],
    ['Tool calls', String(summary.toolCalls), `${summary.steps} steps`],
    ['Tokens', `${count(summary.tokensIn)} / ${count(summary.tokensOut)}`, summary.cachedPercent !== undefined ? `${summary.cachedPercent}% cached` : 'in / out'],
    ['Calls', String(summary.calls)],
    ['Errors', String(summary.errors)],
  ];
  return (
    <section className="ins-stats" aria-label="Summary">
      {stats.map(([label, value, note]) => (
        <div key={label} className={`ins-stat ${label === 'Errors' && summary.errors ? 'bad' : ''}`}>
          <span>{label}</span>
          <div><strong>{value}</strong>{note && <small>{note}</small>}</div>
        </div>
      ))}
    </section>
  );
}

function Row({ item, selected, serverNow, onPick }: { item: LogItem; selected: boolean; serverNow: number; onPick: (id: string) => void }) {
  const status = statusOf(item);
  const elapsed = elapsedOf(item, serverNow);
  const { text, quiet } = rowText(item);
  const kind = item.kind === 'turn' ? sentence(item.name) : item.kind === 'call' ? 'Call' : 'Event';
  return (
    <li>
      <button type="button" className={`ins-row ${status.tone}`} data-id={item.id} aria-current={selected ? 'true' : undefined} onClick={() => onPick(item.id)}>
        <span className="ins-dot" aria-hidden="true" />
        <time className="ins-row-time" dateTime={item.at}>{clock(item.at)}</time>
        <span className="ins-row-kind">{kind}</span>
        <span className={`ins-row-text ${quiet ? 'quiet' : ''}`}>{text}</span>
        <span className="ins-row-dur">{elapsed !== undefined ? ms(elapsed) : status.tone === 'bad' ? status.label : ''}</span>
        <span className="ins-sr">, {status.label}</span>
      </button>
    </li>
  );
}

export default function InspectPage() {
  const [data, setData] = useState<Inspection>();
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(true);
  const [picked, setPicked] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [skew, setSkew] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loadedOnce = false;
    const load = async () => {
      if (stopped) return;
      // The first load always runs (a log opened in a background tab showed "Loading…" until focused);
      // after that it only polls while the tab is visible.
      if (!loadedOnce || document.visibilityState === 'visible') {
        loadedOnce = true;
        try {
          const response = await fetch('/api/inspect', { cache: 'no-store' });
          if (response.status === 401) { setError('No conversation yet. Open the chat first, then come back here.'); setLive(false); }
          else if (!response.ok) { setError('The agent log is unavailable right now.'); setLive(false); }
          else {
            const next = await response.json() as Inspection;
            const received = Date.now();
            const served = next.generatedAt ? Date.parse(next.generatedAt) : NaN;
            if (Number.isFinite(served)) setSkew(served - received);
            setNow(received);
            setData(next); setError(undefined); setLive(true);
          }
        } catch { setError('Lost the connection; retrying.'); setLive(false); }
      }
      if (!stopped) timer = setTimeout(load, 2000);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void load(); } };
    void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const rows = useMemo(() => [...(data?.items ?? [])].reverse(), [data]);
  const ticking = rows.some((item) => statusOf(item).tone === 'running');
  useEffect(() => {
    if (!ticking) return;
    const interval = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(interval);
  }, [ticking]);

  const serverNow = now + skew;
  const following = !picked || !rows.some((item) => item.id === picked);
  const selected = (!following && rows.find((item) => item.id === picked)) || rows.find((item) => item.kind === 'turn') || rows[0];

  const pick = (id: string) => {
    setPicked(id);
    if (window.matchMedia('(max-width: 859px)').matches) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const onListKey = (event: KeyboardEvent<HTMLOListElement>) => {
    if (event.key === 'Escape') { setPicked(undefined); return; }
    if (!['ArrowDown', 'ArrowUp', 'j', 'k', 'Home', 'End'].includes(event.key) || !rows.length) return;
    const index = Math.max(0, rows.findIndex((item) => item.id === selected?.id));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : event.key === 'ArrowDown' || event.key === 'j' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
    const target = rows[next];
    event.preventDefault();
    setPicked(target.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(target.id)}"]`)?.focus();
  };

  const settings: Settings = data?.state.settings ?? { personality: { id: 'default', label: 'Default' }, voice: '' };
  return (
    <div className="ins">
      <header className="ins-top">
        <div className="ins-brand">
          <a className="ins-home" href="/" aria-label="Persona"><PersonaMark /></a>
          <svg className="ins-slash" viewBox="0 0 12 24" aria-hidden="true"><path d="M8.5 4 3.5 20" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          <h1>Agent log</h1>
          <span className={`ins-live ${live ? 'on' : ''}`} title={live ? 'Updates every 2 seconds' : undefined}><i aria-hidden="true" />{live ? 'Live' : 'Paused'}</span>
        </div>
        <a className="ins-open" href="/">Open chat</a>
      </header>
      {error && <p className="ins-banner" role="status">{error}</p>}
      {data && <Stats summary={data.summary} />}
      <div className="ins-body">
        <section className="ins-list" aria-label="Activity">
          <div className="ins-list-head">
            <h2>Activity{data && <span>{rows.length}</span>}</h2>
            {following ? <span className="ins-follow-hint">Following latest</span>
              : <button type="button" className="ins-follow" onClick={() => setPicked(undefined)}>Jump to latest</button>}
          </div>
          {!data && !error && <p className="ins-empty">Loading the agent log…</p>}
          {data && rows.length === 0 && <p className="ins-empty">Nothing yet. Say hello in the chat and each turn will appear here as it runs.</p>}
          {rows.length > 0 && (
            <ol className="ins-rows" ref={listRef} onKeyDown={onListKey} aria-label="Turns, calls and events, newest first">
              {rows.map((item) => <Row key={item.id} item={item} selected={item.id === selected?.id} serverNow={serverNow} onPick={pick} />)}
            </ol>
          )}
        </section>
        <section className="ins-detail" ref={detailRef} aria-label="Details" aria-busy={!data}>
          <div className="ins-detail-in">
            {!selected ? <p className="ins-empty">{data ? 'Pick a row to see its trace.' : ''}</p>
              : selected.kind === 'turn' ? <TurnDetail key={selected.id} turn={selected} serverNow={serverNow} settings={settings} />
              : selected.kind === 'call' ? <CallDetail key={selected.id} call={selected} serverNow={serverNow} settings={settings} />
              : <EventDetail key={selected.id} event={selected} />}
          </div>
        </section>
        {data && <aside className="ins-side" aria-label="What the agent knows"><Knows data={data.state} /></aside>}
      </div>
    </div>
  );
}
