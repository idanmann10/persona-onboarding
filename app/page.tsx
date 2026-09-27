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
      .then((snapshot) => { if (active) { setMessages(snapshot.messages); setVoiceFragments(snapshot.voiceFragments || []); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'The conversation could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    fetch('/api/capabilities', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ voice: boolean }>)
      .then((capabilities) => setVoiceEnabled(capabilities.voice))
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
          <button className="call-button" type="button" onClick={() => void startOrEndCall()} disabled={!voiceEnabled || callPhase === 'connecting' || callPhase === 'ending'} title={voiceEnabled ? 'Start or end a browser voice call' : 'Voice needs a server API key'}><span aria-hidden="true">◉</span> {callPhase === 'active' ? 'Hang up' : callPhase === 'connecting' ? 'Connecting…' : callPhase === 'ending' ? 'Ending…' : 'Call'} {!voiceEnabled ? <span className="soon">setup needed</span> : null}</button>
        </header>
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
