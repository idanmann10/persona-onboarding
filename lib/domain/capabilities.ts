export function availableCapabilities(env: Record<string, string | undefined>): { text: boolean; voice: boolean } {
  const key = Boolean(env.OPENAI_API_KEY?.trim());
  return { text: key && Boolean(env.OPENAI_TEXT_MODEL?.trim()), voice: key };
}
