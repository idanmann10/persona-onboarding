'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { fallbackAppName, isAppSlug, listApps, type AppEntry as CatalogEntry } from '@/lib/domain/apps';
import { SNAPSHOT_APPS } from '@/lib/integrations/catalog';
import { CloseIcon, SearchIcon } from './icons';

export type AppEntry = { slug: string; name: string; logo?: string; category?: string; connected: boolean };

const LEGACY_APPS: Record<string, { name: string; category: string }> = {
  gmail: { name: 'Gmail', category: 'Email' },
  calendar: { name: 'Google Calendar', category: 'Calendar' },
};

/**
 * Reads `GET /api/connections`: `{ apps: AppEntry[] }`. The older `{ gmail: boolean, calendar: boolean }`
 * status shape is still understood, so the sheet works before and after the apps catalog lands.
 */
export function appsFromResponse(body: unknown): AppEntry[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.apps)) {
    return record.apps.flatMap((raw): AppEntry[] => {
      if (!raw || typeof raw !== 'object') return [];
      const app = raw as Record<string, unknown>;
      if (typeof app.slug !== 'string' || !app.slug) return [];
      return [{
        slug: app.slug,
        name: typeof app.name === 'string' && app.name ? app.name : app.slug,
        ...(typeof app.logo === 'string' && app.logo ? { logo: app.logo } : {}),
        ...(typeof app.category === 'string' && app.category ? { category: app.category } : {}),
        connected: app.connected === true,
      }];
    });
  }
  return Object.entries(LEGACY_APPS)
    .filter(([slug]) => typeof record[slug] === 'boolean')
    .map(([slug, app]) => ({ slug, ...app, connected: record[slug] === true }));
}

export function matchesQuery(app: Pick<AppEntry, 'slug' | 'name' | 'category'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [app.name, app.slug, app.category ?? ''].some((value) => value.toLowerCase().includes(needle));
}

const ACRONYMS = new Set(['ai', 'crm', 'hr', 'sms', 'seo']);

/** Composio's categories come lowercase ("team chat", "crm"): "Team chat", "CRM". */
function categoryLabel(category?: string): string {
  return (category ?? '').split(' ').map((word, index) => ACRONYMS.has(word) ? word.toUpperCase() : index ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// ---- Connection status: one small request, shared by the page's prefetch and the sheet. ----

type Status = { version: number; request: Promise<string[]>; connected?: string[]; at?: number };
let status: Status | undefined;
/** A status older than this is shown at once but checked again, e.g. for a change made in another tab. */
const STATUS_TTL_MS = 30_000;

async function fetchConnected(): Promise<string[]> {
  const response = await fetch('/api/connections/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 503 ? 'Apps are not available right now.' : 'Apps could not be loaded.');
  const body = await response.json() as { connected?: unknown };
  return Array.isArray(body.connected) ? body.connected.filter(isAppSlug) : [];
}

/**
 * The apps this session has connected. `version` is the page's count of finished connections, so a
 * change made while the sheet was closed is never answered from the cache.
 */
function loadConnected(version: number, force = false): Promise<string[]> {
  if (!force && status?.version === version && (status.at === undefined || Date.now() - status.at < STATUS_TTL_MS)) return status.request;
  const entry: Status = { version, request: fetchConnected() };
  entry.request.then((connected) => { entry.connected = connected; entry.at = Date.now(); }, () => { if (status === entry) status = undefined; });
  status = entry;
  return entry.request;
}

let logosWarmed = false;

/**
 * Called by the page once it has a session, and again after each connection change: loads the status now
 * and, when the browser is idle, the logos of the sheet's first screen, so the sheet opens complete.
 */
export function prefetchApps(version: number): void {
  loadConnected(version).catch(() => undefined);
  if (logosWarmed || typeof window === 'undefined') return;
  logosWarmed = true;
  const warm = () => {
    for (const app of listApps([...SNAPSHOT_APPS], [], null, 10)) if (app.logo) new Image().src = app.logo;
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 4_000 });
  else setTimeout(warm, 1_500);
}

function AppLogo({ app }: { app: AppEntry }) {
  const [broken, setBroken] = useState(false);
  if (app.logo && !broken) return <img className="app-logo" src={app.logo} alt="" width={36} height={36} loading="lazy" decoding="async" onError={() => setBroken(true)} />;
  return <span className="app-logo app-logo-letter" aria-hidden="true">{(Array.from(app.name.trim())[0] ?? '?').toUpperCase()}</span>;
}

interface SheetProps {
  /** The app whose sign-in window is open, if any. */
  connecting: string | null;
  /** Bumped by the page when a connection finishes, so the status reloads. */
  version: number;
  onConnect(slug: string): void;
  /** Called after a disconnect so the page can refresh the conversation. */
  onChanged(): void;
  onClose(): void;
}

/**
 * The "Apps" sheet: connect or disconnect accounts. It lists and searches the bundled catalog snapshot,
 * so it renders on the first frame; only the session's status is fetched (usually already prefetched),
 * and the server's live catalog is searched only when the snapshot has no match.
 */
export function ConnectionsSheet({ connecting, version, onConnect, onChanged, onClose }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  // null until the status is known: rows show, but their buttons wait for it.
  const [connected, setConnected] = useState<string[] | null>(() => status?.version === version ? status.connected ?? null : null);
  // Apps the server search found beyond the snapshot, kept so they stay listed.
  const [found, setFound] = useState<CatalogEntry[]>([]);
  // Texts the server search already answered; `empty` when it found nothing.
  const [searched, setSearched] = useState<{ needle: string; empty: boolean }[]>([]);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    // On a touch screen, focusing search would raise the keyboard over the list people came to browse.
    if (window.matchMedia?.('(pointer: fine)').matches) searchRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    const request = loadConnected(version, reload > 0);
    request
      // A newer request (a disconnect, a retry) may have replaced this one: only the latest answer counts.
      .then((list) => { if (active && status?.request === request) { setConnected(list); setError(''); } })
      .catch((cause) => { if (active) setError(cause instanceof Error && cause.message ? cause.message : 'Apps could not be loaded.'); });
    return () => { active = false; };
  }, [version, reload]);

  const apps = useMemo(() => {
    const catalog = new Map<string, CatalogEntry>(SNAPSHOT_APPS.map((app) => [app.slug, app]));
    for (const app of found) if (!catalog.has(app.slug)) catalog.set(app.slug, app);
    // An app connected since the snapshot still shows, so it can be disconnected.
    for (const slug of connected ?? []) if (!catalog.has(slug)) catalog.set(slug, { slug, name: fallbackAppName(slug) });
    return listApps([...catalog.values()], connected ?? [], null, Infinity);
  }, [connected, found]);
  const visible = apps.filter((app) => matchesQuery(app, query));
  const needle = query.trim().toLowerCase();
  // Only a text the snapshot can't match goes to the server. Search is by substring, so a text containing
  // one the server found nothing for can't match either.
  const miss = Boolean(needle) && !visible.length && !searched.some((done) => done.needle === needle || (done.empty && needle.includes(done.needle)));

  useEffect(() => {
    if (!miss) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/connections?q=${encodeURIComponent(needle)}`, { cache: 'no-store', signal: controller.signal })
        .then(async (response) => response.ok ? appsFromResponse(await response.json()).map(({ connected: _, ...app }): CatalogEntry => app) : undefined)
        .catch(() => undefined)
        .then((results) => {
          if (controller.signal.aborted) return;
          if (results?.length) setFound((list) => [...list, ...results.filter((app) => !list.some((known) => known.slug === app.slug))]);
          // A failed search reads as no match for this exact text; the snapshot stays listed.
          setSearched((list) => [...list, { needle, empty: results?.length === 0 }]);
        });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [miss, needle]);

  function close() {
    const dialog = dialogRef.current;
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else onClose();
  }

  function onBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) close();
  }

  async function disconnect(slug: string) {
    setRemoving(slug);
    setError('');
    try {
      const response = await fetch('/api/connections', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolkit: slug }) });
      if (!response.ok) throw new Error((await response.text().catch(() => '')).trim() || 'That app could not be disconnected.');
      setConnected((list) => list?.filter((item) => item !== slug) ?? list);
      onChanged();
      setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'That app could not be disconnected.'); }
    finally { setRemoving(null); }
  }

  return (
    <dialog ref={dialogRef} className="sheet" aria-labelledby="apps-title" onClose={onClose} onClick={onBackdrop}>
      <div className="sheet-panel">
        <div className="sheet-head">
          <div>
            <h2 id="apps-title">Apps</h2>
            <p>Connect the accounts your assistant can use. You can disconnect any time.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close apps" onClick={close}><CloseIcon width={18} height={18} /></button>
        </div>
        <label className="sheet-search">
          <SearchIcon width={17} height={17} />
          <input ref={searchRef} type="search" placeholder="Search apps" aria-label="Search apps" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {error ? <p className="sheet-error" role="alert">{error} <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>Retry</button></p> : null}
        <ul className="app-list" aria-busy={connected === null || miss}>
          {!visible.length ? <li className="app-empty">{miss ? 'Searching all apps…' : `No apps match “${query.trim()}”`}</li> : null}
          {visible.map((app) => (
            <li className="app-row" key={app.slug}>
              <AppLogo app={app} />
              <span className="app-text">
                <strong>{app.name}</strong>
                <small>{app.connected ? <><span className="connected-dot" aria-hidden="true" />Connected{app.category ? ` · ${categoryLabel(app.category)}` : ''}</> : categoryLabel(app.category)}</small>
              </span>
              {app.connected ? (
                <button type="button" className="pill" disabled={removing === app.slug} onClick={() => void disconnect(app.slug)} aria-label={`Disconnect ${app.name}`}>{removing === app.slug ? 'Removing…' : 'Disconnect'}</button>
              ) : (
                <button type="button" className="pill primary" disabled={connected === null || Boolean(connecting)} onClick={() => onConnect(app.slug)} aria-label={`Connect ${app.name}`}>{connecting === app.slug ? 'Opening…' : 'Connect'}</button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
}
