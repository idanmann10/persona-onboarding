import { afterEach, describe, expect, it, vi } from 'vitest';
import { microphoneError, startBrowserCall } from '../../lib/voice/client';

const limits = { checkInAfterMs: 20_000, closeAfterMs: 30_000, maxDurationMs: 720_000, wrapUpBeforeMs: 60_000, checkIn: 'CHECK IN', goodbye: 'GOODBYE', wrapUp: 'WRAP UP' };

async function connect(options: { delegation?: boolean; toolOutput?: Record<string, unknown> } = {}) {
  const listeners = new Map<string, (event: { data: string }) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  let clock = 1_000_000;
  const channel = {
    readyState: 'open',
    addEventListener: (name: string, listener: (event: { data: string }) => void) => listeners.set(name, listener),
    send: (value: string) => sent.push(JSON.parse(value)),
    close: () => undefined,
  };
  const track = { stop: () => undefined };
  const peer = {
    iceGatheringState: 'complete', localDescription: { sdp: 'offer' }, createDataChannel: () => channel, addEventListener: () => undefined,
    addTrack: () => undefined, createOffer: async () => ({ type: 'offer', sdp: 'offer' }), setLocalDescription: async () => undefined,
    setRemoteDescription: async () => undefined, close: () => undefined,
  };
  const ui: Array<{ type: string; toolkit?: string }> = [];
  const phases: string[] = [];
  const controller = await startBrowserCall({ onPhase: (phase, reason) => phases.push(reason ? `${phase}:${reason}` : phase), onCaption: () => undefined, onToolUi: (value) => ui.push(value) }, {
    createPeer: () => peer as unknown as RTCPeerConnection,
    getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
    createAudio: () => ({ play: async () => undefined }) as unknown as HTMLAudioElement,
    now: () => clock,
    fetchFn: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      posts.push({ url, body });
      if (url.endsWith('/api/voice/session')) return Response.json({ session: { id: 'live_1' }, transport: { sdp: 'answer' }, greeting: 'HELLO', limits, delegation: options.delegation ?? true }, { status: 201 });
      if (url.endsWith('/api/voice/tool')) return Response.json({ output: JSON.stringify(options.toolOutput ?? { status: 'saved' }), ...(body.name === 'show_connection' ? { ui: { type: 'connection_offer', toolkit: 'gmail' } } : {}) });
      return new Response(null, { status: 204 });
    },
  });
  const receive = (event: Record<string, unknown>) => listeners.get('message')?.({ data: JSON.stringify(event) });
  return { controller, sent, posts, ui, phases, receive, advance: (ms: number) => { clock += ms; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('browser call behavior', () => {
  it('runs a delegated function call on the server and continues the response only after it completes', async () => {
    const call = await connect();
    call.receive({ type: 'session.started' });
    call.receive({ type: 'session.input_transcript.delta', event_id: 'e1', delta: "I'm Dana", start_ms: 0, end_ms: 500 });
    call.receive({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.created', response: { id: 'r1' } } });
    call.receive({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'remember', arguments: '{"key":"preferred_name","value":"Dana"}' } } });
    await vi.waitFor(() => expect(call.posts.some((post) => post.url.endsWith('/api/voice/tool'))).toBe(true));
    const flushIndex = call.posts.findIndex((post) => post.body.kind === 'transcripts');
    const toolIndex = call.posts.findIndex((post) => post.url.endsWith('/api/voice/tool'));
    expect(flushIndex).toBeGreaterThanOrEqual(0);
    expect(flushIndex).toBeLessThan(toolIndex);
    expect(call.posts[toolIndex].body).toEqual({ callId: 'live_1', callItemId: 'call_9', name: 'remember', arguments: '{"key":"preferred_name","value":"Dana"}' });
    expect(call.sent.some((event) => event.type === 'response.create')).toBe(false);
    call.receive({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.completed', response: { output: [] } } });
    await vi.waitFor(() => expect(call.sent.some((event) => event.type === 'response.create')).toBe(true));
    const output = call.sent.find((event) => event.type === 'response.item.create');
    expect(output).toMatchObject({ item: { type: 'function_call_output', call_id: 'call_9', output: '{"status":"saved"}' } });
    expect(call.sent.findIndex((event) => event.type === 'response.item.create')).toBeLessThan(call.sent.findIndex((event) => event.type === 'response.create'));
  });

  it('surfaces a Connect card requested by the voice backend', async () => {
    const call = await connect();
    call.receive({ type: 'session.started' });
    call.receive({ type: 'response.event', delegation_id: 'd2', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'show_connection', arguments: '{"toolkit":"gmail","reason":"r"}' } } });
    await vi.waitFor(() => expect(call.ui).toEqual([{ type: 'connection_offer', toolkit: 'gmail' }]));
  });

  it('sends typed chat text into the call as the user\'s words', async () => {
    const call = await connect();
    call.controller.addTextContext('ignored before start');
    expect(call.sent).toEqual([]);
    call.receive({ type: 'session.started' });
    call.controller.addTextContext('my email is dana@example.com');
    expect(call.sent.find((event) => event.type === 'session.thinking.append')).toMatchObject({ delegation_id: null, content: expect.stringContaining('dana@example.com') });
    expect(call.sent.find((event) => event.type === 'response.item.create')).toMatchObject({ item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'my email is dana@example.com' }] } });
    const noDelegation = await connect({ delegation: false });
    noDelegation.receive({ type: 'session.started' });
    noDelegation.controller.addTextContext('hi');
    expect(noDelegation.sent.some((event) => event.type === 'response.item.create')).toBe(false);
  });

  it('checks in on a quiet line, says goodbye, and closes as inactive; the caller speaking cancels the goodbye', async () => {
    vi.useFakeTimers();
    const call = await connect();
    call.receive({ type: 'session.started' });
    expect(call.sent.map((event) => event.content)).toContain('HELLO');
    call.advance(21_000); vi.advanceTimersByTime(1_000);
    expect(call.sent.map((event) => event.content)).toContain('CHECK IN');
    call.receive({ type: 'session.output_transcript.delta', event_id: 'a1', delta: 'Still there?', start_ms: 21_000, end_ms: 22_000 });
    call.advance(31_000); vi.advanceTimersByTime(1_000);
    expect(call.sent.map((event) => event.content)).toContain('GOODBYE');
    call.advance(1_000);
    call.receive({ type: 'session.input_transcript.delta', event_id: 'u1', delta: 'Sorry, I am here', start_ms: 60_000, end_ms: 61_000 });
    call.advance(11_000); vi.advanceTimersByTime(12_000);
    expect(call.sent.some((event) => event.type === 'session.close')).toBe(false);
    call.advance(21_000); vi.advanceTimersByTime(1_000);
    call.advance(31_000); vi.advanceTimersByTime(1_000);
    call.advance(12_000); vi.advanceTimersByTime(12_000);
    expect(call.sent.some((event) => event.type === 'session.close')).toBe(true);
    call.advance(5_000); vi.advanceTimersByTime(5_000);
    expect(call.sent.filter((event) => event.type === 'session.close')).toHaveLength(1);
    call.receive({ type: 'session.closed', reason: 'close_requested' });
    await vi.runAllTimersAsync();
    expect(call.phases.at(-1)).toBe('ended:inactive');
    expect(call.posts.at(-1)?.body).toEqual({ callId: 'live_1', kind: 'ended', reason: 'inactive' });
  });

  it('pauses the quiet-line timer while the user signs in to Google', async () => {
    vi.useFakeTimers();
    const call = await connect();
    call.receive({ type: 'session.started' });
    call.controller.setBusy(true);
    call.advance(90_000); vi.advanceTimersByTime(3_000);
    expect(call.sent.map((event) => event.content)).not.toContain('CHECK IN');
  });

  it('reports a dropped line and a closed page with distinct reasons', async () => {
    const dropped = await connect();
    dropped.receive({ type: 'session.started' });
    dropped.receive({ type: 'session.closed', reason: 'connection_lost' });
    await vi.waitFor(() => expect(dropped.phases.at(-1)).toBe('dropped:connection_lost'));
    const closedPage = await connect();
    closedPage.receive({ type: 'session.started' });
    closedPage.controller.abandon();
    await vi.waitFor(() => expect(closedPage.posts.some((post) => post.body.kind === 'dropped' && post.body.reason === 'page_closed')).toBe(true));
    expect(closedPage.phases.at(-1)).toBe('dropped:page_closed');
  });

  it('explains microphone failures plainly', () => {
    expect(microphoneError({ name: 'NotAllowedError' }).message).toMatch(/blocked/);
    expect(microphoneError({ name: 'NotFoundError' }).message).toMatch(/No microphone/);
    expect(microphoneError({ name: 'NotReadableError' }).message).toMatch(/busy/);
  });

  it('treats typing as the user being there, so a pending goodbye is cancelled', async () => {
    vi.useFakeTimers();
    const call = await connect();
    call.receive({ type: 'session.started' });
    call.advance(21_000); vi.advanceTimersByTime(1_000);
    call.advance(31_000); vi.advanceTimersByTime(1_000);
    expect(call.sent.map((event) => event.content)).toContain('GOODBYE');
    call.advance(3_000);
    call.controller.addTextContext('sorry, typing a long answer');
    call.advance(9_000); vi.advanceTimersByTime(12_000);
    expect(call.sent.some((event) => event.type === 'session.close')).toBe(false);
  });

  it("lets the user's hang-up win over an automated close, and resolves every close call", async () => {
    vi.useFakeTimers();
    const call = await connect();
    call.receive({ type: 'session.started' });
    const automated = call.controller.close('inactive');
    const byUser = call.controller.close();
    expect(call.sent.filter((event) => event.type === 'session.close')).toHaveLength(1);
    call.receive({ type: 'session.closed', reason: 'close_requested' });
    await vi.runAllTimersAsync();
    await Promise.all([automated, byUser]);
    expect(call.phases.at(-1)).toBe('ended:user_hangup');
  });

  it('keeps typed text within the per-append token limit', async () => {
    const call = await connect();
    call.receive({ type: 'session.started' });
    call.controller.addTextContext('語'.repeat(2_000));
    const typed = call.sent.find((event) => event.type === 'response.item.create') as { item: { content: Array<{ text: string }> } };
    expect(typed.item.content[0].text.length).toBeLessThanOrEqual(441);
  });
});
