import postgres from 'postgres';

let client: ReturnType<typeof postgres> | undefined;

export function getDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  client ??= postgres(process.env.DATABASE_URL, { max: 5, prepare: false });
  return client;
}
