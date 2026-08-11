import { HFModel, ModelQuery } from "./types";

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
