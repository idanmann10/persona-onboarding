import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    // Several files create a Postgres database at once; on a busy machine that can outlast the 10 s default.
    hookTimeout: 30_000, environment: 'node' },
});
