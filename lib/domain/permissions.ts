import type { IdentityStatus } from './knowledge';

export type ActionType = 'gmail_read' | 'gmail_send' | 'calendar_read' | 'calendar_write' | 'browser_call' | 'research_person' | 'claim_completed';

export interface ActionRequest {
  type: ActionType;
  actionId: string;
  previewHash?: string;
}

export interface PermissionContext {
  connected: Array<'gmail' | 'calendar'>;
  confirmations: Array<{ actionId: string; previewHash?: string }>;
  successfulActions?: string[];
  identityStatus?: IdentityStatus;
}

export function authorizeAction(action: ActionRequest, context: PermissionContext): { allowed: boolean; reason?: string } {
  if (action.type === 'claim_completed') {
    return context.successfulActions?.includes(action.actionId)
      ? { allowed: true }
      : { allowed: false, reason: 'No successful matching tool result' };
  }
  if (action.type === 'research_person') {
    return context.identityStatus === 'matched_for_research'
      ? { allowed: true }
      : { allowed: false, reason: 'Identity is not confidently matched' };
  }
  if (action.type.startsWith('gmail') && !context.connected.includes('gmail')) {
    return { allowed: false, reason: 'Gmail is not connected' };
  }
  if (action.type.startsWith('calendar') && !context.connected.includes('calendar')) {
    return { allowed: false, reason: 'Calendar is not connected' };
  }
  if (action.type === 'gmail_read' || action.type === 'calendar_read') return { allowed: true };
  if (action.type === 'gmail_send' || action.type === 'calendar_write') {
    if (!action.previewHash) return { allowed: false, reason: 'No preview was recorded' };
    return context.confirmations.some((confirmation) =>
      confirmation.actionId === action.actionId && confirmation.previewHash === action.previewHash,
    ) ? { allowed: true } : { allowed: false, reason: 'Exact preview is not confirmed' };
  }
  return context.confirmations.some((confirmation) => confirmation.actionId === action.actionId)
    ? { allowed: true }
    : { allowed: false, reason: 'Call was not accepted' };
}
