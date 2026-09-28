'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ToolActivity, VoiceCallbacks } from '@/lib/voice/client';

export type CallSpeaker = 'user' | 'assistant';
export interface CallCaption { id: number; speaker: CallSpeaker; text: string; typed?: boolean; updatedAt: number }
export interface CallTool extends ToolActivity { updatedAt: number }

export interface CallFeedState {
  captions: CallCaption[];
  tools: CallTool[];
  audio: Partial<Record<CallSpeaker, MediaStream>>;
  /** Connect buttons the assistant put on screen during this call, by toolkit. */
  offers: string[];
}

export interface CallFeed {
  state: CallFeedState;
  /** Spread into the call's `VoiceCallbacks`. */
  callbacks: Required<Pick<VoiceCallbacks, 'onCaption' | 'onTool' | 'onAudio' | 'onToolUi'>>;
  /** A new call is starting: clears the last one. The signal cancels this call while it is still connecting. */
  begin(): AbortSignal;
  /** Cancel the call that is still connecting. */
  cancel(): void;
  /** Text the user typed into the call, shown with the spoken captions. */
  addTyped(text: string): void;
}

const EMPTY: CallFeedState = { captions: [], tools: [], audio: {}, offers: [] };
const CAPTION_LIMIT = 80;
/** A pause this long starts a new line for the same speaker, e.g. the assistant's answer after a tool ran. */
const NEW_LINE_AFTER_MS = 2_500;

/** Deltas carry their own spaces, except where one reply ends and the next begins ("check." + "Just"). */
const join = (left: string, right: string) => /[.!?…]$/.test(left) && /^[^\s.,!?;:)'"’”]/.test(right) ? `${left} ${right}` : left + right;

/** Everything the call screen shows about the call in progress: captions, tool activity and the two audio streams. */
export function useCallFeed(): CallFeed {
  const [state, setState] = useState<CallFeedState>(EMPTY);
  const nextId = useRef(0);
  const pending = useRef<AbortController | null>(null);

  const callbacks = useMemo<CallFeed['callbacks']>(() => ({
    onCaption: (fragment) => setState((current) => {
      const at = Date.now();
      const last = current.captions.at(-1);
      if (last && last.speaker === fragment.speaker && !last.typed && at - last.updatedAt < NEW_LINE_AFTER_MS) {
        return { ...current, captions: [...current.captions.slice(0, -1), { ...last, text: join(last.text, fragment.text), updatedAt: at }] };
      }
      const text = fragment.text.trimStart();
      if (!text) return current;
      return { ...current, captions: [...current.captions.slice(1 - CAPTION_LIMIT), { id: ++nextId.current, speaker: fragment.speaker, text, updatedAt: at }] };
    }),
    onTool: (activity) => setState((current) => ({
      ...current,
      tools: [...current.tools.filter((tool) => tool.id !== activity.id).slice(-9), { ...activity, updatedAt: Date.now() }],
    })),
    onAudio: (speaker, stream) => setState((current) => ({ ...current, audio: { ...current.audio, [speaker]: stream } })),
    onToolUi: (ui) => {
      const toolkit = ui.toolkit;
      if (ui.type !== 'connection_offer' || !toolkit) return;
      setState((current) => current.offers.includes(toolkit) ? current : { ...current, offers: [...current.offers, toolkit] });
    },
  }), []);

  const begin = useCallback(() => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState(EMPTY);
    return controller.signal;
  }, []);

  const cancel = useCallback(() => pending.current?.abort(), []);

  const addTyped = useCallback((text: string) => setState((current) => ({
    ...current,
    captions: [...current.captions.slice(1 - CAPTION_LIMIT), { id: ++nextId.current, speaker: 'user', text, typed: true, updatedAt: Date.now() }],
  })), []);

  return useMemo(() => ({ state, callbacks, begin, cancel, addTyped }), [state, callbacks, begin, cancel, addTyped]);
}
