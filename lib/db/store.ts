import type postgres from 'postgres';
import type { SessionEvent } from '../domain/events';
import { readFile } from 'node:fs/promises';

export function createStore(sql: ReturnType<typeof postgres>) {
  return {
    initialize: async () => {
      const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
      await sql.unsafe(schema);
    },
    createSession: async (id: string) => {
      await sql`INSERT INTO persona_sessions (id) VALUES (${id}) ON CONFLICT (id) DO NOTHING`;
    },
    sessionExists: async (id: string) => {
      const rows = await sql`SELECT 1 FROM persona_sessions WHERE id = ${id} LIMIT 1`;
      return rows.length > 0;
    },
    appendEvent: async (id: string, event: SessionEvent) => {
      await sql`INSERT INTO persona_events (session_id, event_id, payload)
        VALUES (${id}, ${event.id}, ${sql.json(event)})
        ON CONFLICT (session_id, event_id) DO NOTHING`;
    },
    readEvents: async (id: string): Promise<SessionEvent[]> => {
      const rows = await sql`SELECT payload FROM persona_events WHERE session_id = ${id} ORDER BY seq`;
      return rows.map((row) => row.payload as SessionEvent);
    },
  };
}
