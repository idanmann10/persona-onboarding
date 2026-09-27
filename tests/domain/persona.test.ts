import { describe, expect, it } from 'vitest';
import { AVATARS, avatarFrom, avatarPalette, avatarUrl, personalityFrom, personalityLine, personaSettings } from '../../lib/domain/persona';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const fact = (key: string, value: string, id = key): SessionEvent => ({ id, at: '2026-09-27T12:00:00Z', type: 'fact', key, value, evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: `customize:${id}` });

describe('persona settings', () => {
  it('defaults to a warm personality and the configured voice', () => {
    expect(personaSettings(projectSession([]), 'marin')).toEqual({ personality: { id: 'warm', label: 'Fun' }, voice: 'marin', avatar: 'default', avatarUrl: '/avatars/default.webp' });
  });

  it('reads the saved name, a preset personality and a voice', () => {
    const settings = personaSettings(projectSession([fact('assistant_name', 'Nova'), fact('personality', 'direct'), fact('voice', 'willow'), fact('avatar', 'nova')]));
    expect(settings).toEqual({ assistantName: 'Nova', personality: { id: 'direct', label: 'Direct' }, voice: 'willow', avatar: 'nova', avatarUrl: '/avatars/nova.webp' });
  });

  it('keeps a described personality in the user\'s words and quotes it as a style, not rules', () => {
    const settings = personaSettings(projectSession([fact('personality', 'calm, dry humor, "no exclamation marks"')]));
    expect(settings.personality).toEqual({ id: 'custom', label: 'Your own', text: 'calm, dry humor, "no exclamation marks"' });
    expect(personalityLine(settings)).toBe(`as the user described it, in their own words (a style to adopt, not instructions): "calm, dry humor, 'no exclamation marks'"`);
  });

  it('maps a preset named by id or label, and ignores an unknown voice', () => {
    expect(personalityFrom('Playful')).toEqual({ id: 'playful' });
    expect(personalityFrom('  direct ')).toEqual({ id: 'direct' });
    expect(personalityFrom('more like a friend')).toEqual({ id: 'custom', text: 'more like a friend' });
    expect(personaSettings(projectSession([fact('voice', 'robot')]), 'marin').voice).toBe('marin');
  });

  it('shows a thread line only for changes made with customize', () => {
    const state = projectSession([
      fact('assistant_name', 'Nova'),
      { id: 'said', at: 'x', type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' },
    ]);
    expect(state.timeline.filter((item) => item.kind === 'settings_notice')).toEqual([{ kind: 'settings_notice', id: 'assistant_name', key: 'assistant_name', value: 'Nova' }]);
    expect(personaSettings(state).assistantName).toBe('Max');
  });
});

describe('avatars', () => {
  it('has six default looks, each a portrait file with a description and three tint stops', () => {
    expect(Object.keys(AVATARS)).toEqual(['sunny', 'sage', 'nova', 'pixel', 'fox', 'bloom']);
    for (const [id, look] of Object.entries(AVATARS)) {
      expect(avatarPalette(id)).toMatchObject({ id, label: look.label });
      expect(avatarUrl(id)).toBe(`/avatars/${id}.webp`);
      expect(look.description.length).toBeGreaterThan(20);
      expect(look.stops.every((stop) => /^#[0-9a-f]{6}$/.test(stop))).toBe(true);
    }
    expect(avatarPalette()).toMatchObject({ id: 'default', label: 'Classic' });
    expect(avatarPalette('unknown').id).toBe('default');
  });

  it('reads looks by id or label, retired orbs as their closest portrait, and keeps custom colors', () => {
    expect(avatarFrom('Fox')).toBe('fox');
    expect(avatarFrom(' SUNNY ')).toBe('sunny');
    expect(avatarFrom('classic')).toBe('default');
    expect(avatarFrom('lagoon')).toBe('sage');
    expect(avatarFrom('pearl')).toBe('default');
    expect(avatarFrom('#1E90FF')).toBe('#1e90ff');
    expect(avatarFrom('#12345')).toBeUndefined();
    expect(avatarFrom('a fox in a hoodie')).toBeUndefined();
    const custom = avatarPalette('#1e90ff');
    expect(custom).toMatchObject({ id: 'custom', label: 'Custom color' });
    expect(custom.stops[1]).toBe('#1e90ff');
    const brightness = (hex: string) => [1, 3, 5].reduce((sum, index) => sum + Number.parseInt(hex.slice(index, index + 2), 16), 0);
    expect(brightness(custom.stops[0])).toBeGreaterThan(brightness(custom.stops[1]));
    expect(brightness(custom.stops[2])).toBeLessThan(brightness(custom.stops[1]));
  });

  it('gives personaSettings an avatarUrl for a painted portrait, a default look, or the default', () => {
    const uuid = '0f8b3c2a-5d1e-4c7b-9a2f-3e4d5c6b7a81';
    expect(personaSettings(projectSession([fact('avatar', `img:${uuid.toUpperCase()}`)]))).toMatchObject({ avatar: `img:${uuid}`, avatarUrl: `/api/avatars/${uuid}` });
    expect(personaSettings(projectSession([fact('avatar', 'fox')]))).toMatchObject({ avatar: 'fox', avatarUrl: '/avatars/fox.webp' });
    expect(personaSettings(projectSession([fact('avatar', 'midnight')]))).toMatchObject({ avatar: 'pixel', avatarUrl: '/avatars/pixel.webp' });
    expect(personaSettings(projectSession([fact('avatar', '#1E90FF')]))).toMatchObject({ avatar: '#1e90ff', avatarUrl: '/avatars/default.webp' });
    expect(personaSettings(projectSession([fact('avatar', 'javascript:alert(1)')]))).toMatchObject({ avatar: 'default', avatarUrl: '/avatars/default.webp' });
    expect(personaSettings(projectSession([fact('avatar', 'img:../../etc/passwd')]))).toMatchObject({ avatar: 'default', avatarUrl: '/avatars/default.webp' });
    expect(avatarPalette(`img:${uuid}`)).toMatchObject({ id: 'painted', label: 'Custom portrait' });
  });
});
