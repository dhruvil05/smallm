/**
 * Shared types for smallm.
 * This is the LOCKED contract (see MVP guide, Section 3).
 * Do not change shapes here without flagging it — everything else depends on this file.
 */

/** What the caller sends in to findModels(). */
export interface ModelQuery {
  /** What kind of task the model needs to do. Open string allowed for forward-compat. */
  task: "summarize" | "classify" | "extract" | "chat" | "code" | "translate" | string;

  /** REQUIRED. Minimum context window needed, in tokens. Treated as a HARD filter. */
  contextLength: number;

  /** Optional hint about target hardware. Not enforced as a filter in MVP — informational only. */
  hardware?: "cpu" | "gpu-low" | "gpu-high";

  /** Optional domain tag to prefer, e.g. "medical", "legal". Used in scoring only. */
  domain?: string;

  /** User-set size cutoff in billions of params, e.g. 7 = "under 7B". HARD filter. */
  maxParamsB?: number;

  /**
   * RESERVED for v0.2+. Accepted on the type for API stability, but NOT
   * scored or filtered on in MVP (HF metadata doesn't give reliable latency data).
   */
  maxLatencyMs?: number;

  /** Max number of results returned. Defaults to 5 if omitted. */
  limit?: number;

  /**
   * v0.2 addition, optional. Configures the file-based cache
   * (directory + TTL). Additive — omitting it preserves v0.1 defaults.
   */
  cacheOptions?: CacheOptions;
}

/** A single scored model returned to the caller. */
export interface ModelMatch {
  name: string;
  provider: "huggingface";
  /** null if size could not be detected from id/tags/config. */
  paramsB: number | null;
  /** null if context window could not be determined. */
  contextWindow: number | null;
  /** Human-readable explanation, generated from the structured score breakdown. */
  reasonWhy: string;
  /** 0–100 */
  score: number;
}

/**
 * Raw-ish shape of a model as we work with it internally, before it becomes
 * a ModelMatch. This is NOT part of the public contract — filters.ts,
 * scorer.ts, and params.ts all operate on this shape.
 */
export interface HFModel {
  /** HuggingFace model id, e.g. "meta-llama/Llama-3-8B-Instruct" */
  id: string;
  /** HuggingFace's task classification for the model, e.g. "text-generation" */
  pipeline_tag?: string;
  /** Free-form tags HF attaches to the model — used for domain matching etc. */
  tags?: string[];
  /** Download count — used only for tie-breaking (Section 4.5), not scoring. */
  downloads?: number;
  /** Filled in by params.ts after extraction. Not present on raw API response. */
  paramsB?: number | null;
  /** Filled in by params.ts after extraction. Not present on raw API response. */
  paramsSource?: ParamsSource;
  /** Context window in tokens, if known. May come from config data. */
  contextWindow?: number | null;
}

/**
 * Internal-only tracking type. Explains WHERE a paramsB value came from,
 * for debugging. Must NOT be exported from index.ts, and must NOT appear
 * on ModelMatch.
 */
export type ParamsSource = "id" | "tag" | "config" | "unknown";

// ---- v0.2 additions (additive only — see post-MVP guide) ----

/**
 * A single measured-latency data point for a (model, hardware) pair.
 * Shipped as a checked-in, versioned JSON dataset — not measured live.
 */
export interface BenchmarkEntry {
  modelId: string;
  hardware: "cpu" | "gpu-low" | "gpu-high";
  avgLatencyMs: number;
  /** ISO date string — benchmark data goes stale, so track when it was taken. */
  measuredAt: string;
  /** Conditions the measurement was taken under. */
  promptTokens: number;
  outputTokens: number;
}

/** Options for the v0.2 file-based cache. */
export interface CacheOptions {
  /** Default: OS temp dir + '/smallm-cache' */
  dir?: string;
  /** Default: same TTL as MVP's in-memory cache (5 minutes). */
  ttlMs?: number;
}
