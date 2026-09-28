import type postgres from 'postgres';
import type { SessionEvent } from '../domain/events';
import { readFile } from 'node:fs/promises';
import type { KnowledgeFact } from '../domain/knowledge';
import type { AutomationRecord, AutomationStatus } from '../domain/automation';
import type { StoredTrace, TraceEntry } from '../observability/trace';
import type { SignedInUser } from '../auth/login';

/** A Google user as the sign-in callback verified them. */
export interface AccountProfile { sub: string; email: string; emailVerified: true; fullName?: string; givenName?: string; picture?: string; locale?: string }

/** An email + password account as stored. */
export interface PasswordAccount { id: string; mainSessionId: string | null; email: string; passwordHash: string; fullName?: string; givenName?: string }

/** The newest agent-log entries a session keeps on screen. */
const TRACE_LIMIT = 2_000;

function automationFrom(row: Record<string, unknown>): AutomationRecord {
  return {
    id: row.id as string, sessionId: row.session_id as string, title: row.title as string, instruction: row.instruction as string,
    toolkits: (row.toolkits as AutomationRecord['toolkits']) ?? [], cadence: row.cadence as AutomationRecord['cadence'],
    ...(row.weekday === null || row.weekday === undefined ? {} : { weekday: Number(row.weekday) }),
    time: row.local_time as string, ...(row.timezone ? { timezone: row.timezone as string } : {}),
    status: row.status as AutomationStatus, ...(row.next_run_at ? { nextRunAt: new Date(row.next_run_at as string).toISOString() } : {}),
  };
}

export function createStore(sql: ReturnType<typeof postgres>) {
  return {
    initialize: async () => {
      const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
      await sql.unsafe(schema);
    },
    createSession: async (id: string) => {
      await sql`INSERT INTO persona_sessions (id) VALUES (${id}) ON CONFLICT (id) DO NOTHING`;
    },
    /** Creates or refreshes the account of a Google user (by `sub`) with what Google just said about them. */
    upsertAccount: async (profile: AccountProfile): Promise<{ id: string; mainSessionId: string | null }> => {
      const rows = await sql`INSERT INTO persona_accounts (id, google_sub, email, full_name, given_name, picture, locale)
        VALUES (${crypto.randomUUID()}, ${profile.sub}, ${profile.email}, ${profile.fullName ?? null}, ${profile.givenName ?? null}, ${profile.picture ?? null}, ${profile.locale ?? null})
        ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, given_name = EXCLUDED.given_name,
          picture = EXCLUDED.picture, locale = EXCLUDED.locale, signed_in_at = now()
        RETURNING id, main_session_id`;
      return { id: rows[0].id as string, mainSessionId: (rows[0].main_session_id as string | null) ?? null };
    },
    /**
     * Creates an email + password account, unless the email already has a password account ('taken') or
     * belongs to a Google account ('google'): accounts never merge by email.
     */
    createPasswordAccount: async (account: { email: string; passwordHash: string; fullName?: string; givenName?: string }): Promise<{ id: string } | 'google' | 'taken'> => sql.begin(async (tx) => {
      const [existing] = await tx`SELECT google_sub IS NOT NULL AS google FROM persona_accounts WHERE email = ${account.email}
        ORDER BY (google_sub IS NOT NULL) DESC LIMIT 1`;
      if (existing) return existing.google ? 'google' : 'taken';
      const rows = await tx`INSERT INTO persona_accounts (id, email, password_hash, full_name, given_name)
        VALUES (${crypto.randomUUID()}, ${account.email}, ${account.passwordHash}, ${account.fullName ?? null}, ${account.givenName ?? null})
        ON CONFLICT (email) WHERE google_sub IS NULL DO NOTHING RETURNING id`;
      return rows[0] ? { id: rows[0].id as string } : 'taken';
    }),
    /** The email + password account for an email, if there is one. */
    findPasswordAccount: async (email: string): Promise<PasswordAccount | undefined> => {
      const [row] = await sql`SELECT id, main_session_id, email, password_hash, full_name, given_name FROM persona_accounts
        WHERE email = ${email} AND google_sub IS NULL AND password_hash IS NOT NULL LIMIT 1`;
      if (!row) return undefined;
      return {
        id: row.id as string, mainSessionId: (row.main_session_id as string | null) ?? null, email: row.email as string, passwordHash: row.password_hash as string,
        ...(row.full_name ? { fullName: row.full_name as string } : {}), ...(row.given_name ? { givenName: row.given_name as string } : {}),
      };
    },
    /** Notes a password sign-in on the account. */
    touchAccount: async (accountId: string): Promise<void> => {
      await sql`UPDATE persona_accounts SET signed_in_at = now() WHERE id = ${accountId}`;
    },
    /**
     * The account's main conversation. Without one, it takes over the conversation `verifiedEmail` had under
     * the retired Gmail sign-in (Google accounts only), or else creates `newSessionId`. Locked, so two tabs
     * agree on one.
     */
    claimMainSession: async (accountId: string, verifiedEmail: string | undefined, newSessionId: string): Promise<{ id: string; created: boolean }> => sql.begin(async (tx) => {
      const [account] = await tx`SELECT main_session_id FROM persona_accounts WHERE id = ${accountId} FOR UPDATE`;
      if (!account) throw new Error('Unknown account');
      if (account.main_session_id) return { id: account.main_session_id as string, created: false };
      const [legacy] = verifiedEmail ? await tx`DELETE FROM persona_users WHERE email = ${verifiedEmail}
        AND NOT EXISTS (SELECT 1 FROM persona_accounts WHERE main_session_id = persona_users.main_session_id)
        RETURNING main_session_id` : [];
      const id = (legacy?.main_session_id as string | undefined) ?? newSessionId;
      if (!legacy) await tx`INSERT INTO persona_sessions (id) VALUES (${id})`;
      await tx`UPDATE persona_accounts SET main_session_id = ${id} WHERE id = ${accountId}`;
      return { id, created: !legacy };
    }),
    /** Records a signed-in browser by the hash of its login token. */
    createLogin: async (tokenHash: string, accountId: string, expiresAt: Date): Promise<void> => {
      if (Math.random() < 0.02) await sql`DELETE FROM persona_logins WHERE expires_at < now()`;
      await sql`INSERT INTO persona_logins (token_hash, account_id, expires_at) VALUES (${tokenHash}, ${accountId}, ${expiresAt})`;
    },
    /** The signed-in user behind an unexpired login. */
    findLogin: async (tokenHash: string): Promise<SignedInUser | undefined> => {
      const rows = await sql`SELECT a.id, a.main_session_id, a.email, a.google_sub IS NOT NULL AS email_verified, a.full_name, a.given_name, a.picture, a.locale
        FROM persona_logins l JOIN persona_accounts a ON a.id = l.account_id
        WHERE l.token_hash = ${tokenHash} AND l.expires_at > now() LIMIT 1`;
      const row = rows[0];
      if (!row) return undefined;
      const optional = (key: string, value: unknown) => (typeof value === 'string' && value ? { [key]: value } : {});
      return {
        accountId: row.id as string, sessionId: (row.main_session_id as string | null) ?? null, email: row.email as string,
        emailVerified: row.email_verified === true, ...optional('fullName', row.full_name), ...optional('givenName', row.given_name), ...optional('picture', row.picture), ...optional('locale', row.locale),
      };
    },
    /** Signs one browser out. */
    deleteLogin: async (tokenHash: string): Promise<void> => {
      await sql`DELETE FROM persona_logins WHERE token_hash = ${tokenHash}`;
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
    /** The newest sessions with their events, for the funnel. */
    recentSessions: async (limit = 500): Promise<Array<{ id: string; events: SessionEvent[] }>> => {
      const rows = await sql`SELECT s.id, e.payload FROM (SELECT id, created_at FROM persona_sessions ORDER BY created_at DESC LIMIT ${limit}) s
        JOIN persona_events e ON e.session_id = s.id ORDER BY s.created_at DESC, s.id, e.seq`;
      const sessions = new Map<string, SessionEvent[]>();
      for (const row of rows) {
        const events = sessions.get(row.id as string) ?? [];
        events.push(row.payload as SessionEvent);
        sessions.set(row.id as string, events);
      }
      return [...sessions].map(([id, events]) => ({ id, events }));
    },
    /** The auth config Persona made for a toolkit other than Gmail and Calendar, if any. */
    getAppAuthConfig: async (toolkit: string): Promise<string | undefined> => {
      const rows = await sql`SELECT auth_config_id FROM persona_auth_configs WHERE toolkit = ${toolkit} LIMIT 1`;
      return rows[0]?.auth_config_id as string | undefined;
    },
    /** Saves a toolkit's auth config unless one is already saved, and returns the saved one. */
    saveAppAuthConfig: async (toolkit: string, authConfigId: string): Promise<string> => {
      await sql`INSERT INTO persona_auth_configs (toolkit, auth_config_id) VALUES (${toolkit}, ${authConfigId}) ON CONFLICT (toolkit) DO NOTHING`;
      const rows = await sql`SELECT auth_config_id FROM persona_auth_configs WHERE toolkit = ${toolkit} LIMIT 1`;
      return rows[0].auth_config_id as string;
    },
    /** Every app this session has connected right now (gmail, calendar and any other toolkit slug). */
    listActiveConnectionToolkits: async (sessionId: string): Promise<string[]> => {
      const rows = await sql`SELECT DISTINCT toolkit FROM persona_connections WHERE session_id = ${sessionId} AND status = 'active' ORDER BY toolkit`;
      return rows.map((row) => row.toolkit as string);
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
    createConnectionAttempt: async (sessionId: string, attemptId: string, toolkit: string, accountId: string, authConfigId: string, expiresAt: string, callbackHash?: string) => {
      await sql`INSERT INTO persona_connections (attempt_id, session_id, toolkit, connected_account_id, auth_config_id, expires_at, callback_hash)
        VALUES (${attemptId}, ${sessionId}, ${toolkit}, ${accountId}, ${authConfigId}, ${expiresAt}, ${callbackHash ?? null})`;
    },
    getConnectionAttempt: async (sessionId: string, attemptId: string) => {
      const rows = await sql`SELECT toolkit, connected_account_id AS "accountId", auth_config_id AS "authConfigId", status, callback_hash AS "callbackHash"
        FROM persona_connections WHERE session_id = ${sessionId} AND attempt_id = ${attemptId}
        AND (expires_at > now() OR status = 'active') LIMIT 1`;
      const row = rows[0] as { toolkit: string; accountId: string; authConfigId: string; status: string; callbackHash: string | null } | undefined;
      return row ? { toolkit: row.toolkit, accountId: row.accountId, authConfigId: row.authConfigId, status: row.status, ...(row.callbackHash ? { callbackHash: row.callbackHash } : {}) } : undefined;
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
    /** A painted portrait of the assistant (see lib/avatars). The same id twice keeps the first. */
    saveAvatar: async (sessionId: string, avatar: { id: string; prompt: string; mime: string; bytes: Uint8Array }): Promise<void> => {
      await sql`INSERT INTO persona_avatars (id, session_id, prompt, mime, bytes)
        VALUES (${avatar.id}, ${sessionId}, ${avatar.prompt}, ${avatar.mime}, ${Buffer.from(avatar.bytes)})
        ON CONFLICT (id) DO NOTHING`;
    },
    /** A portrait, only to the conversation it was painted for. */
    getAvatar: async (id: string, sessionId: string): Promise<{ mime: string; bytes: Uint8Array } | undefined> => {
      const rows = await sql`SELECT mime, bytes FROM persona_avatars WHERE id = ${id} AND session_id = ${sessionId} LIMIT 1`;
      return rows[0] ? { mime: rows[0].mime as string, bytes: new Uint8Array(rows[0].bytes as Uint8Array) } : undefined;
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
    proposeAutomation: async (sessionId: string, automation: Omit<AutomationRecord, 'sessionId' | 'status' | 'timezone' | 'nextRunAt'>): Promise<void> => {
      await sql`INSERT INTO persona_automations (id, session_id, title, instruction, toolkits, cadence, weekday, local_time, status)
        VALUES (${automation.id}, ${sessionId}, ${automation.title}, ${automation.instruction}, ${sql.array(automation.toolkits)}, ${automation.cadence},
          ${automation.weekday ?? null}, ${automation.time}, 'proposed')
        ON CONFLICT (id) DO NOTHING`;
    },
    getAutomation: async (sessionId: string, id: string): Promise<AutomationRecord | undefined> => {
      const rows = await sql`SELECT * FROM persona_automations WHERE session_id = ${sessionId} AND id = ${id} LIMIT 1`;
      return rows[0] ? automationFrom(rows[0]) : undefined;
    },
    listAutomations: async (sessionId: string): Promise<AutomationRecord[]> => {
      const rows = await sql`SELECT * FROM persona_automations WHERE session_id = ${sessionId} ORDER BY created_at, id`;
      return rows.map(automationFrom);
    },
    approveAutomation: async (sessionId: string, id: string, timezone: string, nextRunAt: Date): Promise<'approved' | 'not_found' | 'conflict'> => {
      try {
        const rows = await sql`UPDATE persona_automations SET status = 'active', timezone = ${timezone}, next_run_at = ${nextRunAt}, approved_at = now()
          WHERE session_id = ${sessionId} AND id = ${id} AND status = 'proposed' RETURNING id`;
        return rows.length ? 'approved' : 'not_found';
      } catch (error) {
        if ((error as { code?: string }).code === '23505') return 'conflict';
        throw error;
      }
    },
    setAutomationStatus: async (sessionId: string, id: string, from: AutomationStatus, to: 'declined' | 'disabled'): Promise<boolean> => {
      const rows = await sql`UPDATE persona_automations SET status = ${to}, claimed_until = NULL,
          disabled_at = CASE WHEN ${to}::text = 'disabled' THEN now() ELSE disabled_at END
        WHERE session_id = ${sessionId} AND id = ${id} AND status = ${from} RETURNING id`;
      return rows.length > 0;
    },
    claimDueAutomations: async (sessionId: string | undefined, limit: number): Promise<AutomationRecord[]> => {
      const rows = sessionId
        ? await sql`UPDATE persona_automations SET claimed_until = now() + interval '3 minutes' WHERE id IN (
            SELECT id FROM persona_automations WHERE status = 'active' AND session_id = ${sessionId} AND next_run_at <= now()
              AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY next_run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
          RETURNING *`
        : await sql`UPDATE persona_automations SET claimed_until = now() + interval '3 minutes' WHERE id IN (
            SELECT id FROM persona_automations WHERE status = 'active' AND next_run_at <= now()
              AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY next_run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
          RETURNING *`;
      return rows.map(automationFrom);
    },
    startAutomationRun: async (run: { id: string; automationId: string; sessionId: string; scheduledFor: Date; trigger: 'schedule' | 'run_now' }): Promise<boolean> => {
      const rows = await sql`INSERT INTO persona_automation_runs (id, automation_id, session_id, scheduled_for, trigger, status)
        VALUES (${run.id}, ${run.automationId}, ${run.sessionId}, ${run.scheduledFor}, ${run.trigger}, 'running')
        ON CONFLICT (automation_id, scheduled_for, trigger) DO NOTHING RETURNING id`;
      return rows.length > 0;
    },
    finishAutomationRun: async (runId: string, status: 'succeeded' | 'failed', messageEventId?: string, error?: string): Promise<void> => {
      await sql`UPDATE persona_automation_runs SET status = ${status}, message_event_id = ${messageEventId ?? null}, error = ${error?.slice(0, 500) ?? null}, finished_at = now()
        WHERE id = ${runId}`;
    },
    advanceAutomation: async (id: string, nextRunAt: Date | null): Promise<void> => {
      await sql`UPDATE persona_automations SET next_run_at = ${nextRunAt}, claimed_until = NULL WHERE id = ${id}`;
    },
    /** A lease: a reservation older than the lease can be taken over, so a crashed run is retried. */
    reserve: async (sessionId: string, key: string, leaseSeconds = 180): Promise<boolean> => {
      const rows = await sql`INSERT INTO persona_reservations (session_id, reservation_key)
        VALUES (${sessionId}, ${key})
        ON CONFLICT (session_id, reservation_key) DO UPDATE SET created_at = now()
        WHERE persona_reservations.created_at < now() - make_interval(secs => ${leaseSeconds})
        RETURNING reservation_key`;
      return rows.length > 0;
    },
    getEvent: async (id: string, eventId: string): Promise<SessionEvent | undefined> => {
      const rows = await sql`SELECT payload FROM persona_events WHERE session_id = ${id} AND event_id = ${eventId} LIMIT 1`;
      return rows[0]?.payload as SessionEvent | undefined;
    },
    releaseReservation: async (sessionId: string, key: string): Promise<void> => {
      await sql`DELETE FROM persona_reservations WHERE session_id = ${sessionId} AND reservation_key = ${key}`;
    },
    /** One agent-log entry (see lib/observability/trace.ts). */
    appendTrace: async (sessionId: string, entry: TraceEntry): Promise<void> => {
      const duration = entry.durationMs === undefined || !Number.isFinite(entry.durationMs) ? null : Math.max(0, Math.round(entry.durationMs));
      await sql`INSERT INTO persona_traces (session_id, turn_id, kind, name, at, duration_ms, status, data)
        VALUES (${sessionId}, ${entry.turnId}, ${entry.kind}, ${entry.name}, ${entry.at}, ${duration}, ${entry.status ?? null},
          ${sql.json(JSON.parse(JSON.stringify(entry.data ?? {})) as Parameters<typeof sql.json>[0])})`;
    },
    /** The session's agent log in the order it was written, newest entries kept. */
    readTraces: async (sessionId: string): Promise<StoredTrace[]> => {
      const rows = await sql`SELECT id, turn_id, kind, name, at, duration_ms, status, data FROM (
          SELECT * FROM persona_traces WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${TRACE_LIMIT}) newest ORDER BY id`;
      return rows.map((row) => ({
        id: Number(row.id), turnId: row.turn_id as string, kind: row.kind as StoredTrace['kind'], name: row.name as string,
        at: new Date(row.at as string).toISOString(),
        ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
        ...(row.status ? { status: row.status as StoredTrace['status'] } : {}),
        data: (row.data as Record<string, unknown>) ?? {},
      }));
    },
    reserveIdentityClaim: async (sessionId: string, userEventId: string): Promise<boolean> => {
      const rows = await sql`INSERT INTO persona_identity_reservations (session_id, user_event_id)
        VALUES (${sessionId}, ${userEventId}) ON CONFLICT DO NOTHING RETURNING user_event_id`;
      return rows.length > 0;
    },
    /** The newest event's number: the open page reloads the conversation when it moves. */
    latestEventSeq: async (sessionId: string): Promise<number> => {
      const rows = await sql`SELECT COALESCE(MAX(seq), 0) AS seq FROM persona_events WHERE session_id = ${sessionId}`;
      return Number(rows[0]?.seq ?? 0);
    },
    /** A reservation under this prefix taken in the last `seconds` (a follow-up being written right now). */
    hasActiveReservation: async (sessionId: string, prefix: string, seconds: number): Promise<boolean> => {
      const rows = await sql`SELECT 1 FROM persona_reservations WHERE session_id = ${sessionId}
        AND starts_with(reservation_key, ${prefix}) AND created_at > now() - make_interval(secs => ${seconds}) LIMIT 1`;
      return rows.length > 0;
    },
    /** Sessions whose onboarding coach scheduled a check-in that is now due (for the cron). */
    sessionsWithDueCheckIns: async (limit = 25): Promise<string[]> => {
      // A check-in's own decision is the event `coach:wake:<id of the decision that scheduled it>`.
      const rows = await sql`SELECT DISTINCT e.session_id FROM persona_events e
        WHERE e.payload->>'type' = 'coach' AND e.payload->>'reachOut' = 'later' AND e.payload->>'wakeAt' <= ${new Date().toISOString()}
        AND e.created_at > now() - interval '8 days'
        AND NOT EXISTS (SELECT 1 FROM persona_events d WHERE d.session_id = e.session_id AND d.event_id = 'coach:wake:' || e.event_id)
        LIMIT ${limit}`;
      return rows.map((row) => row.session_id as string);
    },
  };
}
