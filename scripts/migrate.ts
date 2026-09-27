import postgres from 'postgres';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const schema = await readFile(new URL('../lib/db/schema.sql', import.meta.url), 'utf8');
  await sql.unsafe(schema);
  console.log('Persona database schema is ready');
} finally {
  await sql.end();
}
