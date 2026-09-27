import { describe, expect, it } from 'vitest';
import { readCalendarWindow, searchMailbox } from '../../lib/integrations/reads';

describe('bounded account reads', () => {
  it('limits calendar requests and returns only event fields useful for planning', async () => {
    let args: Record<string, unknown> | undefined;
    const execute = async (_slug: string, _account: string, _user: string, input: Record<string, unknown>) => {
      args = input;
      return { items: [{ id: 'e1', summary: 'Design review', start: { dateTime: '2026-09-28T10:00:00Z' }, end: { dateTime: '2026-09-28T11:00:00Z' }, description: 'Sensitive details' }] };
    };
    const events = await readCalendarWindow(execute, 'ca_one', 'owner', '2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z');
    expect(args).toMatchObject({ calendarId: 'primary', maxResults: 10, singleEvents: true });
    expect(events).toEqual([{ id: 'e1', summary: 'Design review', start: '2026-09-28T10:00:00Z', end: '2026-09-28T11:00:00Z' }]);
    await expect(readCalendarWindow(execute, 'ca_one', 'owner', '2026-09-28T00:00:00Z', '2026-11-29T00:00:00Z')).rejects.toThrow('range');
  });

  it('fetches only metadata for a bounded Gmail query', async () => {
    let args: Record<string, unknown> | undefined;
    const execute = async (_slug: string, _account: string, _user: string, input: Record<string, unknown>) => {
      args = input;
      return { messages: [{ id: 'm1', subject: 'Schedule', snippet: 'Can we meet?', from: 'alex@example.com', body: 'Full confidential body' }] };
    };
    expect(await searchMailbox(execute, 'ca_gmail', 'owner', 'newer_than:7d schedule')).toEqual([{ id: 'm1', subject: 'Schedule', snippet: 'Can we meet?', from: 'alex@example.com' }]);
    expect(args).toMatchObject({ max_results: 5, include_payload: false, query: 'newer_than:7d schedule' });
    await expect(searchMailbox(execute, 'ca_gmail', 'owner', 'x'.repeat(121))).rejects.toThrow('query');
  });
});
