import { availableCapabilities } from '@/lib/domain/capabilities';

export function GET(): Response {
  return Response.json(availableCapabilities(process.env), { headers: { 'Cache-Control': 'no-store' } });
}
