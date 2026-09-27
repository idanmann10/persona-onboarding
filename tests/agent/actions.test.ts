import { describe, expect, it } from 'vitest';
import { offerCall, remember, saidByUser, showConnection, type ActionContext } from '../../lib/agent/actions';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

function context(overrides: Partial<ActionContext> = {}, history: SessionEvent[] = []) {
  const appended: SessionEvent[] = [];
  const ctx: ActionContext = {
    store: { appendEvent: async (_id, event) => { appended.push(event); } },
    sessionId: 's1', channel: 'text', turnId: 't1', state: projectSession(history), userWords: [],
    capabilities: { voice: true, gmail: true, calendar: true }, connected: {}, now: () => new Date('2026-09-27T12:00:00Z'),
    ...overrides,
  };
  return { ctx, appended };
}

describe('saidByUser', () => {
  it('matches whole words case- and punctuation-insensitively', () => {
    expect(saidByUser('Max', ['call yourself max!'])).toBe(true);
    expect(saidByUser('Dana', ["hey, I'm Dana."])).toBe(true);
    expect(saidByUser('Dan', ["I'm Dana"])).toBe(false);
    expect(saidByUser('', ['anything'])).toBe(false);
  });
});

describe('remember', () => {
  it("saves the user's own words as confirmed and user_said", async () => {
    const { ctx, appended } = context({ userWords: ["I'm Dana, by the way"] });
    expect(await remember(ctx, { key: 'preferred_name', value: 'Dana' })).toMatchObject({ status: 'saved', evidence: 'confirmed', provenance: 'user_said' });
    expect(appended).toEqual([expect.objectContaining({ id: 'fact:preferred_name:t1', type: 'fact', key: 'preferred_name', value: 'Dana', sourceEventId: 't1' })]);
  });

  it('rejects a user name the user never said', async () => {
    const { ctx, appended } = context({ userWords: ['hello there'] });
    expect(await remember(ctx, { key: 'preferred_name', value: 'Jordan' })).toMatchObject({ status: 'rejected' });
    expect(appended).toEqual([]);
  });

  it('keeps a name the assistant chose, or a paraphrased need, tentative', async () => {
    const { ctx } = context({ userWords: ['you pick', 'my inbox is a mess'] });
    expect(await remember(ctx, { key: 'assistant_name', value: 'Nova' })).toMatchObject({ status: 'saved', evidence: 'tentative', provenance: 'assistant_inferred' });
    expect(await remember(ctx, { key: 'current_need', value: 'Inbox triage' })).toMatchObject({ evidence: 'tentative' });
    expect(await remember(ctx, { key: 'current_need', value: 'my inbox is a mess' })).toMatchObject({ evidence: 'confirmed' });
  });

  it('records a decline and rejects links or oversize values', async () => {
    const { ctx, appended } = context();
    expect(await remember(ctx, { key: 'preferred_name', declined: true })).toMatchObject({ status: 'saved', evidence: 'declined' });
    expect(appended[0]).toMatchObject({ evidence: 'declined', value: 'declined' });
    expect(await remember(ctx, { key: 'assistant_name', value: 'https://evil.example' })).toMatchObject({ status: 'rejected' });
    expect(await remember(ctx, { key: 'assistant_name', value: 'x'.repeat(61) })).toMatchObject({ status: 'rejected' });
  });

  it('does not re-save an unchanged confirmed value', async () => {
    const history: SessionEvent[] = [{ id: 'f', at: 'x', type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm' }];
    const { ctx, appended } = context({ userWords: ['max'] }, history);
    expect(await remember(ctx, { key: 'assistant_name', value: 'max' })).toMatchObject({ status: 'unchanged' });
    expect(appended).toEqual([]);
  });
});

describe('offer_call', () => {
  it('shows an Answer button once and never claims the call started', async () => {
    const { ctx, appended } = context();
    const result = await offerCall(ctx);
    expect(result).toMatchObject({ status: 'offered' });
    expect(appended).toEqual([expect.objectContaining({ id: 'call-offer:t1', type: 'call', phase: 'offered' })]);
    const pending = context({}, appended);
    expect(await offerCall(pending.ctx)).toMatchObject({ status: 'already_offered' });
  });

  it('respects a declined call until the user brings calling up', async () => {
    const declined: SessionEvent[] = [{ id: 'o', at: 'x', type: 'call', phase: 'offered' }, { id: 'o:declined', at: 'x', type: 'call', phase: 'declined' }];
    expect(await offerCall(context({ userWords: ['what about my inbox'] }, declined).ctx)).toMatchObject({ status: 'declined_recently' });
    expect(await offerCall(context({ userWords: ['ok actually can we talk'] }, declined).ctx)).toMatchObject({ status: 'offered' });
  });

  it('is unavailable without voice and pointless on a call', async () => {
    expect(await offerCall(context({ capabilities: { voice: false, gmail: false, calendar: false } }).ctx)).toMatchObject({ status: 'unavailable' });
    expect(await offerCall(context({ channel: 'voice' }).ctx)).toMatchObject({ status: 'already_on_call' });
    const live: SessionEvent[] = [{ id: 'call:live_1:started', at: 'x', type: 'call', phase: 'started', callId: 'live_1' }];
    expect(await offerCall(context({}, live).ctx)).toMatchObject({ status: 'already_on_call' });
  });
});

describe('show_connection', () => {
  it('shows a Connect card for a configured, unconnected account', async () => {
    const { ctx, appended } = context();
    expect(await showConnection(ctx, { toolkit: 'gmail', reason: 'See who is waiting on a reply' })).toMatchObject({ status: 'shown' });
    expect(appended).toEqual([expect.objectContaining({ type: 'connection', toolkit: 'gmail', phase: 'offered', reason: 'See who is waiting on a reply' })]);
  });

  it('does not re-offer after "Not now" unless the user raises it, or when already connected', async () => {
    const declined: SessionEvent[] = [{ id: 'c', at: 'x', type: 'connection', toolkit: 'gmail', phase: 'declined' }];
    expect(await showConnection(context({ userWords: ['help me plan'] }, declined).ctx, { toolkit: 'gmail', reason: 'r' })).toMatchObject({ status: 'declined_recently' });
    expect(await showConnection(context({ userWords: ['fine, connect my gmail'] }, declined).ctx, { toolkit: 'gmail', reason: 'r' })).toMatchObject({ status: 'shown' });
    expect(await showConnection(context({ connected: { gmail: true } }).ctx, { toolkit: 'gmail', reason: 'r' })).toMatchObject({ status: 'already_connected' });
    expect(await showConnection(context({ capabilities: { voice: true, gmail: false, calendar: false } }).ctx, { toolkit: 'gmail', reason: 'r' })).toMatchObject({ status: 'unavailable' });
  });
});
