'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { reconcileFailedTurn } from '@/lib/ui/reconcile';

type Message = { id: string; role: 'user' | 'assistant'; text: string };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/session', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('The conversation could not be loaded. Check the database setup.');
        return response.json() as Promise<{ messages: Message[] }>;
      })
      .then((snapshot) => { if (active) setMessages(snapshot.messages); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'The conversation could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
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
          <button className="call-button" type="button" disabled title="Browser voice is coming in the next build slice"><span aria-hidden="true">◉</span> Call <span className="soon">soon</span></button>
        </header>
        <div className="thread" aria-live="polite">
          {messages.length === 0 && !loading ? <div className="welcome"><div className="welcome-orb" aria-hidden="true">✳</div><span className="eyebrow">START WHERE YOU ARE</span><h1>Start a conversation.</h1><p>Ask for help with something on your mind, or just tell me what you are working through.</p></div> : null}
          {loading ? <p className="loading">Loading your conversation…</p> : null}
          <div className="message-list">{messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span className="message-avatar" aria-hidden="true">{message.role === 'assistant' ? '✳' : 'Y'}</span><div className="message-content"><span className="message-label">{message.role === 'assistant' ? 'Persona' : 'You'}</span><p>{message.text || 'Thinking…'}</p></div></article>)}</div>
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
