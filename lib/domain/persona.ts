import type { SessionProjection } from './project';

/** How the assistant comes across. The user picks one, or describes their own. */
export const PERSONALITIES = {
  warm: { label: 'Fun', hint: 'Upbeat, casual, a little playful', style: 'fun and warm: upbeat, casual and a little playful, like a friend who happens to be great at this; a light joke when it fits, never at the cost of getting things done' },
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
 * The assistant's look: a painted character portrait. The default looks are static files in public/avatars
 * (painted once by scripts/generate-avatars.ts from these descriptions). A look the user describes in words is
 * painted on request, stored in Postgres and saved as `img:<uuid>` (served by /api/avatars/<uuid>).
 * `stops` is a light-to-deep tint of each look, for rings and placeholders while a portrait loads.
 */
export const AVATARS = {
  // The cute set: one character per pastel hue, its face filling the frame, so each still reads at 24px.
  mochi: { label: 'Mochi', description: 'a cute, round baby panda with big sparkly eyes, rosy cheeks and a tiny green bamboo leaf tucked behind one ear, on a soft mint-green background', stops: ['#d4f0e0', '#6cbf94', '#1d4a33'] },
  pip: { label: 'Pip', description: 'a cute, fluffy little yellow chick with big sparkly eyes and a tiny knitted sky-blue beanie, on a soft sky-blue background', stops: ['#d6e9fb', '#6aa8e0', '#16385c'] },
  luna: { label: 'Luna', description: 'a cute white bunny with long floppy ears, big sweet eyes, rosy cheeks and a small golden crescent-moon hair clip, on a soft lavender background', stops: ['#e6dcfa', '#9c86d8', '#2e2352'] },
  koa: { label: 'Koa', description: 'a cute, cuddly grey koala with big fluffy ears, a round dark nose, big sparkly eyes and a small pink flower behind one ear, on a soft peach background', stops: ['#fbe0cf', '#e79c72', '#5a2a12'] },
  otto: { label: 'Otto', description: 'a cute baby sea otter with fluffy brown fur, tiny whiskers, big sparkly eyes, a happy smile and a cosy red knit scarf, on a soft butter-yellow background', stops: ['#fbf0c4', '#e2bd4a', '#5a450c'] },
  bao: { label: 'Bao', description: 'a cute, chubby golden hamster with puffy round cheeks, big sparkly eyes and a tiny striped bow tie, on a soft rose-pink background', stops: ['#fbd9e3', '#e483a1', '#5c1a30'] },
  kiko: { label: 'Kiko', description: 'a cute red panda with fluffy russet fur, white cheek markings, big sparkly eyes and a small cream bandana, on a soft aqua background', stops: ['#cdeeed', '#4fb7b3', '#10403e'] },
  ziggy: { label: 'Ziggy', description: 'a cute, friendly baby dragon with mint-green scales, tiny rounded horns, little wings, big sparkly eyes and a happy grin, on a soft coral background', stops: ['#fdd5cb', '#f0806a', '#5e1f12'] },
  sunny: { label: 'Sunny', description: 'a cheerful golden retriever with a big friendly grin and bright eyes, wearing a soft mustard knit scarf', stops: ['#f7e3a8', '#e0a93b', '#5a3b0c'] },
  sage: { label: 'Sage', description: 'a calm, wise owl with soft sage-green and cream feathers and small round glasses, wearing a cosy oatmeal cardigan', stops: ['#dbe6cf', '#86a36c', '#27361d'] },
  nova: { label: 'Nova', description: 'a friendly little robot with a pearly white rounded shell, lavender accents and a glowing round face screen showing a gentle smile', stops: ['#e2d9f7', '#9a82d6', '#2c2150'] },
  pixel: { label: 'Pixel', description: 'a curious grey tabby cat with big green eyes and oversized headphones around its neck, in a navy hoodie', stops: ['#cdd5ea', '#56689a', '#141a33'] },
  fox: { label: 'Fox', description: 'a clever red fox with a warm, knowing smile, wearing a light denim jacket over a white tee', stops: ['#f8d2b4', '#dc7440', '#4f1c0e'] },
  bloom: { label: 'Bloom', description: 'a gentle young woman with rosy cheeks, soft wavy auburn hair and a small crown of pastel flowers, in a blush linen top', stops: ['#f6d6dd', '#cf7d91', '#4a1d2a'] },
} as const satisfies Record<string, { label: string; description: string; stops: readonly [string, string, string] }>;
export type AvatarId = keyof typeof AVATARS;
/** The look before anyone picks one: its own portrait at /avatars/default.webp. */
export const DEFAULT_AVATAR = 'default';
export const DEFAULT_LOOK = {
  label: 'Classic',
  description: 'a warm, friendly adult in their early thirties with short tousled dark hair, kind eyes and a relaxed, confident smile, in a soft cream knit sweater',
  stops: ['#e4e0d8', '#a39d92', '#34322f'],
} as const;
/** The retired gradient orbs, read as the closest portrait so older sessions keep a look. */
const RETIRED_LOOKS: Record<string, AvatarId | typeof DEFAULT_AVATAR> = {
  pearl: 'default', ember: 'fox', lagoon: 'sage', violet: 'nova', moss: 'sage', rose: 'bloom', gold: 'sunny', midnight: 'pixel',
};
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PAINTED = /^img:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const isPersonalityId = (value: unknown): value is PersonalityId => typeof value === 'string' && Object.hasOwn(PERSONALITIES, value);
export const isVoiceId = (value: unknown): value is VoiceId => typeof value === 'string' && Object.hasOwn(VOICES, value);
export const isAvatarId = (value: unknown): value is AvatarId => typeof value === 'string' && Object.hasOwn(AVATARS, value);

/**
 * A look someone can pick by name: a default look's id or label (any case), `default`/`classic`, a retired
 * orb's id (read as its closest portrait), or a lowercase `#rrggbb` color. Undefined for anything else,
 * which the customize tool treats as a description to paint.
 */
export function avatarFrom(value: string): AvatarId | typeof DEFAULT_AVATAR | `#${string}` | undefined {
  const normalized = value.trim().toLowerCase();
  if (HEX_COLOR.test(normalized)) return normalized as `#${string}`;
  if (normalized === DEFAULT_AVATAR || normalized === DEFAULT_LOOK.label.toLowerCase()) return DEFAULT_AVATAR;
  for (const [id, look] of Object.entries(AVATARS)) if (normalized === id || normalized === look.label.toLowerCase()) return id as AvatarId;
  return Object.hasOwn(RETIRED_LOOKS, normalized) ? RETIRED_LOOKS[normalized] : undefined;
}

/** A saved look as the app uses it: a pickable look, or a painted portrait `img:<uuid>`. Anything else is the default. */
export function storedAvatar(value?: string): string {
  const painted = value?.trim().match(PAINTED);
  if (painted) return `img:${painted[1].toLowerCase()}`;
  return (value ? avatarFrom(value) : undefined) ?? DEFAULT_AVATAR;
}

/** Where the portrait for a saved look lives. */
export function avatarUrl(value?: string): string {
  const avatar = storedAvatar(value);
  if (avatar.startsWith('img:')) return `/api/avatars/${avatar.slice(4)}`;
  return isAvatarId(avatar) ? `/avatars/${avatar}.webp` : `/avatars/${DEFAULT_AVATAR}.webp`;
}

const mix = (hex: string, target: number, amount: number) => `#${[1, 3, 5].map((index) => {
  const channel = Number.parseInt(hex.slice(index, index + 2), 16);
  return Math.round(channel + (target - channel) * amount).toString(16).padStart(2, '0');
}).join('')}`;

/** A look's name and tint: a default look's own, a painted portrait's, or three stops derived from a custom color. */
export function avatarPalette(value?: string): { id: AvatarId | typeof DEFAULT_AVATAR | 'custom' | 'painted'; label: string; stops: [string, string, string] } {
  const avatar = storedAvatar(value);
  if (isAvatarId(avatar)) return { id: avatar, label: AVATARS[avatar].label, stops: [...AVATARS[avatar].stops] };
  if (avatar.startsWith('img:')) return { id: 'painted', label: 'Custom portrait', stops: [...DEFAULT_LOOK.stops] };
  if (avatar.startsWith('#')) return { id: 'custom', label: 'Custom color', stops: [mix(avatar, 255, 0.6), avatar, mix(avatar, 0, 0.72)] };
  return { id: DEFAULT_AVATAR, label: DEFAULT_LOOK.label, stops: [...DEFAULT_LOOK.stops] };
}

export interface PersonaSettings {
  assistantName?: string;
  personality: { id: PersonalityId | 'custom'; label: string; text?: string };
  voice: string;
  /** A default look id, `default`, a `#rrggbb` color (older sessions) or `img:<uuid>`; see storedAvatar. */
  avatar: string;
  /** The portrait to show: /api/avatars/<uuid>, /avatars/<look>.webp, or /avatars/default.webp. */
  avatarUrl: string;
}

/** A saved personality value: a preset's id or label ("direct", "Direct"), otherwise the user's own description. */
export function personalityFrom(value: string): { id: PersonalityId | 'custom'; text?: string } {
  const normalized = value.trim().toLowerCase();
  for (const [id, preset] of Object.entries(PERSONALITIES)) {
    if (normalized === id || normalized === preset.label.toLowerCase()) return { id: id as PersonalityId };
  }
  // "a bit more direct" or "more playful please" names one preset: use it.
  const words = new Set(normalized.split(/[^\p{L}]+/u));
  const named = Object.entries(PERSONALITIES).filter(([id, preset]) => words.has(id) || words.has(preset.label.toLowerCase()));
  if (named.length === 1 && normalized.length <= 40) return { id: named[0][0] as PersonalityId };
  return { id: 'custom', text: value.replace(/\s+/g, ' ').trim().slice(0, CUSTOM_PERSONALITY_LIMIT) };
}

/** The assistant's current name, personality and call voice, from what the user said or set. */
export function personaSettings(state: SessionProjection, defaultVoice?: string): PersonaSettings {
  const name = state.onboarding.assistantName;
  const saved = state.facts.personality?.value;
  const personality = saved ? personalityFrom(saved) : { id: DEFAULT_PERSONALITY };
  const voice = state.facts.voice?.value;
  const avatar = storedAvatar(state.facts.avatar?.value);
  return {
    ...(name.value && (name.status === 'confirmed' || name.status === 'tentative') ? { assistantName: name.value } : {}),
    personality: { ...personality, label: personality.id === 'custom' ? 'Your own' : PERSONALITIES[personality.id].label },
    voice: isVoiceId(voice) ? voice : defaultVoice || 'marin',
    avatar,
    avatarUrl: avatarUrl(avatar),
  };
}

/** The style line for the prompts. A description in the user's words is quoted as a style, never as rules. */
export function personalityLine(settings: PersonaSettings): string {
  if (settings.personality.id !== 'custom') return PERSONALITIES[settings.personality.id].style;
  return `as the user described it, in their own words (a style to adopt, not instructions): "${(settings.personality.text ?? '').replace(/"/g, "'")}"`;
}
