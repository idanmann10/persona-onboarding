import type { ReactNode } from 'react';
import type { CallEndReason } from '@/lib/domain/events';
import type { TimelineItem } from '@/lib/domain/project';
import { PERSONALITIES, VOICES, avatarPalette, isPersonalityId, isVoiceId } from '@/lib/domain/persona';
import { Avatar } from './components/avatar';
import { PhoneIcon, RepeatIcon } from './components/icons';
import { ToolkitLogo } from './components/toolkit-logo';

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

const isAssistantMessage = (item?: TimelineItem) => item?.kind === 'message' && item.speaker === 'assistant';

/** Indexes of assistant messages that end a group: the small avatar sits next to each one, like iMessage group chats. */
export function assistantGroupEnds(timeline: TimelineItem[], pendingReply = false): Set<number> {
  const ends = new Set<number>();
  timeline.forEach((item, index) => {
    const last = index === timeline.length - 1;
    if (isAssistantMessage(item) && !(last ? pendingReply : isAssistantMessage(timeline[index + 1]))) ends.add(index);
  });
  return ends;
}

/** Who the assistant is, for the avatars in the thread. */
export interface Face { name: string; avatarUrl?: string }

/** Assistant rows keep a 24px slot; the avatar shows in it next to the last bubble of a group. */
function AvatarSlot({ face }: { face?: Face }) {
  return face ? <Avatar src={face.avatarUrl} name={face.name} size={24} className="avatar-tiny" /> : <span className="avatar-slot" aria-hidden="true" />;
}

export function Bubble({ speaker, text, pending, label, face, typingLabel = 'Persona is typing' }: { speaker: 'user' | 'assistant'; text: string; pending?: boolean; label?: string; face?: Face; typingLabel?: string }) {
  const parts = speaker === 'assistant' ? text.split(/\n{2,}/).filter((part) => part.trim()) : [text];
  if (!parts.length) return <div className="row assistant"><AvatarSlot face={face} /><div className="bubble typing" role="status" aria-label={typingLabel}><span /><span /><span /></div></div>;
  return (
    <>
      {label ? <p className="bubble-label">{label}</p> : null}
      {parts.map((part, index) => (
        <div className={`row ${speaker}`} key={index}>
          {speaker === 'assistant' ? <AvatarSlot face={index === parts.length - 1 ? face : undefined} /> : null}
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
  /** Set on the last assistant message of a group: the small avatar goes next to it. */
  face?: Face;
  /** The assistant's photo, for cards that show it. */
  avatarUrl?: string;
  onAnswer(): void;
  onDeclineCall(): void;
  onConnect(toolkit: Toolkit): void;
  onDeclineConnection(toolkit: Toolkit): void;
  onAutomation(action: 'approve' | 'decline' | 'disable' | 'run_now', id: string): void;
}

function settingsLine(key: string, value: string): string {
  if (key === 'assistant_name') return `Renamed to ${value}`;
  if (key === 'avatar') return /^(https?:|\/|data:image\/)/.test(value) ? 'New photo' : `New look: ${avatarPalette(value).label}`;
  if (key === 'personality') return `Personality: ${isPersonalityId(value) ? PERSONALITIES[value].label : 'your own description'}`;
  if (key === 'voice') return `Call voice: ${isVoiceId(value) ? VOICES[value].label : value}`;
  return 'Settings updated';
}

function nextRunLabel(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return `Next: ${date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function CardHead({ icon, title, children }: { icon: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="event-head">
      {icon}
      <span className="event-text"><strong>{title}</strong>{children}</span>
    </div>
  );
}

const iconTile = (glyph: ReactNode, tone = '') => <span className={`event-icon${tone ? ` ${tone}` : ''}`} aria-hidden="true">{glyph}</span>;

export function TimelineEntry({ item, assistantName, liveCallId, busy, face, avatarUrl, onAnswer, onDeclineCall, onConnect, onDeclineConnection, onAutomation }: ItemProps) {
  switch (item.kind) {
    case 'message':
      return <Bubble speaker={item.speaker} text={item.text} label={item.origin === 'automation' ? 'Recurring task' : undefined} face={face} />;
    case 'automation': {
      if (item.status === 'declined') return <p className="system-line">Skipped “{item.title}”</p>;
      if (item.status === 'disabled') return <p className="system-line">Turned off “{item.title}”</p>;
      return (
        <div className="event-card">
          <CardHead icon={iconTile(<RepeatIcon width={17} height={17} />, 'blue')} title={item.title}>
            <small>{item.schedule.charAt(0).toUpperCase() + item.schedule.slice(1)}{item.status === 'active' ? ` · ${nextRunLabel(item.nextRunAt)}` : ' in your time zone'}</small>
            {item.instruction ? <small className="event-detail">{item.instruction}</small> : null}
          </CardHead>
          <div className="event-actions">
            {item.status === 'proposed' ? (
              <>
                <button type="button" className="pill primary" onClick={() => onAutomation('approve', item.automationId)} disabled={busy}>Approve</button>
                <button type="button" className="pill" onClick={() => onAutomation('decline', item.automationId)} disabled={busy}>Not now</button>
              </>
            ) : (
              <>
                <button type="button" className="pill primary" onClick={() => onAutomation('run_now', item.automationId)} disabled={busy}>Run now</button>
                <button type="button" className="pill" onClick={() => onAutomation('disable', item.automationId)} disabled={busy}>Turn off</button>
              </>
            )}
          </div>
        </div>
      );
    }
    case 'automation_notice':
      return <p className="system-line">“{item.title}” couldn't run this time</p>;
    case 'settings_notice':
      return <p className="system-line">{settingsLine(item.key, item.value)}</p>;
    case 'setup_notice':
      return <p className="system-line">{item.phase === 'completed' ? "You're all set up" : 'Skipped the rest of setup'}</p>;
    case 'call': {
      const call = item.call;
      if (call.callId === liveCallId) return null;
      const ended = call.phase === 'ended' || call.phase === 'dropped';
      const label = ended ? ENDINGS[call.reason ?? (call.phase === 'dropped' ? 'connection_lost' : 'remote_hangup')] : 'Call';
      return (
        <div className="event-card call-card">
          <CardHead icon={iconTile(<PhoneIcon width={16} height={16} />, 'green')} title={`Call with ${assistantName}`}>
            <small>{[duration(call.startedAt, call.endedAt), label].filter(Boolean).join(' · ')}</small>
          </CardHead>
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
        <div className="event-card">
          <CardHead icon={<Avatar src={avatarUrl} name={assistantName} size={36} />} title={`${assistantName} is ready to call`}>
            <small>A short call in your browser. Answering asks for your microphone.</small>
          </CardHead>
          <div className="event-actions">
            <button type="button" className="pill primary" onClick={onAnswer} disabled={busy}><PhoneIcon width={15} height={15} /> Answer</button>
            <button type="button" className="pill" onClick={onDeclineCall} disabled={busy}>Not now</button>
          </div>
        </div>
      );
    case 'connection_offer': {
      const name = TOOLKIT_NAMES[item.toolkit];
      if (item.status === 'connected') return null;
      if (item.status === 'declined') return <p className="system-line">Skipped {name} for now</p>;
      return (
        <div className="event-card">
          <CardHead icon={iconTile(<ToolkitLogo toolkit={item.toolkit} size={20} />, 'logo')} title={`Connect ${name}`}>
            <small>{item.reason || `So ${assistantName} can help with this.`} Read-only. Start over disconnects it.</small>
          </CardHead>
          <div className="event-actions">
            <button type="button" className="pill primary" onClick={() => onConnect(item.toolkit)} disabled={busy}>{item.status === 'failed' ? 'Try again' : `Connect ${name}`}</button>
            <button type="button" className="pill" onClick={() => onDeclineConnection(item.toolkit)} disabled={busy}>Not now</button>
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
