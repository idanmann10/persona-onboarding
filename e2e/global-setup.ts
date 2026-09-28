import postgres from 'postgres';

/**
 * Each run creates accounts from localhost, which the per-network sign-up limit (10 an hour) would soon
 * refuse. Clear the local sign-in limits before a run; a database that isn't on this machine is left alone.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL ?? 'postgres://localhost/persona_dev';
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) return;
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try { await sql`DELETE FROM persona_ip_limits WHERE scope IN ('sign_in', 'sign_up', 'sign_in_email', 'session')`; }
  finally { await sql.end(); }
}
