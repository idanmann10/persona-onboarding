type Execute = (slug: 'GOOGLECALENDAR_EVENTS_LIST' | 'GMAIL_FETCH_EMAILS', accountId: string, userId: string, args: Record<string, unknown>) => Promise<unknown>;

const string = (value: unknown) => typeof value === 'string' && value.trim() ? value.slice(0, 300) : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/**
 * Composio wraps provider payloads inconsistently (`data.items`, `data.response_data.items`,
 * `data.messages`, ...). Walk the known wrapper keys breadth-first and return the first list found,
 * the way a production reader has to.
 */
export function listItems(payload: unknown, keys: string[]): Array<Record<string, unknown>> {
  const queue: unknown[] = [payload];
  for (let index = 0; index < queue.length && index < 50; index++) {
    const node = queue[index];
    if (Array.isArray(node)) return node.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
    if (node && typeof node === 'object') {
      for (const key of keys) {
        const value = (node as Record<string, unknown>)[key];
        if (value !== undefined) queue.push(value);
      }
    }
  }
  return [];
}

export async function readCalendarWindow(execute: Execute, accountId: string, userId: string, from: string, to: string) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 30 * 86_400_000) throw new Error('Calendar range must be within 30 days');
  const data = await execute('GOOGLECALENDAR_EVENTS_LIST', accountId, userId, {
    calendarId: 'primary', timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(),
    singleEvents: true, orderBy: 'startTime', maxResults: 10,
  });
  return listItems(data, ['items', 'events', 'data', 'response_data', 'result']).slice(0, 10).map((event) => {
    const startValue = record(event.start);
    const endValue = record(event.end);
    return { id: string(event.id), summary: string(event.summary), start: string(startValue.dateTime || startValue.date), end: string(endValue.dateTime || endValue.date) };
  });
}

/**
 * Composio's GMAIL_FETCH_EMAILS returns `messageId`, `sender`, `messageTimestamp` and a `preview`
 * object rather than Gmail's raw `id`/`from`/`snippet`; accept both shapes. `max_results` must be
 * explicit: Composio defaults it to 1 and silently drops unknown argument names.
 */
export async function searchMailbox(execute: Execute, accountId: string, userId: string, query: string) {
  if (!query.trim() || query.length > 120) throw new Error('Gmail query must be between 1 and 120 characters');
  const data = await execute('GMAIL_FETCH_EMAILS', accountId, userId, {
    user_id: 'me', query: query.trim(), max_results: 5, include_payload: false, verbose: false,
  });
  return listItems(data, ['messages', 'emails', 'items', 'data', 'response_data', 'result']).slice(0, 5).map((message) => {
    const preview = record(message.preview);
    const labels = Array.isArray(message.labelIds) ? message.labelIds.filter((label): label is string => typeof label === 'string') : [];
    return {
      id: string(message.messageId) ?? string(message.id),
      threadId: string(message.threadId),
      subject: string(message.subject) ?? string(preview.subject),
      snippet: string(preview.body) ?? string(message.snippet) ?? string(message.messageText),
      from: string(message.sender) ?? string(message.from),
      receivedAt: string(message.messageTimestamp),
      unread: labels.includes('UNREAD'),
    };
  });
}
