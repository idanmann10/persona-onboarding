import { expect, test } from '@playwright/test';

test('every page asks for sign-in first', async ({ page }) => {
  for (const path of ['/', '/inspect']) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Persona' })).toHaveCount(0);
  }
});

test('user data stays behind sign-in', async ({ request }) => {
  for (const path of ['/api/session', '/api/connections/status', '/api/inspect']) {
    expect((await request.get(path)).status(), path).toBe(401);
  }
  expect((await request.post('/api/chat', { data: { text: 'hi' } })).status()).toBe(401);
});

test('privacy and terms are public', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
  await page.goto('/terms');
  await expect(page.getByRole('heading', { name: 'Terms' })).toBeVisible();
});
