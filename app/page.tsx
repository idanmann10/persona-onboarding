'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { OnboardingProgress, TimelineItem } from '@/lib/domain/project';
import { reconcileFailedTurn } from '@/lib/ui/reconcile';
import { startBrowserCall, type VoiceController, type VoiceCallbacks } from '@/lib/voice/client';
import { Bubble, duration, TimelineEntry, type Toolkit } from './thread';

type Message = { id: string; role: 'user' | 'assistant'; text: string };
type FollowUpRequest = { kind: 'call_ended'; callId: string } | { kind: 'connection'; toolkit: Toolkit; acknowledge?: boolean };
type Snapshot = { messages: Message[]; timeline?: TimelineItem[]; progress?: OnboardingProgress; pendingFollowUps?: FollowUpRequest[] };
type Caption = { speaker: 'user' | 'assistant'; text: string };

const TOOLKIT_NAMES: Record<Toolkit, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };
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
  const [capabilities, setCapabilities] = useState({ text: false, voice: false, calendar: false, gmail: false });
  const [connections, setConnections] = useState({ calendar: false, gmail: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [connecting, setConnecting] = useState<Toolkit | null>(null);
  const [callPhase, setCallPhase] = useState<'idle' | 'connecting' | 'active' | 'ending'>('idle');
  const [liveCallId, setLiveCallId] = useState<string | undefined>();
  const [callStartedAt, setCallStartedAt] = useState<string | undefined>();
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [, setTick] = useState(0);
  const voiceRef = useRef<VoiceController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const followUpsRunning = useRef(false);

  const assistantName = progress && (progress.assistantName.status === 'confirmed' || progress.assistantName.status === 'tentative') && progress.assistantName.value ? progress.assistantName.value : 'Persona';

  const refresh = useCallback(async (): Promise<Snapshot | undefined> => {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (!response.ok) throw new Error('The conversation could not be loaded. Check the database setup.');
    const snapshot = await response.json() as Snapshot;
    setTimeline(snapshot.timeline ?? timelineFromMessages(snapshot.messages));
    if (snapshot.progress) setProgress(snapshot.progress);
    void fetch('/api/connections', { cache: 'no-store' }).then((result) => result.ok ? result.json() as Promise<{ calendar: boolean; gmail: boolean }> : null).then((status) => { if (status) setConnections(status); }).catch(() => undefined);
    return snapshot;
  }, []);

  const runFollowUps = useCallback(async (requests: FollowUpRequest[]) => {
    if (!requests.length || followUpsRunning.current) return;
    followUpsRunning.current = true;
    try {
      for (const request of requests) {
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
      .then((snapshot) => { if (active && snapshot?.pendingFollowUps?.length) void runFollowUps(snapshot.pendingFollowUps); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'The conversation could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    fetch('/api/capabilities', { cache: 'no-store' })
      .then((response) => response.json() as Promise<typeof capabilities>)
      .then((result) => { if (active) setCapabilities(result); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [refresh, runFollowUps]);

  const scrolledOnce = useRef(false);
  useEffect(() => {
    if (loading) return;
    endRef.current?.scrollIntoView({ behavior: scrolledOnce.current ? 'smooth' : 'auto', block: 'end' });
    scrolledOnce.current = true;
  }, [timeline, draft, captions, thinking, loading]);

  useEffect(() => {
    if (callPhase !== 'active') return;
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [callPhase]);

  useEffect(() => {
    const onHide = () => voiceRef.current?.abandon();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'persona-connection') return;
      const toolkit = event.data.toolkit === 'gmail' || event.data.toolkit === 'calendar' ? event.data.toolkit as Toolkit : undefined;
      voiceRef.current?.setBusy(false);
      setConnecting(null);
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
    if (!capabilities.voice || callPhase !== 'idle') return;
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
        fetchFn: fetch,
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

  async function connect(toolkit: Toolkit) {
    if (!capabilities[toolkit] || connecting) return;
    setConnecting(toolkit);
    setError('');
    const popup = window.open('about:blank', 'persona-connect', 'popup,width=520,height=720');
    try {
      const response = await post('/api/connections', { toolkit });
      if (!response.ok) throw new Error('The connection could not be started.');
      const { redirectUrl } = await response.json() as { redirectUrl: string };
      if (popup && !popup.closed) {
        popup.location.href = redirectUrl;
        voiceRef.current?.setBusy(true);
        const watcher = setInterval(() => {
          if (!popup.closed) return;
          clearInterval(watcher);
          voiceRef.current?.setBusy(false);
          setConnecting(null);
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

  async function declineConnection(toolkit: Toolkit) {
    await post('/api/connections/decline', { toolkit }).catch(() => undefined);
    await refresh().catch(() => undefined);
  }

  async function disconnect(toolkit: Toolkit) {
    if (connecting) return;
    setConnecting(toolkit);
    setError('');
    try {
      const response = await post('/api/connections', { toolkit }, 'DELETE');
      if (!response.ok) throw new Error('The account could not be disconnected.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The account could not be disconnected.'); }
    finally { setConnecting(null); }
  }

  async function deleteConversation() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    if (callPhase !== 'idle') return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch('/api/session', { method: 'DELETE' });
      if (!response.ok) throw new Error('The conversation could not be deleted. Please try again.');
      window.location.assign('/');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Deletion failed.'); setDeleting(false); }
  }

  const onCall = callPhase !== 'idle';
  const busy = sending || loading || deleting;
  const callLabel = callPhase === 'active' ? 'Hang up' : callPhase === 'connecting' ? 'Connecting…' : callPhase === 'ending' ? 'Ending…' : 'Call';

  return (
    <main className="app">
      <header className="topbar">
        <div className="identity">
          <span className="orb" aria-hidden="true" />
          <span className="identity-text"><strong>{assistantName}</strong><small>{callPhase === 'active' ? `On a call · ${duration(callStartedAt)}` : assistantName === 'Persona' ? 'Your new assistant' : 'Your Persona assistant'}</small></span>
        </div>
        <div className="topbar-actions">
          <button className={`call-button${onCall ? ' live' : ''}`} type="button" onClick={() => void startCall()} disabled={(!capabilities.voice && !onCall) || callPhase === 'connecting' || callPhase === 'ending'} title={capabilities.voice ? 'Start or end a browser call' : 'Voice needs a server API key'}>
            <span aria-hidden="true">✆</span> {callLabel}{!capabilities.voice && !onCall ? <span className="soon"> · setup needed</span> : null}
          </button>
          <button className="menu-button" type="button" aria-label="Settings" aria-expanded={menuOpen} onClick={() => { setMenuOpen((open) => !open); setConfirmDelete(false); }}>⋯</button>
        </div>
        {menuOpen ? (
          <section className="menu" aria-label="Connections and privacy">
            <strong>Connections</strong>
            <p>Optional and read-only. Connect an account only when it helps.</p>
            {(['gmail', 'calendar'] as const).map((toolkit) => (
              <div className="menu-row" key={toolkit}>
                <span>{TOOLKIT_NAMES[toolkit]}</span>
                <button type="button" disabled={(!connections[toolkit] && !capabilities[toolkit]) || Boolean(connecting)} onClick={() => void (connections[toolkit] ? disconnect(toolkit) : connect(toolkit))}>
                  {connecting === toolkit ? 'Working…' : connections[toolkit] ? 'Disconnect' : !capabilities[toolkit] ? 'Setup needed' : 'Connect'}
                </button>
              </div>
            ))}
            <div className="menu-row danger">
              <span>{confirmDelete ? 'This also removes connected accounts.' : 'Delete this conversation'}</span>
              <button type="button" disabled={deleting || onCall} onClick={() => void deleteConversation()}>{deleting ? 'Deleting…' : confirmDelete ? 'Confirm delete' : 'Delete'}</button>
            </div>
          </section>
        ) : null}
      </header>

      {onCall ? (
        <section className="live-call" aria-live="polite" aria-label="Live call">
          <div className="live-head"><span className="pulse" aria-hidden="true" />{callPhase === 'connecting' ? 'Connecting…' : callPhase === 'ending' ? 'Ending call…' : `Live with ${assistantName}`}<span className="live-time">{callPhase === 'active' ? duration(callStartedAt) : ''}</span></div>
          <div className="captions">
            {captions.length ? captions.slice(-3).map((caption, index) => <p key={index} className={caption.speaker}><b>{caption.speaker === 'user' ? 'You' : assistantName}</b> {caption.text}</p>) : <p className="muted">{callPhase === 'active' ? 'Say hello, or type below. Your text goes into the call.' : 'Setting up your microphone…'}</p>}
          </div>
        </section>
      ) : null}

      <div className="thread" aria-live="polite">
        <div className="thread-inner">
          {loading ? <p className="loading">Loading your conversation…</p> : null}
          {timeline.map((item) => (
            <TimelineEntry key={item.id} item={item} assistantName={assistantName} liveCallId={liveCallId} busy={busy || Boolean(connecting) || (item.kind === 'call_offer' && onCall)} connectable={{ gmail: capabilities.gmail, calendar: capabilities.calendar }}
              onAnswer={() => void startCall()} onDeclineCall={() => void declineCall()} onConnect={(toolkit) => void connect(toolkit)} onDeclineConnection={(toolkit) => void declineConnection(toolkit)} />
          ))}
          {draft ? <><Bubble speaker="user" text={draft.user.text} /><Bubble speaker="assistant" text={draft.assistant.text} pending /></> : null}
          {thinking && !draft ? <Bubble speaker="assistant" text="" /> : null}
          <div ref={endRef} />
        </div>
      </div>

      <div className="composer-area">
        {error ? <p className="error" role="alert">{error}</p> : null}
        <form className="composer" onSubmit={sendMessage}>
          <textarea aria-label={`Message ${assistantName}`} placeholder={callPhase === 'active' ? 'Type into the call…' : `Message ${assistantName}…`} rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onComposerKeyDown} disabled={loading || sending} />
          <button className="send-button" type="submit" aria-label="Send message" disabled={!input.trim() || loading || sending}>↑</button>
        </form>
        <p className="composer-note">Private preview · Enter to send, Shift+Enter for a new line</p>
      </div>
    </main>
  );
}
