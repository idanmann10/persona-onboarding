import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { appsFromResponse, ConnectionsSheet, matchesQuery, type AppEntry } from '../../app/components/connections-sheet';

const noop = () => undefined;

describe('apps sheet data', () => {
  it('reads the apps catalog and drops malformed rows', () => {
    expect(appsFromResponse({ apps: [
      { slug: 'slack', name: 'Slack', logo: 'https://logos.example/slack.svg', category: 'Chat', connected: true },
      { slug: 'notion', name: 'Notion', connected: false },
      { name: 'No slug' },
      null,
    ] })).toEqual([
      { slug: 'slack', name: 'Slack', logo: 'https://logos.example/slack.svg', category: 'Chat', connected: true },
      { slug: 'notion', name: 'Notion', connected: false },
    ]);
  });

  it('still understands the older Gmail and Calendar status shape', () => {
    expect(appsFromResponse({ calendar: false, gmail: true })).toEqual([
      { slug: 'gmail', name: 'Gmail', category: 'Email', connected: true },
      { slug: 'calendar', name: 'Google Calendar', category: 'Calendar', connected: false },
    ]);
    expect(appsFromResponse('nope')).toEqual([]);
  });

  it('matches a search on name, slug, or category', () => {
    const app: AppEntry = { slug: 'googlecalendar', name: 'Google Calendar', category: 'Productivity', connected: false };
    expect(matchesQuery(app, '')).toBe(true);
    expect(matchesQuery(app, 'cal')).toBe(true);
    expect(matchesQuery(app, 'PRODUCT')).toBe(true);
    expect(matchesQuery(app, 'slack')).toBe(false);
  });
});

describe('apps sheet markup', () => {
  it('is a labelled dialog with a search field and a close button', () => {
    const html = renderToStaticMarkup(<ConnectionsSheet connecting={null} version={0} onConnect={noop} onChanged={noop} onClose={noop} />);
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-labelledby="apps-title"');
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Close apps"');
    expect(html).toContain('Loading apps');
  });
});
