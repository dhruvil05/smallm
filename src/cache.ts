import { HFModel } from "./types";
import { fetchCandidateModels } from "./registry/huggingface";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Generic in-memory TTL cache. No disk persistence — out of scope for MVP
 * (Section 2.2). Its only job is avoiding duplicate/rate-limited calls for
 * repeated identical queries within the TTL window.
 */
export class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private ttlMs: number = DEFAULT_TTL_MS) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// Module-level singleton cache, keyed by task string (fetchCandidateModels
// only varies by task, since that's what maps to pipeline_tag).
const candidateModelsCache = new TTLCache<HFModel[]>();

/**
 * Cached wrapper around fetchCandidateModels. Same task within the TTL
 * window returns the cached list instead of hitting HuggingFace again.
 */
export async function fetchCandidateModelsCached(task: string): Promise<HFModel[]> {
  const cached = candidateModelsCache.get(task);
  if (cached) return cached;

  const result = await fetchCandidateModels(task);
  candidateModelsCache.set(task, result);
  return result;
}

/** Exposed for tests that need to reset cache state between runs. */
export function clearCandidateModelsCache(): void {
  candidateModelsCache.clear();
}
