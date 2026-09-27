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
    hasEvent: async (id: string, eventId: string): Promise<boolean> => {
      const rows = await sql`SELECT 1 FROM persona_events WHERE session_id = ${id} AND event_id = ${eventId} LIMIT 1`;
      return rows.length > 0;
    },
    getCallLease: async (id: string): Promise<{ callId?: string; active: boolean } | undefined> => {
      const rows = await sql`SELECT call_id, expires_at > now() AS active FROM persona_call_leases WHERE session_id = ${id} LIMIT 1`;
      return rows[0] ? { callId: (rows[0].call_id as string | null) || undefined, active: rows[0].active as boolean } : undefined;
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
    createConnectionAttempt: async (sessionId: string, attemptId: string, toolkit: 'gmail' | 'calendar', accountId: string, authConfigId: string, expiresAt: string) => {
      await sql`INSERT INTO persona_connections (attempt_id, session_id, toolkit, connected_account_id, auth_config_id, expires_at)
        VALUES (${attemptId}, ${sessionId}, ${toolkit}, ${accountId}, ${authConfigId}, ${expiresAt})`;
    },
    getConnectionAttempt: async (sessionId: string, attemptId: string) => {
      const rows = await sql`SELECT toolkit, connected_account_id AS "accountId", auth_config_id AS "authConfigId", status
        FROM persona_connections WHERE session_id = ${sessionId} AND attempt_id = ${attemptId}
        AND expires_at > now() LIMIT 1`;
      return rows[0] as { toolkit: 'gmail' | 'calendar'; accountId: string; authConfigId: string; status: string } | undefined;
    },
    activateConnection: async (sessionId: string, attemptId: string): Promise<boolean> => sql.begin(async (tx) => {
      const rows = await tx`SELECT toolkit FROM persona_connections WHERE session_id = ${sessionId} AND attempt_id = ${attemptId}
        AND status = 'pending' AND expires_at > now() FOR UPDATE`;
      if (!rows.length) return false;
      await tx`UPDATE persona_connections SET status = 'superseded' WHERE session_id = ${sessionId} AND toolkit = ${rows[0].toolkit} AND status = 'active'`;
      await tx`UPDATE persona_connections SET status = 'active' WHERE session_id = ${sessionId} AND attempt_id = ${attemptId}`;
      return true;
    }),
    getActiveConnection: async (sessionId: string, toolkit: 'gmail' | 'calendar'): Promise<string | undefined> => {
      const rows = await sql`SELECT connected_account_id FROM persona_connections
        WHERE session_id = ${sessionId} AND toolkit = ${toolkit} AND status = 'active' LIMIT 1`;
      return rows[0]?.connected_account_id as string | undefined;
    },
    deactivateConnection: async (sessionId: string, toolkit: 'gmail' | 'calendar', accountId: string): Promise<boolean> => {
      const rows = await sql`UPDATE persona_connections SET status = 'superseded'
        WHERE session_id = ${sessionId} AND toolkit = ${toolkit} AND connected_account_id = ${accountId}
        AND status = 'active' RETURNING attempt_id`;
      return rows.length > 0;
    },
    listConnectionAccounts: async (sessionId: string): Promise<string[]> => {
      const rows = await sql`SELECT connected_account_id FROM persona_connections
        WHERE session_id = ${sessionId} AND status IN ('pending', 'active') ORDER BY created_at, attempt_id`;
      return rows.map((row) => row.connected_account_id as string);
    },
    deleteSession: async (sessionId: string): Promise<void> => {
      await sql`DELETE FROM persona_sessions WHERE id = ${sessionId}`;
    },
    acquireCallLease: async (sessionId: string, leaseId: string): Promise<boolean> => {
      const rows = await sql`INSERT INTO persona_call_leases (session_id, lease_id, expires_at)
        VALUES (${sessionId}, ${leaseId}, now() + interval '1 minute')
        ON CONFLICT (session_id) DO UPDATE SET lease_id = EXCLUDED.lease_id, call_id = NULL, expires_at = EXCLUDED.expires_at
        WHERE persona_call_leases.expires_at < now() RETURNING lease_id`;
      return rows.length > 0;
    },
    bindCallLease: async (sessionId: string, leaseId: string, callId: string): Promise<boolean> => {
      const rows = await sql`UPDATE persona_call_leases SET call_id = ${callId}, expires_at = now() + interval '5 minutes'
        WHERE session_id = ${sessionId} AND lease_id = ${leaseId} AND call_id IS NULL RETURNING lease_id`;
      return rows.length > 0;
    },
    refreshCallLease: async (sessionId: string, callId: string): Promise<boolean> => {
      const rows = await sql`UPDATE persona_call_leases SET expires_at = now() + interval '5 minutes'
        WHERE session_id = ${sessionId} AND call_id = ${callId} AND expires_at > now() RETURNING lease_id`;
      return rows.length > 0;
    },
    releaseCallLease: async (sessionId: string, id: string): Promise<void> => {
      await sql`DELETE FROM persona_call_leases WHERE session_id = ${sessionId} AND (lease_id = ${id} OR call_id = ${id})`;
    },
    consumeQuota: async (sessionId: string, scope: 'chat' | 'voice' | 'research' | 'tool', limit: number, windowSeconds: number): Promise<boolean> => {
      const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();
      const rows = await sql`INSERT INTO persona_rate_limits (session_id, scope, window_start, count)
        VALUES (${sessionId}, ${scope}, ${windowStart}, 1)
        ON CONFLICT (session_id, scope, window_start) DO UPDATE SET count = persona_rate_limits.count + 1
        WHERE persona_rate_limits.count < ${limit} RETURNING count`;
      return rows.length > 0;
    },
    consumeIpQuota: async (clientKey: string, scope: string, limit: number, windowSeconds: number): Promise<boolean> => {
      const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();
      if (Math.random() < 0.01) await sql`DELETE FROM persona_ip_limits WHERE window_start < now() - interval '2 days'`;
      const rows = await sql`INSERT INTO persona_ip_limits (client_key, scope, window_start, count)
        VALUES (${clientKey}, ${scope}, ${windowStart}, 1)
        ON CONFLICT (client_key, scope, window_start) DO UPDATE SET count = persona_ip_limits.count + 1
        WHERE persona_ip_limits.count < ${limit} RETURNING count`;
      return rows.length > 0;
    },
    reserve: async (sessionId: string, key: string): Promise<boolean> => {
      const rows = await sql`INSERT INTO persona_reservations (session_id, reservation_key)
        VALUES (${sessionId}, ${key}) ON CONFLICT DO NOTHING RETURNING reservation_key`;
      return rows.length > 0;
    },
    releaseReservation: async (sessionId: string, key: string): Promise<void> => {
      await sql`DELETE FROM persona_reservations WHERE session_id = ${sessionId} AND reservation_key = ${key}`;
    },
    reserveIdentityClaim: async (sessionId: string, userEventId: string): Promise<boolean> => {
      const rows = await sql`INSERT INTO persona_identity_reservations (session_id, user_event_id)
        VALUES (${sessionId}, ${userEventId}) ON CONFLICT DO NOTHING RETURNING user_event_id`;
      return rows.length > 0;
    },
  };
}
