import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AUTH_COOKIE } from '@/lib/auth/cookie';
import { googleConfig } from '@/lib/auth/google';
import { hashLoginToken } from '@/lib/auth/login';
import { testLoginEnabled, type SignInError } from '@/lib/auth/sign-in';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { PersonaMark } from '../components/icons';
import { GoogleMark } from './google-mark';
import './sign-in.css';

export const metadata: Metadata = { title: 'Sign in · Persona' };
export const dynamic = 'force-dynamic';

const MESSAGES: Record<SignInError, string> = {
  not_configured: "Sign-in isn't set up on this server yet.",
  cancelled: 'Sign-in was cancelled. Try again whenever you like.',
  expired: 'That took a little too long. Please try again.',
  failed: "Google sign-in didn't go through. Please try again.",
  unverified: "That Google account's email isn't verified yet. Verify it with Google, then try again.",
  busy: 'Too many sign-ins from this network right now. Please try again in a little while.',
};

/** A browser with a live login goes straight to its conversation. */
async function signedIn(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || !process.env.DATABASE_URL) return false;
  try { return Boolean(await createStore(getDatabase()).findLogin(hashLoginToken(token))); }
  catch { return false; }
}

async function showTestLogin(): Promise<boolean> {
  const list = await headers();
  try { return testLoginEnabled(process.env, new Request(`http://${list.get('host') ?? 'invalid'}/`, { headers: list })); }
  catch { return false; }
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await signedIn()) redirect('/');
  const configured = Boolean(googleConfig(process.env));
  const { error } = await searchParams;
  const message = typeof error === 'string' && error in MESSAGES ? MESSAGES[error as SignInError] : configured ? undefined : MESSAGES.not_configured;
  const testLogin = await showTestLogin();

  return (
    <main className="signin">
      <div className="signin-glow" aria-hidden="true" />
      <section className="signin-panel" aria-labelledby="signin-title">
        <span className="signin-tile glass"><PersonaMark className="signin-mark" /></span>
        <p className="signin-word">Persona</p>
        <h1 id="signin-title">The assistant that takes stuff off your plate.</h1>
        {message ? <p className="signin-error" role="alert">{message}</p> : null}
        {configured ? (
          <a className="google-button" href="/api/auth/google"><GoogleMark className="google-mark" />Continue with Google</a>
        ) : (
          <button className="google-button" type="button" disabled><GoogleMark className="google-mark" />Continue with Google</button>
        )}
        <p className="signin-note">Google shares only your name, email and profile photo. Your inbox stays private unless you connect it later.</p>
        {testLogin ? <a className="signin-test" href="/api/auth/test-login">Continue as the local test user</a> : null}
      </section>
      <footer className="signin-footer"><a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a></footer>
    </main>
  );
}
