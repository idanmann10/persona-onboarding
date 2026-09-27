import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../lib/agent/prompts';
import type { OnboardingProgress } from '../../lib/domain/project';

const progress = (overrides: Partial<OnboardingProgress> = {}): OnboardingProgress => ({
  assistantName: { status: 'unknown' }, preferredName: { status: 'unknown' }, need: { status: 'unknown' },
  gmail: 'not_offered', call: 'not_offered', automation: { status: 'none' }, ...overrides,
});

describe('Persona prompt contract', () => {
  it('includes version, sourced state, and available capabilities', () => {
    const prompt = buildSystemPrompt({
      facts: [{ key: 'company', value: 'Northstar Analytics', provenance: 'user_said', evidence: 'confirmed', sourceUrl: 'https://example.org/company' }],
      capabilities: ['text', 'browser_call'],
    });
    expect(prompt).toContain('understand-user/v4');
    expect(prompt).toContain('user_said');
    expect(prompt).toContain('https://example.org/company');
    expect(prompt).toContain('browser_call');
    expect(prompt).toMatch(/uncertain/i);
    expect(prompt).toContain('resolve_identity');
    expect(prompt).not.toMatch(/first ask.*name/i);
  });

  it('labels a partial voice transcript as unverified context', () => {
    const prompt = buildSystemPrompt({ facts: [], capabilities: ['text'], voiceFragments: [{ speaker: 'user', text: 'I maybe work at North...' }] });
    expect(prompt).toContain('I maybe work at North...');
    expect(prompt).toMatch(/unverified.*voice/i);
  });

  it("pursues the brief's four items contextually and never re-asks what is known or declined", () => {
    const prompt = buildSystemPrompt({
      facts: [], capabilities: ['text', 'browser call'],
      onboarding: progress({
        assistantName: { status: 'confirmed', value: 'Max' }, preferredName: { status: 'declined' },
        call: 'declined', automation: { status: 'active', title: 'Morning rundown', schedule: 'every weekday at 8:00 AM' },
      }),
    });
    expect(prompt).toContain('You are Max');
    expect(prompt).toMatch(/what to call them/);
    expect(prompt).toMatch(/whether they'll connect Gmail/);
    expect(prompt).toMatch(/offer_call/);
    expect(prompt).toContain("Their name: they'd rather not say. Don't ask again.");
    expect(prompt).toContain('they said no to a call');
    expect(prompt).toMatch(/Tasks come first/);
    expect(prompt).not.toContain('preferred_name:');
    expect(prompt).toContain('Recurring task: "Morning rundown" is active, every weekday at 8:00 AM.');
    expect(prompt).toMatch(/propose_automation/);
  });

  it('reads a bare name after the greeting as the assistant\'s name, and a first-person name as the user\'s', () => {
    const prompt = buildSystemPrompt({ facts: [], capabilities: ['text'], onboarding: progress() });
    expect(prompt).toMatch(/a name at the start of their first reply .* is your name: set it with customize/);
    expect(prompt).toMatch(/After you ask what to call them, a bare name is theirs/);
    expect(prompt).toMatch(/save preferred_name only when they say the name is theirs/);
  });

  it('turns the first real result into a recurring offer, and keeps declines out of remember', () => {
    const prompt = buildSystemPrompt({ facts: [], capabilities: ['text'], onboarding: progress() });
    expect(prompt).toMatch(/When you have just shown them a real result from their accounts, offer to make it recurring .* propose_automation/);
    expect(prompt).toMatch(/Saying no to a call or an account is note_decline, never remember/);
    expect(prompt).toMatch(/Never leave template placeholders/);
    expect(prompt).toMatch(/One button per message/);
    expect(prompt).toMatch(/If they asked for something, help with that instead and leave the call for later/);
  });

  it('keeps remember for the user and customize for the assistant, with no settings menu', () => {
    const prompt = buildSystemPrompt({ facts: [], capabilities: ['text'], onboarding: progress() });
    expect(prompt).toMatch(/Use remember only for something new or changed about them: what to call them and what they need/);
    expect(prompt).toMatch(/Use customize when they name you or ask to change your name, look, personality .* or call voice, and switch right away/);
    expect(prompt).toMatch(/When they first name you, you may also give yourself a look .* they can ask for another color/);
    expect(prompt).not.toContain('⋯');
    expect(prompt).not.toContain('assistant_name');
  });

  it('uses the chosen personality, and the warm default otherwise', () => {
    expect(buildSystemPrompt({ facts: [], capabilities: ['text'], personality: 'direct and efficient: lead with the answer' })).toContain('Personality: direct and efficient: lead with the answer.');
    expect(buildSystemPrompt({ facts: [], capabilities: ['text'] })).toMatch(/Personality: warm and encouraging/);
  });

  it('keeps names, needs and personality out of the generic fact list', () => {
    const prompt = buildSystemPrompt({
      facts: [{ key: 'personality', value: 'playful', provenance: 'user_confirmed', evidence: 'confirmed' }, { key: 'voice', value: 'willow', provenance: 'user_confirmed', evidence: 'confirmed' }],
      capabilities: ['text'],
    });
    expect(prompt).not.toContain('- personality:');
    expect(prompt).not.toContain('- voice:');
  });

  it('writes spoken sentences for the voice backend', () => {
    const prompt = buildSystemPrompt({ facts: [], capabilities: ['browser call'], mode: 'voice_backend' });
    expect(prompt).toMatch(/spoken aloud/);
    expect(prompt).toContain('You are on a live call with them now');
    expect(prompt).not.toContain('offer_call');
    expect(prompt).not.toContain('propose_automation');
    expect(prompt).not.toContain('One button per message');
  });
});
