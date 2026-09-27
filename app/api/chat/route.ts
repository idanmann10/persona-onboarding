import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createChatHandler } from '@/lib/http/chat';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { projectSession } from '@/lib/domain/project';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_TEXT_MODEL) {
    return new Response('Text model is not configured', { status: 503 });
  }
  try {
    const handler = createChatHandler(createStore(getDatabase()), (history) => {
      const state = projectSession(history);
      const messages = state.messages.map((message) => ({ role: message.speaker, content: message.text }));
      const currentTask = state.messages.filter((message) => message.speaker === 'user').at(-1)?.text;
      const facts = Object.entries(state.facts).map(([key, fact]) => ({ key, value: fact.value, provenance: 'user_said', evidence: fact.evidence }));
      return streamText({
        model: openai(process.env.OPENAI_TEXT_MODEL!),
        system: buildSystemPrompt({ currentTask, facts, capabilities: ['text'], voiceFragments: state.voiceFragments.map((fragment) => ({ speaker: fragment.speaker, text: fragment.text })) }),
        messages,
      }).textStream;
    });
    return await handler(request);
  } catch (error) {
    console.error('Chat request failed', error);
    return new Response('Chat service unavailable', { status: 503 });
  }
}
