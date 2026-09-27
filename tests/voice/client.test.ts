import { describe, expect, it, vi } from 'vitest';
import { startBrowserCall } from '../../lib/voice/client';

describe('browser voice call', () => {
  it('negotiates WebRTC, records captions, and waits for confirmed close before stopping the microphone', async () => {
    const listeners = new Map<string, (event: { data: string }) => void>();
    const sent: string[] = [];
    const channel = {
      readyState: 'open',
      addEventListener: (name: string, listener: (event: { data: string }) => void) => listeners.set(name, listener),
      send: (value: string) => sent.push(value),
      close: () => undefined,
    };
    let stopped = false;
    let remoteSdp = '';
    const track = { stop: () => { stopped = true; } };
    const peer = {
      iceGatheringState: 'complete',
      localDescription: { sdp: 'offer-sdp' },
      createDataChannel: () => channel,
      addEventListener: () => undefined,
      addTrack: () => undefined,
      createOffer: async () => ({ type: 'offer', sdp: 'offer-sdp' }),
      setLocalDescription: async () => undefined,
      setRemoteDescription: async (answer: { sdp: string }) => { remoteSdp = answer.sdp; },
      close: () => undefined,
    };
    const phases: string[] = [];
    const posted: Array<Record<string, unknown>> = [];
    const captions: string[] = [];
    let releaseEnd: (() => void) | undefined;
    const controller = await startBrowserCall({ onPhase: (phase) => phases.push(phase), onCaption: (event) => captions.push(event.text) }, {
      createPeer: () => peer as unknown as RTCPeerConnection,
      getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
      createAudio: () => ({ autoplay: false, play: async () => undefined }) as unknown as HTMLAudioElement,
      fetchFn: async (input, init) => {
        if (String(input).endsWith('/api/voice/session')) return Response.json({ session: { id: 'live_one' }, transport: { type: 'webrtc', sdp: 'answer-sdp' }, greeting: 'Greet the caller now in English.' }, { status: 201 });
        const body = JSON.parse(String(init?.body));
        posted.push(body);
        if (body.kind === 'ended') return new Promise<Response>((resolve) => { releaseEnd = () => resolve(new Response(null, { status: 204 })); });
        return new Response(null, { status: 204 });
      },
    });
    expect(controller.callId).toBe('live_one');
    expect(remoteSdp).toBe('answer-sdp');
    listeners.get('message')?.({ data: JSON.stringify({ type: 'session.started' }) });
    listeners.get('message')?.({ data: JSON.stringify({ type: 'session.input_transcript.delta', event_id: 'evt-1', delta: 'Hello ', start_ms: 0, end_ms: 400 }) });
    expect(phases).toContain('active');
    expect(captions).toEqual(['Hello ']);
    expect(sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({ type: 'session.instructions.append', delegation_id: null, content: 'Greet the caller now in English.' }));
    const closing = controller.close();
    expect(sent.some((value) => JSON.parse(value).type === 'session.close')).toBe(true);
    expect(stopped).toBe(false);
    listeners.get('message')?.({ data: JSON.stringify({ type: 'session.closed', reason: 'close_requested' }) });
    let closeSettled = false;
    void closing.then(() => { closeSettled = true; });
    await vi.waitFor(() => expect(releaseEnd).toBeTypeOf('function'));
    expect(posted).toContainEqual({ callId: 'live_one', kind: 'transcripts', fragments: [{ eventId: 'evt-1', speaker: 'user', text: 'Hello ', startMs: 0, endMs: 400 }] });
    expect(posted.at(-1)).toEqual({ callId: 'live_one', kind: 'ended', reason: 'user_hangup' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeSettled).toBe(false);
    releaseEnd?.();
    await closing;
    expect(stopped).toBe(true);
    expect(phases.at(-1)).toBe('ended');
  });
});
