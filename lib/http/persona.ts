import { z } from 'zod';
import type { SessionEvent } from '../domain/events';
import { projectSession } from '../domain/project';
import { DEFAULT_AVATAR, isAvatarId, isVoiceId, personaSettings, storedAvatar } from '../domain/persona';
import type { AvatarFailure, AvatarResult } from '../avatars/generate';
import { signedInSession, type LoginStore } from '../auth/login';
import { withinIpLimit, type IpQuotaStore } from './client-key';
import { sameOrigin } from './origin';

interface Store extends LoginStore, IpQuotaStore {
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  saveAvatar(sessionId: string, avatar: { id: string; prompt: string; mime: string; bytes: Uint8Array }): Promise<void>;
  getAvatar(id: string, sessionId: string): Promise<{ mime: string; bytes: Uint8Array } | undefined>;
}

export interface PersonaDependencies {
  /** Paints a described look; absent when there is no OpenAI key. */
  paint?: (input: { name: string; description: string }) => Promise<AvatarResult>;
  env?: Record<string, string | undefined>;
}

/** The same bounds the customize tool puts on a described look. */
const DESCRIPTION_LIMIT = 200;
const UNSAFE = /[\u0000-\u001f\u007f]|https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|io|ai|co|app|dev|me|ly)\b/i;
const PAINTED = /^img:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

/** A stock look (or `default`), a portrait painted earlier for this conversation, a description to paint, or a call voice. */
export const personaInput = z.union([
  z.object({ avatar: z.string().refine((value) => value === DEFAULT_AVATAR || isAvatarId(value) || PAINTED.test(value)) }).strict(),
  z.object({ voice: z.string().refine(isVoiceId) }).strict(),
  z.object({ paint: z.string().transform(clean).pipe(z.string().min(3).max(DESCRIPTION_LIMIT).refine((value) => !UNSAFE.test(value))) }).strict(),
]);

const PAINT_FAILED: Record<AvatarFailure['error'], [number, string]> = {
  refused: [422, 'The image safety filter refused that look. Try describing it another way.'],
  timeout: [504, 'Painting took too long. Please try again.'],
  not_configured: [503, "Painting a new look isn't available here."],
  http_error: [502, 'The painting service had a problem. Please try again in a moment.'],
  network: [502, 'The painting service had a problem. Please try again in a moment.'],
  bad_response: [502, 'The painting service had a problem. Please try again in a moment.'],
};

/**
 * The look picker in the header. Picking a stock portrait, painting one from a description, or picking a call
 * voice saves the same `avatar` or `voice` fact the customize tool saves when the user asks in the chat, so
 * the next reply, the next call and the thread (a "New look" or "Call voice" line) all follow it. A voice
 * picked here is theirs: the assistant no longer matches its voice to a new look on its own.
 */
export function createPersonaHandler(store: Store, deps: PersonaDependencies = {}) {
  return async (request: Request): Promise<Response> => {
    if (!sameOrigin(request)) return new Response('Unexpected origin', { status: 403 });
    const sessionId = await signedInSession(store, request);
    if (!sessionId) return new Response('Session required', { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const parsed = personaInput.safeParse(body);
    if (!parsed.success) {
      const field = typeof body === 'object' && body !== null ? ('paint' in body ? 'paint' : 'voice' in body ? 'voice' : 'avatar') : 'avatar';
      return new Response(field === 'paint' ? `Describe the look in ${DESCRIPTION_LIMIT} characters or fewer, without links.` : field === 'voice' ? 'Unknown voice' : 'Unknown look', { status: 400 });
    }
    const input = parsed.data;
    if (!(await withinIpLimit(store, request, 'paint' in input ? 'paint' : 'look'))) return new Response('Too many changes right now. Please try again later.', { status: 429 });

    const state = projectSession(await store.readEvents(sessionId));
    const unchanged = () => Response.json({ settings: personaSettings(state, deps.env?.OPENAI_VOICE), changed: false }, { headers: { 'Cache-Control': 'no-store' } });
    let key: 'avatar' | 'voice' = 'avatar';
    let value: string;
    if ('voice' in input) {
      // Already the call voice, whether they chose it or it came with the look.
      if (personaSettings(state, deps.env?.OPENAI_VOICE).voice === input.voice) return unchanged();
      key = 'voice';
      value = input.voice;
    } else if ('avatar' in input) {
      value = input.avatar.toLowerCase();
      // Going back to an earlier painting: only one painted for this conversation.
      if (value.startsWith('img:') && !(await store.getAvatar(value.slice(4), sessionId))) return new Response('Unknown look', { status: 404 });
      if (storedAvatar(state.facts.avatar?.value) === value) return unchanged();
    } else {
      if (!deps.paint) return new Response(PAINT_FAILED.not_configured[1], { status: 503 });
      const saved = state.onboarding.assistantName;
      const name = saved.value && (saved.status === 'confirmed' || saved.status === 'tentative') ? saved.value : 'Persona';
      const image = await deps.paint({ name, description: input.paint });
      if (!image.ok) {
        console.error('Look painting failed', { error: image.error, status: image.status });
        const [status, message] = PAINT_FAILED[image.error];
        return new Response(message, { status });
      }
      const id = crypto.randomUUID();
      await store.saveAvatar(sessionId, { id, prompt: image.prompt, mime: image.mime, bytes: image.bytes });
      value = `img:${id}`;
    }

    // A `settings:` source is what gives the change its line in the thread (see projectSession).
    const change = crypto.randomUUID();
    await store.appendEvent(sessionId, {
      id: `settings:${key}:${change}`, at: new Date().toISOString(), type: 'fact', key, value,
      evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: `settings:${change}`,
    });
    const updated = projectSession(await store.readEvents(sessionId));
    return Response.json({ settings: personaSettings(updated, deps.env?.OPENAI_VOICE), changed: true }, { headers: { 'Cache-Control': 'no-store' } });
  };
}
