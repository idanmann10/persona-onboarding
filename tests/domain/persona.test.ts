import { describe, expect, it } from 'vitest';
import { AVATARS, avatarFrom, avatarPalette, personalityFrom, personalityLine, personaSettings } from '../../lib/domain/persona';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const fact = (key: string, value: string, id = key): SessionEvent => ({ id, at: '2026-09-27T12:00:00Z', type: 'fact', key, value, evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: `customize:${id}` });

describe('persona settings', () => {
  it('defaults to a warm personality and the configured voice', () => {
    expect(personaSettings(projectSession([]), 'marin')).toEqual({ personality: { id: 'warm', label: 'Warm' }, voice: 'marin', avatar: 'pearl' });
  });

  it('reads the saved name, a preset personality and a voice', () => {
    const settings = personaSettings(projectSession([fact('assistant_name', 'Nova'), fact('personality', 'direct'), fact('voice', 'willow'), fact('avatar', 'lagoon')]));
    expect(settings).toEqual({ assistantName: 'Nova', personality: { id: 'direct', label: 'Direct' }, voice: 'willow', avatar: 'lagoon' });
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
  it('keeps pearl as the default orb and gives every preset three stops', () => {
    expect(avatarPalette()).toEqual({ id: 'pearl', label: 'Pearl', stops: ['#d9d6cf', '#8f8b84', '#2a2a2e'] });
    expect(avatarPalette('unknown').id).toBe('pearl');
    for (const [id, preset] of Object.entries(AVATARS)) {
      expect(avatarPalette(id)).toMatchObject({ id, label: preset.label });
      expect(preset.stops.every((stop) => /^#[0-9a-f]{6}$/.test(stop))).toBe(true);
    }
    expect(Object.keys(AVATARS)).toEqual(['pearl', 'ember', 'lagoon', 'violet', 'moss', 'rose', 'gold', 'midnight']);
  });

  it('reads presets by id or label and derives a light-to-deep palette from a custom color', () => {
    expect(avatarFrom('Lagoon')).toBe('lagoon');
    expect(avatarFrom(' MIDNIGHT ')).toBe('midnight');
    expect(avatarFrom('#1E90FF')).toBe('#1e90ff');
    expect(avatarFrom('#12345')).toBeUndefined();
    expect(avatarFrom('plaid')).toBeUndefined();
    const custom = avatarPalette('#1e90ff');
    expect(custom).toMatchObject({ id: 'custom', label: 'Custom color' });
    expect(custom.stops[1]).toBe('#1e90ff');
    const brightness = (hex: string) => [1, 3, 5].reduce((sum, index) => sum + Number.parseInt(hex.slice(index, index + 2), 16), 0);
    expect(brightness(custom.stops[0])).toBeGreaterThan(brightness(custom.stops[1]));
    expect(brightness(custom.stops[2])).toBeLessThan(brightness(custom.stops[1]));
    expect(personaSettings(projectSession([fact('avatar', '#1E90FF')])).avatar).toBe('#1e90ff');
    expect(personaSettings(projectSession([fact('avatar', 'javascript:alert(1)')])).avatar).toBe('pearl');
  });
});
