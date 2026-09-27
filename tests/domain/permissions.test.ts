import { describe, expect, it } from 'vitest';
import { authorizeAction } from '../../lib/domain/permissions';

describe('server action authorization', () => {
  it('denies Gmail writes without exact preview confirmation and a connection', () => {
    const send = { type: 'gmail_send' as const, actionId: 'send-1', previewHash: 'content-a' };
    expect(authorizeAction(send, { connected: ['gmail'], confirmations: [] }).allowed).toBe(false);
    expect(authorizeAction(send, { connected: [], confirmations: [{ actionId: 'send-1', previewHash: 'content-a' }] }).allowed).toBe(false);
    expect(authorizeAction(send, { connected: ['gmail'], confirmations: [{ actionId: 'send-1', previewHash: 'content-b' }] }).allowed).toBe(false);
    expect(authorizeAction(send, { connected: ['gmail'], confirmations: [{ actionId: 'send-1', previewHash: 'content-a' }] }).allowed).toBe(true);
  });

  it('does not treat a general yes as consent to call or account writes', () => {
    expect(authorizeAction({ type: 'browser_call', actionId: 'call-1' }, { connected: [], confirmations: [{ actionId: 'other-action' }] }).allowed).toBe(false);
  });

  it('requires a tool success record before claiming a write completed', () => {
    expect(authorizeAction({ type: 'claim_completed', actionId: 'send-1' }, { connected: ['gmail'], confirmations: [], successfulActions: [] }).allowed).toBe(false);
    expect(authorizeAction({ type: 'claim_completed', actionId: 'send-1' }, { connected: ['gmail'], confirmations: [], successfulActions: ['send-1'] }).allowed).toBe(true);
  });

  it('denies research until the identity reaches matched_for_research', () => {
    expect(authorizeAction({ type: 'research_person', actionId: 'r1' }, { connected: [], confirmations: [], identityStatus: 'candidate' }).allowed).toBe(false);
    expect(authorizeAction({ type: 'research_person', actionId: 'r1' }, { connected: [], confirmations: [], identityStatus: 'matched_for_research' }).allowed).toBe(true);
  });
});
