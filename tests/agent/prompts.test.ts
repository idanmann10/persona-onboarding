import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../lib/agent/prompts';

describe('Persona prompt contract', () => {
  it('includes version, current task, sourced state, and available capabilities', () => {
    const prompt = buildSystemPrompt({
      currentTask: 'Prepare a board meeting brief',
      facts: [{ key: 'company', value: 'Northstar Analytics', provenance: 'user_said', evidence: 'confirmed', sourceUrl: 'https://example.org/company' }],
      capabilities: ['text', 'browser_call'],
    });
    expect(prompt).toContain('understand-user/v3');
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

  it("pursues the brief's four items contextually and never re-asks what is known or declined", () => {
    const prompt = buildSystemPrompt({
      currentTask: 'hi', facts: [], capabilities: ['text', 'browser call'],
      onboarding: {
        assistantName: { status: 'confirmed', value: 'Max' }, preferredName: { status: 'declined' }, need: { status: 'unknown' },
        gmail: 'not_offered', call: 'declined', automation: { status: 'active', title: 'Morning rundown', schedule: 'every weekday at 8:00 AM' },
      },
    });
    expect(prompt).toContain('You are Max');
    expect(prompt).toMatch(/what to call them/);
    expect(prompt).toMatch(/whether they want to connect Gmail/);
    expect(prompt).toMatch(/offer_call/);
    expect(prompt).toContain("Their name: they'd rather not say. Don't ask again.");
    expect(prompt).toContain('they said no to a call');
    expect(prompt).toMatch(/task comes first/);
    expect(prompt).not.toContain('preferred_name:');
    expect(prompt).toContain('Recurring task: "Morning rundown" is active, every weekday at 8:00 AM.');
    expect(prompt).toMatch(/propose_automation/);
  });

  it('writes spoken sentences for the voice backend', () => {
    const prompt = buildSystemPrompt({ facts: [], capabilities: ['browser call'], mode: 'voice_backend' });
    expect(prompt).toMatch(/spoken aloud/);
    expect(prompt).toContain('You are on that call now.');
    expect(prompt).not.toContain('use offer_call');
    expect(prompt).not.toContain('propose_automation');
  });
});
