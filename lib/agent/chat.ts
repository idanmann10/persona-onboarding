import type { SessionEvent } from '../domain/events';

interface Store {
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  readEvents(id: string): Promise<SessionEvent[]>;
}

export async function* runTextTurn(
  store: Store,
  sessionId: string,
  userEvent: SessionEvent,
  respond: (history: SessionEvent[]) => AsyncIterable<string>,
): AsyncGenerator<string> {
  if (userEvent.type !== 'message' || userEvent.speaker !== 'user') throw new Error('A user message is required');
  await store.appendEvent(sessionId, userEvent);
  const history = await store.readEvents(sessionId);
  const answerId = `answer:${userEvent.id}`;
  const existing = history.find((event) => event.id === answerId);
  if (existing?.type === 'message') {
    yield existing.text;
    return;
  }
  let answer = '';
  for await (const chunk of respond(history)) {
    answer += chunk;
    yield chunk;
  }
  if (answer.trim()) {
    await store.appendEvent(sessionId, {
      id: answerId,
      at: new Date().toISOString(),
      type: 'message',
      speaker: 'assistant',
      channel: 'text',
      text: answer,
    });
  }
}
