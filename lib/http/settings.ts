import { z } from 'zod';
import type { SessionEvent } from '../domain/events';
import { projectSession } from '../domain/project';
import { CUSTOM_PERSONALITY_LIMIT, PERSONALITIES, personaSettings, VOICES } from '../domain/persona';
import { readSessionCookie } from './session';
import { withinIpLimit, type IpQuotaStore } from './client-key';

interface Store extends IpQuotaStore {
  sessionExists(id: string): Promise<boolean>;
  readEvents(id: string): Promise<SessionEvent[]>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const safe = (value: string) => !/[\u0000-\u001f]|https?:\/\//i.test(value);

export const settingsInput = z.object({
  assistantName: z.string().transform(clean).pipe(z.string().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u)).optional(),
  personality: z.union([
    z.enum(Object.keys(PERSONALITIES) as [keyof typeof PERSONALITIES, ...Array<keyof typeof PERSONALITIES>]),
    z.object({ custom: z.string().transform(clean).pipe(z.string().min(3).max(CUSTOM_PERSONALITY_LIMIT).refine(safe, 'No links')) }),
  ]).optional(),
  voice: z.enum(Object.keys(VOICES) as [keyof typeof VOICES, ...Array<keyof typeof VOICES>]).optional(),
}).refine((value) => value.assistantName !== undefined || value.personality !== undefined || value.voice !== undefined, 'Nothing to change');

/**
 * Settings are facts the user confirmed directly: the same `assistant_name`, `personality` and `voice`
 * facts the assistant saves when the user says "call yourself Nova" or "be more direct", so both paths
 * land in one place and the next reply and the next call use them.
 */
export function createSettingsHandler(store: Store, env: Record<string, string | undefined> = {}) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Origin mismatch', { status: 403 });
    const sessionId = readSessionCookie(request);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !(await store.sessionExists(sessionId))) return new Response('Session required', { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const parsed = settingsInput.safeParse(body);
    if (!parsed.success) return new Response('Invalid settings', { status: 400 });
    if (!(await withinIpLimit(store, request, 'settings'))) return new Response('Too many changes; try again shortly', { status: 429 });
    const change = crypto.randomUUID();
    const at = new Date().toISOString();
    const fact = (key: string, value: string): SessionEvent => ({
      id: `settings:${key}:${change}`, at, type: 'fact', key, value, evidence: 'confirmed', provenance: 'user_confirmed', sourceEventId: `settings:${change}`,
    });
    const { assistantName, personality, voice } = parsed.data;
    const state = projectSession(await store.readEvents(sessionId));
    const current = personaSettings(state, env.OPENAI_VOICE);
    // Only real changes become events, so the thread shows one line per thing the user changed.
    if (assistantName !== undefined && assistantName !== current.assistantName) await store.appendEvent(sessionId, fact('assistant_name', assistantName));
    if (personality !== undefined) {
      const value = typeof personality === 'string' ? personality : personality.custom;
      const unchanged = typeof personality === 'string' ? current.personality.id === personality : current.personality.id === 'custom' && current.personality.text === value;
      if (!unchanged) await store.appendEvent(sessionId, fact('personality', value));
    }
    if (voice !== undefined && voice !== current.voice) await store.appendEvent(sessionId, fact('voice', voice));
    const updated = projectSession(await store.readEvents(sessionId));
    return Response.json({ settings: personaSettings(updated, env.OPENAI_VOICE), progress: updated.onboarding }, { headers: { 'Cache-Control': 'no-store' } });
  };
}
