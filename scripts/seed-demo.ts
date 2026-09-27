/**
 * Seeds the most recent guest session with a representative onboarding timeline so the UI can be
 * inspected without provider keys. Local development only: refuses to run against a non-local database.
 */
import postgres from 'postgres';
import { createStore } from '../lib/db/store';
import type { SessionEvent } from '../lib/domain/events';

const url = process.env.DATABASE_URL;
if (!url || !/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('seed-demo only runs against a local DATABASE_URL');
const sql = postgres(url, { max: 1 });
try {
  const [latest] = await sql`SELECT id FROM persona_sessions ORDER BY created_at DESC LIMIT 1`;
  if (!latest) throw new Error('Open the app once to create a session first');
  const sessionId = latest.id as string;
  const store = createStore(sql);
  const base = Date.now() - 10 * 60_000;
  const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
  const callId = 'live_demo_1';
  const fragments: Array<['user' | 'assistant', string, number]> = [
    ['assistant', "Hey, it's Max, picking up from the chat. What should I call you?", 0],
    ['user', "I'm Dana.", 3_500],
    ['assistant', 'Nice to meet you, Dana. What would you love to never deal with again?', 5_200],
    ['user', 'Honestly the investor updates, every month I have to', 9_000],
  ];
  const events: SessionEvent[] = [
    { id: 'demo-m1', at: at(10), type: 'message', speaker: 'user', channel: 'text', text: 'Call yourself Max' },
    { id: 'fact:assistant_name:demo-m1', at: at(11), type: 'fact', key: 'assistant_name', value: 'Max', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'demo-m1' },
    { id: 'answer:demo-m1', at: at(12), type: 'message', speaker: 'assistant', channel: 'text', text: "Max it is.\n\nWant to hop on a two-minute call? It's faster than typing." },
    { id: 'demo-m2', at: at(20), type: 'message', speaker: 'user', channel: 'text', text: 'sure' },
    { id: 'call-offer:demo-m2', at: at(21), type: 'call', phase: 'offered' },
    { id: 'answer:demo-m2', at: at(21), type: 'message', speaker: 'assistant', channel: 'text', text: 'Tap Answer when you are ready.' },
    { id: `call:${callId}:accepted`, at: at(30), type: 'call', phase: 'accepted', callId },
    { id: `call:${callId}:started`, at: at(31), type: 'call', phase: 'started', callId },
    ...fragments.map(([speaker, text, startMs], index): SessionEvent => ({ id: `voice:${callId}:demo${index}`, at: at(32 + index), type: 'voice_fragment', callId, speaker, text, startMs, endMs: startMs + 2_000, final: false })),
    { id: 'fact:preferred_name:demo-call', at: at(36), type: 'fact', key: 'preferred_name', value: 'Dana', evidence: 'confirmed', provenance: 'user_said', sourceEventId: 'demo-call' },
    { id: `call:${callId}:ended`, at: at(72), type: 'call', phase: 'ended', callId, reason: 'user_hangup' },
    { id: `answer:followup:call:${callId}`, at: at(74), type: 'message', speaker: 'assistant', channel: 'text', origin: 'follow_up', text: "Hey, looks like we got cut off. You were saying the monthly investor updates eat your time. Want me to take a first pass at the next one?" },
    { id: `decision:followup:call:${callId}`, at: at(74), type: 'decision', trigger: `followup:call:${callId}`, outcome: 'messaged' },
    { id: 'demo-m3', at: at(90), type: 'message', speaker: 'user', channel: 'text', text: 'yes, they always start from last month\'s email' },
    { id: 'connection-offer:gmail:demo-m3', at: at(91), type: 'connection', toolkit: 'gmail', phase: 'offered', reason: "I'll find last month's update and draft this one from it." },
    { id: 'answer:demo-m3', at: at(91), type: 'message', speaker: 'assistant', channel: 'text', text: "Then let me look at last month's. Connect Gmail below and I'll draft this month's from it." },
  ];
  for (const event of events) await store.appendEvent(sessionId, event);
  console.log(`Seeded ${events.length} events into ${sessionId}`);
} finally {
  await sql.end();
}
