import { ModelQuery, ModelMatch } from "./types";
import { validateQuery } from "./query";
import { fetchCandidateModelsCached, configureCandidateModelsCache } from "./cache-file";
import { enrichWithParams } from "./params";
import { applyHardFilters } from "./filters";
import { scoreModel, generateReasonWhy, compareModels } from "./scorer";
import { mapTaskToPipelineTag } from "./registry/huggingface";

/**
 * Finds and ranks HuggingFace models matching the given query.
 *
 * Pipeline (locked order, per MVP guide Section 5, Step 8 — unchanged in v0.2):
 *   validate -> fetch -> hard-filter -> score -> tie-break -> sort -> limit -> return
 *
 * v0.2 changes (see post-MVP guide):
 *   - fetch is now backed by a file-based cache (cache-file.ts) instead of
 *     MVP's in-memory Map, so repeated queries survive process restarts.
 *     Same call-site shape, so this swap didn't touch the pipeline order.
 *   - maxLatencyMs is now a real hard filter when both it and `hardware`
 *     are provided AND a benchmark entry exists for that (model, hardware)
 *     pair (see filters.ts, benchmark.ts). Still unenforced when no
 *     benchmark data is available — unknown values are never punished.
 *   - HuggingFace fetch failures now retry transient errors (429/5xx) with
 *     backoff before throwing a typed SmallmError subclass (errors.ts).
 *
 * Known MVP-era limitation, still present in v0.2: candidate models come
 * only from HuggingFace's list endpoint, which does not return
 * context-window data, so `contextWindow` stays null/unknown for every
 * model and the context-fit score component stays neutral (50). Not part
 * of v0.2's scope (see post-MVP guide) — tracked as a future addition.
 */
export async function findModels(query: ModelQuery): Promise<ModelMatch[]> {
  // 1. validate
  const validated = validateQuery(query);

  // (v0.2) apply per-call cache options, if provided, before the fetch step.
  if (validated.cacheOptions) {
    configureCandidateModelsCache(validated.cacheOptions);
  }

  // 2. fetch (cached — now file-backed, see cache-file.ts)
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

// (v0.2) Public error exports — additive. Lets consumers do
// `catch (e) { if (e instanceof ValidationError) ... }` without reaching
// into internal modules.
export { SmallmError, HFApiError, RateLimitError, ValidationError } from "./errors";
