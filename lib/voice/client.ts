import type { ParsedLiveEvent } from './events';
import { parseLiveEvent } from './events';

export interface VoiceController {
  callId: string;
  close(): Promise<void>;
  addTextContext(text: string): void;
}

export interface VoiceDependencies {
  createPeer(): RTCPeerConnection;
  getMicrophone(): Promise<MediaStream>;
  createAudio(): HTMLAudioElement;
  fetchFn: typeof fetch;
}

export interface VoiceCallbacks {
  onPhase(phase: 'connecting' | 'active' | 'ending' | 'ended' | 'dropped'): void;
  onCaption(event: Extract<ParsedLiveEvent, { kind: 'transcript' }>): void;
}

export async function startBrowserCall(callbacks: VoiceCallbacks, deps: VoiceDependencies): Promise<VoiceController> {
  callbacks.onPhase('connecting');
  const peer = deps.createPeer();
  const audio = deps.createAudio();
  audio.autoplay = true;
  let microphone: MediaStream | undefined;
  let callId = '';
  let closed = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let resolveClose: (() => void) | undefined;
  const pendingEvents = new Set<Promise<unknown>>();
  const channel = peer.createDataChannel('oai-events');

  function postEvent(body: Record<string, unknown>) {
    if (!callId) return;
    let pending: Promise<unknown>;
    try { pending = deps.fetchFn('/api/voice/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, ...body }) }).catch(() => undefined); }
    catch { return; }
    pendingEvents.add(pending);
    void pending.finally(() => pendingEvents.delete(pending));
  }

  function finish(phase: 'ended' | 'dropped') {
    if (closed) return;
    closed = true;
    if (closeTimer) clearTimeout(closeTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    postEvent({ kind: phase });
    microphone?.getTracks().forEach((track) => track.stop());
    channel.close();
    peer.close();
    audio.srcObject = null;
    if (!callId) { callbacks.onPhase(phase); resolveClose?.(); return; }
    let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { persistenceTimer = setTimeout(resolve, 5_000); });
    void Promise.race([Promise.allSettled([...pendingEvents]).then(() => undefined), timeout]).then(() => {
      if (persistenceTimer) clearTimeout(persistenceTimer);
      callbacks.onPhase(phase);
      resolveClose?.();
    });
  }

  channel.addEventListener('message', ({ data }) => {
    let parsed: ParsedLiveEvent | null = null;
    try { parsed = parseLiveEvent(JSON.parse(data)); } catch { return; }
    if (!parsed || closed) return;
    if (parsed.kind === 'started') {
      postEvent({ kind: 'started' });
      if (!heartbeatTimer) heartbeatTimer = setInterval(() => {
        if (!callId || closed) return;
        void deps.fetchFn('/api/voice/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, kind: 'heartbeat' }) })
          .then((response) => { if (response.status === 409) finish('dropped'); })
          .catch(() => undefined);
      }, 30_000);
      callbacks.onPhase('active');
    } else if (parsed.kind === 'transcript') {
      postEvent({ ...parsed });
      callbacks.onCaption(parsed);
    } else finish(parsed.kind);
  });
  channel.addEventListener('close', () => { if (!closed) finish('dropped'); });
  peer.addEventListener('connectionstatechange', () => { if (peer.connectionState === 'failed' && !closed) finish('dropped'); });
  peer.addEventListener('track', (event) => {
    audio.srcObject = new MediaStream([event.track]);
    void audio.play().catch(() => undefined);
  });

  try {
    microphone = await deps.getMicrophone();
    for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (peer.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ICE gathering timed out')), 10_000);
        const onState = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', onState); resolve(); } };
        peer.addEventListener('icegatheringstatechange', onState);
        onState();
      });
    }
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error('The browser did not create an audio offer.');
    const response = await deps.fetchFn('/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp }) });
    if (!response.ok) throw new Error(response.status === 503 ? 'Voice is not configured yet.' : 'The call could not connect.');
    const result = await response.json() as { session?: { id?: string }; transport?: { sdp?: string } };
    if (!result.session?.id || !result.transport?.sdp) throw new Error('The voice connection returned an invalid answer.');
    callId = result.session.id;
    await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });
  } catch (error) {
    finish('dropped');
    throw error;
  }

  return {
    callId,
    close: async () => {
      if (closed) return;
      callbacks.onPhase('ending');
      if (channel.readyState !== 'open') { finish('dropped'); return; }
      const finished = new Promise<void>((resolve) => { resolveClose = resolve; });
      channel.send(JSON.stringify({ type: 'session.close' }));
      closeTimer = setTimeout(() => finish('dropped'), 15_000);
      await finished;
    },
    addTextContext: (text) => {
      if (closed || channel.readyState !== 'open') return;
      channel.send(JSON.stringify({ type: 'session.thinking.append', event_id: crypto.randomUUID(), delegation_id: null, content: `The user typed in chat: ${text.slice(0, 1200)}` }));
    },
  };
}
