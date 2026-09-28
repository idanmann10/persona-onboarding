import { expect, test, type Page } from '@playwright/test';

const password = 'e2e-password-1';
const freshEmail = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`;

async function fillAccountForm(page: Page, email: string, secret: string) {
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password').fill(secret);
}

async function createAccount(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByRole('textbox', { name: 'Name (optional)' }).fill('Dana');
  await fillAccountForm(page, email, password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function signOut(page: Page) {
  const origin = new URL(page.url()).origin;
  expect((await page.request.post('/api/auth/sign-out', { headers: { origin } })).ok()).toBe(true);
}

test('email and password: create, sign out, sign back in to the same conversation', async ({ page }) => {
  const email = freshEmail();
  await createAccount(page, email);
  await expect(page.getByRole('textbox', { name: 'Message Persona' })).toBeVisible();
  const conversation = async () => ((await (await page.request.get('/api/session')).json()) as { messages: Array<{ id: string }> }).messages.map((message) => message.id);
  const before = await conversation();

  await signOut(page);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();

  await fillAccountForm(page, email, 'not-the-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.signin-error')).toBeVisible();

  await fillAccountForm(page, email.toUpperCase(), password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Persona' })).toBeVisible();
  // Same conversation: everything that was there before signing out is still there.
  expect((await conversation()).slice(0, before.length)).toEqual(before);
});

test('an email can only have one account', async ({ page, browser }) => {
  const email = freshEmail();
  await createAccount(page, email);
  await expect(page.getByRole('textbox', { name: 'Message Persona' })).toBeVisible();

  const other = await browser.newPage();
  await createAccount(other, email);
  await expect(other.locator('.signin-error')).toContainText(/already exists/i);
  await other.close();
});
