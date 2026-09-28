'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const SLOW_MS = 10_000;
const FAST_MS = 1_500;
const FAST_FOR_MS = 60_000;

/**
 * Follow-ups are decided and written on the server (lib/agent/follow-ups.ts); the open page only watches.
 * It polls a light endpoint while visible, faster for a minute after something that may earn a message
 * (the page opened, a call ended, an account connected), and reloads the conversation when it changed.
 * `writing` is true while the server writes a follow-up, for the typing dots. Paused while a reply
 * streams, which reloads the conversation itself.
 */
export function useFollowUps(refresh: () => Promise<unknown>, paused: boolean) {
  const [writing, setWriting] = useState(false);
  const seq = useRef<number | undefined>(undefined);
  const fastUntil = useRef(0);
  const wake = useRef(true);
  const pausedRef = useRef(paused);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tickRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const schedule = useCallback((delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void tickRef.current(), delay);
  }, []);

  useEffect(() => {
    tickRef.current = async () => {
      if (document.hidden) return;
      const waking = wake.current;
      wake.current = false;
      try {
        const response = await fetch(`/api/agent/updates${waking ? '?wake=1' : ''}`, { cache: 'no-store' });
        if (response.ok) {
          const update = await response.json() as { seq: number; writing: boolean };
          setWriting(update.writing);
          if (update.writing) fastUntil.current = Math.max(fastUntil.current, Date.now() + 15_000);
          if (!pausedRef.current) {
            if (update.seq !== seq.current) await refresh();
            seq.current = update.seq;
          }
        }
      } catch { /* offline for a moment: the next poll catches up */ }
      schedule(Date.now() < fastUntil.current ? FAST_MS : SLOW_MS);
    };
  }, [refresh, schedule]);

  /** Something just happened that may earn a follow-up: settle it now and watch closely for a minute. */
  const expect = useCallback(() => {
    wake.current = true;
    fastUntil.current = Date.now() + FAST_FOR_MS;
    schedule(0);
  }, [schedule]);

  useEffect(() => {
    const onVisible = () => { if (!document.hidden) expect(); };
    document.addEventListener('visibilitychange', onVisible);
    expect();
    return () => { document.removeEventListener('visibilitychange', onVisible); clearTimeout(timer.current); };
  }, [expect]);

  return { writing, expect };
}
