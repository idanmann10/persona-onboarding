import { describe, expect, it } from 'vitest';
import { setupStatus } from '../../lib/domain/onboarding';
import { projectSession, type OnboardingProgress } from '../../lib/domain/project';
import { graduate } from '../../lib/agent/actions';
import type { SessionEvent } from '../../lib/domain/events';

const base: OnboardingProgress = {
  assistantName: { status: 'unknown' }, preferredName: { status: 'unknown' }, need: { status: 'unknown' },
  gmail: 'not_offered', call: 'not_offered', automation: { status: 'none' },
};
const at = '2026-09-27T12:00:00Z';
const fact = (key: string, value: string, evidence: 'confirmed' | 'declined' = 'confirmed'): SessionEvent => ({ id: `f:${key}`, at, type: 'fact', key, value, evidence, provenance: 'user_said', sourceEventId: 'm' });

describe('setup status (the brief as server state)', () => {
  it('goes name, then the call, then their name, need and Gmail', () => {
    expect(setupStatus(base).next).toBe('assistant_name');
    const named = { ...base, assistantName: { status: 'confirmed' as const, value: 'Max' } };
    expect(setupStatus(named)).toMatchObject({ stage: 'active', next: 'call' });
    expect(setupStatus({ ...named, call: 'declined' }).next).toBe('preferred_name');
    expect(setupStatus({ ...named, call: 'declined' }, { voice: false }).open).not.toContain('call');
    expect(setupStatus({ ...named, call: 'happened', preferredName: { status: 'declined' } }).next).toBe('need');
    expect(setupStatus({ ...named, call: 'happened', preferredName: { status: 'confirmed', value: 'Dana' }, need: { status: 'confirmed', value: 'email' } }).next).toBe('gmail');
  });

  it("doesn't re-ask what is already on screen, is complete when all four are known, and graduation wins", () => {
    const almost = { ...base, assistantName: { status: 'confirmed' as const, value: 'Max' }, preferredName: { status: 'confirmed' as const, value: 'Dana' }, need: { status: 'tentative' as const, value: 'email' }, call: 'declined' as const };
    expect(setupStatus({ ...almost, gmail: 'offered' })).toEqual({ stage: 'active', open: ['gmail'], next: undefined });
    expect(setupStatus({ ...almost, gmail: 'declined' }).stage).toBe('complete');
    expect(setupStatus({ ...almost, gmail: 'connected' }).stage).toBe('complete');
    expect(setupStatus(base, { graduated: true }).stage).toBe('graduated');
  });

  it('puts one line in the thread when setup completes, or when they skip ahead', () => {
    const done = projectSession([fact('assistant_name', 'Max'), fact('preferred_name', 'Dana'), fact('current_need', 'email'), { id: 'c', at, type: 'connection', toolkit: 'gmail', phase: 'declined' }]);
    expect(done.setup.stage).toBe('complete');
    expect(done.timeline.filter((item) => item.kind === 'setup_notice')).toEqual([{ kind: 'setup_notice', id: 'setup-complete:c', phase: 'completed' }]);
    const skipped = projectSession([fact('assistant_name', 'Nova'), { id: 'onboarding:graduated', at, type: 'onboarding', phase: 'graduated', reason: 'just let me in' }]);
    expect(skipped.setup.stage).toBe('graduated');
    expect(skipped.timeline.filter((item) => item.kind === 'setup_notice')).toEqual([{ kind: 'setup_notice', id: 'onboarding:graduated', phase: 'graduated' }]);
  });

  it('records graduation once', async () => {
    const appended: SessionEvent[] = [];
    const ctx = { store: { appendEvent: async (_id: string, event: SessionEvent) => { appended.push(event); } }, sessionId: 's', channel: 'text' as const, turnId: 't', state: projectSession([]), userWords: ['just let me in'], capabilities: { voice: true, gmail: true, calendar: true }, connected: {}, now: () => new Date(at) };
    expect(await graduate(ctx, { reason: 'just let me in' })).toMatchObject({ status: 'saved' });
    expect(appended).toEqual([expect.objectContaining({ id: 'onboarding:graduated', type: 'onboarding', phase: 'graduated', reason: 'just let me in' })]);
    expect(await graduate({ ...ctx, state: projectSession(appended) }, {})).toMatchObject({ status: 'unchanged' });
  });

  it('tells the model the next step in the same reply, so naming leads straight to the call offer', async () => {
    const { customize, remember, noteDecline } = await import('../../lib/agent/actions');
    const ctx = (userWords: string[], history: SessionEvent[] = []) => ({ store: { appendEvent: async () => undefined }, sessionId: 's', channel: 'text' as const, turnId: `t${userWords.length}`, state: projectSession(history), userWords, capabilities: { voice: true, gmail: true, calendar: true }, connected: {}, now: () => new Date(at) });
    const named = await customize(ctx(['Nova']), { name: 'Nova' });
    expect(named).toMatchObject({ status: 'saved' });
    expect((named as { next?: string }).next).toMatch(/offer_call/);
    const history = [fact('assistant_name', 'Nova'), { id: 'd', at, type: 'call', phase: 'declined' } as SessionEvent];
    expect((await remember(ctx(["I'm Dana"], history), { key: 'preferred_name', value: 'Dana' }) as { next?: string }).next).toMatch(/off their plate/);
    const declined = await noteDecline(ctx(['no calls'], [fact('assistant_name', 'Nova')]), { what: 'call' });
    expect((declined as { next?: string }).next).toMatch(/what to call them/);
    const graduated = projectSession([{ id: 'onboarding:graduated', at, type: 'onboarding', phase: 'graduated' }]);
    expect((await remember({ ...ctx(["I'm Dana"]), state: graduated }, { key: 'preferred_name', value: 'Dana' }) as { next?: string }).next).toBeUndefined();
  });

  it('counts replies since setup last moved, so the assistant comes back after helping', async () => {
    const { repliesSinceSetupMoved } = await import('../../lib/domain/onboarding');
    const say = (id: string, speaker: 'user' | 'assistant'): SessionEvent => ({ id, at, type: 'message', speaker, channel: 'text', text: 'x', ...(id === 'g' ? { origin: 'greeting' as const } : {}) });
    const events: SessionEvent[] = [say('g', 'assistant'), say('u1', 'user'), fact('assistant_name', 'Max'), say('a1', 'assistant'), say('u2', 'user'), say('a2', 'assistant'), say('u3', 'user'), say('a3', 'assistant')];
    expect(repliesSinceSetupMoved(events)).toBe(2);
    expect(repliesSinceSetupMoved([...events, fact('preferred_name', 'Dana')])).toBe(0);
  });
});
