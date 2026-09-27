/** Apps a user can connect from the Apps sheet: any Composio toolkit with Composio-managed sign-in. */

/** A toolkit slug as the UI and the API use it. Composio's own slugs are lowercase words and underscores. */
export const APP_SLUG = /^[a-z0-9_]{1,60}$/;

/** The two apps the agent can read today; they keep their own auth configs and `connection` events. */
export type BuiltinApp = 'gmail' | 'calendar';

export interface AppEntry {
  slug: string;
  name: string;
  logo?: string;
  category?: string;
  /** Composio needs no sign-in for this toolkit, so there is nothing to connect. */
  noAuth?: boolean;
}

export interface AppListing extends AppEntry { connected: boolean }

/** Shown first, in this order, when they are in the catalog. Our 'calendar' is Composio's 'googlecalendar'. */
export const POPULAR_APPS = [
  'gmail', 'calendar', 'googledrive', 'slack', 'notion', 'github', 'linear', 'outlook', 'microsoft_teams', 'hubspot',
  'salesforce', 'jira', 'asana', 'trello', 'dropbox', 'zoom', 'calendly', 'airtable', 'figma', 'discord', 'youtube', 'x', 'twitter',
];

export const MAX_APP_RESULTS = 60;

export function isBuiltinApp(slug: string): slug is BuiltinApp {
  return slug === 'gmail' || slug === 'calendar';
}

export function isAppSlug(value: unknown): value is string {
  return typeof value === 'string' && APP_SLUG.test(value);
}

/** Composio's toolkit slug for an app slug. */
export function composioToolkitSlug(slug: string): string {
  return slug === 'calendar' ? 'googlecalendar' : slug;
}

/** The app slug for a Composio toolkit slug (Google Calendar is 'calendar' everywhere in Persona). */
export function appSlugFor(toolkitSlug: string): string {
  return toolkitSlug === 'googlecalendar' ? 'calendar' : toolkitSlug;
}

/** A readable name when the catalog has none: 'microsoft_teams' -> 'Microsoft Teams'. */
export function fallbackAppName(slug: string): string {
  if (slug === 'calendar') return 'Google Calendar';
  if (slug === 'gmail') return 'Gmail';
  return slug.split('_').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') || slug;
}

/**
 * The Apps sheet list: connected apps first, then the popular ones in their fixed order, then the rest by
 * name. `query` matches name or slug, case-insensitively.
 */
export function listApps(catalog: AppEntry[], connected: Iterable<string>, query?: string | null, limit = MAX_APP_RESULTS): AppListing[] {
  const connectedSet = new Set(connected);
  const needle = (query ?? '').trim().toLowerCase();
  const popularity = (slug: string) => {
    const rank = POPULAR_APPS.indexOf(slug);
    return rank === -1 ? POPULAR_APPS.length : rank;
  };
  return catalog
    .filter((app) => !needle || app.slug.includes(needle) || app.name.toLowerCase().includes(needle))
    .map((app) => ({ ...app, connected: connectedSet.has(app.slug) }))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || popularity(a.slug) - popularity(b.slug) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}
