'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from 'react';
import type { TimelineItem } from '@/lib/domain/project';
import { Avatar, avatarCandidates } from '../components/avatar';
import { ArrowUpIcon, CalendarIcon, CheckIcon, ChevronDownIcon, CloseIcon, KeyboardIcon, MailIcon, MicIcon, MicOffIcon, PhoneIcon } from '../components/icons';
import { duration, type Toolkit } from '../thread';
import { toolStatus } from './tool-status';
import type { CallCaption, CallFeed } from './use-call-feed';
import { useVoiceLevels } from './use-voice-levels';
import './call.css';

type Phase = 'idle' | 'connecting' | 'active' | 'ending';

export interface CallScreenProps {
  phase: Phase;
  name: string;
  avatarUrl?: string;
  /** When the line went live, for the timer. */
  startedAt?: string;
  feed: CallFeed;
  /** The thread, to tell whether a Connect button shown during the call is still waiting. */
  timeline: TimelineItem[];
  /** Google's sign-in window is open; the call's quiet-line timers are paused meanwhile. */
  signingIn: boolean;
  error?: string;
  /** Hang up, or cancel while the call is still connecting. */
  onHangUp(): void;
  onMute(muted: boolean): void;
  /** Sends typed text into the call; returns why it could not. */
  onType(text: string): string | undefined;
  onConnect(toolkit: Toolkit): void;
}

const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };
const isToolkit = (value: string): value is Toolkit => value === 'gmail' || value === 'calendar';
/** A finished tool's line stays up this long, so a quick one is still readable. */
const TOOL_LINGER_MS = 2_600;
/** A caption updated this recently is still being spoken: it shows a caret. */
const LIVE_CAPTION_MS = 1_500;
/** "Call ended" stays up this long before the screen fades, like a phone; a call that never connected just closes. */
const ENDED_HOLD_MS = 900;
const EXIT_MS = 320;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * The full-screen call, in the style of a phone call: the assistant's portrait over a blurred copy of itself,
 * a live waveform, captions from both sides, what the assistant is doing, and round glass controls.
 * It stays mounted briefly after the call so it can leave with a transition.
 */
export function CallScreen(props: CallScreenProps) {
  const live = props.phase !== 'idle';
  const [mounted, setMounted] = useState(live);
  const [leaving, setLeaving] = useState(false);
  const [connected, setConnected] = useState(false);
  // A new call remounts the view, so mute and the keyboard never carry over from the last one.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (props.phase === 'active') setConnected(true);
    if (live) {
      if (!mounted || leaving) setGeneration((value) => value + 1);
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const timer = setTimeout(() => { setMounted(false); setLeaving(false); setConnected(false); }, (connected ? ENDED_HOLD_MS : 0) + EXIT_MS);
    return () => clearTimeout(timer);
  }, [live, props.phase]); // Only the phase drives this; `mounted`, `leaving` and `connected` are its own bookkeeping.

  if (!mounted) return null;
  return <CallView key={generation} {...props} leaving={leaving} ended={leaving && connected} />;
}

function CallView({ phase, name, avatarUrl, startedAt, feed, timeline, signingIn, error, leaving, ended, onHangUp, onMute, onType, onConnect }: CallScreenProps & { leaving: boolean; ended: boolean }) {
  const reducedMotion = useReducedMotion();
  const { levels, subscribe, speaking } = useVoiceLevels(feed.state.audio, reducedMotion);
  const [minimized, setMinimized] = useState(false);
  const [muted, setMuted] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [typeError, setTypeError] = useState('');
  const [hiddenOffers, setHiddenOffers] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const typeRef = useRef<HTMLInputElement>(null);

  // Timer, caption carets and the tool line's linger all run off one coarse clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  // Loudness drives CSS variables (the portrait's halo, the minimized meter) every frame without re-rendering.
  useEffect(() => subscribe(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.setProperty('--al', levels.current.assistant.toFixed(3));
    root.style.setProperty('--ul', levels.current.user.toFixed(3));
  }), [levels, subscribe]);

  // Full screen is a modal dialog: the page behind is inert and focus stays in the call. Minimized, the chat is usable again.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!minimized && !dialog.open) dialog.showModal();
    else if (minimized && dialog.open) dialog.close();
  }, [minimized]);

  useEffect(() => { if (typing) typeRef.current?.focus(); }, [typing]);

  const active = phase === 'active' && !leaving;
  const status = leaving ? 'Call ended' : phase === 'connecting' ? 'Calling…' : phase === 'ending' ? 'Ending…' : duration(startedAt) || '0:00';

  // What the assistant is doing: the tool in flight, else the last one for a moment after it finished.
  const running = [...feed.state.tools].reverse().find((tool) => tool.status === 'running');
  const recent = feed.state.tools.at(-1);
  const tool = running ?? (recent && now - recent.updatedAt < TOOL_LINGER_MS ? recent : undefined);
  const activity = signingIn && active ? { state: 'running' as const, text: 'Waiting while you sign in to Google…' }
    : tool?.status === 'failed' ? { state: tool.status, text: "That didn't go through" }
      : tool ? { state: tool.status, text: toolStatus(tool.name, tool.arguments)[tool.status === 'running' ? 'running' : 'done'] }
        : undefined;

  const speakingLine = !active ? '' : speaking === 'assistant' ? `${name} is speaking` : speaking === 'user' ? 'You’re speaking' : muted ? 'You’re muted' : 'Listening';

  // A Connect button the assistant put up during the call, still waiting in the thread.
  const offers = active ? feed.state.offers.filter((toolkit): toolkit is Toolkit => isToolkit(toolkit) && !hiddenOffers.includes(toolkit) && offerWaiting(timeline, toolkit)) : [];

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    onMute(next);
  }

  function submitTyped(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const problem = onType(text);
    if (problem) { setTypeError(problem); return; }
    feed.addTyped(text);
    setDraft('');
    setTypeError('');
  }

  // Escape backs out of the keyboard first, then minimizes; it never ends the call.
  function onCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    if (typing) setTyping(false);
    else setMinimized(true);
  }

  const backdrop = avatarCandidates(avatarUrl).map((url) => `url("${url.replace(/"/g, '%22')}")`).join(', ');
  // With the keyboard or a Connect card open, the portrait steps back to leave room for the transcript.
  const compact = (typing && active) || offers.length > 0;
  const rootClass = ['call-root', leaving ? 'leaving' : '', ended ? 'ended' : '', compact ? 'compact' : '', speaking ? `speaking-${speaking}` : ''].filter(Boolean).join(' ');

  return (
    <div className={rootClass} ref={rootRef} data-phase={phase}>
      <dialog ref={dialogRef} className="call-screen" aria-label={`Call with ${name}`} onCancel={onCancel} onClose={() => { if (!leaving) setMinimized(true); }}>
        <div className="cs-backdrop" style={{ backgroundImage: backdrop }} aria-hidden="true" />
        <div className="cs-shade" aria-hidden="true" />

        <div className="cs-body">
          <div className="cs-top">
            <button type="button" className="cs-glass cs-round" onClick={() => setMinimized(true)} aria-label="Back to the chat. The call keeps going." title="Back to the chat">
              <ChevronDownIcon width={20} height={20} />
            </button>
            <span className="cs-kicker">Persona call</span>
            <span className="cs-round-spacer" aria-hidden="true" />
          </div>

          <div className="cs-hero">
            <div className="cs-portrait">
              <span className="cs-halo" aria-hidden="true" />
              <Avatar src={avatarUrl} name={name} size={176} className="cs-avatar" />
            </div>
            <h2 className="cs-name">{name}</h2>
            <p className="cs-status"><span className="cs-status-text">{status}</span>{muted && active ? <span className="cs-chip">Muted</span> : null}</p>
            <Waveform levels={levels} subscribe={subscribe} />
            <p className="cs-speaking" aria-hidden="true">{speakingLine}</p>
            <div className="cs-activity-slot" role="status" aria-live="polite">
              {activity ? (
                <span className={`cs-activity cs-glass ${activity.state}`} key={activity.text}>
                  {activity.state === 'running' ? <span className="cs-spinner" aria-hidden="true" /> : activity.state === 'done' ? <CheckIcon width={14} height={14} /> : <CloseIcon width={14} height={14} />}
                  {activity.text}
                </span>
              ) : null}
            </div>
          </div>

          <span className="cs-spacer" aria-hidden="true" />
          <Captions captions={feed.state.captions} name={name} now={now}
            hint={leaving ? '' : phase === 'connecting' ? 'Setting up your microphone…' : `Say hello, or tap Keyboard to type. ${name} hears both.`} />

          {offers.map((toolkit) => (
            <div className="cs-offer cs-glass" key={toolkit}>
              <span className="cs-offer-icon" aria-hidden="true">{toolkit === 'gmail' ? <MailIcon width={18} height={18} /> : <CalendarIcon width={18} height={18} />}</span>
              <span className="cs-offer-text"><strong>Connect {TOOLKIT_NAMES[toolkit]}</strong><small>Read-only. The call keeps going.</small></span>
              <button type="button" className="cs-offer-go" disabled={signingIn || !active} onClick={() => onConnect(toolkit)}>{signingIn ? 'Signing in…' : 'Connect'}</button>
              <button type="button" className="cs-offer-hide" aria-label={`Hide Connect ${TOOLKIT_NAMES[toolkit]}`} onClick={() => setHiddenOffers((list) => [...list, toolkit])}><CloseIcon width={14} height={14} /></button>
            </div>
          ))}

          {error && !leaving ? <p className="cs-error" role="alert">{error}</p> : null}

          {typing && active ? (
            <form className="cs-type cs-glass" onSubmit={submitTyped}>
              <input ref={typeRef} type="text" value={draft} maxLength={2_000} enterKeyHint="send" autoComplete="off" placeholder={`Type to ${name}…`} aria-label={`Type into the call with ${name}`}
                onChange={(event) => { setDraft(event.target.value); if (typeError) setTypeError(''); }} />
              <button type="submit" className="cs-send" aria-label="Send into the call" disabled={!draft.trim()}><ArrowUpIcon width={16} height={16} /></button>
              {typeError ? <p className="cs-type-error" role="alert">{typeError}</p> : null}
            </form>
          ) : null}

          <div className="cs-controls" role="group" aria-label="Call controls">
            <Control label={muted ? 'Unmute' : 'Mute'} pressed={muted} disabled={!active} onClick={toggleMute}>
              {muted ? <MicOffIcon width={26} height={26} /> : <MicIcon width={26} height={26} />}
            </Control>
            <Control label="Keyboard" expanded={typing} disabled={!active} onClick={() => setTyping((value) => !value)} title="Type into the call">
              <KeyboardIcon width={27} height={27} />
            </Control>
            <Control label={phase === 'connecting' ? 'Cancel' : 'End'} tone="end" disabled={phase === 'ending' || leaving} onClick={onHangUp} ariaLabel={phase === 'connecting' ? 'Cancel the call' : 'End call'}>
              <PhoneIcon width={30} height={30} className="cs-hangup-glyph" />
            </Control>
          </div>
        </div>
      </dialog>

      {minimized ? (
        <div className="cs-island" role="region" aria-label={`Call with ${name}`}>
          <button type="button" className="cs-island-open" onClick={() => setMinimized(false)} aria-label={`Open the call with ${name}`}>
            <Avatar src={avatarUrl} name={name} size={30} />
            <span className="cs-island-text">
              <strong>{name}</strong>
              <small>{activity?.text ?? (muted && active ? `${status} · Muted` : status)}</small>
            </span>
            <span className="cs-meter" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          </button>
          <button type="button" className="cs-island-end" onClick={onHangUp} disabled={phase === 'ending' || leaving} aria-label={phase === 'connecting' ? 'Cancel the call' : 'End call'}>
            <PhoneIcon width={17} height={17} className="cs-hangup-glyph" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function offerWaiting(timeline: TimelineItem[], toolkit: Toolkit): boolean {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.kind === 'connection_offer' && item.toolkit === toolkit) return item.status === 'pending' || item.status === 'failed';
  }
  // Not in the thread yet: the refresh that brings it is still on its way.
  return true;
}

function Control({ label, children, onClick, disabled, pressed, expanded, tone, title, ariaLabel }: { label: string; children: ReactNode; onClick(): void; disabled?: boolean; pressed?: boolean; expanded?: boolean; tone?: 'end'; title?: string; ariaLabel?: string }) {
  return (
    <button type="button" className={`cs-control${tone ? ` ${tone}` : ''}`} onClick={onClick} disabled={disabled} aria-pressed={pressed} aria-expanded={expanded} aria-label={ariaLabel} title={title}>
      <span className={`cs-disc${tone === 'end' ? '' : ' cs-glass'}`}>{children}</span>
      <span className="cs-control-label" aria-hidden={ariaLabel ? true : undefined}>{label}</span>
    </button>
  );
}

function Captions({ captions, name, now, hint }: { captions: CallCaption[]; name: string; now: number; hint: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Follow new lines unless the user scrolled up to reread.
  const following = useRef(true);
  useLayoutEffect(() => {
    const list = ref.current;
    if (list && following.current) list.scrollTop = list.scrollHeight;
  }, [captions]);
  // The panel also shrinks when the keyboard or a Connect card opens: stay on the latest line.
  useEffect(() => {
    const list = ref.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (following.current) list.scrollTop = list.scrollHeight; });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // The glass frame stays put while the lines scroll inside it.
  return (
    <div className="cs-captions cs-glass">
      <div className="cs-captions-scroll" ref={ref} role="log" aria-live="off" aria-label="Live transcript" tabIndex={0}
        onScroll={(event) => { const list = event.currentTarget; following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40; }}>
        {captions.length ? captions.map((caption) => (
          <p key={caption.id} className={`cs-line ${caption.speaker}${!caption.typed && now - caption.updatedAt < LIVE_CAPTION_MS ? ' live' : ''}`}>
            <b>{caption.speaker === 'user' ? (caption.typed ? 'You typed' : 'You') : name}</b>
            <span>{caption.text}</span>
          </p>
        )) : hint ? <p className="cs-line cs-hint">{hint}</p> : null}
      </div>
    </div>
  );
}

const ASSISTANT_COLOR = '#ffffff';
const USER_COLOR = '#30d158';
const IDLE_COLOR = 'rgba(255, 255, 255, 0.34)';

/** A scrolling bar waveform of the last few seconds: white bars are the assistant, green bars are the user. */
function Waveform({ levels, subscribe }: Pick<ReturnType<typeof useVoiceLevels>, 'levels' | 'subscribe'>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let width = 0;
    let height = 0;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(canvas);
    const draw = () => {
      context.clearRect(0, 0, width, height);
      const step = 6;
      const bar = 3;
      const count = Math.max(1, Math.floor(width / step));
      const { history } = levels;
      const offset = (width - count * step + (step - bar)) / 2;
      for (let index = 0; index < count; index++) {
        const sample = history[history.length - count + index];
        const assistant = sample?.assistant ?? 0;
        const user = sample?.user ?? 0;
        const level = Math.max(assistant, user);
        const barHeight = Math.max(bar, Math.pow(level, 1.15) * (height - 2));
        // Older bars fade toward the left edge.
        context.globalAlpha = 0.25 + 0.75 * ((index + 1) / count);
        context.fillStyle = level < 0.06 ? IDLE_COLOR : user > assistant ? USER_COLOR : ASSISTANT_COLOR;
        const x = offset + index * step;
        const y = (height - barHeight) / 2;
        context.beginPath();
        if (context.roundRect) context.roundRect(x, y, bar, barHeight, bar / 2);
        else context.rect(x, y, bar, barHeight);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    draw();
    const unsubscribe = subscribe(draw);
    return () => { unsubscribe(); observer?.disconnect(); };
  }, [levels, subscribe]);

  return <canvas ref={canvasRef} className="cs-wave" aria-hidden="true" />;
}
