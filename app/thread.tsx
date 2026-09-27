import type { CallEndReason } from '@/lib/domain/events';
import type { TimelineItem } from '@/lib/domain/project';

export type Toolkit = 'gmail' | 'calendar';

const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };

const ENDINGS: Record<CallEndReason, string> = {
  user_hangup: 'You hung up',
  remote_hangup: 'Call ended',
  expired: 'Call ended',
  connection_lost: 'Call dropped',
  lost: 'Call dropped',
  page_closed: 'Page closed',
  inactive: 'Ended after a quiet line',
  max_duration: 'Reached the time limit',
  content: 'Call stopped',
  setup_failed: "Couldn't connect",
};

export function duration(startedAt?: string, endedAt?: string): string {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.round(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function Bubble({ speaker, text, pending, label }: { speaker: 'user' | 'assistant'; text: string; pending?: boolean; label?: string }) {
  const parts = speaker === 'assistant' ? text.split(/\n{2,}/).filter((part) => part.trim()) : [text];
  if (!parts.length) return <div className="row assistant"><div className="bubble typing" aria-label="Persona is typing"><span /><span /><span /></div></div>;
  return (
    <>
      {label ? <p className="bubble-label">{label}</p> : null}
      {parts.map((part, index) => (
        <div className={`row ${speaker}`} key={index}>
          <div className={`bubble${pending ? ' pending' : ''}`}>{part}</div>
        </div>
      ))}
    </>
  );
}

interface ItemProps {
  item: TimelineItem;
  assistantName: string;
  liveCallId?: string;
  busy: boolean;
  connectable: Record<Toolkit, boolean>;
  onAnswer(): void;
  onDeclineCall(): void;
  onConnect(toolkit: Toolkit): void;
  onDeclineConnection(toolkit: Toolkit): void;
  onAutomation(action: 'approve' | 'decline' | 'disable' | 'run_now', id: string): void;
}

function nextRunLabel(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return `Next: ${date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

export function TimelineEntry({ item, assistantName, liveCallId, busy, connectable, onAnswer, onDeclineCall, onConnect, onDeclineConnection, onAutomation }: ItemProps) {
  switch (item.kind) {
    case 'message':
      return <Bubble speaker={item.speaker} text={item.text} label={item.origin === 'automation' ? 'Recurring task' : undefined} />;
    case 'automation': {
      if (item.status === 'declined') return <p className="system-line">Skipped “{item.title}”</p>;
      if (item.status === 'disabled') return <p className="system-line">Turned off “{item.title}”</p>;
      return (
        <div className="event-card offer-card">
          <div className="event-head">
            <span className="event-icon" aria-hidden="true">↻</span>
            <span><strong>{item.title}</strong><small>{item.schedule.charAt(0).toUpperCase() + item.schedule.slice(1)}{item.status === 'active' ? ` · ${nextRunLabel(item.nextRunAt)}` : ' in your time zone'}</small>{item.instruction ? <small>{item.instruction}</small> : null}</span>
          </div>
          <div className="event-actions">
            {item.status === 'proposed' ? (
              <>
                <button type="button" className="primary" onClick={() => onAutomation('approve', item.automationId)} disabled={busy}>Approve</button>
                <button type="button" className="quiet" onClick={() => onAutomation('decline', item.automationId)} disabled={busy}>Not now</button>
              </>
            ) : (
              <>
                <button type="button" className="primary" onClick={() => onAutomation('run_now', item.automationId)} disabled={busy}>Run now</button>
                <button type="button" className="quiet" onClick={() => onAutomation('disable', item.automationId)} disabled={busy}>Turn off</button>
              </>
            )}
          </div>
        </div>
      );
    }
    case 'automation_notice':
      return <p className="system-line">“{item.title}” couldn't run this time</p>;
    case 'call': {
      const call = item.call;
      if (call.callId === liveCallId) return null;
      const ended = call.phase === 'ended' || call.phase === 'dropped';
      const label = ended ? ENDINGS[call.reason ?? (call.phase === 'dropped' ? 'connection_lost' : 'remote_hangup')] : 'Call';
      return (
        <div className="event-card call-card">
          <div className="event-head">
            <span className="event-icon" aria-hidden="true">✆</span>
            <span><strong>Call with {assistantName}</strong><small>{[duration(call.startedAt, call.endedAt), label].filter(Boolean).join(' · ')}</small></span>
          </div>
          {call.utterances.length ? (
            <details className="transcript">
              <summary>Transcript</summary>
              {call.utterances.map((utterance, index) => (
                <p key={index} className={utterance.speaker}><b>{utterance.speaker === 'user' ? 'You' : assistantName}</b> {utterance.text}</p>
              ))}
            </details>
          ) : null}
        </div>
      );
    }
    case 'call_offer':
      if (item.status === 'answered') return null;
      if (item.status === 'declined') return <p className="system-line">Call declined</p>;
      return (
        <div className="event-card offer-card">
          <div className="event-head">
            <span className="orb small" aria-hidden="true" />
            <span><strong>{assistantName} is ready to call</strong><small>A short call in your browser. Answering asks for your microphone.</small></span>
          </div>
          <div className="event-actions">
            <button type="button" className="answer" onClick={onAnswer} disabled={busy}>Answer</button>
            <button type="button" className="quiet" onClick={onDeclineCall} disabled={busy}>Not now</button>
          </div>
        </div>
      );
    case 'connection_offer': {
      const name = TOOLKIT_NAMES[item.toolkit];
      if (item.status === 'connected') return null;
      if (item.status === 'declined') return <p className="system-line">Skipped {name} for now</p>;
      return (
        <div className="event-card offer-card">
          <div className="event-head">
            <span className="event-icon" aria-hidden="true">{item.toolkit === 'gmail' ? '✉' : '▦'}</span>
            <span><strong>Connect {name}</strong><small>{item.reason || `So ${assistantName} can help with this.`} Read-only, and you can disconnect anytime.</small></span>
          </div>
          <div className="event-actions">
            <button type="button" className="primary" onClick={() => onConnect(item.toolkit)} disabled={busy || !connectable[item.toolkit]}>{!connectable[item.toolkit] ? 'Setup needed' : item.status === 'failed' ? 'Try again' : `Connect ${name}`}</button>
            <button type="button" className="quiet" onClick={() => onDeclineConnection(item.toolkit)} disabled={busy}>Not now</button>
          </div>
        </div>
      );
    }
    case 'connection_notice': {
      const name = TOOLKIT_NAMES[item.toolkit];
      return <p className="system-line">{item.phase === 'connected' ? `${name} connected` : item.phase === 'failed' ? `${name} didn't connect` : `${name} disconnected`}</p>;
    }
  }
}
