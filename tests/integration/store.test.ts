import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { SessionEvent } from '../../lib/domain/events';
import { createStore } from '../../lib/db/store';

const database = `persona_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const admin = postgres('postgres://localhost/postgres', { max: 1 });
let sql: ReturnType<typeof postgres>;

describe('Postgres session store', () => {
  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${database}`);
    sql = postgres(`postgres://localhost/${database}`, { max: 1 });
    await createStore(sql).initialize();
  });

  afterAll(async () => {
    if (sql) await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('persists a guest session and appends each event only once', async () => {
    const store = createStore(sql);
    const sessionId = crypto.randomUUID();
    const event: SessionEvent = { id: 'm1', at: new Date().toISOString(), type: 'message', speaker: 'user', channel: 'text', text: 'Help me plan my week' };
    await store.createSession(sessionId);
    await store.appendEvent(sessionId, event);
    await store.appendEvent(sessionId, event);
    const reloaded = createStore(sql);
    expect(await reloaded.sessionExists(sessionId)).toBe(true);
    expect(await reloaded.readEvents(sessionId)).toEqual([event]);
  });
});
