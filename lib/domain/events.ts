export type Toolkit = 'gmail' | 'calendar';

/**
 * Why a call stopped. The client reports what it observed; `lost` is inferred on the server when a
 * call lease expires without any end report (a closed tab or a crashed browser). `goodbye` is the
 * assistant hanging up after a natural goodbye.
 */
export type CallEndReason =
  | 'user_hangup' | 'remote_hangup' | 'connection_lost' | 'inactive' | 'max_duration'
  | 'expired' | 'content' | 'page_closed' | 'lost' | 'setup_failed' | 'goodbye';

/** The brief's setup items: a name for the assistant (in text), and the rest, attempted on a call. */
export type SetupItem = 'assistant_name' | 'preferred_name' | 'need' | 'gmail' | 'call';
export const SETUP_ITEMS: readonly SetupItem[] = ['assistant_name', 'preferred_name', 'need', 'gmail', 'call'];

export type Provenance = 'user_said' | 'tool_observed' | 'assistant_inferred' | 'user_confirmed';
export type AgentName = 'assistant' | 'memory';

/** What a memory is about. `routine` is how they do something ("invoices go out on the 1st"). */
export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'person', 'need', 'routine', 'context'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
/** Where a memory came from: their own words (typed or on a call), or content the assistant read. */
export type MemorySource = 'user' | 'call' | 'email' | 'calendar' | 'web';

export type SessionEvent =
  | { id: string; at: string; type: 'message'; speaker: 'user' | 'assistant'; channel: 'text' | 'voice'; text: string; origin?: 'greeting' | 'follow_up' | 'automation' }
  | { id: string; at: string; type: 'fact'; key: string; value: string; evidence: 'tentative' | 'confirmed' | 'declined'; provenance: Provenance; sourceEventId: string; sourceUrl?: string }
  | { id: string; at: string; type: 'call'; phase: 'offered' | 'accepted' | 'started' | 'ended' | 'declined' | 'dropped'; callId?: string; reason?: CallEndReason }
  | { id: string; at: string; type: 'voice_fragment'; text: string; final: boolean; callId?: string; speaker?: 'user' | 'assistant'; startMs?: number; endMs?: number }
  | { id: string; at: string; type: 'connection'; toolkit: Toolkit; phase: 'offered' | 'declined' | 'connected' | 'failed' | 'disconnected'; reason?: string }
  /** Retired: the browser-driven follow-ups recorded their outcome here. Kept so older sessions still read. */
  | { id: string; at: string; type: 'decision'; trigger: string; outcome: 'messaged' | 'silent' }
  | { id: string; at: string; type: 'automation'; automationId: string; phase: 'proposed' | 'approved' | 'declined' | 'disabled' | 'ran' | 'failed'; title: string; schedule: string; instruction?: string; nextRunAt?: string; runId?: string }
  /** A read of a connected account during a turn or call; `items` is how much it found. */
  | { id: string; at: string; type: 'account_read'; toolkit: Toolkit; items: number }
  /** An app other than Gmail or Calendar was connected from the Apps sheet; the assistant can't act in it yet. */
  | { id: string; at: string; type: 'app_connection'; app: string; name: string; phase: 'connected' | 'disconnected' | 'failed' }
  /** The user came back to the conversation after a gap. */
  | { id: string; at: string; type: 'visit' }
  /** The user chose to skip the rest of setup and get started. */
  | { id: string; at: string; type: 'onboarding'; phase: 'graduated'; reason?: string }
  /** A line an agent added to its own soul for this user ("keep it to one line in the morning"). Style only. */
  | { id: string; at: string; type: 'soul_note'; agent: AgentName; text: string; source: string }
  /** Retired: the first untyped memory notes. Still projected, as memories, so older sessions keep what they knew. */
  | { id: string; at: string; type: 'note'; text: string; kind: 'need' | 'preference' | 'fact' | 'context'; source: MemorySource; provenance: Provenance }
  /**
   * A durable memory: one plain line, typed and labeled, with where it came from and how sure we are.
   * `replaces` names the memories it merges or corrects; those stop being recalled but stay in the log.
   * Memories from email, calendar or the web are data about the world, never instructions.
   */
  | { id: string; at: string; type: 'memory'; memoryId: string; text: string; kind: MemoryKind; labels: string[]; confidence: 'low' | 'medium' | 'high'; source: MemorySource; provenance: Provenance; sourceEventId: string; by: AgentName; replaces?: string[] }
  /** A memory dropped ("forget that", or no longer true). A tombstone: kept for the record, never recalled again. */
  | { id: string; at: string; type: 'forget'; memoryId: string; reason: string; by: AgentName }
  /** A short tag about the user for tone ("founder", "prefers text"). Never used for permissions. */
  | { id: string; at: string; type: 'label'; label: string; action: 'add' | 'remove'; confidence: 'low' | 'medium' | 'high'; evidence: string; provenance: Provenance }
  /** Something left open: a promise the assistant made, or a thought the user didn't finish. */
  | { id: string; at: string; type: 'loop'; loopId: string; action: 'open' | 'close'; text: string }
  /**
   * The rolling summary of the conversation's older lines. `lines` is the watermark: lines before it are
   * folded into the summary and the prompt replays the rest verbatim.
   */
  | { id: string; at: string; type: 'summary'; text: string; lines: number }
  /** How far the memory has read (conversation lines), so each run only reads what's new. */
  | { id: string; at: string; type: 'memory_run'; lines: number }
  /**
   * What came of an app event that woke the assistant (a call ended, an account connected, a check-in came
   * due): it wrote a follow-up, or stayed quiet with a reason. `guard` is a code guardrail that decided
   * before the model ran (quiet hours, the daily cap, a live call, "stop").
   */
  | { id: string; at: string; type: 'follow_up'; trigger: string; outcome: 'messaged' | 'quiet'; reason: string; guard?: string }
  /** A check-in the assistant (or quiet hours) scheduled; only the newest counts, and a reply from the user cancels it. */
  | { id: string; at: string; type: 'check_in'; wakeAt: string; reason: string };
