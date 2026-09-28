import { z } from 'zod';
import type { Toolkit } from '../../domain/events';
import { runCalendarRead, runGmailSearch } from './accounts';
import { TOOLKIT_NAMES, timestamp } from './gates';
import { defineTool, type ToolContext, type ToolResult } from './types';

/**
 * A read happens only for a connected account and a request about it. The text turn doesn't even see the
 * tool otherwise; a call offers it for the whole call, so the same checks run again on every request.
 */
async function gated(ctx: ToolContext, toolkit: Toolkit, read: (accountId: string, record: (toolkit: Toolkit, items: number) => Promise<void>) => Promise<ToolResult>): Promise<ToolResult> {
  const accountId = ctx.accounts[toolkit];
  if (!ctx.composio || !accountId) return { status: 'not_connected', note: `${TOOLKIT_NAMES[toolkit]} is not connected. Offer the Connect button if it would help.` };
  if (!ctx.relevant.includes(toolkit)) return { status: 'not_relevant', note: 'Read the account only for a request the user made about it.' };
  return read(accountId, (kit, items) => ctx.store.appendEvent(ctx.sessionId, { id: `read:${ctx.turnId}:${kit}`, at: timestamp(ctx), type: 'account_read', toolkit: kit, items }));
}

export const searchGmail = defineTool({
  name: 'search_gmail',
  description: 'Search at most five connected Gmail message summaries (sender, subject, preview, unread) for the current email request. No message bodies, no writes.',
  input: z.object({ query: z.string().min(1).max(120).describe('A Gmail search query, e.g. "in:inbox is:unread newer_than:7d".') }),
  channels: ['text', 'voice'],
  offered: (ctx) => Boolean(ctx.composio && ctx.accounts.gmail && ctx.relevant.includes('gmail')),
  onCall: (capabilities) => capabilities.gmail,
  execute: (ctx, input) => gated(ctx, 'gmail', (accountId, record) => runGmailSearch(ctx.composio!, accountId, ctx.sessionId, input, record)),
});

export const readCalendarWindow = defineTool({
  name: 'read_calendar_window',
  description: 'Read at most ten events from the connected primary calendar within a 30-day window, only to answer the current calendar request. No writes.',
  input: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
  channels: ['text', 'voice'],
  offered: (ctx) => Boolean(ctx.composio && ctx.accounts.calendar && ctx.relevant.includes('calendar')),
  onCall: (capabilities) => capabilities.calendar,
  execute: (ctx, input) => gated(ctx, 'calendar', (accountId, record) => runCalendarRead(ctx.composio!, accountId, ctx.sessionId, input, record)),
});
