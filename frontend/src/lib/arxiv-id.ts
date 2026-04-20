const NEW_ID = /(\d{4}\.\d{4,5})(?:v\d+)?/;
const OLD_ID = /([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})/;

export function parseArxivId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const newMatch = trimmed.match(NEW_ID);
  if (newMatch) return newMatch[1];
  const oldMatch = trimmed.match(OLD_ID);
  if (oldMatch) return oldMatch[1];
  return null;
}
