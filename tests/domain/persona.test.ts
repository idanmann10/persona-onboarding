import { describe, expect, it } from 'vitest';
import { personalityFrom, personalityLine, personaSettings } from '../../lib/domain/persona';
import { projectSession } from '../../lib/domain/project';
import type { SessionEvent } from '../../lib/domain/events';

const fact = (key: string, value: string, id = key): SessionEvent => ({ id, at: '2026-09-27T12:00:00Z', type: 'fact', key, value, evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: `settings:${id}` });

describe('persona settings', () => {
  it('defaults to a warm personality and the configured voice', () => {
    expect(personaSettings(projectSession([]), 'marin')).toEqual({ personality: { id: 'warm', label: 'Warm' }, voice: 'marin' });
  });

  it('reads the saved name, a preset personality and a voice', () => {
    const settings = personaSettings(projectSession([fact('assistant_name', 'Nova'), fact('personality', 'direct'), fact('voice', 'willow')]));
    expect(settings).toEqual({ assistantName: 'Nova', personality: { id: 'direct', label: 'Direct' }, voice: 'willow' });
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

  it('shows a thread line only for changes made in Settings', () => {
    const state = projectSession([
      fact('assistant_name', 'Nova'),
      { id: 'said', at: 'x', type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'm1' },
    ]);
    expect(state.timeline.filter((item) => item.kind === 'settings_notice')).toEqual([{ kind: 'settings_notice', id: 'assistant_name', key: 'assistant_name', value: 'Nova' }]);
    expect(personaSettings(state).assistantName).toBe('Max');
  });
});
