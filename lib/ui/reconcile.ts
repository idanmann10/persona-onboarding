export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string };

export function reconcileFailedTurn(messages: ChatMessage[], id: string, draft: string): { messages: ChatMessage[]; input: string } {
  return { messages, input: messages.some((message) => message.id === id) ? '' : draft };
}
