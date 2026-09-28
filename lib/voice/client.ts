import type { CallEndReason } from '../domain/events';
import type { ParsedLiveEvent } from './events';
import { parseLiveEvent } from './events';
import { truncateToTokens } from './tokens';

export interface VoiceController {
  callId: string;
  /** Hang up. `reason` defaults to the user's own hangup. */
  close(reason?: CallEndReason): Promise<void>;
  /** A message the user typed in the chat during the call. */
  addTextContext(text: string): void;
  /** Pause the quiet-line timers, e.g. while the user is in Google's sign-in window. */
  setBusy(busy: boolean): void;
  /** The page is going away: report it without waiting. */
  abandon(): void;
  /** App-confirmed context for the voice model, e.g. "Gmail is now connected". */
  notify(content: string): void;
  /** Silence the microphone without ending the call. */
  setMuted(muted: boolean): void;
}

export interface VoiceDependencies {
  createPeer(): RTCPeerConnection;
  getMicrophone(): Promise<MediaStream>;
  createAudio(): HTMLAudioElement;
  fetchFn: typeof fetch;
  now?: () => number;
  /** Aborting it while the call is still connecting cancels the call; once connected, use `close`. */
  signal?: AbortSignal;
}

/** A backend function call the browser forwards for the voice model, e.g. `search_gmail`. */
export interface ToolActivity {
  id: string;
  name: string;
  /** The model's arguments, as the JSON string it sent. */
  arguments: string;
  status: 'running' | 'done' | 'failed';
}

export interface VoiceCallbacks {
  onPhase(phase: 'connecting' | 'active' | 'ending' | 'ended' | 'dropped', reason?: CallEndReason): void;
  onCaption(event: Extract<ParsedLiveEvent, { kind: 'transcript' }>): void;
  /** The backend asked to show something in the chat, e.g. a Connect Gmail button. */
  onToolUi?(ui: { type: string; toolkit?: string }): void;
  /** A forwarded tool call started or finished. */
  onTool?(activity: ToolActivity): void;
  /** The user's microphone or the assistant's voice is available, e.g. for a level meter. */
  onAudio?(speaker: 'user' | 'assistant', stream: MediaStream): void;
}

interface Limits { checkInAfterMs: number; closeAfterMs: number; maxDurationMs: number; wrapUpBeforeMs: number; checkIn: string; goodbye: string; wrapUp: string }

type Fragment = { eventId: string; speaker: 'user' | 'assistant'; text: string; startMs: number; endMs: number };

export function microphoneError(error: unknown): Error {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return new Error('Microphone access is blocked. Allow the microphone in your browser to call, or keep going here.');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error('No microphone was found on this device. You can keep going here in text.');
  if (name === 'NotReadableError' || name === 'AbortError') return new Error('Your microphone is busy in another app. Close it and try again, or keep going here.');
  return error instanceof Error ? error : new Error('The call could not connect.');
}

const CLOSED_REASONS: Record<string, { phase: 'ended' | 'dropped'; reason: CallEndReason }> = {
  remote_hangup: { phase: 'ended', reason: 'remote_hangup' },
  connection_lost: { phase: 'dropped', reason: 'connection_lost' },
  expired: { phase: 'ended', reason: 'expired' },
  content: { phase: 'ended', reason: 'content' },
};

export async function startBrowserCall(callbacks: VoiceCallbacks, deps: VoiceDependencies): Promise<VoiceController> {
  const now = deps.now ?? (() => Date.now());
  // Called detached, never as `deps.fetchFn(...)`: a native fetch called as a method of another object throws "Illegal invocation".
  const fetchFn = deps.fetchFn;
  const signal = deps.signal;
  callbacks.onPhase('connecting');
  const peer = deps.createPeer();
  const audio = deps.createAudio();
  audio.autoplay = true;
  let microphone: MediaStream | undefined;
  let callId = '';
  let started = false;
  let closed = false;
  let busy = false;
  let requestedReason: CallEndReason | undefined;
  let closing: Promise<void> | undefined;
  let greeting = '';
  let greetingLine = '';
  let assistantSpoke = false;
  let userSpoke = false;
  let greetingTimer: ReturnType<typeof setTimeout> | undefined;
  let limits: Limits | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClose: (() => void) | undefined;
  let startedAt = 0;
  let lastActivity = 0;
  let lastUserActivity = 0;
  let delegation = false;
  let checkedIn = false;
  let wrappedUp = false;
  let sequence = 0;
  const pendingEvents = new Set<Promise<unknown>>();
  let queue: Fragment[] = [];
  const delegations = new Map<string, { calls: Array<Promise<{ callId: string; output: string }>>; completed: boolean; submitting: boolean }>();
  const channel = peer.createDataChannel('oai-events');

  const send = (event: Record<string, unknown>) => {
    if (closed || channel.readyState !== 'open') return;
    channel.send(JSON.stringify({ event_id: `persona_${++sequence}`, ...event }));
  };
  const instruct = (content: string) => send({ type: 'session.instructions.append', delegation_id: null, content });

  /**
   * The assistant speaks first. The greeting goes out as an instruction with its own id; GPT-Live acks it
   * (`session.instructions.appended` with that `client_event_id`). If no assistant speech follows shortly
   * after the ack (or after the call starts, when no ack comes), one short line goes out as commentary,
   * which the model says aloud. Nothing is sent once either side has spoken.
   */
  const GREETING_EVENT = 'persona_greeting';
  const nudgeGreeting = (afterMs: number) => {
    clearTimeout(greetingTimer);
    greetingTimer = setTimeout(() => {
      if (closed || assistantSpoke || userSpoke || !greetingLine) return;
      send({ type: 'session.commentary.append', delegation_id: null, content: greetingLine });
    }, afterMs);
  };
  const greet = () => {
    if (!greeting) return;
    send({ type: 'session.instructions.append', event_id: GREETING_EVENT, delegation_id: null, content: greeting });
    nudgeGreeting(4_000);
  };

  function post(body: Record<string, unknown>, keepalive = false) {
    if (!callId) return Promise.resolve();
    let pending: Promise<unknown>;
    try {
      pending = fetchFn('/api/voice/event', { method: 'POST', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, ...body }) }).catch(() => undefined);
    } catch { return Promise.resolve(); }
    pendingEvents.add(pending);
    void pending.finally(() => pendingEvents.delete(pending));
    return pending;
  }

  function flush(keepalive = false) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    const batch = queue;
    queue = [];
    const posts: Promise<unknown>[] = [];
    for (let index = 0; index < batch.length; index += 40) posts.push(post({ kind: 'transcripts', fragments: batch.slice(index, index + 40) }, keepalive));
    return Promise.all(posts);
  }

  function finish(phase: 'ended' | 'dropped', reason: CallEndReason) {
    if (closed) return;
    closed = true;
    for (const timer of [closeTimer, flushTimer, greetingTimer]) if (timer) clearTimeout(timer);
    for (const timer of [heartbeatTimer, watchTimer]) if (timer) clearInterval(timer);
    const persisted = flush().then(() => post({ kind: phase, reason }));
    microphone?.getTracks().forEach((track) => track.stop());
    try { channel.close(); } catch { /* already closed */ }
    peer.close();
    audio.srcObject = null;
    if (!callId) { callbacks.onPhase(phase, reason); resolveClose?.(); return; }
    // The line is already closed: say so now rather than after the last transcripts are saved.
    if (!closing) callbacks.onPhase('ending');
    let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { persistenceTimer = setTimeout(resolve, 5_000); });
    void Promise.race([persisted.then(() => Promise.allSettled([...pendingEvents])).then(() => undefined), timeout]).then(() => {
      if (persistenceTimer) clearTimeout(persistenceTimer);
      callbacks.onPhase(phase, reason);
      resolveClose?.();
    });
  }

  function close(reason: CallEndReason = 'user_hangup') {
    if (closed) return Promise.resolve();
    // The user's own hang-up always wins over an automated close already under way.
    if (closing) { if (reason === 'user_hangup') requestedReason = reason; return closing; }
    requestedReason = reason;
    callbacks.onPhase('ending');
    // No line to say goodbye on yet (e.g. hung up while it was still ringing): the user's hang-up is still a hang-up.
    if (channel.readyState !== 'open') { if (reason === 'user_hangup') finish('ended', reason); else finish('dropped', 'connection_lost'); return Promise.resolve(); }
    closing = new Promise<void>((resolve) => { resolveClose = resolve; });
    send({ type: 'session.close' });
    closeTimer = setTimeout(() => finish('ended', requestedReason ?? reason), 15_000);
    return closing;
  }

  async function runTool(item: { call_id?: unknown; name?: unknown; arguments?: unknown }) {
    const toolCallId = String(item.call_id ?? '');
    const activity: ToolActivity = { id: toolCallId, name: String(item.name ?? ''), arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}), status: 'running' };
    const report = (status: ToolActivity['status']) => { if (!closed) callbacks.onTool?.({ ...activity, status }); };
    lastActivity = now();
    report('running');
    try {
      await flush();
      const response = await fetchFn('/api/voice/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, callItemId: toolCallId, name: activity.name, arguments: activity.arguments }) });
      const result = response.ok ? await response.json() as { output?: string; ui?: { type: string; toolkit?: string } } : {};
      if (result.ui) callbacks.onToolUi?.(result.ui);
      report(typeof result.output === 'string' ? 'done' : 'failed');
      return { callId: toolCallId, output: typeof result.output === 'string' ? result.output : JSON.stringify({ status: 'unavailable' }) };
    } catch {
      report('failed');
      return { callId: toolCallId, output: JSON.stringify({ status: 'unavailable' }) };
    }
  }

  async function submitIfReady(delegationId: string) {
    const delegation = delegations.get(delegationId);
    if (!delegation || !delegation.completed || !delegation.calls.length || delegation.submitting) return;
    delegation.submitting = true;
    const results = await Promise.all(delegation.calls);
    delegations.delete(delegationId);
    for (const result of results) send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: result.callId, output: result.output } });
    send({ type: 'response.create' });
  }

  function onResponseEvent(envelope: Record<string, unknown>) {
    const inner = (envelope.event ?? {}) as Record<string, unknown>;
    const delegationId = String(envelope.delegation_id ?? 'default');
    const delegation = delegations.get(delegationId) ?? { calls: [], completed: false, submitting: false };
    const type = String(inner.type ?? '');
    if (type === 'response.created') {
      delegations.set(delegationId, { calls: [], completed: false, submitting: false });
    } else if (type === 'response.output_item.done') {
      const item = (inner.item ?? {}) as Record<string, unknown>;
      if (item.type !== 'function_call') return;
      delegation.calls.push(runTool(item));
      delegations.set(delegationId, delegation);
    } else if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
      delegation.completed = true;
      delegations.set(delegationId, delegation);
      void submitIfReady(delegationId);
    } else if (type === 'response.failed' || type === 'response.cancelled') {
      delegations.delete(delegationId);
    }
  }

  function watch() {
    if (closed || closing || !started || !limits) return;
    const time = now();
    if (!wrappedUp && time - startedAt >= limits.maxDurationMs - limits.wrapUpBeforeMs) { wrappedUp = true; instruct(limits.wrapUp); }
    if (time - startedAt >= limits.maxDurationMs) { void close('max_duration'); return; }
    if (busy) return;
    const quiet = time - lastActivity;
    if (!checkedIn && quiet >= limits.checkInAfterMs) { checkedIn = true; instruct(limits.checkIn); }
    else if (checkedIn && quiet >= limits.closeAfterMs && !requestedReason) {
      requestedReason = 'inactive';
      const goodbyeAt = time;
      instruct(limits.goodbye);
      // Long enough for the spoken goodbye to finish and for the user to answer or type.
      setTimeout(() => {
        if (closed || closing || requestedReason !== 'inactive') return;
        if (lastUserActivity >= goodbyeAt) { requestedReason = undefined; checkedIn = false; return; }
        void close('inactive');
      }, 12_000);
    }
  }

  channel.addEventListener('message', ({ data }) => {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(data); } catch { return; }
    if (closed) return;
    if (raw?.type === 'response.event') { onResponseEvent(raw); return; }
    if (raw?.type === 'session.instructions.appended' && raw.client_event_id === GREETING_EVENT) { nudgeGreeting(2_000); return; }
    if (raw?.type === 'error' || (typeof raw?.type === 'string' && raw.type.endsWith('.error')) || (raw?.error && typeof raw.error === 'object')) {
      console.error('GPT-Live error', raw);
      if (raw.client_event_id === GREETING_EVENT || (raw.error as { event_id?: unknown } | undefined)?.event_id === GREETING_EVENT) nudgeGreeting(0);
      return;
    }
    const parsed = parseLiveEvent(raw);
    if (!parsed) return;
    if (parsed.kind === 'started') {
      if (started) return;
      started = true;
      startedAt = now();
      lastActivity = startedAt;
      lastUserActivity = startedAt;
      void post({ kind: 'started' });
      greet();
      heartbeatTimer = setInterval(() => {
        if (!callId || closed) return;
        void fetchFn('/api/voice/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, kind: 'heartbeat' }) })
          .then((response) => { if (response.status === 409) finish('dropped', 'connection_lost'); })
          .catch(() => undefined);
      }, 30_000);
      watchTimer = setInterval(watch, 1_000);
      callbacks.onPhase('active');
    } else if (parsed.kind === 'transcript') {
      lastActivity = now();
      if (parsed.speaker === 'user') { lastUserActivity = lastActivity; checkedIn = false; userSpoke = true; }
      else assistantSpoke = true;
      queue.push({ eventId: parsed.eventId, speaker: parsed.speaker, text: parsed.text, startMs: parsed.startMs, endMs: parsed.endMs });
      if (queue.length >= 40) void flush();
      else flushTimer ??= setTimeout(() => { flushTimer = undefined; void flush(); }, 700);
      callbacks.onCaption(parsed);
    } else {
      const reason = typeof raw.reason === 'string' ? raw.reason : '';
      const mapped = reason === 'close_requested' || !CLOSED_REASONS[reason]
        ? { phase: 'ended' as const, reason: requestedReason ?? 'remote_hangup' }
        : CLOSED_REASONS[reason];
      finish(mapped.phase, mapped.reason);
    }
  });
  channel.addEventListener('close', () => { if (!closed) finish('dropped', 'connection_lost'); });
  peer.addEventListener('connectionstatechange', () => { if (peer.connectionState === 'failed' && !closed) finish('dropped', 'connection_lost'); });
  peer.addEventListener('track', (event) => {
    const remote = new MediaStream([event.track]);
    audio.srcObject = remote;
    void audio.play().catch(() => undefined);
    callbacks.onAudio?.('assistant', remote);
  });

  // Cancelling while connecting ends the call at once; once GPT-Live has answered, the session exists, so it ends as the user's hang-up.
  const cancelled = () => new DOMException('The call was cancelled.', 'AbortError');
  const onAbort = () => callId ? finish('ended', 'user_hangup') : finish('dropped', 'setup_failed');
  const unlessCancelled = <T,>(work: Promise<T>): Promise<T> => !signal ? work : new Promise<T>((resolve, reject) => {
    const stop = () => reject(cancelled());
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const granted = deps.getMicrophone();
    // The browser's microphone prompt cannot be withdrawn: a microphone granted after a cancel is released straight away.
    granted.then((stream) => { if (closed) stream.getTracks().forEach((track) => track.stop()); }, () => undefined);
    try { microphone = await unlessCancelled(granted); }
    catch (error) { throw signal?.aborted ? error : microphoneError(error); }
    callbacks.onAudio?.('user', microphone);
    for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (peer.iceGatheringState !== 'complete') {
      await unlessCancelled(new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The call could not connect. Check your network and try again.')), 10_000);
        const onState = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', onState); resolve(); } };
        peer.addEventListener('icegatheringstatechange', onState);
        onState();
      }));
    }
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error('The browser did not create an audio offer.');
    const response = await fetchFn('/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp }) });
    if (!response.ok) throw new Error(response.status === 503 ? 'Voice is not configured yet.' : response.status === 429 ? 'Call limit reached. Please try again later.' : response.status === 409 ? 'A call is already active in this conversation.' : 'The call could not connect.');
    const result = await response.json() as { session?: { id?: string }; transport?: { sdp?: string }; greeting?: string; greetingLine?: string; limits?: Limits; delegation?: boolean };
    if (!result.session?.id || !result.transport?.sdp) throw new Error('The voice connection returned an invalid answer.');
    callId = result.session.id;
    greeting = typeof result.greeting === 'string' ? result.greeting : '';
    greetingLine = typeof result.greetingLine === 'string' ? result.greetingLine : '';
    limits = result.limits;
    delegation = result.delegation === true;
    // Cancelled while GPT-Live was answering: the call is already closed here, but the server holds it open, so record the hang-up to free the line.
    if (signal?.aborted) { void post({ kind: 'ended', reason: 'user_hangup' }); throw cancelled(); }
    await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });
  } catch (error) {
    finish('dropped', 'setup_failed');
    throw signal?.aborted ? cancelled() : error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  return {
    callId,
    close: (reason) => close(reason),
    addTextContext: (text) => {
      if (!started) return;
      lastActivity = now();
      lastUserActivity = lastActivity;
      checkedIn = false;
      // Each append is limited to 500 tokens; leave room for the framing sentence.
      const typed = truncateToTokens(text, 440);
      send({ type: 'session.thinking.append', delegation_id: null, content: `The user typed this in the chat during the call. Treat it as their own words and respond to it: ${typed}` });
      if (delegation) send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: typed }] } });
    },
    setBusy: (value) => { busy = value; if (!value) { lastActivity = now(); lastUserActivity = lastActivity; checkedIn = false; } },
    notify: (content) => { if (started) send({ type: 'session.thinking.append', delegation_id: null, content: truncateToTokens(content, 480) }); },
    setMuted: (muted) => { microphone?.getAudioTracks().forEach((track) => { track.enabled = !muted; }); },
    abandon: () => {
      if (closed || !callId) return;
      void flush(true);
      void post({ kind: 'dropped', reason: 'page_closed' }, true);
      closed = true;
      for (const timer of [closeTimer, flushTimer, greetingTimer]) if (timer) clearTimeout(timer);
      for (const timer of [heartbeatTimer, watchTimer]) if (timer) clearInterval(timer);
      microphone?.getTracks().forEach((track) => track.stop());
      peer.close();
      // If the page is restored from the back/forward cache, it must not still look like a live call.
      callbacks.onPhase('dropped', 'page_closed');
      resolveClose?.();
    },
  };
}
