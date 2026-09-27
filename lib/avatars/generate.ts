/**
 * Paints the assistant's portrait with OpenAI image generation. Every failure comes back as a typed
 * result, never a thrown error, so a slow or refused image can't break the turn that asked for it.
 */

/** The one style every portrait shares. `{name}` and `{description}` are filled in per portrait. */
export const AVATAR_STYLE_PROMPT = 'A friendly avatar portrait of an AI personal assistant named {name}: {description}. '
  + 'Soft 3D illustrated character, head and shoulders, centered, looking at the viewer, warm soft light, clean light background, '
  + 'gentle pastel palette, rounded shapes, premium Apple-like polish. No text, no logos, no watermark.';

/** ChatGPT's image model first; gpt-image-2 when the account can't use it. OPENAI_IMAGE_MODEL overrides the first. */
export const DEFAULT_IMAGE_MODEL = 'chatgpt-image-latest';
export const FALLBACK_IMAGE_MODEL = 'gpt-image-2';
export const AVATAR_TIMEOUT_MS = 60_000;
const ENDPOINT = 'https://api.openai.com/v1/images/generations';

export type AvatarMime = 'image/webp' | 'image/png' | 'image/jpeg';
export type AvatarImage = { ok: true; bytes: Uint8Array; mime: AvatarMime; prompt: string; model: string };
export type AvatarFailure = {
  ok: false;
  error: 'not_configured' | 'timeout' | 'refused' | 'http_error' | 'network' | 'bad_response';
  message: string;
  status?: number;
};
export type AvatarResult = AvatarImage | AvatarFailure;

export interface GenerateOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const oneLine = (value: string, limit: number) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

export function avatarPrompt(name: string, description: string): string {
  return AVATAR_STYLE_PROMPT
    .replace('{name}', oneLine(name, 40) || 'Persona')
    .replace('{description}', oneLine(description, 300).replace(/[.\s]+$/, ''));
}

/** The image type from its first bytes, so the stored mime always matches what was returned. */
export function sniffMime(bytes: Uint8Array): AvatarMime | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return undefined;
}

type ApiError = { code?: string; param?: string; message?: string; type?: string };

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = await response.json() as { error?: ApiError };
    return body.error ?? {};
  } catch { return {}; }
}

const isModelError = (status: number, error: ApiError) => status === 404 || error.code === 'model_not_found' || error.param === 'model'
  || (status === 400 && /\bmodel\b/i.test(error.message ?? '') && !/safety|moderation/i.test(error.message ?? ''));
const isRefusal = (error: ApiError) => /moderation|safety|content_policy/i.test(`${error.code ?? ''} ${error.type ?? ''} ${error.message ?? ''}`);
/** DALL-E models predate output_format and quality 'low'; everything newer (gpt-image-*, chatgpt-image-*) takes them. */
const takesFormat = (model: string) => !model.startsWith('dall-e');

/** Paint one 1024x1024 portrait. Tries the configured model, then gpt-image-2 when the first is refused as a model. */
export async function generateAvatar(input: { name: string; description: string }, options: GenerateOptions = {}): Promise<AvatarResult> {
  const env = options.env ?? process.env;
  const apiKey = env.OPENAI_API_KEY?.trim();
  const prompt = avatarPrompt(input.name, input.description);
  if (!apiKey) return { ok: false, error: 'not_configured', message: 'OPENAI_API_KEY is not set.' };
  const models = [...new Set([env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL, FALLBACK_IMAGE_MODEL])];
  const signal = AbortSignal.timeout(options.timeoutMs ?? AVATAR_TIMEOUT_MS);
  const doFetch = options.fetch ?? fetch;
  let failure: AvatarFailure = { ok: false, error: 'http_error', message: 'No image model answered.' };

  for (const model of models) {
    let formatted = takesFormat(model);
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = {
        model, prompt, n: 1, size: '1024x1024',
        ...(formatted ? { quality: 'low', output_format: 'webp' } : { response_format: 'b64_json' }),
      };
      let response: Response;
      try {
        response = await doFetch(ENDPOINT, {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError' || signal.aborted) return { ok: false, error: 'timeout', message: 'The image took longer than a minute.' };
        return { ok: false, error: 'network', message: oneLine(String((error as Error)?.message ?? error), 200) };
      }
      if (!response.ok) {
        const error = await readError(response);
        // A model that won't take webp or quality 'low' gets one plain PNG request instead.
        if (formatted && response.status === 400 && (error.param === 'output_format' || error.param === 'quality')) { formatted = false; continue; }
        if (isRefusal(error)) return { ok: false, error: 'refused', status: response.status, message: oneLine(error.message || 'The image was refused by the safety system.', 200) };
        failure = { ok: false, error: 'http_error', status: response.status, message: oneLine(error.message || `Image request failed with HTTP ${response.status}.`, 200) };
        if (isModelError(response.status, error)) break;
        return failure;
      }
      try {
        const json = await response.json() as { data?: Array<{ b64_json?: string }> };
        const b64 = json.data?.[0]?.b64_json;
        const bytes = b64 ? new Uint8Array(Buffer.from(b64, 'base64')) : new Uint8Array();
        const mime = sniffMime(bytes);
        if (!mime) return { ok: false, error: 'bad_response', message: 'The image response had no image in it.' };
        return { ok: true, bytes, mime, prompt, model };
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: 'timeout', message: 'The image took longer than a minute.' };
        return { ok: false, error: 'bad_response', message: 'The image response was not valid JSON.' };
      }
    }
  }
  return failure;
}
