import { describe, expect, it } from 'vitest';
import { createSettingsHandler } from '../../lib/http/settings';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const SESSION = '123e4567-e89b-42d3-a456-426614174000';

function setup() {
  const events: SessionEvent[] = [];
  const store = {
    sessionExists: async (id: string) => id === SESSION,
    readEvents: async () => [...events],
    appendEvent: async (_id: string, event: SessionEvent) => { events.push(event); },
    consumeIpQuota: async () => true,
  };
  const handler = createSettingsHandler(store, { OPENAI_VOICE: 'marin' });
  const send = (body: unknown, origin = 'https://persona.example') => handler(new Request('https://persona.example/api/settings', {
    method: 'POST', headers: { origin, cookie: `persona_session=${SESSION}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { events, send };
}

describe('settings endpoint', () => {
  it('saves a name, a personality and a voice as confirmed facts and returns the new settings', async () => {
    const { events, send } = setup();
    const response = await send({ assistantName: '  Nova ', personality: 'direct', voice: 'willow' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ settings: { assistantName: 'Nova', personality: { id: 'direct' }, voice: 'willow' }, progress: { assistantName: { status: 'confirmed', value: 'Nova' } } });
    expect(events.map((event) => event.type === 'fact' && [event.key, event.value, event.provenance])).toEqual([
      ['assistant_name', 'Nova', 'user_confirmed'], ['personality', 'direct', 'user_confirmed'], ['voice', 'willow', 'user_confirmed'],
    ]);
    expect(projectSession(events).timeline.filter((item) => item.kind === 'settings_notice')).toHaveLength(3);
  });

  it('records nothing when a value did not change', async () => {
    const { events, send } = setup();
    await send({ assistantName: 'Nova', voice: 'marin' });
    await send({ assistantName: 'Nova', personality: 'warm' });
    expect(events.map((event) => event.type === 'fact' && event.key)).toEqual(['assistant_name']);
  });

  it('keeps a described personality in the user\'s words', async () => {
    const { send } = setup();
    expect(await (await send({ personality: { custom: 'calm, dry humor' } })).json()).toMatchObject({ settings: { personality: { id: 'custom', text: 'calm, dry humor' } } });
  });

  it('rejects other origins, empty or invalid changes, links, and unknown voices', async () => {
    const { events, send } = setup();
    expect((await send({ assistantName: 'Nova' }, 'https://evil.example')).status).toBe(403);
    expect((await send({})).status).toBe(400);
    expect((await send({ assistantName: '<script>' })).status).toBe(400);
    expect((await send({ personality: { custom: 'see https://evil.example' } })).status).toBe(400);
    expect((await send({ voice: 'robot' })).status).toBe(400);
    expect(events).toEqual([]);
  });
});
