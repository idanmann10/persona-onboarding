import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { readCalendarWindow, searchMailbox } from '../integrations/reads';
import type { Toolkit } from '../integrations/connections';

const RELEVANT: Record<Toolkit, RegExp> = {
  calendar: /\b(calendar|schedule|meeting|meetings|appointment|availability|agenda|free time|this week|my week|next week|today.?s plan|tomorrow.?s plan)\b/i,
  gmail: /\b(gmail|email|emails|e-mail|mail|inbox|unread|message from|messages from|reply|replies|respond to|waiting on|thread|newsletters?|unsubscribe)\b/i,
};
const AFFIRMATION = /^\s*(yes|yeah|yep|sure|ok|okay|please|go ahead|do it|sounds good|let'?s do it|yes please)\b/i;

export function accountReadRelevant(toolkit: Toolkit, text: string): boolean {
  return RELEVANT[toolkit].test(text);
}

/**
 * Account reads are exposed only for a request about that account. The request is the user's last two
 * messages; a short "yes" also carries the assistant's question it answers ("want me to check your
 * inbox?"). An app event such as "Gmail just connected" can open the read explicitly.
 */
export function relevantToolkits(context: { userTexts: string[]; lastAssistant?: string; include?: Toolkit[] }): Toolkit[] {
  const recent = context.userTexts.slice(-2);
  const texts = [...recent];
  if (context.lastAssistant && AFFIRMATION.test(recent.at(-1) ?? '')) texts.push(context.lastAssistant);
  return (['calendar', 'gmail'] as const).filter((toolkit) => context.include?.includes(toolkit) || texts.some((text) => accountReadRelevant(toolkit, text)));
}

export interface AccountReadClient {
  executeRead: (slug: 'GOOGLECALENDAR_EVENTS_LIST' | 'GMAIL_FETCH_EMAILS', accountId: string, userId: string, args: Record<string, unknown>) => Promise<unknown>;
}

export async function runCalendarRead(client: AccountReadClient, accountId: string, sessionId: string, input: { from: string; to: string }) {
  try { return { status: 'ok', events: await readCalendarWindow(client.executeRead, accountId, sessionId, input.from, input.to) }; }
  catch (error) { console.error('Calendar read failed', error); return { status: 'unavailable' }; }
}

export async function runGmailSearch(client: AccountReadClient, accountId: string, sessionId: string, input: { query: string }) {
  try { return { status: 'ok', messages: await searchMailbox(client.executeRead, accountId, sessionId, input.query) }; }
  catch (error) { console.error('Gmail read failed', error); return { status: 'unavailable' }; }
}

export const calendarReadInput = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) });
export const gmailSearchInput = z.object({ query: z.string().min(1).max(120).describe('A Gmail search query, e.g. "in:inbox is:unread newer_than:7d".') });

export function createAccountTools(client: AccountReadClient, sessionId: string, relevant: Toolkit[], accounts: Partial<Record<Toolkit, string>>): ToolSet {
  const result: ToolSet = {};
  if (accounts.calendar && relevant.includes('calendar')) {
    const accountId = accounts.calendar;
    result.read_calendar_window = tool({
      description: 'Read at most ten events from the connected primary calendar within a 30-day window, only to answer the current calendar request. No writes.',
      inputSchema: calendarReadInput,
      execute: (input) => runCalendarRead(client, accountId, sessionId, input),
    });
  }
  if (accounts.gmail && relevant.includes('gmail')) {
    const accountId = accounts.gmail;
    result.search_gmail = tool({
      description: 'Search at most five connected Gmail message summaries (sender, subject, preview, unread) for the current email request. No message bodies, no writes.',
      inputSchema: gmailSearchInput,
      execute: (input) => runGmailSearch(client, accountId, sessionId, input),
    });
  }
  return result;
}
