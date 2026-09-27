import { describe, expect, it } from 'vitest';
import { isDirectIdentityClaim } from '../../lib/research/claim';

describe('identity claim gate', () => {
  const clue = { first: 'Jordan', last: 'Lee', company: 'Northstar Analytics' };
  it('accepts a direct first-person name and company assertion', () => {
    expect(isDirectIdentityClaim("I'm Jordan Lee, founder of Northstar Analytics.", clue)).toBe(true);
    expect(isDirectIdentityClaim('My name is Jordan Lee. I run Northstar Analytics.', clue)).toBe(true);
  });
  it('rejects third-person mentions, missing company, and negated claims', () => {
    expect(isDirectIdentityClaim('Jordan Lee runs Northstar Analytics.', clue)).toBe(false);
    expect(isDirectIdentityClaim("I'm Jordan Lee.", clue)).toBe(false);
    expect(isDirectIdentityClaim("I'm not Jordan Lee and I do not run Northstar Analytics.", clue)).toBe(false);
  });
});
