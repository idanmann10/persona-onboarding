'use client';

import { useRef, useState, type FormEvent } from 'react';

type Mode = 'sign-in' | 'create';
type Field = 'name' | 'email' | 'password';

const MIN_PASSWORD = 8;

/** Email + password, under the Google button: sign in, or create an account with an optional name. */
export function PasswordForm() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field?: Field } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const creating = mode === 'create';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const name = String(form.get('name') ?? '').trim();
    const invalid = (text: string, field: Field) => {
      setError({ text, field });
      (field === 'email' ? emailRef : passwordRef).current?.focus();
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid('Enter a valid email address.', 'email');
    if (!password) return invalid('Enter your password.', 'password');
    if (creating && password.length < MIN_PASSWORD) return invalid(`Use at least ${MIN_PASSWORD} characters for your password.`, 'password');
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/password/${creating ? 'sign-up' : 'sign-in'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, ...(creating && name ? { name } : {}) }),
      });
      if (response.ok) { window.location.assign('/'); return; }
      const body = await response.json().catch(() => undefined) as { error?: string; field?: Field } | undefined;
      setError({ text: body?.error || "That didn't go through. Please try again.", field: body?.field });
      if (response.status === 401) passwordRef.current?.select();
    } catch {
      setError({ text: "Couldn't reach Persona. Check your connection and try again." });
    }
    setBusy(false);
  }

  function switchMode() {
    setMode(creating ? 'sign-in' : 'create');
    setError(null);
  }

  return (
    <form className="password-form" method="post" noValidate onSubmit={(event) => void submit(event)} aria-label={creating ? 'Create an account' : 'Sign in with email'}>
      {creating ? (
        <input className="signin-field" name="name" type="text" autoComplete="name" placeholder="Name (optional)" aria-label="Name (optional)" maxLength={100} disabled={busy} />
      ) : null}
      <input ref={emailRef} className="signin-field" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
        placeholder="Email" aria-label="Email" required maxLength={320} disabled={busy} aria-invalid={error?.field === 'email' || undefined} />
      <input ref={passwordRef} className="signin-field" name="password" type="password" autoComplete={creating ? 'new-password' : 'current-password'}
        placeholder={creating ? `Password (${MIN_PASSWORD}+ characters)` : 'Password'} aria-label="Password" required minLength={creating ? MIN_PASSWORD : undefined} maxLength={200}
        disabled={busy} aria-invalid={error?.field === 'password' || undefined} />
      {error ? <p className="signin-error inline" role="alert">{error.text}</p> : null}
      <button className="signin-submit" type="submit" disabled={busy}>{busy ? (creating ? 'Creating account…' : 'Signing in…') : creating ? 'Create account' : 'Sign in'}</button>
      <p className="signin-switch">
        {creating ? 'Already have an account?' : 'New to Persona?'}{' '}
        <button type="button" className="text-button" onClick={switchMode} disabled={busy}>{creating ? 'Sign in' : 'Create an account'}</button>
      </p>
    </form>
  );
}
