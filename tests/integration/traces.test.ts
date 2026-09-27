import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createStore } from '../../lib/db/store';
import { createInspectHandler } from '../../lib/http/inspect';

const database = `persona_traces_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL || 'postgres://localhost/postgres');
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = postgres(adminUrl.toString(), { max: 1 });
let sql: ReturnType<typeof postgres>;

describe('agent log store', () => {
  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${database} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    sql = postgres(testUrl.toString(), { max: 1 });
    await createStore(sql).initialize();
  });

  afterAll(async () => {
    if (sql) await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('round-trips trace entries in order, serves them only to their session, and deletes them with it', async () => {
    const store = createStore(sql);
    const sessionId = crypto.randomUUID();
    await store.createSession(sessionId);
    await store.appendTrace(sessionId, { turnId: 'm1', kind: 'turn', name: 'Reply', at: '2026-09-27T10:00:00.000Z', status: 'running', data: { instructions: 'SYSTEM', tools: ['remember'] } });
    await store.appendTrace(sessionId, { turnId: 'm1', kind: 'step', name: 'Step 1', at: '2026-09-27T10:00:00.900Z', durationMs: 900.4, status: 'ok', data: { tokensIn: 10, skipped: undefined } });
    await store.appendTrace(sessionId, { turnId: 'm1', kind: 'turn', name: 'Reply', at: '2026-09-27T10:00:01.000Z', durationMs: 1000, status: 'ok', data: { reply: 'Hi' } });

    const traces = await store.readTraces(sessionId);
    expect(traces.map((entry) => [entry.kind, entry.status, entry.durationMs])).toEqual([['turn', 'running', undefined], ['step', 'ok', 900], ['turn', 'ok', 1000]]);
    expect(traces[0]).toMatchObject({ turnId: 'm1', name: 'Reply', at: '2026-09-27T10:00:00.000Z', data: { instructions: 'SYSTEM', tools: ['remember'] } });
    expect(traces[1].data).toEqual({ tokensIn: 10 });

    const inspect = createInspectHandler(store);
    const response = await inspect(new Request('http://localhost/api/inspect', { headers: { cookie: `persona_session=${sessionId}` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as { summary: { turns: number }; items: Array<{ kind: string; reply?: string }> };
    expect(body.summary.turns).toBe(1);
    expect(body.items[0]).toMatchObject({ kind: 'turn', reply: 'Hi' });
    expect((await inspect(new Request('http://localhost/api/inspect'))).status).toBe(401);

    await store.deleteSession(sessionId);
    expect(await store.readTraces(sessionId)).toEqual([]);
  });
});
