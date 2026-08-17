import { HFModel, ModelQuery, ScoringMode } from "./types";
import { embed, cosineSimilarity } from "./embeddings";

const NEUTRAL_SCORE = 50;
const TIE_THRESHOLD = 1;

export interface ScoreBreakdown {
  task: number;
  context: number;
  size: number;
  domain: number;
  /** Weighted sum of the four components above, 0-100. */
  total: number;
}

// ---- Component scorers (Section 4.3) ----

/** Task match: 50% weight. Filter already guarantees compatibility or "unknown". */
function scoreTask(model: HFModel, expectedPipelineTag: string): number {
  if (!model.pipeline_tag) return NEUTRAL_SCORE; // unknown metadata
  return model.pipeline_tag === expectedPipelineTag ? 100 : 0;
}

/**
 * Context window fit: 20% weight. contextWindow is unknown for every model
 * in the MVP pipeline (list endpoint doesn't return it) — see index.ts notes.
 * Formula kept general so it does the right thing once contextWindow is
 * ever populated: exactly meeting the requirement -> 50, double or more -> 100.
 */
function scoreContext(model: HFModel, contextLength: number): number {
  if (model.contextWindow == null) return NEUTRAL_SCORE;
  const ratio = model.contextWindow / contextLength; // >= 1, guaranteed by hard filter
  const score = 50 + Math.min(1, ratio - 1) * 50;
  return Math.min(100, Math.max(0, score));
}

/** Size fit: 15% weight. Closer to (without exceeding) maxParamsB scores higher. */
function scoreSize(model: HFModel, maxParamsB: number | undefined): number {
  if (model.paramsB == null) return NEUTRAL_SCORE; // unknown metadata
  if (maxParamsB === undefined) return NEUTRAL_SCORE; // no budget constraint given
  return Math.min(100, Math.max(0, (model.paramsB / maxParamsB) * 100));
}

/** Domain match: 15% weight. */
function scoreDomain(model: HFModel, domain: string | undefined): number {
  if (domain === undefined) return NEUTRAL_SCORE; // component not requested
  const tags = model.tags ?? [];
  const found = tags.some((tag) => tag.toLowerCase() === domain.toLowerCase());
  return found ? 100 : 0;
}

export function scoreModel(model: HFModel, query: ModelQuery, expectedPipelineTag: string): ScoreBreakdown {
  const task = scoreTask(model, expectedPipelineTag);
  const context = scoreContext(model, query.contextLength);
  const size = scoreSize(model, query.maxParamsB);
  const domain = scoreDomain(model, query.domain);

  const total = Math.round(task * 0.5 + context * 0.2 + size * 0.15 + domain * 0.15);

  return { task, context, size, domain, total };
}

// ---- reasonWhy generation (Section 4.6) ----

export function generateReasonWhy(breakdown: ScoreBreakdown): string {
  const parts: string[] = [];

  if (breakdown.task >= 90) parts.push("strong task match");
  else if (breakdown.task >= 50) parts.push("reasonable task fit");
  else parts.push("uncertain task fit");

  if (breakdown.context >= 90) parts.push("generous context window");
  else if (breakdown.context >= 50) parts.push("sufficient context window");
  else parts.push("tight context window");

  if (breakdown.size >= 80) parts.push("comfortably within your parameter limit");
  else if (breakdown.size >= 50) parts.push("reasonable size fit");
  else parts.push("well under your size budget");

  if (breakdown.domain >= 90) parts.push("matches your domain focus");
  // domain omitted from sentence when neutral/not requested or unmatched —
  // it's the least essential signal and keeps the sentence readable.

  // Capitalize first part, join naturally.
  const [first, ...rest] = parts;
  const capitalized = first.charAt(0).toUpperCase() + first.slice(1);
  if (rest.length === 0) return capitalized + ".";
  return `${capitalized}, ${rest.slice(0, -1).join(", ")}${rest.length > 1 ? ", and " : " and "}${rest[rest.length - 1]}.`;
}

// ---- Tie-break comparator (Section 4.5) ----

export interface Rankable {
  score: number;
  downloads: number;
}

/**
 * Sort comparator: higher score first. When two scores land within
 * TIE_THRESHOLD points of each other, break the tie by download count
 * (higher downloads first) instead — a minor popularity signal, not a
 * scoring component.
 */
export function compareModels(a: Rankable, b: Rankable): number {
  if (Math.abs(a.score - b.score) <= TIE_THRESHOLD) {
    return b.downloads - a.downloads;
  }
  return b.score - a.score;
}

// ---- v0.3: embedding-based scoring + mode blending ----

const HYBRID_RULE_WEIGHT = 0.6;
const HYBRID_EMBEDDING_WEIGHT = 0.4;

/**
 * Builds the best available free-text description of a model from what the
 * MVP/v0.2 pipeline actually has on hand (list endpoint only — no per-model
 * detail fetch, same limitation flagged elsewhere for contextWindow). This
 * is an approximation, not a real model card description: id (de-slugged),
 * pipeline_tag, and tags.
 */
function modelDescriptionText(model: HFModel): string {
  const idWords = model.id.replace(/[/_-]/g, " ");
  return [idWords, model.pipeline_tag ?? "", ...(model.tags ?? [])].join(" ");
}

/** Cosine-similarity-based score (0-100) between the free-text task and the model's available text signals. */
export function scoreEmbeddingSimilarity(model: HFModel, taskText: string): number {
  const taskVector = embed(taskText);
  const modelVector = embed(modelDescriptionText(model));
  const similarity = cosineSimilarity(taskVector, modelVector); // ~[0,1] for these non-negative vectors
  return Math.min(100, Math.max(0, similarity * 100));
}

export interface ScoringResult {
  /** Always computed (needed for hybrid blending and as a reference), regardless of mode. */
  ruleBreakdown: ScoreBreakdown;
  /** Only present when scoringMode is "embedding" or "hybrid". */
  embeddingScore?: number;
  /** The score actually used for ModelMatch.score, per scoringMode. */
  finalScore: number;
  scoringMode: ScoringMode;
}

/**
 * Computes the final score for a model under the requested scoringMode.
 * - "rule" (default): finalScore = ruleBreakdown.total, unchanged from v0.1/v0.2.
 * - "embedding": finalScore = embeddingScore alone.
 * - "hybrid": finalScore = ruleScore*0.60 + embeddingScore*0.40 (locked weights).
 * Hard filters (filters.ts) run before this, identically regardless of mode —
 * this function only ever sees candidates that already passed them.
 */
export function computeFinalScore(
  model: HFModel,
  query: ModelQuery,
  expectedPipelineTag: string
): ScoringResult {
  const mode: ScoringMode = query.scoringMode ?? "rule";
  const ruleBreakdown = scoreModel(model, query, expectedPipelineTag);

  if (mode === "rule") {
    return { ruleBreakdown, finalScore: ruleBreakdown.total, scoringMode: mode };
  }

  const embeddingScore = scoreEmbeddingSimilarity(model, query.task);

  if (mode === "embedding") {
    return { ruleBreakdown, embeddingScore, finalScore: Math.round(embeddingScore), scoringMode: mode };
  }

  // hybrid
  const finalScore = Math.round(
    ruleBreakdown.total * HYBRID_RULE_WEIGHT + embeddingScore * HYBRID_EMBEDDING_WEIGHT
  );
  return { ruleBreakdown, embeddingScore, finalScore, scoringMode: mode };
}

/** Mode-aware reasonWhy: rule-only text for "rule", an embedding note added/substituted otherwise. */
export function generateReasonWhyForResult(result: ScoringResult): string {
  if (result.scoringMode === "rule") {
    return generateReasonWhy(result.ruleBreakdown);
  }

  const embeddingScore = result.embeddingScore ?? 0;
  const embeddingPhrase =
    embeddingScore >= 75
      ? "strong semantic similarity to your task description"
      : embeddingScore >= 40
      ? "moderate semantic similarity to your task description"
      : "weak semantic similarity to your task description";

  if (result.scoringMode === "embedding") {
    return embeddingPhrase.charAt(0).toUpperCase() + embeddingPhrase.slice(1) + ".";
  }

  // hybrid: rule-based reasoning plus the embedding signal
  const ruleReason = generateReasonWhy(result.ruleBreakdown);
  return `${ruleReason.slice(0, -1)}, plus ${embeddingPhrase}.`;
}
