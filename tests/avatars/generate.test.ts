import { describe, expect, it } from 'vitest';
import { AVATAR_STYLE_PROMPT, avatarPrompt, generateAvatar, sniffMime } from '../../lib/avatars/generate';

const WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 8, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 '), 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const env = { OPENAI_API_KEY: 'test-key' };

function recorder(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.Authorization });
    return responses[calls.length - 1]();
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('generateAvatar', () => {
  it('asks ChatGPT image gen for one low-quality 1024 webp portrait in the house style and returns the bytes', async () => {
    const { calls, fetchFn } = recorder([() => Response.json({ data: [{ b64_json: b64(WEBP) }] })]);
    const result = await generateAvatar({ name: 'Max', description: 'a fox in a denim jacket' }, { env, fetch: fetchFn });
    expect(result).toMatchObject({ ok: true, mime: 'image/webp', model: 'chatgpt-image-latest' });
    expect(result.ok && [...result.bytes]).toEqual([...WEBP]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/images/generations');
    expect(calls[0].auth).toBe('Bearer test-key');
    expect(calls[0].body).toEqual({
      model: 'chatgpt-image-latest', n: 1, size: '1024x1024', quality: 'low', output_format: 'webp',
      prompt: expect.stringContaining('A friendly avatar portrait of an AI personal assistant named Max: a fox in a denim jacket. Soft 3D illustrated character'),
    });
    expect(String(calls[0].body.prompt)).toMatch(/No text, no logos, no watermark\.$/);
  });

  it('uses OPENAI_IMAGE_MODEL when set', async () => {
    const { calls, fetchFn } = recorder([() => Response.json({ data: [{ b64_json: b64(PNG) }] })]);
    const result = await generateAvatar({ name: 'Max', description: 'an owl' }, { env: { ...env, OPENAI_IMAGE_MODEL: 'gpt-image-1' }, fetch: fetchFn });
    expect(result).toMatchObject({ ok: true, mime: 'image/png', model: 'gpt-image-1' });
    expect(calls[0].body.model).toBe('gpt-image-1');
  });

  it('falls back to gpt-image-2 when the first model is refused as a model', async () => {
    const { calls, fetchFn } = recorder([
      () => Response.json({ error: { code: 'model_not_found', message: 'The model `chatgpt-image-latest` does not exist.' } }, { status: 404 }),
      () => Response.json({ data: [{ b64_json: b64(WEBP) }] }),
    ]);
    const result = await generateAvatar({ name: 'Max', description: 'an owl' }, { env, fetch: fetchFn });
    expect(result).toMatchObject({ ok: true, model: 'gpt-image-2' });
    expect(calls.map((call) => call.body.model)).toEqual(['chatgpt-image-latest', 'gpt-image-2']);
  });

  it('returns a typed failure for an HTTP error without trying another model', async () => {
    const { calls, fetchFn } = recorder([() => Response.json({ error: { message: 'Rate limit reached' } }, { status: 429 })]);
    expect(await generateAvatar({ name: 'Max', description: 'an owl' }, { env, fetch: fetchFn })).toEqual({ ok: false, error: 'http_error', status: 429, message: 'Rate limit reached' });
    expect(calls).toHaveLength(1);
  });

  it('reports a safety refusal as refused', async () => {
    const { fetchFn } = recorder([() => Response.json({ error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }, { status: 400 })]);
    expect(await generateAvatar({ name: 'Max', description: 'something awful' }, { env, fetch: fetchFn })).toMatchObject({ ok: false, error: 'refused', status: 400 });
  });

  it('times out instead of hanging the turn', async () => {
    const fetchFn = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
    expect(await generateAvatar({ name: 'Max', description: 'an owl' }, { env, fetch: fetchFn, timeoutMs: 20 })).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('needs a key, and never accepts a response without an image', async () => {
    let called = false;
    const never = (async () => { called = true; return Response.json({}); }) as typeof fetch;
    expect(await generateAvatar({ name: 'Max', description: 'an owl' }, { env: {}, fetch: never })).toMatchObject({ ok: false, error: 'not_configured' });
    expect(called).toBe(false);
    const { fetchFn } = recorder([() => Response.json({ data: [{ b64_json: b64(new TextEncoder().encode('<html>nope</html>')) }] })]);
    expect(await generateAvatar({ name: 'Max', description: 'an owl' }, { env, fetch: fetchFn })).toMatchObject({ ok: false, error: 'bad_response' });
  });

  it('keeps the style in one constant and flattens user text into it', () => {
    expect(AVATAR_STYLE_PROMPT).toContain('{name}');
    expect(avatarPrompt('Max\n', 'a fox\u0000 in a hoodie.')).toContain('named Max: a fox in a hoodie. Soft 3D');
    expect(avatarPrompt('', 'an owl')).toContain('named Persona: an owl.');
    expect(sniffMime(WEBP)).toBe('image/webp');
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });
});
