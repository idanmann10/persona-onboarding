export function availableCapabilities(env: Record<string, string | undefined>): { text: boolean; voice: boolean; calendar: boolean; gmail: boolean } {
  const key = Boolean(env.OPENAI_API_KEY?.trim());
  const composio = Boolean(env.COMPOSIO_API_KEY?.trim());
  return {
    text: key && Boolean(env.OPENAI_TEXT_MODEL?.trim()), voice: key,
    calendar: composio && Boolean(env.COMPOSIO_CALENDAR_AUTH_CONFIG_ID?.trim()),
    gmail: composio && Boolean(env.COMPOSIO_GMAIL_AUTH_CONFIG_ID?.trim()),
  };
}
