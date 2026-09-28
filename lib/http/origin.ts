/**
 * A same-site request: its Origin is this server's own, or the app's public origin (APP_BASE_URL). They differ
 * when the public address is a proxy in front of the server (Vercel in front of Railway), where the request
 * this server sees carries the server's own host.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  if (origin === new URL(request.url).origin) return true;
  try { return Boolean(process.env.APP_BASE_URL) && origin === new URL(process.env.APP_BASE_URL!).origin; }
  catch { return false; }
}
