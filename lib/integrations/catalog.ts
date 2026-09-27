import { APP_SLUG, appSlugFor, fallbackAppName, type AppEntry } from '../domain/apps';

const TOOLKITS_URL = 'https://backend.composio.dev/api/v3/toolkits';
const PAGE_SIZE = 1000;
/** A runaway cursor must not turn one Apps sheet into hundreds of Composio requests. */
const MAX_PAGES = 20;
export const CATALOG_TTL_MS = 60 * 60_000;

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function category(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : undefined;
  if (typeof first === 'string') return text(first, 60);
  const record = first as { name?: unknown; id?: unknown } | undefined;
  return text(record?.name, 60) ?? text(record?.id, 60);
}

function logo(value: unknown): string | undefined {
  const raw = text(value, 500);
  if (!raw) return undefined;
  try { return new URL(raw).protocol === 'https:' ? raw : undefined; } catch { return undefined; }
}

/**
 * Composio toolkits a user can connect with Composio's own OAuth app (non-empty
 * `composio_managed_auth_schemes`), plus toolkits that need no sign-in at all (`no_auth`), which are
 * listed but have nothing to connect. Deprecated toolkits and unsafe slugs are dropped.
 */
export function parseToolkits(items: unknown): AppEntry[] {
  if (!Array.isArray(items)) return [];
  const apps = new Map<string, AppEntry>();
  for (const raw of items) {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== 'object' || item.deprecated === true) continue;
    const toolkit = typeof item.slug === 'string' ? item.slug.toLowerCase() : '';
    if (!APP_SLUG.test(toolkit)) continue;
    const managed = Array.isArray(item.composio_managed_auth_schemes) && item.composio_managed_auth_schemes.length > 0;
    const noAuth = item.no_auth === true;
    if (!managed && !noAuth) continue;
    const slug = appSlugFor(toolkit);
    if (apps.has(slug)) continue;
    const meta = (item.meta ?? {}) as Record<string, unknown>;
    const entry: AppEntry = { slug, name: text(item.name, 80) ?? fallbackAppName(slug) };
    const image = logo(meta.logo);
    if (image) entry.logo = image;
    const group = category(meta.categories);
    if (group) entry.category = group;
    if (noAuth && !managed) entry.noAuth = true;
    apps.set(slug, entry);
  }
  return [...apps.values()];
}

export interface ToolkitCatalog {
  list(): Promise<AppEntry[]>;
  find(slug: string): Promise<AppEntry | undefined>;
}

/** Composio's toolkit catalog, fetched page by page and kept in memory for an hour. */
export function createToolkitCatalog(key: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now, ttlMs = CATALOG_TTL_MS): ToolkitCatalog {
  let cached: { at: number; apps: AppEntry[] } | undefined;
  let loading: Promise<AppEntry[]> | undefined;
  const load = async (): Promise<AppEntry[]> => {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(TOOLKITS_URL);
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetchFn(url.toString(), { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Composio toolkit catalog failed (${response.status})`);
      const data = await response.json() as { items?: unknown; next_cursor?: unknown };
      if (Array.isArray(data.items)) items.push(...data.items);
      const next = typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : undefined;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return parseToolkits(items);
  };
  const list = async (): Promise<AppEntry[]> => {
    if (cached && now() - cached.at < ttlMs) return cached.apps;
    if (!key) throw new Error('Composio is not configured');
    loading ??= load().then((apps) => { cached = { at: now(), apps }; return apps; }).finally(() => { loading = undefined; });
    return loading;
  };
  return {
    list,
    find: async (slug: string) => (await list()).find((app) => app.slug === slug),
  };
}

const shared = new Map<string, ToolkitCatalog>();

/** One catalog (and one cache) per API key for the whole server process. */
export function sharedToolkitCatalog(key: string): ToolkitCatalog {
  let catalog = shared.get(key);
  if (!catalog) { catalog = createToolkitCatalog(key); shared.set(key, catalog); }
  return catalog;
}
