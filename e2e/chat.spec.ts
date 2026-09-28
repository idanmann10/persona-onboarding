import { expect, test, type Page } from '@playwright/test';

/** A fresh local test account per test, so each one starts a new conversation. */
async function signIn(page: Page) {
  const user = `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await page.goto(`/api/auth/test-login?user=${user}`);
  await expect(page.getByRole('textbox', { name: 'Message Persona' })).toBeVisible();
}

test('the Apps sheet opens instantly', async ({ page }) => {
  await signIn(page);
  const started = Date.now();
  await page.getByRole('button', { name: /apps/i }).first().click();
  await expect(page.getByRole('dialog').getByText('Gmail', { exact: true }).first()).toBeVisible({ timeout: 1_000 });
  expect(Date.now() - started).toBeLessThan(1_000);
});

test.describe('@live (calls the model)', () => {
  test('the assistant opens the conversation and takes a name', async ({ page }) => {
    await signIn(page);
    // The first message is written by the assistant from what sign-in knows.
    await expect(page.locator('.row.assistant .bubble').first()).not.toBeEmpty({ timeout: 45_000 });

    await page.getByRole('textbox', { name: 'Message Persona' }).fill('Call yourself Max');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('header').getByText('Max', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    // No dashes in what it writes.
    const replies = await page.locator('.row.assistant .bubble').allInnerTexts();
    expect(replies.join('\n')).not.toMatch(/[—–]/);
  });
});
