import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createStore } from '../../lib/db/store';
import { createAvatarHandler } from '../../lib/avatars/route';

const database = `persona_avatars_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL || 'postgres://localhost/postgres');
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = postgres(adminUrl.toString(), { max: 1 });
let sql: ReturnType<typeof postgres>;

describe('avatar store', () => {
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

  it('round-trips portrait bytes, keeps the first write for an id, serves them, and deletes them with the session', async () => {
    const store = createStore(sql);
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 255, 128, 87, 69, 66, 80]);
    await store.createSession(sessionId);
    await store.saveAvatar(sessionId, { id, prompt: 'a fox in a denim jacket', mime: 'image/webp', bytes });
    await store.saveAvatar(sessionId, { id, prompt: 'a second painting', mime: 'image/png', bytes: new Uint8Array([1]) });
    const saved = await store.getAvatar(id);
    expect(saved?.mime).toBe('image/webp');
    expect([...saved!.bytes]).toEqual([...bytes]);
    const response = await createAvatarHandler(store)(new Request(`http://localhost/api/avatars/${id}`), id);
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]);
    await store.deleteSession(sessionId);
    expect(await store.getAvatar(id)).toBeUndefined();
  });
});
