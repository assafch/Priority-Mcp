/** Name-only normalization. Identifiers, SKUs and barcodes must never pass through this. */
export function normalizeEntityName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Lexical similarity is a ranking signal, never a probability or an identity decision. */
export function lexicalNameMatch(
  query: string,
  displayName: string,
): { weight: number; reason: string } | undefined {
  const needle = normalizeEntityName(query);
  const name = normalizeEntityName(displayName);
  if (!needle || !name) return undefined;
  if (needle === name) return { weight: 1, reason: 'normalized-name' };
  if (name.includes(needle))
    return { weight: 0.9 + (0.05 * needle.length) / name.length, reason: 'name-substring' };
  // Bigrams tolerate a single missing/swapped letter in Hebrew and English without transliteration.
  const grams = (text: string) =>
    new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
  const a = grams(needle);
  const b = grams(name);
  if (!a.size || !b.size) return undefined;
  let overlap = 0;
  for (const part of a) if (b.has(part)) overlap++;
  const dice = (2 * overlap) / (a.size + b.size);
  return dice >= 0.45 ? { weight: dice * 0.85, reason: 'lexical-name-similarity' } : undefined;
}
