// Small text index for tool search (design §3.8) and memory recall (§3.9):
// a tokenizer with light English stemming, Okapi BM25, and cosine
// similarity for embeddings from a local model. Pure. Checked on the 60-tool
// fixture in tool-search.eval.test.ts.

export type EmbedPurpose = "document" | "query";

/** A local embedding model (platform/store/ollama-embedder.ts). Throws when
 *  unavailable; callers fall back to BM25. */
export interface TextEmbedder {
  readonly model: string;
  embed(texts: readonly string[], purpose: EmbedPurpose): Promise<Float32Array[]>;
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our please should so than that the their them then there these this those to us was we were what when where which who why will with would you your".split(
    " ",
  ),
);

export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // \p{M} keeps Arabic diacritics (shadda, harakat) inside their word.
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
      .map(stem)
  );
}

export type Bm25Hit = { id: string; score: number; matched: number; of: number };

export function createBm25Index(
  docs: readonly { id: string; text: string }[],
  params: { k1?: number; b?: number } = {},
): { search(query: string | readonly string[]): Bm25Hit[] } {
  const k1 = params.k1 ?? 1.2;
  const b = params.b ?? 0.75;
  const terms = docs.map((doc) => {
    const counts = new Map<string, number>();
    const tokens = tokenize(doc.text);
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { counts, length: tokens.length };
  });
  const total = docs.length;
  const average = total === 0 ? 1 : terms.reduce((sum, t) => sum + t.length, 0) / total || 1;
  const frequency = new Map<string, number>();
  for (const { counts } of terms) {
    for (const term of counts.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }

  return {
    search(query) {
      const queryTerms = [...new Set(typeof query === "string" ? tokenize(query) : query)];
      if (queryTerms.length === 0) return [];
      const hits: (Bm25Hit & { order: number })[] = [];
      terms.forEach(({ counts, length }, order) => {
        let score = 0;
        let matched = 0;
        for (const term of queryTerms) {
          const tf = counts.get(term);
          if (tf === undefined) continue;
          matched++;
          const n = frequency.get(term) ?? 0;
          const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
          score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * length) / average));
        }
        const id = docs[order]?.id;
        if (score > 0 && id !== undefined) {
          hits.push({ id, score, matched, of: queryTerms.length, order });
        }
      });
      hits.sort((x, y) => y.score - x.score || x.order - y.order);
      return hits.map(({ order: _order, ...hit }) => hit);
    },
  };
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}
