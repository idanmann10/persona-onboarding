import { describe, expect, it } from 'vitest';
import { clientAddress, clientKey } from '../../lib/http/client-key';

const request = (headers: Record<string, string>) => new Request('https://persona.example/api/session', { headers });

describe('per-network client key', () => {
  it('uses the platform header, else the right-most forwarded address', () => {
    expect(clientAddress(request({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientAddress(request({ 'x-vercel-forwarded-for': '198.51.100.4', 'x-forwarded-for': '6.6.6.6' }))).toBe('198.51.100.4');
    expect(clientAddress(request({ 'x-real-ip': '192.0.2.1' }))).toBe('192.0.2.1');
    expect(clientAddress(request({}))).toBe('unknown');
  });

  it('cannot be varied by a spoofed left-most entry and depends on the secret', () => {
    const real = clientKey(request({ 'x-forwarded-for': '203.0.113.9' }), 'secret-a');
    expect(clientKey(request({ 'x-forwarded-for': 'random-1, 203.0.113.9' }), 'secret-a')).toBe(real);
    expect(clientKey(request({ 'x-forwarded-for': 'random-2, 203.0.113.9' }), 'secret-a')).toBe(real);
    expect(clientKey(request({ 'x-forwarded-for': '203.0.113.9' }), 'secret-b')).not.toBe(real);
    expect(real).toMatch(/^[0-9a-f]{32}$/);
  });
});
