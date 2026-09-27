import { describe, expect, it } from 'vitest';
import { availableCapabilities } from '../../lib/domain/capabilities';

describe('availableCapabilities', () => {
  it('enables voice only with a server key and text only with a configured model', () => {
    expect(availableCapabilities({})).toEqual({ text: false, voice: false, calendar: false, gmail: false });
    expect(availableCapabilities({ OPENAI_API_KEY: 'key', OPENAI_TEXT_MODEL: 'model', COMPOSIO_API_KEY: 'composio', COMPOSIO_CALENDAR_AUTH_CONFIG_ID: 'calendar' })).toEqual({ text: true, voice: true, calendar: true, gmail: false });
  });
});
