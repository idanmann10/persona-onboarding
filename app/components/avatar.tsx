'use client';

import { useEffect, useRef, useState } from 'react';

/** Shown when the session has no `avatarUrl` yet. */
export const DEFAULT_AVATAR_URL = '/avatars/default.webp';

/** The image candidates to try in order: the assistant's own photo, then the default one. */
export function avatarCandidates(src?: string): string[] {
  const own = src?.trim();
  return own && own !== DEFAULT_AVATAR_URL ? [own, DEFAULT_AVATAR_URL] : [DEFAULT_AVATAR_URL];
}

export function avatarInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? 'P').toUpperCase();
}

/**
 * The assistant's round photo. Falls back to the default photo, then to a neutral circle
 * with the assistant's initial when no image loads.
 */
export function Avatar({ src, name, size = 36, className = '' }: { src?: string; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const imageRef = useRef<HTMLImageElement>(null);
  const current = avatarCandidates(src).find((url) => !failed.includes(url));

  // An image that failed before hydration never fires onError in React: check once mounted.
  useEffect(() => {
    const image = imageRef.current;
    if (current && image && image.complete && image.naturalWidth === 0) setFailed((list) => list.includes(current) ? list : [...list, current]);
  }, [current]);

  const style = { width: size, height: size };
  if (!current) {
    return <span className={`avatar avatar-fallback ${className}`.trim()} style={{ ...style, fontSize: Math.round(size * 0.44) }} aria-hidden="true">{avatarInitial(name)}</span>;
  }
  return (
    <img ref={imageRef} key={current} className={`avatar ${className}`.trim()} src={current} alt="" width={size} height={size} style={style} draggable={false}
      onError={() => setFailed((list) => list.includes(current) ? list : [...list, current])} />
  );
}
