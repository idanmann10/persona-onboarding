export function isDirectIdentityClaim(text: string, clue: { first: string; last: string; company: string }): boolean {
  const source = text.toLocaleLowerCase().replace(/\s+/g, ' ');
  const name = `${clue.first} ${clue.last}`.toLocaleLowerCase();
  const company = clue.company.toLocaleLowerCase();
  if (!clue.first.trim() || !clue.last.trim() || !clue.company.trim()) return false;
  if (/\b(not|never|no longer|don't|do not)\b/i.test(source)) return false;
  const nameAt = source.indexOf(name);
  const companyAt = source.indexOf(company);
  if (nameAt < 0 || companyAt < 0) return false;
  const firstPerson = /\b(i['’]?m|i am|my name is)\s+/gi;
  const companyRelation = /\b(founder of|ceo of|i run|i work at|i lead|i own)\s+/gi;
  const nearBefore = (pattern: RegExp, position: number, distance: number) =>
    [...source.matchAll(pattern)].some((match) => match.index < position && position - match.index <= distance);
  return nearBefore(firstPerson, nameAt, 30) && nearBefore(companyRelation, companyAt, 60);
}
