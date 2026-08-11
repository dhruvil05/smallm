import { HFModel, ParamsSource } from "./types";

/**
 * Matches patterns like "7B", "13b", "1.1B", "70B-Instruct".
 * Requires a digit immediately before the B/b, and no letter/digit right after,
 * so we don't accidentally match things like "Bert" or "B16".
 */
const PARAM_REGEX = /(\d+(?:\.\d+)?)[\-_]?[bB](?![a-zA-Z0-9])/;

export interface ParamsExtractionResult {
  paramsB: number | null;
  paramsSource: ParamsSource;
}

function extractFromString(value: string, regex: RegExp): number | null {
  const match = value.match(regex);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Extracts a billions-of-params estimate for a model, trying id first,
 * then tags. Config-based extraction ("config" source) would require
 * fetching per-model detail, which the MVP pipeline does not do
 * (see index.ts notes) — so "config" is defined in ParamsSource for
 * forward-compat but never produced in MVP.
 *
 * Known limitation: sub-billion models (e.g. "opt-125m") are not detected
 * since we only match the B suffix. They correctly fall through to
 * "unknown" rather than being misread, which is the safe failure mode
 * per the Unknown-Value Rule.
 */
export function extractParamsB(model: HFModel): ParamsExtractionResult {
  const fromId = extractFromString(model.id, PARAM_REGEX);
  if (fromId !== null) {
    return { paramsB: fromId, paramsSource: "id" };
  }

  for (const tag of model.tags ?? []) {
    const fromTag = extractFromString(tag, PARAM_REGEX);
    if (fromTag !== null) {
      return { paramsB: fromTag, paramsSource: "tag" };
    }
  }

  return { paramsB: null, paramsSource: "unknown" };
}

/** Applies extraction to a full list, returning enriched copies (does not mutate input). */
export function enrichWithParams(models: HFModel[]): HFModel[] {
  return models.map((model) => {
    const { paramsB, paramsSource } = extractParamsB(model);
    return { ...model, paramsB, paramsSource };
  });
}
