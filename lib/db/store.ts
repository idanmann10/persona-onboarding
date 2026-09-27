import type postgres from 'postgres';
import type { SessionEvent } from '../domain/events';
import { readFile } from 'node:fs/promises';
import type { KnowledgeFact } from '../domain/knowledge';

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
      if (event.type !== 'fact') {
        await sql`INSERT INTO persona_events (session_id, event_id, payload)
          VALUES (${id}, ${event.id}, ${sql.json(event)})
          ON CONFLICT (session_id, event_id) DO NOTHING`;
        return;
      }
      await sql.begin(async (tx) => {
        const inserted = await tx`INSERT INTO persona_events (session_id, event_id, payload)
          VALUES (${id}, ${event.id}, ${tx.json(event)})
          ON CONFLICT (session_id, event_id) DO NOTHING RETURNING seq`;
        if (!inserted.length) return;
        await tx`UPDATE persona_graph_facts SET evidence = 'superseded'
          WHERE session_id = ${id} AND subject = 'user' AND predicate = ${event.key}
          AND evidence IN ('tentative', 'confirmed')`;
        await tx`INSERT INTO persona_graph_facts
          (id, session_id, event_id, subject, predicate, object_value, evidence, provenance, source_url, source_event_id)
          VALUES (${crypto.randomUUID()}, ${id}, ${event.id}, 'user', ${event.key}, ${event.value}, ${event.evidence}, ${event.provenance}, ${event.sourceUrl || null}, ${event.sourceEventId})`;
      });
    },
    readEvents: async (id: string): Promise<SessionEvent[]> => {
      const rows = await sql`SELECT payload FROM persona_events WHERE session_id = ${id} ORDER BY seq`;
      return rows.map((row) => row.payload as SessionEvent);
    },
    readGraphFacts: async (id: string): Promise<Array<Pick<KnowledgeFact, 'value' | 'evidence' | 'provenance' | 'sourceUrl'> & { key: string }>> => {
      const rows = await sql`SELECT predicate AS key, object_value AS value, evidence, provenance, source_url AS "sourceUrl"
        FROM persona_graph_facts WHERE session_id = ${id} ORDER BY created_at, id`;
      return rows.map((row) => ({
        key: row.key as string,
        value: row.value as string,
        evidence: row.evidence as KnowledgeFact['evidence'],
        provenance: row.provenance as KnowledgeFact['provenance'],
        sourceUrl: (row.sourceUrl as string | null) || undefined,
      }));
    },
  };
}
