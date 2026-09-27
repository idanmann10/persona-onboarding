export type SessionEvent =
  | { id: string; at: string; type: 'message'; speaker: 'user' | 'assistant'; channel: 'text' | 'voice'; text: string }
  | { id: string; at: string; type: 'fact'; key: string; value: string; evidence: 'tentative' | 'confirmed' | 'declined'; sourceEventId: string }
  | { id: string; at: string; type: 'call'; phase: 'offered' | 'accepted' | 'started' | 'ended' | 'declined' | 'dropped' }
  | { id: string; at: string; type: 'voice_fragment'; text: string; final: boolean };
