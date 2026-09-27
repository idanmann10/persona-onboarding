type Execute = (slug: 'GOOGLECALENDAR_EVENTS_LIST' | 'GMAIL_FETCH_EMAILS', accountId: string, userId: string, args: Record<string, unknown>) => Promise<unknown>;

const string = (value: unknown) => typeof value === 'string' ? value.slice(0, 300) : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

export async function readCalendarWindow(execute: Execute, accountId: string, userId: string, from: string, to: string) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 30 * 86_400_000) throw new Error('Calendar range must be within 30 days');
  const data = record(await execute('GOOGLECALENDAR_EVENTS_LIST', accountId, userId, {
    calendarId: 'primary', timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(),
    singleEvents: true, orderBy: 'startTime', maxResults: 10,
  }));
  const items = Array.isArray(data.items) ? data.items.slice(0, 10) : [];
  return items.map((item) => {
    const event = record(item);
    const startValue = record(event.start);
    const endValue = record(event.end);
    return { id: string(event.id), summary: string(event.summary), start: string(startValue.dateTime || startValue.date), end: string(endValue.dateTime || endValue.date) };
  });
}

export async function searchMailbox(execute: Execute, accountId: string, userId: string, query: string) {
  if (!query.trim() || query.length > 120) throw new Error('Gmail query must be between 1 and 120 characters');
  const data = record(await execute('GMAIL_FETCH_EMAILS', accountId, userId, {
    user_id: 'me', query: query.trim(), max_results: 5, include_payload: false, verbose: false,
  }));
  const messages = Array.isArray(data.messages) ? data.messages.slice(0, 5) : Array.isArray(data.emails) ? data.emails.slice(0, 5) : [];
  return messages.map((item) => {
    const message = record(item);
    return { id: string(message.id), subject: string(message.subject), snippet: string(message.snippet), from: string(message.from) };
  });
}
