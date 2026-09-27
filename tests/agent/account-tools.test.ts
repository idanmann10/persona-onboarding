import { describe, expect, it } from 'vitest';
import { accountReadRelevant } from '../../lib/agent/account-tools';

describe('need-led account tool exposure', () => {
  it('offers a narrow account read only for a relevant current user request', () => {
    expect(accountReadRelevant('calendar', 'Can you help me plan my week around meetings?')).toBe(true);
    expect(accountReadRelevant('gmail', 'Summarize my unread email from Alex')).toBe(true);
    expect(accountReadRelevant('calendar', 'I feel overwhelmed today')).toBe(false);
    expect(accountReadRelevant('gmail', 'I am Jordan Lee at Northstar')).toBe(false);
  });
});
