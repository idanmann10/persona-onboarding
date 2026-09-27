import { writeFile } from 'node:fs/promises';
import { getDatabase } from '../lib/db/client';
import { createStore } from '../lib/db/store';
import { projectSession } from '../lib/domain/project';
import { buildAgentLog } from '../lib/observability/log';

/**
 * Export one session's full agent trace as a self-contained HTML page: every turn with its trigger,
 * the exact system prompt, each model step, every tool call's full input and result, the reply, and
 * timings. Read-only.
 *
 *   bun scripts/export-trace.ts <session-id> <out.html>
 *   bun scripts/export-trace.ts --latest-with "<text a user typed>" <out.html>
 */
const args = process.argv.slice(2);
const sql = getDatabase();
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const pretty = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };
const ms = (value?: number) => (value === undefined ? '–' : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);

try {
  let sessionId = args[0];
  let out = args[1];
  if (args[0] === '--latest-with') {
    const rows = await sql`SELECT session_id FROM persona_events WHERE payload->>'type' = 'message' AND payload->>'speaker' = 'user' AND payload->>'text' = ${args[1]} ORDER BY created_at DESC LIMIT 1`;
    if (!rows[0]) throw new Error('No session has a user message with that text');
    sessionId = rows[0].session_id as string;
    out = args[2];
  }
  const store = createStore(sql);
  const events = await store.readEvents(sessionId);
  const traces = await store.readTraces(sessionId);
  const state = projectSession(events);
  const log = buildAgentLog(state, events, traces);
  const summary = log.summary as unknown as Record<string, unknown>;
  const turns = log.items.filter((item) => item.kind === 'turn') as Array<Record<string, any>>;
  const known = state.onboarding;
  const body = turns.map((turn, index) => `
  <section class="turn">
    <h2>${index + 1}. ${esc(turn.name)} <small>${esc(new Date(turn.at).toISOString().slice(11, 19))} UTC · ${ms(turn.durationMs)} total · first token ${ms(turn.firstTokenMs)} · ${esc(turn.status)}</small></h2>
    ${turn.userText ? `<p class="said"><b>User</b> ${esc(turn.userText)}</p>` : ''}
    ${turn.trigger ? `<details><summary>Trigger (system message)</summary><pre>${esc(turn.trigger)}</pre></details>` : ''}
    <details><summary>System prompt (${esc(turn.promptVersion)}, ${esc((turn.instructions ?? '').length)} chars) · model ${esc(turn.model)} · ${esc(turn.messageCount)} messages · tools offered: ${esc((turn.toolsOffered ?? []).join(', '))}</summary><pre>${esc(turn.instructions)}</pre></details>
    ${(turn.steps ?? []).map((step: any) => `
    <div class="step"><h3>${esc(step.name)} <small>${ms(step.durationMs)} · model ${ms(step.modelMs)} · tools ${ms(step.toolMs)} · ${esc(step.finishReason ?? '')} · ${esc(step.tokensIn)} in (${esc(step.cachedIn)} cached) / ${esc(step.tokensOut)} out</small></h3>
      ${(step.tools ?? []).map((tool: any) => `<div class="tool"><p><b>${esc(tool.name)}</b> → ${esc(tool.status)} · ${ms(tool.ms)}</p><div class="io"><div><span>Input</span><pre>${esc(pretty(tool.input || '{}'))}</pre></div><div><span>Result</span><pre>${esc(pretty(tool.preview || ''))}</pre></div></div></div>`).join('')}
      ${step.text ? `<p class="text"><span>Text in this step</span>${esc(step.text)}</p>` : ''}
    </div>`).join('')}
    <p class="reply"><b>Reply</b> ${esc(turn.reply ?? '')}</p>
  </section>`).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>Persona agent trace</title>
<style>
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif;color:#1d1d1f;background:#fff;max-width:1100px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}h2 small,h3 small{color:#6e6e73;font-weight:400;font-size:12px}h3{font-size:13px;margin:10px 0 6px}
.meta{color:#6e6e73;margin:0 0 16px}.grid{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}.grid div{border:1px solid #d2d2d7;border-radius:12px;padding:8px 12px;font-size:12px;color:#6e6e73}.grid b{display:block;color:#1d1d1f;font-size:16px}
.turn{border:1px solid #d2d2d7;border-radius:16px;padding:16px;margin:0 0 14px}.said{background:#0a84ff;color:#fff;border-radius:14px;padding:8px 12px;display:inline-block;margin:0 0 8px}.said b{margin-right:6px}
.reply{background:#e9e9eb;border-radius:14px;padding:8px 12px;margin:10px 0 0}.reply b{margin-right:6px}.step{border-left:3px solid #0a84ff;padding:2px 0 2px 12px;margin:8px 0}
.tool{margin:6px 0}.tool p{margin:0 0 4px}.io{display:grid;grid-template-columns:1fr 1fr;gap:8px}.io span,.text span{display:block;font-size:11px;color:#6e6e73;text-transform:uppercase;letter-spacing:.06em}
pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f7;border-radius:10px;padding:10px;margin:2px 0;font:12px/1.45 ui-monospace,"SF Mono",Menlo,monospace;max-height:420px;overflow:auto}
details{margin:6px 0}summary{cursor:pointer;color:#0a84ff}.text{color:#1d1d1f}@media(max-width:720px){.io{grid-template-columns:1fr}}
</style>
<h1>Persona agent trace</h1>
<p class="meta">Session ${esc(sessionId.slice(0, 8))}… · exported ${esc(new Date().toISOString().slice(0, 16))} UTC · setup: ${esc(state.setup.stage)} · assistant ${esc(known.assistantName.value ?? '—')} · user ${esc(known.preferredName.value ?? known.preferredName.status)} · need “${esc(known.need.value ?? '—')}” · Gmail ${esc(known.gmail)} · call ${esc(known.call)} · recurring ${esc(known.automation.status)}</p>
<div class="grid">${Object.entries(summary).map(([key, value]) => `<div><b>${esc(typeof value === 'number' && /ms$/i.test(key) ? ms(value) : value)}</b>${esc(key)}</div>`).join('')}</div>
${body}`;
  await writeFile(out, html);
  console.log(`wrote ${out}: ${turns.length} turns, ${traces.length} trace entries`);
} finally {
  await sql.end();
}
