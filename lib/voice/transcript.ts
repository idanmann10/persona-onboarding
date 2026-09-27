import type { SessionEvent } from '../domain/events';

type Fragment = Extract<SessionEvent, { type: 'voice_fragment' }>;

export interface Utterance {
  callId: string;
  speaker: 'user' | 'assistant';
  text: string;
  startMs: number;
  endMs: number;
}

const BACKCHANNEL = /^(?:m+-?hm+|uh-?huh|yeah|yep|right|okay|ok|sure|got it|i see)[.!]?$/i;

/**
 * Group one call's transcript fragments into speaker turns. GPT-Live deltas carry no turn marker, so
 * a turn is a run of one speaker in timeline order. A short acknowledgement sandwiched inside the other
 * speaker's run ("mm-hmm" while the caller keeps talking) is folded away so the caller's thought stays
 * one bubble. The original fragments remain the evidence; this is a derived view.
 */
export function groupUtterances(fragments: Fragment[]): Utterance[] {
  const byCall = new Map<string, Array<{ fragment: Fragment; order: number }>>();
  fragments.forEach((fragment, order) => {
    if (!fragment.callId || !fragment.speaker || !fragment.text) return;
    const list = byCall.get(fragment.callId) ?? [];
    list.push({ fragment, order });
    byCall.set(fragment.callId, list);
  });
  const result: Utterance[] = [];
  for (const [callId, list] of byCall) {
    list.sort((a, b) => (a.fragment.startMs ?? Number.MAX_SAFE_INTEGER) - (b.fragment.startMs ?? Number.MAX_SAFE_INTEGER) || a.order - b.order);
    const runs: Utterance[] = [];
    for (const { fragment } of list) {
      const speaker = fragment.speaker!;
      const startMs = fragment.startMs ?? runs.at(-1)?.endMs ?? 0;
      const endMs = fragment.endMs ?? startMs;
      const last = runs.at(-1);
      if (last && last.speaker === speaker) {
        last.text += fragment.text;
        last.endMs = Math.max(last.endMs, endMs);
      } else runs.push({ callId, speaker, text: fragment.text, startMs, endMs });
    }
    for (let i = 1; i < runs.length - 1; i++) {
      const [before, middle, after] = [runs[i - 1], runs[i], runs[i + 1]];
      if (before.speaker === after.speaker && middle.speaker !== before.speaker && BACKCHANNEL.test(middle.text.trim())) {
        before.text += after.text;
        before.endMs = Math.max(before.endMs, after.endMs);
        runs.splice(i, 2);
        i -= 1;
      }
    }
    for (const run of runs) {
      const text = run.text.replace(/\s+/g, ' ').trim();
      if (text) result.push({ ...run, text });
    }
  }
  return result;
}
