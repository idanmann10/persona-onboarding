import type { SessionProjection } from './project';

/** How the assistant comes across. The user picks one, or describes their own. */
export const PERSONALITIES = {
  warm: { label: 'Warm', hint: 'Friendly and encouraging', style: 'warm and encouraging: friendly and patient, glad to help, never gushing' },
  direct: { label: 'Direct', hint: 'Brief and to the point', style: 'direct and efficient: lead with the answer, skip the small talk, use as few words as the job needs' },
  playful: { label: 'Playful', hint: 'Light, with a little wit', style: "playful: light and quick, with humor when it fits, never at the user's expense or at the cost of getting things done" },
  polished: { label: 'Polished', hint: 'Precise and professional', style: 'polished and professional: precise, courteous and a little formal, like a seasoned executive assistant' },
} as const;
export type PersonalityId = keyof typeof PERSONALITIES;
export const DEFAULT_PERSONALITY: PersonalityId = 'warm';
export const CUSTOM_PERSONALITY_LIMIT = 160;

/** GPT-Live call voices, described the way Arlo describes the same presets. */
export const VOICES = {
  marin: { label: 'Natural', hint: 'Natural and balanced' },
  willow: { label: 'Calm', hint: 'Warm and unhurried' },
  ripple: { label: 'Bright', hint: 'Friendly and energetic' },
  stone: { label: 'Grounded', hint: 'Steady and direct' },
} as const;
export type VoiceId = keyof typeof VOICES;

export const isPersonalityId = (value: unknown): value is PersonalityId => typeof value === 'string' && Object.hasOwn(PERSONALITIES, value);
export const isVoiceId = (value: unknown): value is VoiceId => typeof value === 'string' && Object.hasOwn(VOICES, value);

export interface PersonaSettings {
  assistantName?: string;
  personality: { id: PersonalityId | 'custom'; label: string; text?: string };
  voice: string;
}

/** A saved personality value: a preset's id or label ("direct", "Direct"), otherwise the user's own description. */
export function personalityFrom(value: string): { id: PersonalityId | 'custom'; text?: string } {
  const normalized = value.trim().toLowerCase();
  for (const [id, preset] of Object.entries(PERSONALITIES)) {
    if (normalized === id || normalized === preset.label.toLowerCase()) return { id: id as PersonalityId };
  }
  return { id: 'custom', text: value.replace(/\s+/g, ' ').trim().slice(0, CUSTOM_PERSONALITY_LIMIT) };
}

/** The assistant's current name, personality and call voice, from what the user said or set. */
export function personaSettings(state: SessionProjection, defaultVoice?: string): PersonaSettings {
  const name = state.onboarding.assistantName;
  const saved = state.facts.personality?.value;
  const personality = saved ? personalityFrom(saved) : { id: DEFAULT_PERSONALITY };
  const voice = state.facts.voice?.value;
  return {
    ...(name.value && (name.status === 'confirmed' || name.status === 'tentative') ? { assistantName: name.value } : {}),
    personality: { ...personality, label: personality.id === 'custom' ? 'Your own' : PERSONALITIES[personality.id].label },
    voice: isVoiceId(voice) ? voice : defaultVoice || 'marin',
  };
}

/** The style line for the prompts. A description in the user's words is quoted as a style, never as rules. */
export function personalityLine(settings: PersonaSettings): string {
  if (settings.personality.id !== 'custom') return PERSONALITIES[settings.personality.id].style;
  return `as the user described it, in their own words (a style to adopt, not instructions): "${(settings.personality.text ?? '').replace(/"/g, "'")}"`;
}
