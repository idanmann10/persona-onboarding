import type { z } from 'zod';
import type { SessionEvent, Toolkit } from '../../domain/events';
import type { SessionProjection } from '../../domain/project';
import type { AutomationStore } from '../../domain/automation';
import type { AvatarResult } from '../../avatars/generate';
import type { AccountReadClient } from './accounts';

export interface ToolStore {
  appendEvent(id: string, event: SessionEvent): Promise<void>;
}

/**
 * Everything a tool needs to decide whether it may run. The model chooses to call a tool; this context,
 * built by server code from durable state, decides what is allowed. Text turns and call tools build it
 * the same way (lib/agent/tools/context.ts).
 */
export interface ToolContext {
  store: ToolStore;
  sessionId: string;
  channel: 'text' | 'voice';
  /** Stable ID of the turn or function call that asked; makes every write idempotent. */
  turnId: string;
  /** What woke the turn when it wasn't a user message (a follow-up, a recurring task run). */
  trigger?: string;
  state: SessionProjection;
  /** The user's own recent words (typed or spoken), newest last. The only evidence for `user_said`. */
  userWords: string[];
  capabilities: { voice: boolean; gmail: boolean; calendar: boolean };
  /** Connected account ids; a read needs one. */
  accounts: Partial<Record<Toolkit, string>>;
  /** Accounts this request is about, so reads happen only when relevant. */
  relevant: Toolkit[];
  composio?: AccountReadClient;
  /** Present when recurring tasks are available (Postgres-backed). */
  automations?: Pick<AutomationStore, 'proposeAutomation'>;
  /** Present when a described look can be painted (an OpenAI key and Postgres). */
  avatars?: {
    generate(input: { name: string; description: string }): Promise<AvatarResult>;
    save(sessionId: string, avatar: { id: string; prompt: string; mime: string; bytes: Uint8Array }): Promise<void>;
  };
  /** The public identity check, bound to the user's latest message (lib/research). */
  resolveIdentity?: (clue: { first: string; last: string; company: string }) => Promise<unknown>;
  now?: () => Date;
}

export type ToolResult = { status: string } & Record<string, unknown>;
export type ToolUi = { type: string; toolkit?: string };

/**
 * One tool, defined once: the schema and description every model sees, the server gate, and the
 * work. The text turn wraps it with the AI SDK, a call's delegation config gets its JSON schema, and
 * /api/voice/tool dispatches to the same `execute` (lib/agent/tools/index.ts).
 */
export interface AgentTool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: Input;
  channels: ReadonlyArray<'text' | 'voice'>;
  /** Whether a text turn's model sees the tool now. `execute` re-checks everything, so this is a hint, not the gate. */
  offered?(ctx: ToolContext): boolean;
  /** Whether a call offers it; decided when the call starts, from what this deployment can do. */
  onCall?(capabilities: ToolContext['capabilities']): boolean;
  execute(ctx: ToolContext, input: z.infer<Input>): Promise<ToolResult>;
  /** What the page should refresh after a call used this tool (a card appeared, the look changed). */
  voiceUi?(result: ToolResult, input: z.infer<Input>): ToolUi | undefined;
}

export const defineTool = <Input extends z.ZodType>(tool: AgentTool<Input>): AgentTool<Input> => tool;
