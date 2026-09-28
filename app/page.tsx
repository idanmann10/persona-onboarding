'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { OnboardingProgress, TimelineItem } from '@/lib/domain/project';
import { reconcileFailedTurn } from '@/lib/ui/reconcile';
import { startBrowserCall, type VoiceController, type VoiceCallbacks } from '@/lib/voice/client';
import type { PersonaSettings } from '@/lib/domain/persona';
import { assistantGroupEnds, Bubble, duration, TimelineEntry, type Face, type Toolkit } from './thread';
import { Avatar } from './components/avatar';
import { ConnectionsSheet } from './components/connections-sheet';
import { AppsIcon, ArrowUpIcon, PersonaMark, PhoneIcon } from './components/icons';

type Message = { id: string; role: 'user' | 'assistant'; text: string };
type FollowUpRequest = { kind: 'call_ended'; callId: string } | { kind: 'connection'; toolkit: Toolkit; acknowledge?: boolean };
/** `avatarUrl` is the assistant's photo, served by `/api/session`. */
type Settings = PersonaSettings & { avatarUrl?: string };
type Snapshot = { messages: Message[]; timeline?: TimelineItem[]; progress?: OnboardingProgress; settings?: Settings; pendingFollowUps?: FollowUpRequest[]; automationDue?: boolean; account?: { email: string } | null };
type Caption = { speaker: 'user' | 'assistant'; text: string };

const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };
const isToolkit = (value: unknown): value is Toolkit => value === 'gmail' || value === 'calendar';
const post = (url: string, body: unknown, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function timelineFromMessages(messages: Message[]): TimelineItem[] {
  return messages.map((message) => ({ kind: 'message', id: message.id, speaker: message.role, channel: 'text', text: message.text }));
}

export default function Home() {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [draft, setDraft] = useState<{ user: Message; assistant: Message } | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>();
  // The signed-in Google account (sign-in comes before chat; see proxy.ts).
  const [account, setAccount] = useState<{ email: string } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [appsVersion, setAppsVersion] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [callPhase, setCallPhase] = useState<'idle' | 'connecting' | 'active' | 'ending'>('idle');
  const [liveCallId, setLiveCallId] = useState<string | undefined>();
  const [callStartedAt, setCallStartedAt] = useState<string | undefined>();
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [, setTick] = useState(0);
  const voiceRef = useRef<VoiceController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const appsButtonRef = useRef<HTMLButtonElement>(null);
  const followUpsRunning = useRef(false);
  const followUpQueue = useRef<FollowUpRequest[]>([]);

  const assistantName = progress && (progress.assistantName.status === 'confirmed' || progress.assistantName.status === 'tentative') && progress.assistantName.value ? progress.assistantName.value : 'Persona';

  const refresh = useCallback(async (): Promise<Snapshot | undefined> => {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (response.status === 401) { window.location.replace('/sign-in'); return undefined; }
    if (!response.ok) throw new Error('The conversation could not be loaded. Check the database setup.');
    const snapshot = await response.json() as Snapshot;
    setTimeline(snapshot.timeline ?? timelineFromMessages(snapshot.messages));
    if (snapshot.progress) setProgress(snapshot.progress);
    if (snapshot.settings) setAvatarUrl(snapshot.settings.avatarUrl || undefined);
    setAccount(snapshot.account ?? null);
    return snapshot;
  }, []);

  const runFollowUps = useCallback(async (requests: FollowUpRequest[]) => {
    // Queue rather than drop: a connection can finish while a call's follow-up is still running.
    followUpQueue.current.push(...requests);
    if (followUpsRunning.current) return;
    followUpsRunning.current = true;
    try {
      for (let request = followUpQueue.current.shift(); request; request = followUpQueue.current.shift()) {
        setThinking(!('acknowledge' in request && request.acknowledge));
        const response = await post('/api/agent/follow-up', request).catch(() => undefined);
        if (response?.ok) await refresh();
      }
    } finally {
      followUpsRunning.current = false;
      setThinking(false);
    }
  }, [refresh]);

  useEffect(() => {
    let active = true;
    refresh()
      .then(async (snapshot) => {
        if (!active || !snapshot) return;
        if (snapshot.pendingFollowUps?.length) await runFollowUps(snapshot.pendingFollowUps);
        if (snapshot.automationDue) {
          setThinking(true);
          const response = await post('/api/automations', { action: 'run_due' }).catch(() => undefined);
          setThinking(false);
          if (response?.ok) await refresh();
        }
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'The conversation could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh, runFollowUps]);

  const scrolledOnce = useRef(false);
  useEffect(() => {
    if (loading) return;
    endRef.current?.scrollIntoView({ behavior: scrolledOnce.current ? 'smooth' : 'auto', block: 'end' });
    scrolledOnce.current = true;
  }, [timeline, draft, thinking, loading]);

  useEffect(() => {
    if (callPhase !== 'active') return;
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [callPhase]);

  // The header and composer float over the thread as glass: keep the thread's padding equal to their height.
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const sync = () => {
      app.style.setProperty('--top-h', `${topRef.current?.offsetHeight ?? 0}px`);
      app.style.setProperty('--bottom-h', `${bottomRef.current?.offsetHeight ?? 0}px`);
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    if (topRef.current) observer.observe(topRef.current);
    if (bottomRef.current) observer.observe(bottomRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onHide = () => voiceRef.current?.abandon();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'persona-connection') return;
      const slug: unknown = event.data.toolkit;
      const toolkit = isToolkit(slug) ? slug : undefined;
      voiceRef.current?.setBusy(false);
      setConnecting(null);
      setAppsVersion((value) => value + 1);
      void refresh().then(() => {
        if (!toolkit) return;
        if (voiceRef.current && event.data.status === 'connected') {
          voiceRef.current.notify(`The user just connected ${TOOLKIT_NAMES[toolkit]}, and the app confirmed it. Tell them briefly and offer to take a look for them.`);
          void runFollowUps([{ kind: 'connection', toolkit, acknowledge: true }]);
        } else void runFollowUps([{ kind: 'connection', toolkit }]);
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refresh, runFollowUps]);

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || sending || loading) return;
    const id = crypto.randomUUID();
    setInput('');
    setError('');
    if (voiceRef.current && callPhase === 'active') {
      if (text.length > 2_000) { setInput(text); setError('That is too long to send into the call. Keep it under 2,000 characters, or send it after the call.'); return; }
      voiceRef.current.addTextContext(text);
      setTimeline((current) => [...current, { kind: 'message', id, speaker: 'user', channel: 'text', text }]);
      await post('/api/voice/event', { callId: voiceRef.current.callId, kind: 'typed', messageId: id, text }).catch(() => undefined);
      return;
    }
    const answerId = `answer:${id}`;
    setSending(true);
    setDraft({ user: { id, role: 'user', text }, assistant: { id: answerId, role: 'assistant', text: '' } });
    try {
      const response = await post('/api/chat', { id, text });
      if (!response.ok) throw new Error(response.status === 503 ? 'The text model is not configured yet.' : response.status === 429 ? 'Too many messages right now. Please try again shortly.' : 'The reply could not be started.');
      if (!response.body) throw new Error('The reply stream is unavailable.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setDraft((current) => current ? { ...current, assistant: { ...current.assistant, text: current.assistant.text + chunk } } : current);
      }
      await refresh();
      setDraft(null);
    } catch (cause) {
      try {
        const snapshot = await refresh();
        const reconciled = reconcileFailedTurn(snapshot?.messages ?? [], id, text);
        if (reconciled.input) setInput(reconciled.input);
      } catch { setInput(text); }
      setDraft(null);
      setError(cause instanceof Error ? cause.message : 'The reply failed.');
    } finally { setSending(false); }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  }

  async function startCall() {
    if (voiceRef.current) { await voiceRef.current.close(); return; }
    if (callPhase !== 'idle') return;
    setError('');
    setCaptions([]);
    let callId: string | undefined;
    const callbacks: VoiceCallbacks = {
      onPhase: (phase) => {
        if (phase === 'connecting' || phase === 'ending') setCallPhase(phase);
        else if (phase === 'active') { setCallPhase('active'); setCallStartedAt(new Date().toISOString()); }
        else {
          voiceRef.current = null;
          setCallPhase('idle');
          setLiveCallId(undefined);
          setCaptions([]);
          void refresh().then(() => { if (callId) void runFollowUps([{ kind: 'call_ended', callId }]); }).catch(() => undefined);
        }
      },
      onCaption: (fragment) => setCaptions((current) => {
        const last = current.at(-1);
        if (last?.speaker === fragment.speaker) return [...current.slice(0, -1), { speaker: last.speaker, text: last.text + fragment.text }];
        return [...current.slice(-7), { speaker: fragment.speaker, text: fragment.text }];
      }),
      onToolUi: () => { void refresh(); },
    };
    try {
      const controller = await startBrowserCall(callbacks, {
        createPeer: () => new RTCPeerConnection(),
        getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
        createAudio: () => new Audio(),
        fetchFn: (input, init) => fetch(input, init),
      });
      voiceRef.current = controller;
      callId = controller.callId;
      setLiveCallId(controller.callId);
      void refresh();
    } catch (cause) {
      setCallPhase('idle');
      setError(cause instanceof Error ? cause.message : 'The call could not connect.');
    }
  }

  async function declineCall() {
    await fetch('/api/voice/offer', { method: 'DELETE' }).catch(() => undefined);
    await refresh().catch(() => undefined);
  }

  /** Opens the sign-in window for any app slug: Gmail and Calendar from the thread, the rest from the Apps sheet. */
  async function connect(toolkit: string) {
    if (connecting) return;
    setConnecting(toolkit);
    setError('');
    const popup = window.open('about:blank', 'persona-connect', 'popup,width=520,height=720');
    try {
      const response = await post('/api/connections', { toolkit });
      if (!response.ok) throw new Error((await response.text().catch(() => '')).trim() || 'The connection could not be started.');
      const { redirectUrl } = await response.json() as { redirectUrl: string };
      if (popup?.closed) {
        // The user closed the sign-in window while it was loading: treat it as cancelled.
        setConnecting(null);
        return;
      }
      if (popup) {
        popup.location.href = redirectUrl;
        voiceRef.current?.setBusy(true);
        const watcher = setInterval(() => {
          if (!popup.closed) return;
          clearInterval(watcher);
          voiceRef.current?.setBusy(false);
          setConnecting(null);
          setAppsVersion((value) => value + 1);
          void refresh().catch(() => undefined);
        }, 600);
      } else if (voiceRef.current) {
        throw new Error('Your browser blocked the sign-in window. Allow pop-ups for this site to connect without ending the call.');
      } else window.location.assign(redirectUrl);
    } catch (cause) {
      popup?.close();
      setError(cause instanceof Error ? cause.message : 'The connection could not be started.');
      setConnecting(null);
    }
  }

  async function automation(action: 'approve' | 'decline' | 'disable' | 'run_now', id: string) {
    setError('');
    if (action === 'run_now') setThinking(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response = await post('/api/automations', { action, id, ...(action === 'approve' ? { timezone } : {}) });
      if (!response.ok && response.status !== 409) throw new Error(response.status === 503 ? 'The text model is not configured yet.' : response.status === 429 ? 'Too many requests right now. Please try again shortly.' : 'That did not go through. Please try again.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'That did not go through.'); }
    finally { setThinking(false); }
  }

  async function declineConnection(toolkit: Toolkit) {
    await post('/api/connections/decline', { toolkit }).catch(() => undefined);
    await refresh().catch(() => undefined);
  }

  /** Start over: clears the conversation and revokes connected accounts, then reloads a fresh chat. */
  /** Sign out of this browser only: the conversation and its accounts stay, and signing in with the same Google account brings them back. */
  async function signOut() {
    if (signingOut || callPhase !== 'idle') return;
    setSigningOut(true);
    setError('');
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST' });
      if (!response.ok) throw new Error('Signing out did not go through. Please try again.');
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Signing out failed.'); setSigningOut(false); }
  }

  async function startOver() {
    if (callPhase !== 'idle') return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch('/api/session', { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.text().catch(() => '')).trim() || 'The conversation could not be cleared. Please try again.');
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Starting over failed.'); setDeleting(false); setConfirmDelete(false); }
  }

  function closeApps() {
    setAppsOpen(false);
    appsButtonRef.current?.focus();
  }

  const onCall = callPhase !== 'idle';
  const busy = sending || loading || deleting;
  const face: Face = { name: assistantName, avatarUrl };
  const groupEnds = assistantGroupEnds(timeline, thinking && !draft);
  const callLabel = callPhase === 'active' ? 'Hang up' : callPhase === 'connecting' ? 'Connecting…' : callPhase === 'ending' ? 'Ending…' : 'Call';
  const subtitle = callPhase === 'active' ? `On a call · ${duration(callStartedAt)}` : assistantName === 'Persona' ? 'Your new assistant' : 'Your Persona assistant';

  return (
    <main className={`app${onCall ? ' on-call' : ''}`} ref={appRef}>
      <div className="top-stack" ref={topRef}>
        <header className="topbar">
          <div className="topbar-inner">
            <span className="brand" aria-label="Persona"><PersonaMark className="brand-mark" /><span className="brand-word" aria-hidden="true">Persona</span></span>
            <div className="identity">
              <Avatar src={avatarUrl} name={assistantName} size={36} />
              <span className="identity-text"><strong>{assistantName}</strong><small>{subtitle}</small></span>
            </div>
            <div className="topbar-actions">
              {confirmDelete ? (
                <span className="confirm" role="group" aria-label="Start over">
                  <span className="confirm-text">Clear the chat and disconnect accounts?</span>
                  <button type="button" className="pill danger" disabled={deleting || onCall} onClick={() => void startOver()}>{deleting ? 'Clearing…' : 'Start over'}</button>
                  <button type="button" className="pill" disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              ) : (
                <>
                  <button ref={appsButtonRef} type="button" className="pill" aria-haspopup="dialog" aria-expanded={appsOpen} disabled={deleting} onClick={() => { setError(''); setAppsOpen(true); }}><AppsIcon className="pill-icon" width={15} height={15} />Apps</button>
                  <a className="pill" href="/inspect" target="_blank" rel="noreferrer">Agent log</a>
                  {account ? (
                    <span className="account" title={`Signed in as ${account.email}`}>
                      <span className="account-email">{account.email}</span>
                      <button type="button" className="pill" disabled={signingOut || onCall} onClick={() => void signOut()}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
                    </span>
                  ) : null}
                  <button type="button" className="pill" disabled={busy || onCall} onClick={() => { setError(''); setConfirmDelete(true); }}>Start over</button>
                </>
              )}
            </div>
            <button className={`call-button glass${onCall ? ' live' : ''}`} type="button" onClick={() => void startCall()} disabled={callPhase === 'connecting' || callPhase === 'ending'} title="Start or end a browser call">
              {onCall ? <span className="live-dot" aria-hidden="true" /> : <PhoneIcon className="call-glyph" width={15} height={15} />}
              {callLabel}
            </button>
          </div>
        </header>

        {onCall ? (
          <section className="live-call glass" aria-live="polite" aria-label="Live call">
            <div className="live-head">
              <Avatar src={avatarUrl} name={assistantName} size={28} />
              <span className="live-title">{callPhase === 'connecting' ? 'Connecting…' : callPhase === 'ending' ? 'Ending call…' : `Live with ${assistantName}`}</span>
              <span className="live-time"><span className="live-dot" aria-hidden="true" />{callPhase === 'active' ? duration(callStartedAt) : ''}</span>
            </div>
            <div className="captions">
              {captions.length ? captions.slice(-3).map((caption, index) => <p key={index} className={caption.speaker}><b>{caption.speaker === 'user' ? 'You' : assistantName}</b> {caption.text.length > 240 ? `…${caption.text.slice(-240)}` : caption.text}</p>) : <p className="muted">{callPhase === 'active' ? 'Say hello, or type below. Your text goes into the call.' : 'Setting up your microphone…'}</p>}
            </div>
          </section>
        ) : null}
      </div>

      <div className="thread" aria-live="polite">
        <div className="thread-inner">
          {loading ? <p className="loading">Loading your conversation…</p> : null}
          {timeline.map((item, index) => (
            <TimelineEntry key={item.id} item={item} assistantName={assistantName} liveCallId={liveCallId} busy={busy || Boolean(connecting) || (item.kind === 'call_offer' && onCall)}
              avatarUrl={avatarUrl} face={groupEnds.has(index) ? face : undefined}
              onAnswer={() => void startCall()} onDeclineCall={() => void declineCall()} onConnect={(toolkit) => void connect(toolkit)} onDeclineConnection={(toolkit) => void declineConnection(toolkit)} onAutomation={(action, id) => void automation(action, id)} />
          ))}
          {draft ? <><Bubble speaker="user" text={draft.user.text} /><Bubble speaker="assistant" text={draft.assistant.text} pending face={face} typingLabel={`${assistantName} is typing`} /></> : null}
          {thinking && !draft ? <Bubble speaker="assistant" text="" face={face} typingLabel={`${assistantName} is typing`} /> : null}
          <div className="thread-end" ref={endRef} />
        </div>
      </div>

      <div className="composer-area" ref={bottomRef}>
        <div className="composer-inner">
          {error ? <p className="error" role="alert">{error}</p> : null}
          <form className="composer glass" onSubmit={sendMessage}>
            <textarea maxLength={8_000} aria-label={`Message ${assistantName}`} placeholder={callPhase === 'active' ? 'Type into the call…' : `Message ${assistantName}`} rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onComposerKeyDown} disabled={loading || sending} />
            <button className="send-button" type="submit" aria-label="Send message" disabled={!input.trim() || loading || sending}><ArrowUpIcon width={17} height={17} /></button>
          </form>
          <p className="composer-note">Private preview · Enter to send, Shift+Enter for a new line</p>
        </div>
      </div>

      {appsOpen ? <ConnectionsSheet connecting={connecting} version={appsVersion} onConnect={(slug) => void connect(slug)} onChanged={() => void refresh().catch(() => undefined)} onClose={closeApps} /> : null}
    </main>
  );
}
