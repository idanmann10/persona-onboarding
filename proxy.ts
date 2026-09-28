import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE } from '@/lib/auth/cookie';

/**
 * Sign-in comes first. An optimistic check on the login cookie only (no database here): a browser without
 * one sees the sign-in screen on any page, and gets 401 from any API that holds user data. Every route
 * handler still verifies the login itself, so a stale or forged cookie gets no further than this.
 */
const PUBLIC_PAGES = new Set(['/sign-in', '/privacy', '/terms']);
/** Sign-in itself, and machine endpoints that carry their own secret (admin funnel, scheduled runs). */
const PUBLIC_API = /^\/api\/(?:auth\/|admin\/|automations\/run-due$)/;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasLogin = /^[A-Za-z0-9_-]{43}$/.test(request.cookies.get(AUTH_COOKIE)?.value ?? '');
  if (pathname.startsWith('/api/')) {
    if (hasLogin || PUBLIC_API.test(pathname)) return NextResponse.next();
    return NextResponse.json({ error: 'Sign-in required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  if (hasLogin || PUBLIC_PAGES.has(pathname)) return NextResponse.next();
  const signIn = request.nextUrl.clone();
  signIn.pathname = '/sign-in';
  return NextResponse.rewrite(signIn);
}

export const config = {
  // Not static files: Next's build output, the brand mark, the stock portraits, icons and images.
  matcher: ['/((?!_next/static|_next/image|brand/|avatars/|favicon\\.ico|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|webp|ico|txt)$).*)'],
};
