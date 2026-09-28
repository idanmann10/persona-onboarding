import { readCalendarWindow, searchMailbox } from '../../integrations/reads';
import type { Toolkit } from '../../integrations/connections';

/** Gmail and Calendar reads: when a request is about an account, and the read itself. Used by search_gmail and read_calendar_window. */

const RELEVANT: Record<Toolkit, RegExp> = {
  // English plus the words people use in Spanish, French, German and Portuguese.
  calendar: /\b(calendar|schedule|meeting|meetings|appointment|availability|agenda|free time|this week|my week|next week|today.?s plan|tomorrow.?s plan|calendario|reuni[oó]n(es)?|cita|semana|calendrier|r[ée]union|rendez-vous|kalender|termin|besprechung|calend[aá]rio|reuni[aã]o)\b/i,
  gmail: /\b(gmail|email|emails|e-mail|mail|inbox|unread|message from|messages from|reply|replies|respond to|waiting on|thread|newsletters?|unsubscribe|correo|correos|bandeja|mensajes?|responder|courriel|courriels|posteingang|nachricht(en)?|caixa de entrada|mensagens?)\b/i,
};
const AFFIRMATION = /^\s*(yes|yeah|yep|sure|ok|okay|please|go ahead|do it|sounds good|let'?s do it|yes please|s[ií]|claro|dale|por favor|oui|d'accord|ja|gerne|sim|pode)\b/i;

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

/** Records a successful read and how much it found (the funnel's "saw something real" signal). */
export type ReadRecorder = (toolkit: Toolkit, items: number) => Promise<void>;

async function recorded(record: ReadRecorder | undefined, toolkit: Toolkit, items: unknown) {
  if (record) await record(toolkit, Array.isArray(items) ? items.length : 0).catch((error) => console.error('Read record failed', error));
}

export async function runCalendarRead(client: AccountReadClient, accountId: string, sessionId: string, input: { from: string; to: string }, record?: ReadRecorder) {
  try {
    const events = await readCalendarWindow(client.executeRead, accountId, sessionId, input.from, input.to);
    await recorded(record, 'calendar', events);
    return { status: 'ok', events };
  } catch (error) { console.error('Calendar read failed', error); return { status: 'unavailable' }; }
}

export async function runGmailSearch(client: AccountReadClient, accountId: string, sessionId: string, input: { query: string }, record?: ReadRecorder) {
  try {
    const messages = await searchMailbox(client.executeRead, accountId, sessionId, input.query);
    await recorded(record, 'gmail', messages);
    return { status: 'ok', messages };
  } catch (error) { console.error('Gmail read failed', error); return { status: 'unavailable' }; }
}
