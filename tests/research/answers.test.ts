import { describe, expect, it } from 'vitest';
import { researchMatchedPerson } from '../../lib/research/answers';

describe('task-relevant Context.dev research', () => {
  it('requests only a small professional-context answer after a confident match', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchFn = async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.context.dev/v1/web/answers');
      body = JSON.parse(String(init?.body));
      return Response.json({ json_content: { role: 'Founder', company_summary: 'Analytics software for retailers.' }, sources: ['https://northstar.example/team', 'https://northstar.example/about'], partial: false });
    };
    const result = await researchMatchedPerson({ status: 'matched_for_research', score: .97, name: 'Jordan Lee', company: 'Northstar Analytics', sourceUrl: 'https://northstar.example/team' }, 'secret', fetchFn as typeof fetch);
    expect(body).toMatchObject({ mode: 'fast', json_format: { role: '', company_summary: '' } });
    expect(String(body?.task)).toContain('Jordan Lee');
    expect(result).toEqual({ role: 'Founder', companySummary: 'Analytics software for retailers.', sources: ['https://northstar.example/team', 'https://northstar.example/about'], partial: false });
  });

  it('does not research an uncertain candidate or accept an unsourced answer', async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return Response.json({ json_content: { role: 'CEO' }, sources: [] }); };
    expect(await researchMatchedPerson({ status: 'candidate', score: .7 }, 'secret', fetchFn as typeof fetch)).toBeNull();
    expect(calls).toBe(0);
    expect(await researchMatchedPerson({ status: 'matched_for_research', score: .97, name: 'Jordan Lee', company: 'Northstar Analytics', sourceUrl: 'https://northstar.example/team' }, 'secret', fetchFn as typeof fetch)).toBeNull();
  });
});
