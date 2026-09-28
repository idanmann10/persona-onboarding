import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the real app on localhost: a real Postgres, real routes, and (for the tests
 * tagged @live) the real model. Sign-in uses the local test login (E2E_TEST_LOGIN=on), which a production
 * build never serves. Uses the installed Chrome, so there is no browser download.
 */
export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', channel: 'chrome', trace: 'retain-on-failure' },
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:3000/sign-in',
    reuseExistingServer: true,
    env: { E2E_TEST_LOGIN: 'on' },
    timeout: 120_000,
  },
});
