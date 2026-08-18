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

  /** Optional hint about target hardware. v0.4: widened to also accept a
   *  structured HardwareSpec — existing string-enum callers keep working. */
  hardware?: "cpu" | "gpu-low" | "gpu-high" | HardwareSpec;

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

  /**
   * v0.3 addition, optional. "rule" (default, v0.1/v0.2 behavior) uses only
   * the weighted rule-based scorer. "embedding" scores purely on text
   * similarity between `task` and each candidate's available text signals.
   * "hybrid" blends both per the locked 60/40 formula (see scorer.ts).
   * Additive — omitting it preserves prior-version behavior exactly.
   */
  scoringMode?: ScoringMode;

  /**
   * v0.4 addition, optional. Which registries to query. Defaults to
   * ["huggingface"] when omitted — identical behavior to v0.1-v0.3.
   */
  providers?: ProviderName[];
}

/** v0.3: which scoring strategy to use. */
export type ScoringMode = "rule" | "embedding" | "hybrid";

/** v0.4: which registries a query can target. */
export type ProviderName = "huggingface" | "ollama";

/**
 * v0.4: structured hardware spec carrying real VRAM figures, for more
 * precise filtering than the coarse cpu/gpu-low/gpu-high enum allows.
 * ModelQuery.hardware is WIDENED to accept this in addition to the
 * original string enum — see that field's doc comment.
 */
export interface HardwareSpec {
  type: "cpu" | "gpu";
  vramGB?: number;
}

/** A single scored model returned to the caller. */
export interface ModelMatch {
  name: string;
  /** v0.4: widened from the literal "huggingface" to include "ollama". */
  provider: ProviderName;
  /** null if size could not be detected from id/tags/config. */
  paramsB: number | null;
  /** null if context window could not be determined. */
  contextWindow: number | null;
  /** Human-readable explanation, generated from the structured score breakdown. */
  reasonWhy: string;
  /** 0–100 */
  score: number;

  /**
   * v0.3 addition, optional. Which scoring mode actually produced this
   * result's score — useful when a caller wants to confirm which strategy
   * ran. Always populated in practice by findModels(), but kept optional
   * on the type per the locked v0.3 contract (so a hand-constructed
   * ModelMatch from older code, e.g. in a mock, still type-checks).
   */
  scoringMode?: ScoringMode;
}

/**
 * v0.4: shared shape every Provider implementation maps its raw data into,
 * before candidates reach filters.ts / scorer.ts. Those two files only
 * ever see this shape — never provider-specific data — so they stay fully
 * provider-agnostic (per the v0.4 guide's Do's/Don'ts). NOT part of the
 * public contract.
 */
export interface RawModel {
  /** Provider-specific model id, e.g. "meta-llama/Llama-3-8B-Instruct" (HF) or "llama3:8b" (Ollama). */
  id: string;
  /**
   * Which provider this candidate came from. Optional rather than required
   * purely so pre-v0.4 internal call sites/test fixtures (written before
   * the provider abstraction existed) keep type-checking unmodified —
   * every real Provider implementation always sets it in practice, and
   * index.ts falls back to "huggingface" if it's ever missing.
   */
  provider?: ProviderName;
  /** Task classification for the model, e.g. "text-generation". HuggingFace-specific concept; undefined for Ollama. */
  pipeline_tag?: string;
  /** Free-form tags — used for domain matching etc. */
  tags?: string[];
  /** Download count — used only for tie-breaking (Section 4.5), not scoring. HuggingFace-specific; undefined for Ollama. */
  downloads?: number;
  /** Filled in by params.ts after extraction. Not present on raw provider response. */
  paramsB?: number | null;
  /** Filled in by params.ts after extraction. Not present on raw provider response. */
  paramsSource?: ParamsSource;
  /** Context window in tokens, if known. May come from config data. */
  contextWindow?: number | null;
}

/**
 * Backward-compatible alias. filters.ts, scorer.ts, params.ts, and their
 * existing tests were written against "HFModel" before the v0.4 provider
 * abstraction existed — same shape now that HuggingFace is one of possibly
 * several providers, so this is kept as an alias rather than forcing a
 * rename at every call site.
 */
export type HFModel = RawModel;

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
