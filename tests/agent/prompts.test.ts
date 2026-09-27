import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../lib/agent/prompts';

describe('Persona prompt contract', () => {
  it('includes version, current task, sourced state, and available capabilities', () => {
    const prompt = buildSystemPrompt({
      currentTask: 'Prepare a board meeting brief',
      facts: [{ key: 'company', value: 'Northstar Analytics', provenance: 'user_said', evidence: 'confirmed', sourceUrl: 'https://example.org/company' }],
      capabilities: ['text', 'browser_call'],
    });
    expect(prompt).toContain('understand-user/v1');
    expect(prompt).toContain('Prepare a board meeting brief');
    expect(prompt).toContain('user_said');
    expect(prompt).toContain('https://example.org/company');
    expect(prompt).toContain('browser_call');
    expect(prompt).toMatch(/uncertain|uncertainty/i);
    expect(prompt).toContain('resolve_identity');
    expect(prompt).not.toMatch(/first ask.*name/i);
  });

  it('labels a partial voice transcript as unverified context', () => {
    const prompt = buildSystemPrompt({ currentTask: 'Continue in text', facts: [], capabilities: ['text'], voiceFragments: [{ speaker: 'user', text: 'I maybe work at North...' }] });
    expect(prompt).toContain('I maybe work at North...');
    expect(prompt).toMatch(/unverified.*voice/i);
  });
});
