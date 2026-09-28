import { estimateTokens } from '../voice/tokens';

export { estimateTokens };

type Env = Record<string, string | undefined>;

/**
 * Token budgets for prompt assembly, one per section. The soul and the rules are fixed text, so they're
 * measured, not cut. Everything that grows with the relationship has a cap: memories are chosen best
 * first until theirs is spent, the rolling summary is clipped to its own, the replayed conversation is a
 * window with a hard cap (see lib/agent/conversation.ts), and one tool result can only be so big. The
 * pinned profile is small by construction and never cut. A call's seeded input uses the voice column.
 * Every turn's trace records what each section actually took, so drift shows up in the agent log.
 */
export const BUDGET = {
  text: { memories: 700, summary: 450, facts: 250, history: 6_000 },
  voice: { memories: 300, summary: 300, facts: 150, history: 3_000 },
  /** One tool result, as the model sees it (the trace keeps the full result). */
  toolResult: 2_000,
} as const;

export type Channel = keyof Pick<typeof BUDGET, 'text' | 'voice'>;

/**
 * When the replayed conversation gets folded into the rolling summary. It grows by append until it passes
 * `roll`, then everything but the newest `keep` is summarized, so between rolls the prompt's older part
 * stays put (cache-friendly) and a summary call happens every several turns, not every turn.
 * PERSONA_HISTORY_ROLL_TOKENS lowers the threshold to watch it happen.
 */
export function compactionBudget(env: Env = process.env) {
  const roll = Math.max(100, Number(env.PERSONA_HISTORY_ROLL_TOKENS) || 4_000);
  return { roll, rollLines: 40, keep: Math.round(roll * 0.35), keepLines: 12 };
}

/** Lines picked in order until the budget is spent (the first always fits, clipped if it must). */
export function withinBudget<T>(items: T[], render: (item: T) => string, budget: number): { lines: string[]; kept: T[]; tokens: number } {
  const lines: string[] = [];
  const kept: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const line = render(item);
    const cost = estimateTokens(line);
    if (tokens + cost > budget) {
      if (lines.length) break;
      const clipped = clipToTokens(line, budget);
      return { lines: [clipped], kept: [item], tokens: estimateTokens(clipped) };
    }
    lines.push(line);
    kept.push(item);
    tokens += cost;
  }
  return { lines, kept, tokens };
}

/** Text clipped to a budget on a word boundary. */
export function clipToTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  // ~4 characters a token for Latin text; one per character otherwise. Cut once, then trim to a word.
  const ascii = /^[\x00-\x7f]*$/.test(text);
  const cut = text.slice(0, Math.max(0, (ascii ? budget * 4 : budget) - 2));
  return `${cut.replace(/\s+\S*$/, '')}…`;
}
