/**
 * A small, local, dependency-free text embedding scheme.
 *
 * WHY NOT A REAL NEURAL EMBEDDING MODEL: a genuine pretrained sentence
 * embedding model (e.g. all-MiniLM-L6-v2 via transformers.js) needs to
 * download model weights from HuggingFace at install/first-run time. This
 * package's build/test environment can't verify that network path, so
 * rather than ship an unverified dependency, this is a self-authored
 * character-trigram hashing vectorizer + cosine similarity — a classic,
 * well-understood, fully offline technique with zero external dependencies
 * or license concerns (original code).
 *
 * TRADE-OFF: this captures lexical/surface similarity (shared substrings),
 * not deep semantic meaning. "extract key-value pairs from invoices" and
 * "structured data extraction" would score lower here than they would with
 * a real neural embedding, since they share few character sequences despite
 * being semantically close. Swap in a real model later by replacing embed()
 * with one backed by transformers.js (or similar) — cosineSimilarity() and
 * every caller of embed() would keep working unchanged, since only the
 * vector-production step would change.
 *
 * SWAP-IN NOTE (build order step 6, "benchmark embedding-mode latency —
 * feed into v0.2's benchmark dataset if relevant"): that benchmark dataset
 * (src/data/benchmarks.json) measures LLM *inference* latency per
 * (model, hardware) — a real, meaningful cost that varies by model size and
 * hardware. This embedding scheme is a synchronous, local, sub-millisecond
 * hash computation with no model inference involved, so there's no
 * per-(model, hardware) latency to record there — "not relevant" for this
 * implementation. See test/embeddings.test.ts's performance sanity check
 * for a concrete timing figure instead. If embed() is ever swapped for a
 * real neural embedding model (see the trade-off note above), *that* would
 * introduce real inference latency worth feeding into the benchmark dataset.
 */

const VECTOR_DIM = 256;
const MAX_CACHE_SIZE = 500;

/** djb2 string hash — fast, deterministic, decent distribution for this use. */
function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function charTrigrams(text: string): string[] {
  const padded = ` ${normalizeText(text)} `;
  const grams: string[] = [];
  for (let i = 0; i < padded.length - 2; i++) {
    grams.push(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * Cache of computed embeddings, keyed by exact input text. Per the v0.3
 * Do's/Don'ts ("don't recompute embeddings for the same model description
 * on every call"), repeated calls with identical text are served from here
 * instead of re-hashing. Simple FIFO eviction once MAX_CACHE_SIZE is hit —
 * this is a small in-process cache, not meant to be a durable store.
 */
const embeddingCache = new Map<string, number[]>();

/**
 * Produces a fixed-length (VECTOR_DIM), L2-normalized vector for the given
 * text using hashed character-trigram counts. Deterministic: same text
 * always produces the same vector.
 */
export function embed(text: string): number[] {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const vector = new Array(VECTOR_DIM).fill(0);
  for (const gram of charTrigrams(text)) {
    vector[hashString(gram) % VECTOR_DIM] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  const normalized = norm > 0 ? vector.map((v) => v / norm) : vector;

  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = embeddingCache.keys().next().value;
    if (oldestKey !== undefined) embeddingCache.delete(oldestKey);
  }
  embeddingCache.set(text, normalized);

  return normalized;
}

/**
 * Cosine similarity between two equal-length vectors, in [0, 1] for these
 * non-negative count-based vectors (in [-1, 1] in general). Since embed()
 * always L2-normalizes, this is just the dot product.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vectors must be the same length (got ${a.length} and ${b.length})`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Exposed for tests. */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

/** Exposed for tests/debugging. */
export function embeddingCacheSize(): number {
  return embeddingCache.size;
}
