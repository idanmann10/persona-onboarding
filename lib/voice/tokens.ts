/** Conservative token estimate: ~4 Latin characters per token, one token per non-ASCII character. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) (character.charCodeAt(0) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other);
}

/** Trim text to an estimated token budget, keeping the start and marking the cut. */
export function truncateToTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let kept = '';
  for (const character of text) {
    if (estimateTokens(kept + character) > budget - 2) break;
    kept += character;
  }
  return `${kept}…`;
}
