'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { reconcileFailedTurn } from '@/lib/ui/reconcile';
import { startBrowserCall, type VoiceController, type VoiceCallbacks } from '@/lib/voice/client';

type Message = { id: string; role: 'user' | 'assistant'; text: string };
type VoiceFragment = { speaker?: 'user' | 'assistant'; text: string; startMs?: number; endMs?: number; callId?: string };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [connectable, setConnectable] = useState({ calendar: false, gmail: false });
  const [connections, setConnections] = useState({ calendar: false, gmail: false });
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connecting, setConnecting] = useState<'calendar' | 'gmail' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [callPhase, setCallPhase] = useState<'idle' | 'connecting' | 'active' | 'ending' | 'ended' | 'dropped'>('idle');
  const [voiceFragments, setVoiceFragments] = useState<VoiceFragment[]>([]);
  const voiceRef = useRef<VoiceController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/session', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('The conversation could not be loaded. Check the database setup.');
        return response.json() as Promise<{ messages: Message[]; voiceFragments: VoiceFragment[] }>;
      })
      .then((snapshot) => { if (active) { setMessages(snapshot.messages); setVoiceFragments(snapshot.voiceFragments || []); void fetch('/api/connections', { cache: 'no-store' }).then((response) => response.ok ? response.json() as Promise<{ calendar: boolean; gmail: boolean }> : null).then((status) => { if (active && status) setConnections(status); }).catch(() => undefined); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'The conversation could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    fetch('/api/capabilities', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ voice: boolean; calendar: boolean; gmail: boolean }>)
      .then((capabilities) => { setVoiceEnabled(capabilities.voice); setConnectable({ calendar: capabilities.calendar, gmail: capabilities.gmail }); })
      .catch(() => setVoiceEnabled(false));
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || sending || loading) return;
    const id = crypto.randomUUID();
    const answerId = `answer:${id}`;
    setInput('');
    setError('');
    setSending(true);
    setMessages((current) => [...current, { id, role: 'user', text }, { id: answerId, role: 'assistant', text: '' }]);
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) });
      if (!response.ok) throw new Error(response.status === 503 ? 'The text model is not configured yet.' : 'The reply could not be started.');
      voiceRef.current?.addTextContext(text);
      if (!response.body) throw new Error('The reply stream is unavailable.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((current) => current.map((message) => message.id === answerId ? { ...message, text: message.text + chunk } : message));
      }
    } catch (cause) {
      try {
        const snapshotResponse = await fetch('/api/session', { cache: 'no-store' });
        if (!snapshotResponse.ok) throw new Error('Session reload failed');
        const snapshot = await snapshotResponse.json() as { messages: Message[] };
        const reconciled = reconcileFailedTurn(snapshot.messages, id, text);
        setMessages(reconciled.messages);
        if (reconciled.input) setInput(reconciled.input);
      } catch {
        setMessages((current) => current.filter((message) => message.id !== id && message.id !== answerId));
        setInput(text);
      }
      setError(cause instanceof Error ? cause.message : 'The reply failed.');
    } finally { setSending(false); }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  }

  async function startOrEndCall() {
    if (voiceRef.current) { await voiceRef.current.close(); return; }
    if (!voiceEnabled || callPhase === 'connecting' || callPhase === 'ending') return;
    setError('');
    const callbacks: VoiceCallbacks = {
      onPhase: (phase) => {
        setCallPhase(phase);
        if (phase === 'ended' || phase === 'dropped') {
          voiceRef.current = null;
          void fetch('/api/session', { cache: 'no-store' })
            .then((response) => response.json() as Promise<{ voiceFragments: VoiceFragment[] }>)
            .then((snapshot) => setVoiceFragments((current) => snapshot.voiceFragments?.length >= current.length ? snapshot.voiceFragments : current))
            .catch(() => undefined);
        }
      },
      onCaption: (fragment) => setVoiceFragments((current) => [...current, { speaker: fragment.speaker, text: fragment.text, startMs: fragment.startMs, endMs: fragment.endMs }]),
    };
    try {
      voiceRef.current = await startBrowserCall(callbacks, {
        createPeer: () => new RTCPeerConnection(),
        getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
        createAudio: () => new Audio(),
        fetchFn: fetch,
      });
    } catch (cause) {
      setCallPhase('idle');
      setError(cause instanceof Error ? cause.message : 'The call could not connect.');
    }
  }

  async function connectAccount(toolkit: 'calendar' | 'gmail') {
    if (!connectable[toolkit] || connecting) return;
    setConnecting(toolkit);
    setError('');
    try {
      const response = await fetch('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolkit }) });
      if (!response.ok) throw new Error('The connection could not be started.');
      const data = await response.json() as { redirectUrl: string };
      window.location.assign(data.redirectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The connection could not be started.');
      setConnecting(null);
    }
  }

  async function disconnectAccount(toolkit: 'calendar' | 'gmail') {
    if (connecting) return;
    setConnecting(toolkit);
    setError('');
    try {
      const response = await fetch('/api/connections', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolkit }) });
      if (!response.ok) throw new Error('The account could not be disconnected.');
      setConnections((current) => ({ ...current, [toolkit]: false }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The account could not be disconnected.'); }
    finally { setConnecting(null); }
  }

  async function deleteConversation() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    if (callPhase === 'active' || callPhase === 'connecting' || callPhase === 'ending') return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch('/api/session', { method: 'DELETE' });
      if (!response.ok) throw new Error('The conversation could not be deleted. Please try again.');
      window.location.assign('/');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Deletion failed.'); setDeleting(false); }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Workspace">
        <div className="brand"><span className="brand-mark" aria-hidden="true">✳</span><span>Persona</span></div>
        <div className="sidebar-content"><span className="eyebrow">YOUR SPACE</span><p>One conversation, at your pace.</p></div>
        <div className="sidebar-footer"><span className="status-dot" /> Private preview</div>
      </aside>
      <section className="conversation" aria-label="Conversation">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark" aria-hidden="true">✳</span> Persona</div>
          <span className="topbar-label">A conversation that picks up where you left off</span>
          <div className="topbar-actions"><button className="connections-button" type="button" aria-expanded={connectionsOpen} onClick={() => setConnectionsOpen((open) => !open)}>Connections</button><button className="call-button" type="button" onClick={() => void startOrEndCall()} disabled={!voiceEnabled || callPhase === 'connecting' || callPhase === 'ending'} title={voiceEnabled ? 'Start or end a browser voice call' : 'Voice needs a server API key'}><span aria-hidden="true">◉</span> {callPhase === 'active' ? 'Hang up' : callPhase === 'connecting' ? 'Connecting…' : callPhase === 'ending' ? 'Ending…' : 'Call'} {!voiceEnabled ? <span className="soon">setup needed</span> : null}</button></div>
        </header>
        {connectionsOpen ? <section className="connections-panel" aria-label="Optional connections"><strong>Optional connections</strong><p>Connect an account only when it helps your conversation.</p>{(['calendar', 'gmail'] as const).map((toolkit) => <div className="connection-row" key={toolkit}><span>{toolkit === 'calendar' ? 'Google Calendar' : 'Gmail'}</span><button type="button" disabled={(!connections[toolkit] && !connectable[toolkit]) || Boolean(connecting)} onClick={() => void (connections[toolkit] ? disconnectAccount(toolkit) : connectAccount(toolkit))}>{connecting === toolkit ? 'Working…' : connections[toolkit] ? 'Disconnect' : !connectable[toolkit] ? 'Setup needed' : 'Connect'}</button></div>)}<div className="connection-row deletion-row"><span>{confirmDelete ? 'This also removes connected accounts.' : 'Delete this conversation'}</span><button type="button" disabled={deleting || callPhase === 'active' || callPhase === 'connecting' || callPhase === 'ending'} onClick={() => void deleteConversation()}>{deleting ? 'Deleting…' : confirmDelete ? 'Confirm delete' : 'Delete'}</button></div></section> : null}
        <div className="thread" aria-live="polite">
          {messages.length === 0 && !loading ? <div className="welcome"><div className="welcome-orb" aria-hidden="true">✳</div><span className="eyebrow">START WHERE YOU ARE</span><h1>Start a conversation.</h1><p>Ask for help with something on your mind, or just tell me what you are working through.</p></div> : null}
          {loading ? <p className="loading">Loading your conversation…</p> : null}
          <div className="message-list">{messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span className="message-avatar" aria-hidden="true">{message.role === 'assistant' ? '✳' : 'Y'}</span><div className="message-content"><span className="message-label">{message.role === 'assistant' ? 'Persona' : 'You'}</span><p>{message.text || 'Thinking…'}</p></div></article>)}</div>
          {callPhase === 'active' ? <p className="call-status">● Call active · microphone on</p> : null}
          {voiceFragments.length ? <section className="voice-notes" aria-label="Voice transcript"><span className="message-label">Voice transcript · unverified</span>{voiceFragments.slice(-12).map((fragment, index) => <p key={`${fragment.callId || 'live'}:${fragment.startMs || 0}:${index}`}><strong>{fragment.speaker === 'assistant' ? 'Persona' : 'You'}:</strong> {fragment.text}</p>)}</section> : null}
          <div ref={endRef} />
        </div>
        <div className="composer-area">
          {error ? <p className="error" role="alert">{error}</p> : null}
          <form className="composer" onSubmit={sendMessage}><textarea aria-label="Message Persona" placeholder="Message Persona…" rows={2} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onComposerKeyDown} disabled={loading || sending} /><button className="send-button" type="submit" aria-label="Send message" disabled={!input.trim() || loading || sending}>↑</button></form>
          <p className="composer-note">Your pace, your call. Press Enter to send · Shift+Enter for a new line.</p>
        </div>
      </section>
    </main>
  );
}
