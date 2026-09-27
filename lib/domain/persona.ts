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

/**
 * The assistant's look: the orb's three gradient stops (light, mid, deep), drawn as
 * `radial-gradient(circle at 32% 28%, #fff 0 12%, light 38%, mid 72%, deep 100%)`.
 */
export const AVATARS = {
  pearl: { label: 'Pearl', stops: ['#d9d6cf', '#8f8b84', '#2a2a2e'] },
  ember: { label: 'Ember', stops: ['#f6c9a4', '#d86a3a', '#4e1a10'] },
  lagoon: { label: 'Lagoon', stops: ['#bfe7e2', '#3d9a96', '#10353c'] },
  violet: { label: 'Violet', stops: ['#dcd0f5', '#8b6fd0', '#2a1d4f'] },
  moss: { label: 'Moss', stops: ['#d6e1c0', '#7a9255', '#24311a'] },
  rose: { label: 'Rose', stops: ['#f4d0d8', '#c76e85', '#461a28'] },
  gold: { label: 'Gold', stops: ['#f3e2b2', '#c29a3c', '#46320f'] },
  midnight: { label: 'Midnight', stops: ['#bcc5de', '#4a5a88', '#11152a'] },
} as const satisfies Record<string, { label: string; stops: readonly [string, string, string] }>;
export type AvatarId = keyof typeof AVATARS;
export const DEFAULT_AVATAR: AvatarId = 'pearl';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const isPersonalityId = (value: unknown): value is PersonalityId => typeof value === 'string' && Object.hasOwn(PERSONALITIES, value);
export const isVoiceId = (value: unknown): value is VoiceId => typeof value === 'string' && Object.hasOwn(VOICES, value);
export const isAvatarId = (value: unknown): value is AvatarId => typeof value === 'string' && Object.hasOwn(AVATARS, value);

/** A look as stored: a preset id (by id or label, any case) or a lowercase `#rrggbb` color. Undefined when neither. */
export function avatarFrom(value: string): AvatarId | `#${string}` | undefined {
  const normalized = value.trim().toLowerCase();
  if (HEX_COLOR.test(normalized)) return normalized as `#${string}`;
  for (const [id, preset] of Object.entries(AVATARS)) if (normalized === id || normalized === preset.label.toLowerCase()) return id as AvatarId;
  return undefined;
}

const mix = (hex: string, target: number, amount: number) => `#${[1, 3, 5].map((index) => {
  const channel = Number.parseInt(hex.slice(index, index + 2), 16);
  return Math.round(channel + (target - channel) * amount).toString(16).padStart(2, '0');
}).join('')}`;

/** The orb's gradient for a stored look: a preset's stops, or three stops derived from a custom color. Unknown values get the default. */
export function avatarPalette(value?: string): { id: AvatarId | 'custom'; label: string; stops: [string, string, string] } {
  const avatar = value ? avatarFrom(value) : undefined;
  if (avatar && isAvatarId(avatar)) return { id: avatar, label: AVATARS[avatar].label, stops: [...AVATARS[avatar].stops] };
  if (avatar) return { id: 'custom', label: 'Custom color', stops: [mix(avatar, 255, 0.6), avatar, mix(avatar, 0, 0.72)] };
  return { id: DEFAULT_AVATAR, label: AVATARS[DEFAULT_AVATAR].label, stops: [...AVATARS[DEFAULT_AVATAR].stops] };
}

export interface PersonaSettings {
  assistantName?: string;
  personality: { id: PersonalityId | 'custom'; label: string; text?: string };
  voice: string;
  /** A preset id or a `#rrggbb` color; see avatarPalette. */
  avatar: string;
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
  const avatar = state.facts.avatar?.value ? avatarFrom(state.facts.avatar.value) : undefined;
  return {
    ...(name.value && (name.status === 'confirmed' || name.status === 'tentative') ? { assistantName: name.value } : {}),
    personality: { ...personality, label: personality.id === 'custom' ? 'Your own' : PERSONALITIES[personality.id].label },
    voice: isVoiceId(voice) ? voice : defaultVoice || 'marin',
    avatar: avatar ?? DEFAULT_AVATAR,
  };
}

/** The style line for the prompts. A description in the user's words is quoted as a style, never as rules. */
export function personalityLine(settings: PersonaSettings): string {
  if (settings.personality.id !== 'custom') return PERSONALITIES[settings.personality.id].style;
  return `as the user described it, in their own words (a style to adopt, not instructions): "${(settings.personality.text ?? '').replace(/"/g, "'")}"`;
}
