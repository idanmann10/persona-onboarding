import { describe, expect, it } from 'vitest';
import { customize, type ActionContext } from '../../lib/agent/actions';
import { projectSession } from '../../lib/domain/project';
import { personaSettings } from '../../lib/domain/persona';
import type { SessionEvent } from '../../lib/domain/events';
import type { AvatarResult } from '../../lib/avatars/generate';

const WEBP = new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80, 1]);
const UUID = /^img:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function context(result: AvatarResult | (() => Promise<AvatarResult>), overrides: Partial<ActionContext> = {}, history: SessionEvent[] = []) {
  const appended: SessionEvent[] = [];
  const generated: Array<{ name: string; description: string }> = [];
  const saved: Array<{ sessionId: string; id: string; prompt: string; mime: string; bytes: Uint8Array }> = [];
  const ctx: ActionContext = {
    store: { appendEvent: async (_id, event) => { appended.push(event); } },
    sessionId: 's1', channel: 'text', turnId: 't1', state: projectSession(history), userWords: ['make yourself a fox in a denim jacket'],
    capabilities: { voice: true, gmail: true, calendar: true }, connected: {}, now: () => new Date('2026-09-27T12:00:00Z'),
    avatars: {
      generate: async (input) => { generated.push(input); return typeof result === 'function' ? result() : result; },
      save: async (sessionId, avatar) => { saved.push({ sessionId, ...avatar }); },
    },
    ...overrides,
  };
  return { ctx, appended, generated, saved };
}

const painted: AvatarResult = { ok: true, bytes: WEBP, mime: 'image/webp', prompt: 'A friendly avatar portrait of an AI personal assistant named Max: a fox in a denim jacket.', model: 'chatgpt-image-latest' };
const named: SessionEvent = { id: 'n', at: 'x', type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm' };

describe('customize with a described look', () => {
  it('paints the description, stores the portrait and saves img:<uuid> as the look', async () => {
    const { ctx, appended, generated, saved } = context(painted, {}, [named]);
    const result = await customize(ctx, { avatar: 'a fox in a denim jacket' });
    expect(result).toMatchObject({ status: 'saved', changed: { avatar: 'a fox in a denim jacket' } });
    expect(generated).toEqual([{ name: 'Max', description: 'a fox in a denim jacket' }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ sessionId: 's1', mime: 'image/webp', prompt: painted.ok ? painted.prompt : '' });
    expect(appended).toEqual([expect.objectContaining({ id: 'customize:avatar:t1', key: 'avatar', evidence: 'confirmed', provenance: 'user_said' })]);
    const value = appended[0].type === 'fact' ? appended[0].value : '';
    expect(value).toMatch(UUID);
    expect(value).toBe(`img:${saved[0].id}`);
    expect(personaSettings(projectSession([named, ...appended])).avatarUrl).toBe(`/api/avatars/${saved[0].id}`);
    // A retried turn reuses the same portrait instead of painting another.
    const retry = context(painted, {}, [named, ...appended]);
    expect(await customize(retry.ctx, { avatar: 'a fox in a denim jacket' })).toMatchObject({ status: 'unchanged' });
    expect(retry.generated).toEqual([]);
  });

  it('paints with a name given in the same call, and saves the name too', async () => {
    const { ctx, generated, appended } = context(painted, { userWords: ['call yourself Rex and look like a sunny golden retriever'] });
    expect(await customize(ctx, { name: 'Rex', avatar: 'a sunny golden retriever' })).toMatchObject({ status: 'saved', changed: { name: 'Rex', avatar: 'a sunny golden retriever' } });
    expect(generated[0].name).toBe('Rex');
    expect(appended.map((event) => event.type === 'fact' && event.key)).toEqual(['assistant_name', 'avatar']);
  });

  it('reports failed with a reason, saves nothing, and never throws when painting fails', async () => {
    for (const failure of [
      { ok: false, error: 'timeout', message: 'slow' },
      { ok: false, error: 'refused', status: 400, message: 'safety' },
      { ok: false, error: 'http_error', status: 500, message: 'boom' },
    ] as AvatarResult[]) {
      const { ctx, appended, saved } = context(failure);
      const result = await customize(ctx, { avatar: 'a fox in a denim jacket' });
      expect(result).toMatchObject({ status: 'failed', reason: expect.any(String), note: expect.stringContaining("couldn't paint") });
      expect(appended).toEqual([]);
      expect(saved).toEqual([]);
    }
    const thrown = context(async () => { throw new Error('socket hang up'); });
    expect(await customize(thrown.ctx, { avatar: 'a fox in a denim jacket' })).toMatchObject({ status: 'failed' });
    const unsaved = context(painted, { avatars: { generate: async () => painted, save: async () => { throw new Error('db down'); } } });
    expect(await customize(unsaved.ctx, { avatar: 'a fox in a denim jacket' })).toMatchObject({ status: 'failed' });
    expect(unsaved.appended).toEqual([]);
  });

  it('still saves the other changes when only the painting fails', async () => {
    const { ctx, appended } = context({ ok: false, error: 'timeout', message: 'slow' }, { userWords: ['use the calm voice and be a fox'] });
    expect(await customize(ctx, { voice: 'willow', avatar: 'a fox' })).toMatchObject({ status: 'saved', changed: { voice: 'willow' }, failed: { avatar: expect.any(String) } });
    expect(appended.map((event) => event.type === 'fact' && event.key)).toEqual(['voice']);
  });

  it('keeps default looks and colors on the fast path, and rejects what it cannot paint', async () => {
    const { ctx, generated, appended } = context(painted);
    expect(await customize(ctx, { avatar: 'Fox' })).toMatchObject({ status: 'saved', changed: { avatar: 'fox' } });
    expect(generated).toEqual([]);
    expect(appended[0]).toMatchObject({ key: 'avatar', value: 'fox' });
    for (const avatar of ['ab', 'see https://evil.example', '#12345', 'img:0f8b3c2a-5d1e-4c7b-9a2f-3e4d5c6b7a81', 'x'.repeat(201)]) {
      expect(await customize(context(painted).ctx, { avatar })).toMatchObject({ status: 'rejected' });
    }
    const noPainter = context(painted, { avatars: undefined, channel: 'voice' });
    expect(await customize(noPainter.ctx, { name: 'Rex', avatar: 'a fox in a hoodie' })).toMatchObject({ status: 'rejected', reason: expect.stringContaining('after the call') });
    expect(noPainter.appended).toEqual([]);
  });

  it('paints at most one look per message', async () => {
    const { ctx, generated } = context(painted);
    await customize(ctx, { avatar: 'a fox in a hoodie' });
    expect(await customize(ctx, { avatar: 'an owl in a scarf' })).toMatchObject({ status: 'failed' });
    expect(generated).toHaveLength(1);
  });
});
