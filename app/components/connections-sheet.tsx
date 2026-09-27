'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
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

export function matchesQuery(app: AppEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [app.name, app.slug, app.category ?? ''].some((value) => value.toLowerCase().includes(needle));
}

function AppLogo({ app }: { app: AppEntry }) {
  const [broken, setBroken] = useState(false);
  if (app.logo && !broken) return <img className="app-logo" src={app.logo} alt="" width={36} height={36} loading="lazy" onError={() => setBroken(true)} />;
  return <span className="app-logo app-logo-letter" aria-hidden="true">{(Array.from(app.name.trim())[0] ?? '?').toUpperCase()}</span>;
}

interface SheetProps {
  /** The app whose sign-in window is open, if any. */
  connecting: string | null;
  /** Bumped by the page when a connection finishes, so the list reloads. */
  version: number;
  onConnect(slug: string): void;
  /** Called after a disconnect so the page can refresh the conversation. */
  onChanged(): void;
  onClose(): void;
}

/** The "Apps" sheet: search the catalog, connect or disconnect accounts. */
export function ConnectionsSheet({ connecting, version, onConnect, onChanged, onClose }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const q = query.trim();
    const timer = setTimeout(() => {
      fetch(`/api/connections${q ? `?q=${encodeURIComponent(q)}` : ''}`, { cache: 'no-store', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(response.status === 503 ? 'Apps are not available right now.' : 'Apps could not be loaded.');
          setApps(appsFromResponse(await response.json()));
          setError('');
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setError(cause instanceof Error && cause.message ? cause.message : 'Apps could not be loaded.');
        });
    }, q ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, version, reload]);

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
      setApps((list) => list?.map((app) => app.slug === slug ? { ...app, connected: false } : app) ?? list);
      onChanged();
      setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'That app could not be disconnected.'); }
    finally { setRemoving(null); }
  }

  const visible = apps?.filter((app) => matchesQuery(app, query)) ?? [];

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
        <ul className="app-list" aria-busy={apps === null}>
          {apps === null && !error ? <li className="app-empty">Loading apps…</li> : null}
          {apps !== null && !visible.length ? <li className="app-empty">{query.trim() ? `No apps match “${query.trim()}”` : 'No apps yet'}</li> : null}
          {visible.map((app) => (
            <li className="app-row" key={app.slug}>
              <AppLogo app={app} />
              <span className="app-text">
                <strong>{app.name}</strong>
                <small>{app.connected ? <><span className="connected-dot" aria-hidden="true" />Connected{app.category ? ` · ${app.category}` : ''}</> : app.category ?? ''}</small>
              </span>
              {app.connected ? (
                <button type="button" className="pill" disabled={removing === app.slug} onClick={() => void disconnect(app.slug)} aria-label={`Disconnect ${app.name}`}>{removing === app.slug ? 'Removing…' : 'Disconnect'}</button>
              ) : (
                <button type="button" className="pill primary" disabled={Boolean(connecting)} onClick={() => onConnect(app.slug)} aria-label={`Connect ${app.name}`}>{connecting === app.slug ? 'Opening…' : 'Connect'}</button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
}
