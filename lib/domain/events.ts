export type Toolkit = 'gmail' | 'calendar';

/**
 * Why a call stopped. The client reports what it observed; `lost` is inferred on the server when a
 * call lease expires without any end report (a closed tab or a crashed browser).
 */
export type CallEndReason =
  | 'user_hangup' | 'remote_hangup' | 'connection_lost' | 'inactive' | 'max_duration'
  | 'expired' | 'content' | 'page_closed' | 'lost' | 'setup_failed';

export type SessionEvent =
  | { id: string; at: string; type: 'message'; speaker: 'user' | 'assistant'; channel: 'text' | 'voice'; text: string; origin?: 'greeting' | 'follow_up' | 'automation' }
  | { id: string; at: string; type: 'fact'; key: string; value: string; evidence: 'tentative' | 'confirmed' | 'declined'; provenance: 'user_said' | 'tool_observed' | 'assistant_inferred' | 'user_confirmed'; sourceEventId: string; sourceUrl?: string }
  | { id: string; at: string; type: 'call'; phase: 'offered' | 'accepted' | 'started' | 'ended' | 'declined' | 'dropped'; callId?: string; reason?: CallEndReason }
  | { id: string; at: string; type: 'voice_fragment'; text: string; final: boolean; callId?: string; speaker?: 'user' | 'assistant'; startMs?: number; endMs?: number }
  | { id: string; at: string; type: 'connection'; toolkit: Toolkit; phase: 'offered' | 'declined' | 'connected' | 'failed' | 'disconnected'; reason?: string }
  | { id: string; at: string; type: 'decision'; trigger: string; outcome: 'messaged' | 'silent' }
  | { id: string; at: string; type: 'automation'; automationId: string; phase: 'proposed' | 'approved' | 'declined' | 'disabled' | 'ran' | 'failed'; title: string; schedule: string; instruction?: string; nextRunAt?: string; runId?: string }
  /** A read of a connected account during a turn or call; `items` is how much it found. */
  | { id: string; at: string; type: 'account_read'; toolkit: Toolkit; items: number }
  /** An app other than Gmail or Calendar was connected from the Apps sheet; the assistant can't act in it yet. */
  | { id: string; at: string; type: 'app_connection'; app: string; name: string; phase: 'connected' | 'disconnected' | 'failed' }
  /** The user came back to the conversation after a gap. */
  | { id: string; at: string; type: 'visit' };
