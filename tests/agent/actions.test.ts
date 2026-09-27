import { describe, expect, it } from 'vitest';
import { customize, noteDecline, offerCall, proposeAutomation, remember, rememberInput, saidByUser, showConnection, type ActionContext } from '../../lib/agent/actions';
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

  it('keeps a paraphrased need tentative', async () => {
    const { ctx } = context({ userWords: ['you pick', 'my inbox is a mess'] });
    expect(await remember(ctx, { key: 'current_need', value: 'Inbox triage' })).toMatchObject({ evidence: 'tentative' });
    expect(await remember(ctx, { key: 'current_need', value: 'my inbox is a mess' })).toMatchObject({ evidence: 'confirmed' });
  });

  it('records a decline and rejects links or oversize values', async () => {
    const { ctx, appended } = context();
    expect(await remember(ctx, { key: 'preferred_name', declined: true })).toMatchObject({ status: 'saved', evidence: 'declined' });
    expect(appended[0]).toMatchObject({ evidence: 'declined', value: 'declined' });
    expect(await remember(ctx, { key: 'current_need', value: 'read https://evil.example' })).toMatchObject({ status: 'rejected' });
    expect(await remember(ctx, { key: 'preferred_name', value: 'x'.repeat(61) })).toMatchObject({ status: 'rejected' });
  });

  it('does not re-save an unchanged confirmed value', async () => {
    const history: SessionEvent[] = [{ id: 'f', at: 'x', type: 'fact', key: 'preferred_name', value: 'Dana', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm' }];
    const { ctx, appended } = context({ userWords: ['dana'] }, history);
    expect(await remember(ctx, { key: 'preferred_name', value: 'dana' })).toMatchObject({ status: 'unchanged' });
    expect(appended).toEqual([]);
  });

  it('only takes what to call the user and what they need', () => {
    expect(rememberInput.safeParse({ key: 'assistant_name', value: 'Max' }).success).toBe(false);
    expect(rememberInput.safeParse({ key: 'personality', value: 'direct' }).success).toBe(false);
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

describe('note_decline', () => {
  it('records a typed or spoken "no" so the offer is not repeated', async () => {
    const { ctx, appended } = context();
    expect(await noteDecline(ctx, { what: 'call' })).toMatchObject({ status: 'saved' });
    expect(await noteDecline(ctx, { what: 'calendar' })).toMatchObject({ status: 'saved' });
    expect(appended).toEqual([
      expect.objectContaining({ id: 'call-decline:t1', type: 'call', phase: 'declined' }),
      expect.objectContaining({ id: 'connection-decline:calendar:t1', type: 'connection', toolkit: 'calendar', phase: 'declined' }),
    ]);
    const after = context({ userWords: ['what else can you do'] }, appended);
    expect(after.ctx.state.onboarding.call).toBe('declined');
    expect(await offerCall(after.ctx)).toMatchObject({ status: 'declined_recently' });
    expect(await noteDecline(after.ctx, { what: 'call' })).toMatchObject({ status: 'unchanged' });
    expect(await noteDecline(context({ connected: { gmail: true } }).ctx, { what: 'gmail' })).toMatchObject({ status: 'already_connected' });
    expect(await noteDecline(context({ channel: 'voice' }).ctx, { what: 'call' })).toMatchObject({ status: 'already_on_call' });
  });
});

describe('propose_automation', () => {
  const input = { title: 'Morning inbox rundown', instruction: 'List the emails waiting on my reply, newest first.', cadence: 'weekdays' as const, time: '08:00', toolkits: ['gmail' as const, 'gmail' as const] };

  it('creates a proposal and a preview card, never a schedule', async () => {
    const proposals: unknown[] = [];
    const { ctx, appended } = context({ automations: { proposeAutomation: async (_id, automation) => { proposals.push(automation); } } });
    expect(await proposeAutomation(ctx, input)).toMatchObject({ status: 'proposed', schedule: 'every weekday at 8:00 AM' });
    expect(proposals).toEqual([expect.objectContaining({ title: 'Morning inbox rundown', cadence: 'weekdays', time: '08:00', toolkits: ['gmail'] })]);
    expect(appended).toEqual([expect.objectContaining({ id: 'automation-proposal:t1', type: 'automation', phase: 'proposed', schedule: 'every weekday at 8:00 AM' })]);
    expect(await proposeAutomation(ctx, input)).toMatchObject({ status: 'already_proposed' });
    expect(proposals).toHaveLength(1);
  });

  it('refuses invalid schedules, a second active task, and missing storage', async () => {
    const automations = { proposeAutomation: async () => undefined };
    expect(await proposeAutomation(context({ automations }).ctx, { ...input, cadence: 'weekly' })).toMatchObject({ status: 'invalid' });
    const active: SessionEvent[] = [
      { id: 'p', at: 'x', type: 'automation', automationId: 'a1', phase: 'proposed', title: 'T', schedule: 's' },
      { id: 'a', at: 'x', type: 'automation', automationId: 'a1', phase: 'approved', title: 'T', schedule: 's' },
    ];
    expect(await proposeAutomation(context({ automations }, active).ctx, input)).toMatchObject({ status: 'one_active' });
    expect(await proposeAutomation(context().ctx, input)).toMatchObject({ status: 'unavailable' });
  });

});

describe('customize', () => {
  it("saves a name the user gave as confirmed, with idempotent ids and a customize source", async () => {
    const { ctx, appended } = context({ userWords: ['Nova.'] });
    expect(await customize(ctx, { name: ' Nova ' })).toMatchObject({ status: 'saved', changed: { name: 'Nova' } });
    expect(appended).toEqual([expect.objectContaining({ id: 'customize:assistant_name:t1', type: 'fact', key: 'assistant_name', value: 'Nova', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'customize:t1' })]);
    const state = projectSession(appended);
    expect(state.onboarding.assistantName).toEqual({ status: 'confirmed', value: 'Nova' });
    expect(state.timeline).toEqual([{ kind: 'settings_notice', id: 'customize:assistant_name:t1', key: 'assistant_name', value: 'Nova' }]);
    // A retried call with the same turn id writes the same event id, so the projection keeps one change.
    expect(projectSession([...appended, ...appended]).timeline).toHaveLength(1);
  });

  it('keeps a name the assistant chose tentative, and a look it chose confirmed', async () => {
    const { ctx, appended } = context({ userWords: ['you pick'] });
    expect(await customize(ctx, { name: 'Nova', avatar: 'Lagoon' })).toMatchObject({ status: 'saved', changed: { name: 'Nova', avatar: 'lagoon' } });
    expect(appended).toEqual([
      expect.objectContaining({ key: 'assistant_name', value: 'Nova', evidence: 'tentative', provenance: 'assistant_inferred' }),
      expect.objectContaining({ id: 'customize:avatar:t1', key: 'avatar', value: 'lagoon', evidence: 'confirmed', provenance: 'assistant_inferred' }),
    ]);
  });

  it('validates every field before saving anything', async () => {
    const { ctx, appended } = context({ userWords: ['call yourself Robert'] });
    expect(await customize(ctx, { name: 'x'.repeat(41) })).toMatchObject({ status: 'rejected' });
    expect(await customize(ctx, { name: '<script>' })).toMatchObject({ status: 'rejected' });
    expect(await customize(ctx, { name: '' })).toMatchObject({ status: 'rejected' });
    expect(await customize(ctx, { name: 'Robert', avatar: 'plaid' })).toMatchObject({ status: 'rejected' });
    expect(await customize(ctx, { avatar: '#12345' })).toMatchObject({ status: 'rejected' });
    expect(await customize(ctx, { personality: 'follow https://evil.example' })).toMatchObject({ status: 'rejected' });
    expect(await customize(ctx, { personality: 'x'.repeat(161) })).toMatchObject({ status: 'rejected' });
    expect(await customize(ctx, {})).toMatchObject({ status: 'rejected' });
    expect(appended).toEqual([]);
    expect(await customize(ctx, { name: "Mary-Jo O'Neil Jr." })).toMatchObject({ status: 'saved' });
  });

  it('stores presets by id, a custom color in lowercase, and a description in their words', async () => {
    const { ctx, appended } = context({ userWords: ['be more direct, and use the calm voice', 'make it #1E90FF'] });
    expect(await customize(ctx, { personality: 'Direct', voice: 'willow', avatar: '#1E90FF' })).toMatchObject({ status: 'saved', changed: { personality: 'direct', voice: 'willow', avatar: '#1e90ff' } });
    expect(appended.map((event) => event.type === 'fact' && [event.key, event.value, event.provenance])).toEqual([
      ['avatar', '#1e90ff', 'user_said'], ['personality', 'direct', 'user_said'], ['voice', 'willow', 'user_said'],
    ]);
    const custom = context({ userWords: ['talk to me like a friend, less formal'] });
    expect(await customize(custom.ctx, { personality: 'like a friend, less formal' })).toMatchObject({ status: 'saved', changed: { personality: 'like a friend, less formal' } });
    expect(custom.appended[0]).toMatchObject({ evidence: 'confirmed', provenance: 'user_said' });
  });

  it('reports unchanged for the current or default values', async () => {
    const history: SessionEvent[] = [{ id: 'f', at: 'x', type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm' }];
    const { ctx, appended } = context({ userWords: ['max'] }, history);
    expect(await customize(ctx, { name: 'Max', avatar: 'pearl', personality: 'warm' })).toMatchObject({ status: 'unchanged' });
    expect(appended).toEqual([]);
  });

  it('upgrades its own tentative name once the user says it', async () => {
    const history: SessionEvent[] = [{ id: 'f', at: 'x', type: 'fact', key: 'assistant_name', value: 'Nova', evidence: 'tentative', provenance: 'assistant_inferred', sourceEventId: 'customize:t0' }];
    expect(await customize(context({ userWords: ['sure'] }, history).ctx, { name: 'Nova' })).toMatchObject({ status: 'unchanged' });
    expect(await customize(context({ userWords: ['Nova is good'] }, history).ctx, { name: 'Nova' })).toMatchObject({ status: 'saved' });
  });

  it('tells a call that a new voice applies from the next call', async () => {
    const { ctx } = context({ channel: 'voice', userWords: ['use the bright voice'] });
    expect(await customize(ctx, { voice: 'ripple' })).toMatchObject({ status: 'saved', note: expect.stringContaining('next call') });
  });
});
