import { describe, expect, it } from 'vitest';
import { reconcileFailedTurn } from '../../lib/ui/reconcile';

describe('failed text turn reconciliation', () => {
  it('restores the draft when the server did not save the user message', () => {
    expect(reconcileFailedTurn([], 'm1', 'Help me plan').input).toBe('Help me plan');
  });
  it('keeps the persisted user message when generation failed after saving it', () => {
    const messages = [{ id: 'm1', role: 'user' as const, text: 'Help me plan' }];
    expect(reconcileFailedTurn(messages, 'm1', 'Help me plan')).toEqual({ messages, input: '' });
  });
});
