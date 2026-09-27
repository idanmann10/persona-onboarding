import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { readCalendarWindow, searchMailbox } from '../integrations/reads';
import type { Toolkit } from '../integrations/connections';

export function accountReadRelevant(toolkit: Toolkit, text: string): boolean {
  return toolkit === 'calendar'
    ? /\b(calendar|schedule|meeting|appointment|availability|free time|this week|my week|next week|today.?s plan|tomorrow.?s plan)\b/i.test(text)
    : /\b(email|e-mail|mail|inbox|unread|message from|messages from)\b/i.test(text);
}

interface Client {
  executeRead: (slug: 'GOOGLECALENDAR_EVENTS_LIST' | 'GMAIL_FETCH_EMAILS', accountId: string, userId: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function createAccountTools(client: Client, sessionId: string, currentUserText: string, accounts: Partial<Record<Toolkit, string>>): ToolSet {
  const result: ToolSet = {};
  if (accounts.calendar && accountReadRelevant('calendar', currentUserText)) {
    const accountId = accounts.calendar;
    result.read_calendar_window = tool({
      description: 'Read at most ten events from the connected primary calendar within a 30-day window, only to answer the current calendar request. No writes.',
      inputSchema: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
      execute: async ({ from, to }) => {
        try { return { status: 'ok', events: await readCalendarWindow(client.executeRead, accountId, sessionId, from, to) }; }
        catch (error) { console.error('Calendar read failed', error); return { status: 'unavailable' }; }
      },
    });
  }
  if (accounts.gmail && accountReadRelevant('gmail', currentUserText)) {
    const accountId = accounts.gmail;
    result.search_gmail = tool({
      description: 'Search at most five connected Gmail message summaries for the current email request. Do not fetch message bodies or write.',
      inputSchema: z.object({ query: z.string().min(1).max(120) }),
      execute: async ({ query }) => {
        try { return { status: 'ok', messages: await searchMailbox(client.executeRead, accountId, sessionId, query) }; }
        catch (error) { console.error('Gmail read failed', error); return { status: 'unavailable' }; }
      },
    });
  }
  return result;
}
