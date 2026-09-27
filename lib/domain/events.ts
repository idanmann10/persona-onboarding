export type Toolkit = 'gmail' | 'calendar';

/**
 * Why a call stopped. The client reports what it observed; `lost` is inferred on the server when a
 * call lease expires without any end report (a closed tab or a crashed browser).
 */
export type CallEndReason =
  | 'user_hangup' | 'remote_hangup' | 'connection_lost' | 'inactive' | 'max_duration'
  | 'expired' | 'content' | 'page_closed' | 'lost' | 'setup_failed';

export type SessionEvent =
  | { id: string; at: string; type: 'message'; speaker: 'user' | 'assistant'; channel: 'text' | 'voice'; text: string; origin?: 'greeting' | 'follow_up' }
  | { id: string; at: string; type: 'fact'; key: string; value: string; evidence: 'tentative' | 'confirmed' | 'declined'; provenance: 'user_said' | 'tool_observed' | 'assistant_inferred' | 'user_confirmed'; sourceEventId: string; sourceUrl?: string }
  | { id: string; at: string; type: 'call'; phase: 'offered' | 'accepted' | 'started' | 'ended' | 'declined' | 'dropped'; callId?: string; reason?: CallEndReason }
  | { id: string; at: string; type: 'voice_fragment'; text: string; final: boolean; callId?: string; speaker?: 'user' | 'assistant'; startMs?: number; endMs?: number }
  | { id: string; at: string; type: 'connection'; toolkit: Toolkit; phase: 'offered' | 'declined' | 'connected' | 'failed' | 'disconnected'; reason?: string }
  | { id: string; at: string; type: 'decision'; trigger: string; outcome: 'messaged' | 'silent' };
