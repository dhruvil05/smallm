import { ModelQuery, ModelMatch } from "./types";
import { validateQuery } from "./query";
import { fetchCandidateModelsCached } from "./cache";
import { enrichWithParams } from "./params";
import { applyHardFilters } from "./filters";
import { scoreModel, generateReasonWhy, compareModels } from "./scorer";
import { mapTaskToPipelineTag } from "./registry/huggingface";

/**
 * Finds and ranks HuggingFace models matching the given query.
 *
 * Pipeline (locked order, per MVP guide Section 5, Step 8):
 *   validate -> fetch -> hard-filter -> score -> tie-break -> sort -> limit -> return
 *
 * Known MVP limitation: candidate models come only from HuggingFace's list
 * endpoint (registry/huggingface.ts), which does not return context-window
 * data. That means `contextWindow` is always null/unknown for every model
 * in this pipeline, so the contextLength hard filter rarely excludes
 * anything and the context-fit score component is always neutral (50).
 * Per Section 6.3's guidance ("fetch full model detail only for shortlisted
 * top candidates"), a real fix would add a detail-fetch enrichment step for
 * the top N *after* scoring — but that's not part of the fixed Step 8
 * pipeline order, so it's deliberately left out of MVP and flagged here
 * rather than silently built.
 */
export async function findModels(query: ModelQuery): Promise<ModelMatch[]> {
  // 1. validate
  const validated = validateQuery(query);

  // 2. fetch (cached)
  const rawCandidates = await fetchCandidateModelsCached(validated.task);
  const enriched = enrichWithParams(rawCandidates);

  // 3. hard-filter
  const filtered = applyHardFilters(enriched, validated);

  // 4. score
  const expectedPipelineTag = mapTaskToPipelineTag(validated.task);
  const scored = filtered.map((model) => ({
    model,
    breakdown: scoreModel(model, validated, expectedPipelineTag),
  }));

  // 5. tie-break + 6. sort (single stable sort using the tie-break-aware comparator)
  scored.sort((a, b) =>
    compareModels(
      { score: a.breakdown.total, downloads: a.model.downloads ?? 0 },
      { score: b.breakdown.total, downloads: b.model.downloads ?? 0 }
    )
  );

  // 7. limit
  const top = scored.slice(0, validated.limit);

  // 8. return — map to the public ModelMatch shape
  return top.map(({ model, breakdown }): ModelMatch => ({
    name: model.id,
    provider: "huggingface",
    paramsB: model.paramsB ?? null,
    contextWindow: model.contextWindow ?? null,
    reasonWhy: generateReasonWhy(breakdown),
    score: breakdown.total,
  }));
}

// Public type exports — consumers need these to type their own code.
// Internal helpers (fetch, scorer internals) and ParamsSource are
// intentionally NOT exported from here, per docx Section 6.1/3.1.
export type { ModelQuery, ModelMatch } from "./types";
