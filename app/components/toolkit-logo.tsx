import type { Toolkit } from '@/lib/domain/events';

/** The same logos the Apps sheet shows (Composio's), so a Connect card reads as that app at a glance. */
const LOGOS: Record<Toolkit, string> = {
  gmail: 'https://logos.composio.dev/api/gmail',
  calendar: 'https://logos.composio.dev/api/googlecalendar',
};

export function ToolkitLogo({ toolkit, size }: { toolkit: Toolkit; size: number }) {
  // eslint-disable-next-line @next/next/no-img-element -- a small remote logo; next/image would need a remote pattern.
  return <img className="toolkit-logo" src={LOGOS[toolkit]} alt="" width={size} height={size} decoding="async" />;
}
