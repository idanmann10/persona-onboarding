/**
 * Records the short clip each call voice plays in the look picker (public/voices/<voice>.m4a), straight
 * from GPT-Live so it sounds exactly like a call. Run it when the voice list changes:
 * `bun scripts/record-voice-samples.ts [voice...]` (reads OPENAI_API_KEY; macOS, for afconvert).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { VOICES, type VoiceId } from '../lib/domain/persona';

const RATE = 24_000;
const FRAME_MS = 40;
const LINE = "Hey, it's me. This is how I'll sound when we talk. Want me to check who's waiting on you today?";
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY is required');

/** The stream keeps sending silence after the line: keep the speech plus a short tail. */
function trim(pcm: Buffer): Buffer {
  const loud = (index: number) => Math.abs(pcm.readInt16LE(index)) > 300;
  let start = 0; while (start < pcm.length - 1 && !loud(start)) start += 2;
  let end = pcm.length - 2; while (end > start && !loud(end)) end -= 2;
  const pad = RATE * 0.25 * 2;
  return pcm.subarray(Math.max(0, start - pad), Math.min(pcm.length, end + pad));
}

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function record(voice: VoiceId): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const silence = Buffer.alloc((RATE * FRAME_MS / 1000) * 2);
  const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${key}` } } as unknown as string[]);
  const send = (event: Record<string, unknown>) => ws.readyState === 1 && ws.send(JSON.stringify(event));
  let pump: ReturnType<typeof setInterval> | undefined;
  let last = 0;
  return new Promise((resolve, reject) => {
    const finish = () => { clearInterval(pump); send({ type: 'session.close' }); ws.close(); resolve(Buffer.concat(chunks)); };
    const deadline = setTimeout(finish, 20_000);
    ws.onopen = () => send({
      type: 'session.start', event_id: 'start',
      session: { model: 'gpt-live-1', instructions: 'Say only what you are given, then stay silent.', audio: { output: { voice }, format: { type: 'audio/pcm', rate: RATE } } },
    });
    ws.onerror = () => { clearTimeout(deadline); reject(new Error(`${voice}: socket error`)); };
    ws.onmessage = ({ data }) => {
      const event = JSON.parse(String(data)) as { type: string; delta?: string; audio?: string; error?: { message?: string } };
      if (event.type === 'error') { clearTimeout(deadline); clearInterval(pump); ws.close(); reject(new Error(`${voice}: ${event.error?.message}`)); return; }
      if (event.type === 'session.started') {
        pump = setInterval(() => send({ type: 'session.input_audio.append', audio: silence.toString('base64') }), FRAME_MS);
        send({ type: 'session.commentary.append', event_id: 'sample', delegation_id: null, content: LINE });
        return;
      }
      const audio = /output_audio\.delta$/.test(event.type) ? event.delta ?? event.audio : undefined;
      if (audio) { chunks.push(Buffer.from(audio, 'base64')); last = Date.now(); }
      // Done once audio has stopped for a moment.
      if (last && Date.now() - last > 3_000) { clearTimeout(deadline); finish(); }
    };
    const idle = setInterval(() => { if (last && Date.now() - last > 3_000) { clearInterval(idle); clearTimeout(deadline); finish(); } }, 250);
  });
}

const wanted = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VOICES)) as VoiceId[];
await mkdir('public/voices', { recursive: true });
for (const voice of wanted) {
  const pcm = trim(await record(voice));
  if (pcm.length < RATE) throw new Error(`${voice}: no audio came back`);
  const tmp = `public/voices/${voice}.wav`;
  await writeFile(tmp, wav(pcm));
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '48000', tmp, `public/voices/${voice}.m4a`]);
  await rm(tmp);
  console.log(`${voice}: ${(pcm.length / 2 / RATE).toFixed(1)}s`);
}
