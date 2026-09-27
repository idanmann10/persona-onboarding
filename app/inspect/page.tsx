'use client';

import { useEffect, useState } from 'react';
import type { CallItem, EventItem, LogItem, LogSummary, StepView, TurnItem } from '@/lib/observability/log';
import './inspect.css';

type Slot = { status: string; value?: string };
interface Inspection {
  state: {
    progress: { assistantName: Slot; preferredName: Slot; need: Slot; gmail: string; call: string; automation: { status: string; title?: string; schedule?: string } };
    settings: { assistantName?: string; personality: { id: string; label: string; text?: string }; voice: string };
    connections: Record<string, string>;
    facts: Array<{ key: string; value: string; evidence: string; provenance: string }>;
  };
  summary: LogSummary;
  items: LogItem[];
}

const ms = (value?: number) => value === undefined ? '–' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
const count = (value: number) => value >= 10_000 ? `${(value / 1000).toFixed(0)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const time = (iso?: string) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const humanize = (value: string) => value.replace(/_/g, ' ');

function StatusChip({ status }: { status: string }) {
  const label = status === 'ok' ? 'Done' : status === 'running' ? 'Running' : status === 'timeout' ? 'Timed out' : 'Error';
  return <span className={`ins-status ${status}`}>{label}</span>;
}

function Waterfall({ turn }: { turn: TurnItem }) {
  const total = Math.max(turn.durationMs ?? 0, ...turn.steps.map((step) => step.offsetMs + step.durationMs), 1);
  if (!turn.steps.length) return null;
  return (
    <div className="ins-waterfall" role="list" aria-label="Model steps">
      {turn.steps.map((step: StepView) => {
        const left = (step.offsetMs / total) * 100;
        const width = Math.max((step.durationMs / total) * 100, 1.5);
        const modelShare = step.durationMs ? Math.min(100, (step.modelMs / step.durationMs) * 100) : 100;
        return (
          <div className="ins-step" role="listitem" key={`${step.index}-${step.name}`}>
            <div className="ins-step-label">
              <span>{step.status === 'timeout' ? 'Stall' : `Step ${step.index}`}</span>
              <small>{ms(step.durationMs)}</small>
            </div>
            <div className="ins-track">
              <div className={`ins-bar ${step.status === 'timeout' ? 'stall' : ''}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} title={`model ${ms(step.modelMs)} · tools ${ms(step.toolMs)}`}>
                <span className="ins-bar-model" style={{ width: `${modelShare}%` }} />
                <span className="ins-bar-tool" style={{ width: `${100 - modelShare}%` }} />
              </div>
            </div>
            <div className="ins-step-meta">
              {step.status === 'timeout' ? 'stalled, retried once' : `${count(step.tokensIn)} in${step.cachedIn ? ` (${Math.round((step.cachedIn / Math.max(step.tokensIn, 1)) * 100)}% cached)` : ''} · ${count(step.tokensOut)} out${step.reasoningTokens ? ` · ${count(step.reasoningTokens)} reasoning` : ''}${step.finishReason ? ` · ${humanize(step.finishReason)}` : ''}`}
            </div>
          </div>
        );
      })}
      <div className="ins-legend" aria-hidden="true"><span><i className="model" />Model</span><span><i className="tool" />Tools</span></div>
    </div>
  );
}

function ToolLines({ tools }: { tools: Array<{ name: string; input: string; status: string; ms?: number; preview?: string }> }) {
  if (!tools.length) return null;
  return (
    <ul className="ins-tools">
      {tools.map((tool, index) => (
        <li key={index} title={tool.preview}>
          <span className="ins-tool-name">{tool.name}</span>
          <span className="ins-tool-input">{tool.input || '{}'}</span>
          <span className={`ins-tool-status ${/error|fail|invalid|refused|unavailable|rate/.test(tool.status) ? 'bad' : ''}`}>→ {humanize(tool.status)}</span>
          <span className="ins-tool-ms">{ms(tool.ms)}</span>
        </li>
      ))}
    </ul>
  );
}

function TurnCard({ turn }: { turn: TurnItem }) {
  const tools = turn.steps.flatMap((step) => step.tools);
  return (
    <article className={`ins-card turn ${turn.status}`}>
      <header className="ins-card-head">
        <div className="ins-card-title">
          <span className="ins-kind">{turn.name}</span>
          <time dateTime={turn.at}>{time(turn.at)}</time>
        </div>
        <div className="ins-chips">
          {turn.durationMs !== undefined && <span className="ins-chip">{ms(turn.durationMs)}</span>}
          {turn.firstTokenMs !== undefined && <span className="ins-chip">first token {ms(turn.firstTokenMs)}</span>}
          {turn.stalls > 0 && <span className="ins-chip bad">stalled ×{turn.stalls}</span>}
          <StatusChip status={turn.status} />
        </div>
      </header>
      {turn.userText && <p className="ins-user"><span>User</span>{turn.userText}</p>}
      {turn.trigger && <p className="ins-trigger"><span>Trigger</span>{turn.trigger}</p>}
      <Waterfall turn={turn} />
      <ToolLines tools={tools} />
      {turn.status === 'running'
        ? <p className="ins-reply pending">Thinking…</p>
        : turn.reply ? <p className="ins-reply">{turn.reply}</p> : turn.status === 'ok' ? <p className="ins-reply silent">Stayed silent</p> : null}
      {turn.error && <p className="ins-error">{turn.error}</p>}
      <footer className="ins-card-foot">
        <span>{turn.model ?? 'model'}</span>
        {turn.messageCount !== undefined && <span>{turn.messageCount} messages</span>}
        {turn.totals.tokensIn > 0 && <span>{count(turn.totals.tokensIn)} in · {count(turn.totals.tokensOut)} out</span>}
        {turn.toolsOffered.length > 0 && <span title={turn.toolsOffered.join(', ')}>{turn.toolsOffered.length} tools offered</span>}
      </footer>
      {turn.instructions && (
        <details className="ins-prompt">
          <summary>System prompt ({(turn.promptVersion ?? '').split('/').pop() || 'prompt'} · {turn.instructions.length.toLocaleString()} chars)</summary>
          <pre>{turn.instructions}</pre>
        </details>
      )}
    </article>
  );
}

function CallCard({ call }: { call: CallItem }) {
  const failed = call.setup?.status === 'error';
  return (
    <article className={`ins-card call ${failed ? 'error' : ''}`}>
      <header className="ins-card-head">
        <div className="ins-card-title">
          <span className="ins-kind">Call</span>
          <time dateTime={call.at}>{time(call.at)}</time>
        </div>
        <div className="ins-chips">
          {call.durationMs !== undefined && <span className="ins-chip">{ms(call.durationMs)}</span>}
          {call.setup?.ms !== undefined && <span className="ins-chip">setup {ms(call.setup.ms)}</span>}
          {call.reason && <span className="ins-chip">{humanize(call.reason)}</span>}
          <StatusChip status={failed ? 'error' : call.endedAt ? 'ok' : 'running'} />
        </div>
      </header>
      {call.setup && (
        <p className="ins-meta-line">
          {[call.setup.model, call.setup.voice && `voice ${call.setup.voice}`, call.setup.delegation && `delegation ${call.setup.delegation}`,
            call.setup.seededMessages !== undefined && `${call.setup.seededMessages} seeded messages`,
            call.setup.instructionsChars !== undefined && `${call.setup.instructionsChars.toLocaleString()} char instructions`].filter(Boolean).join(' · ')}
        </p>
      )}
      {call.setup?.error && <p className="ins-error">{call.setup.error}</p>}
      <ToolLines tools={call.tools} />
      {call.utterances.length > 0 && (
        <div className="ins-transcript">
          {call.utterances.map((line, index) => <p key={index} className={line.speaker}><b>{line.speaker === 'user' ? 'User' : 'Assistant'}</b>{line.text}</p>)}
        </div>
      )}
    </article>
  );
}

function EventRow({ event }: { event: EventItem }) {
  return (
    <div className={`ins-event ${event.tone}`}>
      <span className="ins-event-dot" aria-hidden="true" />
      <span className="ins-event-label">{event.label}</span>
      {event.detail && <span className="ins-event-detail">{event.detail}</span>}
      {event.tag && <span className="ins-tag">{event.tag}</span>}
      <time dateTime={event.at}>{time(event.at)}</time>
    </div>
  );
}

function Knows({ data }: { data: Inspection['state'] }) {
  const fact = (key: string) => data.facts.find((item) => item.key === key);
  const row = (label: string, value: string | undefined, tag?: string, tone?: string) => (
    <div className="ins-know" key={label}>
      <dt>{label}</dt>
      <dd className={value ? '' : 'empty'}>{value ?? 'Not yet'}{tag && <span className={`ins-tag ${tone ?? ''}`}>{humanize(tag)}</span>}</dd>
    </div>
  );
  const slot = (label: string, value: Slot, key: string) => {
    const saved = fact(key);
    return row(label, value.status === 'declined' ? 'Declined to share' : value.value, saved ? saved.provenance : value.status !== 'unknown' ? value.status : undefined);
  };
  const progress = data.progress;
  const automation = progress.automation;
  return (
    <aside className="ins-panel" aria-label="What the agent knows">
      <h2>What the agent knows</h2>
      <dl>
        {slot('Assistant name', progress.assistantName, 'assistant_name')}
        {slot('User name', progress.preferredName, fact('preferred_name') ? 'preferred_name' : 'name')}
        {slot('Need', progress.need, 'current_need')}
        {row('Gmail', progress.gmail === 'not_offered' ? undefined : humanize(progress.gmail), undefined)}
        {row('Call', progress.call === 'not_offered' ? undefined : humanize(progress.call), undefined)}
        {row('Recurring task', automation.status === 'none' ? undefined : `${automation.title ?? 'Task'}${automation.schedule ? ` · ${automation.schedule}` : ''}`, automation.status === 'none' ? undefined : automation.status)}
        {row('Personality', data.settings.personality.id === 'custom' ? data.settings.personality.text : data.settings.personality.label, fact('personality')?.provenance ?? 'default')}
        {row('Voice', data.settings.voice, fact('voice')?.provenance ?? 'default')}
      </dl>
    </aside>
  );
}

function Stats({ summary }: { summary: LogSummary }) {
  const stats: Array<[string, string, string?]> = [
    ['Turns', String(summary.turns)],
    ['Median reply', ms(summary.medianMs), summary.p95Ms !== undefined ? `p95 ${ms(summary.p95Ms)}` : undefined],
    ['First token', ms(summary.medianFirstTokenMs), 'median'],
    ['Tool calls', String(summary.toolCalls), `${summary.steps} steps`],
    ['Tokens', `${count(summary.tokensIn)} / ${count(summary.tokensOut)}`, summary.cachedPercent !== undefined ? `in / out · ${summary.cachedPercent}% cached` : 'in / out'],
    ['Calls', String(summary.calls)],
    ['Errors', String(summary.errors)],
  ];
  return (
    <section className="ins-stats" aria-label="Summary">
      {stats.map(([label, value, note]) => (
        <div key={label} className={`ins-stat ${label === 'Errors' && summary.errors ? 'bad' : ''}`}>
          <span>{label}</span>
          <strong>{value}</strong>
          {note && <small>{note}</small>}
        </div>
      ))}
    </section>
  );
}

export default function InspectPage() {
  const [data, setData] = useState<Inspection>();
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(true);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try {
          const response = await fetch('/api/inspect', { cache: 'no-store' });
          if (response.status === 401) { setError('No conversation yet. Open the chat first, then come back here.'); setLive(false); }
          else if (!response.ok) { setError('The agent log is unavailable right now.'); setLive(false); }
          else { setData(await response.json() as Inspection); setError(undefined); setLive(true); }
        } catch { setError('Lost the connection; retrying.'); setLive(false); }
      }
      if (!stopped) timer = setTimeout(load, 2000);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void load(); } };
    void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const items = data?.items ?? [];
  return (
    <div className="ins">
      <header className="ins-top">
        <div className="ins-brand">
          <span className="orb small" aria-hidden="true" />
          <div>
            <h1>Agent log</h1>
            <p><span className={`ins-live ${live ? 'on' : ''}`} aria-hidden="true" />{live ? 'Live, updates every 2 seconds' : 'Paused'}</p>
          </div>
        </div>
        <a className="ins-open" href="/">Open chat</a>
      </header>
      {error && <p className="ins-banner" role="status">{error}</p>}
      {data && <Stats summary={data.summary} />}
      <div className="ins-body">
        <main className="ins-timeline" aria-label="Timeline" aria-live="polite" aria-busy={!data}>
          {!data && !error && <p className="ins-empty">Loading the agent log…</p>}
          {data && items.length === 0 && <p className="ins-empty">Nothing yet. Say hello in the chat and each turn will appear here as it runs.</p>}
          {items.map((item) => item.kind === 'turn' ? <TurnCard key={item.id} turn={item} />
            : item.kind === 'call' ? <CallCard key={item.id} call={item} />
            : <EventRow key={item.id} event={item} />)}
        </main>
        {data && <Knows data={data.state} />}
      </div>
    </div>
  );
}
