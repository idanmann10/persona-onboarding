'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { CallSpeaker } from './use-call-feed';

type Levels = Record<CallSpeaker, number>;

export interface VoiceLevels {
  /** Smoothed loudness of each side, 0 to 1, updated every animation frame. */
  current: Levels;
  /** Recent samples, oldest first, for the scrolling waveform. */
  history: Levels[];
}

const SPEAKERS: CallSpeaker[] = ['user', 'assistant'];
const FFT_SIZE = 1024;
const HISTORY = 160;
/**
 * Above this a side counts as speaking; it keeps the label for a short hold so pauses between words don't
 * flicker it. The mic side needs a louder, held sound (about -38 dB for 200 ms), so a fan, a keyboard or a
 * cough doesn't read as "You're speaking".
 */
const SPEAKING: Record<CallSpeaker, number> = { user: 0.46, assistant: 0.32 };
const USER_SUSTAIN_MS = 200;
const HOLD_MS = 450;

/** RMS to 0..1 on a decibel scale: -60 dB (room tone) is silent, -12 dB is a loud voice. */
const loudness = (rms: number) => Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 60) / 48));

function useAnalyser(context: MutableRefObject<AudioContext | null>, analysers: MutableRefObject<Partial<Record<CallSpeaker, AnalyserNode>>>, speaker: CallSpeaker, stream?: MediaStream) {
  useEffect(() => {
    const audio = context.current;
    if (!audio || !stream?.getAudioTracks().length) return;
    // Analysed only, never connected to the speakers: the call's own <audio> element plays the voice.
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser);
    analysers.current[speaker] = analyser;
    return () => {
      try { source.disconnect(); } catch { /* the context is already closed */ }
      if (analysers.current[speaker] === analyser) delete analysers.current[speaker];
    };
  }, [context, analysers, speaker, stream]);
}

/**
 * Live loudness of the user's microphone and the assistant's voice, read with Web Audio AnalyserNodes.
 * Levels live in a ref and are pushed to subscribers every frame, so drawing never re-renders React;
 * only the "who is speaking" label is state.
 */
export function useVoiceLevels(streams: Partial<Record<CallSpeaker, MediaStream>>, reducedMotion: boolean) {
  const levels = useRef<VoiceLevels>({ current: { user: 0, assistant: 0 }, history: [] });
  const listeners = useRef(new Set<() => void>());
  const context = useRef<AudioContext | null>(null);
  const analysers = useRef<Partial<Record<CallSpeaker, AnalyserNode>>>({});
  const [speaking, setSpeaking] = useState<CallSpeaker | null>(null);

  useEffect(() => {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const audio = new Context();
    context.current = audio;
    // Made just after the tap that started the call; a browser that still holds it suspended lets it run on the next tap.
    const resume = () => { if (audio.state === 'suspended') void audio.resume().catch(() => undefined); };
    resume();
    window.addEventListener('pointerdown', resume, true);
    return () => {
      window.removeEventListener('pointerdown', resume, true);
      context.current = null;
      analysers.current = {};
      void audio.close().catch(() => undefined);
    };
  }, []);

  useAnalyser(context, analysers, 'user', streams.user);
  useAnalyser(context, analysers, 'assistant', streams.assistant);

  useEffect(() => {
    const buffer = new Float32Array(FFT_SIZE);
    const loudAt: Levels = { user: -Infinity, assistant: -Infinity };
    const loudSince: Partial<Record<CallSpeaker, number>> = {};
    let frame = 0;
    let sampledAt = 0;
    let shown: CallSpeaker | null = null;
    const tick = (time: number) => {
      const { current, history } = levels.current;
      for (const speaker of SPEAKERS) {
        const analyser = analysers.current[speaker];
        let target = 0;
        if (analyser) {
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (const value of buffer) sum += value * value;
          target = loudness(Math.sqrt(sum / buffer.length));
        }
        // Fast attack, slow release: syllables pop, pauses fade.
        current[speaker] += (target - current[speaker]) * (target > current[speaker] ? 0.5 : 0.14);
        if (current[speaker] > SPEAKING[speaker]) {
          loudSince[speaker] ??= time;
          if (speaker === 'assistant' || time - loudSince[speaker]! >= USER_SUSTAIN_MS) loudAt[speaker] = time;
        } else loudSince[speaker] = undefined;
      }
      if (time - sampledAt >= (reducedMotion ? 150 : 70)) {
        history.push({ ...current });
        if (history.length > HISTORY) history.shift();
        sampledAt = time;
      }
      const user = time - loudAt.user < HOLD_MS;
      const assistant = time - loudAt.assistant < HOLD_MS;
      const who = user && assistant ? (current.user > current.assistant ? 'user' : 'assistant') : user ? 'user' : assistant ? 'assistant' : null;
      if (who !== shown) { shown = who; setSpeaking(who); }
      listeners.current.forEach((listener) => listener());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion]);

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  return { levels: levels.current, subscribe, speaking };
}
