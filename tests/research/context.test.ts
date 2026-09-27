import { describe, expect, it } from 'vitest';
import { lookupPersonCandidate } from '../../lib/research/context';

describe('Context.dev identity lookup', () => {
  const candidate = {
    match: { status: 'candidate', score: 97, person: {
      name: { full: 'Jordan Lee', first: 'Jordan', last: 'Lee' },
      current_role_status: 'present',
      current_role: { organization: { name: 'Northstar Analytics' } },
      social_urls: ['https://www.linkedin.com/in/jordan-lee/'],
    } }, request_id: 'req-1',
  };

  it('never queries from a lone name or an assistant inference', async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return Response.json(candidate); };
    expect(await lookupPersonCandidate({ first: 'Jordan', last: 'Lee', provenance: 'user_said' }, 'test-key', fetchFn)).toBeNull();
    expect(await lookupPersonCandidate({ first: 'Jordan', last: 'Lee', company: 'Northstar Analytics', provenance: 'assistant_inferred' }, 'test-key', fetchFn)).toBeNull();
    expect(calls).toBe(0);
  });

  it('promotes only a high-score matching current role with a person source URL', async () => {
    let body: unknown;
    const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json(candidate); };
    const result = await lookupPersonCandidate({ first: 'Jordan', last: 'Lee', company: 'Northstar Analytics', provenance: 'user_said' }, 'test-key', fetchFn);
    expect(body).toEqual({ name: { first: 'Jordan', last: 'Lee' }, company: { name: 'Northstar Analytics' } });
    expect(result?.status).toBe('matched_for_research');
    expect(result?.sourceUrl).toBe('https://www.linkedin.com/in/jordan-lee/');
    expect(result?.requestId).toBe('req-1');
  });

  it('stays a candidate when current company conflicts', async () => {
    const fetchFn = async () => Response.json({ ...candidate, match: { ...candidate.match, person: { ...candidate.match.person, current_role: { organization: { name: 'Different Co' } } } } });
    const result = await lookupPersonCandidate({ first: 'Jordan', last: 'Lee', company: 'Northstar Analytics', provenance: 'user_said' }, 'test-key', fetchFn);
    expect(result?.status).toBe('candidate');
  });
});
