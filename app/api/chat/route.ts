import { stepCountIs, streamText, tool, type ToolSet } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { createStore } from '@/lib/db/store';
import { getDatabase } from '@/lib/db/client';
import { createChatHandler } from '@/lib/http/chat';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { projectSession } from '@/lib/domain/project';
import { resolveIdentityClaim } from '@/lib/research/service';
import { createComposioClient } from '@/lib/integrations/composio';
import { createAccountTools } from '@/lib/agent/account-tools';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_TEXT_MODEL) {
    return new Response('Text model is not configured', { status: 503 });
  }
  try {
    const store = createStore(getDatabase());
    const handler = createChatHandler(store, async function* (history, sessionId) {
      const state = projectSession(history);
      const messages = state.messages.map((message) => ({ role: message.speaker, content: message.text }));
      const latestUser = state.messages.filter((message) => message.speaker === 'user').at(-1);
      const currentTask = latestUser?.text;
      const accounts = process.env.COMPOSIO_API_KEY ? {
        calendar: await store.getActiveConnection(sessionId, 'calendar'),
        gmail: await store.getActiveConnection(sessionId, 'gmail'),
      } : {};
      const facts = Object.entries(state.facts).filter(([key]) => key !== 'identity_lookup_status').map(([key, fact]) => ({ key, value: fact.value, provenance: fact.provenance, evidence: fact.evidence, sourceUrl: fact.sourceUrl }));
      const researchTools: ToolSet = process.env.CONTEXT_DEV_API_KEY ? {
        resolve_identity: tool({
          description: 'Check a directly stated first-person full name and company against a public Context.dev candidate. The server rejects weak or inferred claims.',
          inputSchema: z.object({ first: z.string().min(1), last: z.string().min(1), company: z.string().min(1) }),
          execute: async (clue) => {
            if (!latestUser) return { status: 'insufficient_evidence' };
            try { return await resolveIdentityClaim(store, sessionId, latestUser, clue, process.env.CONTEXT_DEV_API_KEY!); }
            catch (error) { console.error('Identity lookup failed', error); return { status: 'unavailable' }; }
          },
        }),
      } : {};
      const accountTools = process.env.COMPOSIO_API_KEY && currentTask
        ? createAccountTools(createComposioClient(process.env.COMPOSIO_API_KEY), sessionId, currentTask, accounts)
        : {};
      const result = streamText({
        model: openai(process.env.OPENAI_TEXT_MODEL!),
        system: buildSystemPrompt({ currentTask, facts, capabilities: ['text', ...(accounts.calendar ? ['connected calendar'] : []), ...(accounts.gmail ? ['connected Gmail'] : [])], voiceFragments: state.voiceFragments.map((fragment) => ({ speaker: fragment.speaker, text: fragment.text })) }),
        messages,
        tools: { ...researchTools, ...accountTools },
        stopWhen: stepCountIs(3),
      });
      for await (const chunk of result.textStream) yield chunk;
    });
    return await handler(request);
  } catch (error) {
    console.error('Chat request failed', error);
    return new Response('Chat service unavailable', { status: 503 });
  }
}
