import { ModelQuery, ModelMatch, ProviderName, RawModel } from "./types";
import { validateQuery } from "./query";
import { getOrFetchCached, configureCandidateModelsCache } from "./cache-file";
import { enrichWithParams } from "./params";
import { applyHardFilters } from "./filters";
import { computeFinalScore, generateReasonWhyForResult, compareModels } from "./scorer";
import { mapTaskToPipelineTag, huggingfaceProvider } from "./registry/huggingface";
import { ollamaProvider } from "./registry/ollama";
import { Provider } from "./registry/provider";

/** (v0.4) Registry of known providers, keyed by name, for the fan-out step below. */
const PROVIDERS: Record<ProviderName, Provider> = {
  huggingface: huggingfaceProvider,
  ollama: ollamaProvider,
};

/**
 * Finds and ranks models matching the given query, across one or more
 * providers (HuggingFace by default; optionally Ollama as of v0.4).
 *
 * Pipeline (locked order, per MVP guide Section 5, Step 8 — unchanged since MVP):
 *   validate -> fetch -> hard-filter -> score -> tie-break -> sort -> limit -> return
 *
 * v0.4 changes (see post-MVP guide):
 *   - New optional `providers` field: which registries to query. Defaults
 *     to ["huggingface"] — identical behavior to v0.1-v0.3 when omitted.
 *   - The FETCH step now fans out to every requested provider in parallel
 *     and merges their RawModel[] results before hard-filtering — filters.ts
 *     and scorer.ts never see provider-specific shapes or branch on
 *     provider name (v0.4 Do's/Don'ts).
 *   - `hardware` is widened to optionally accept a structured HardwareSpec
 *     ({ type, vramGB? }) alongside the original string enum. When vramGB
 *     is given, filters.ts applies an estimated-footprint hard filter
 *     (see that file for the heuristic and its caveats).
 *   - Ollama being unreachable never fails the whole call — see
 *     registry/ollama.ts for the graceful-degradation behavior.
 *
 * v0.3 changes (see post-MVP guide):
 *   - New optional `scoringMode`: "rule" (default, unchanged v0.1/v0.2
 *     behavior) | "embedding" | "hybrid". Only the SCORE step changes
 *     between modes — hard filters (step 3) run identically regardless of
 *     scoringMode, per the "filters stay mode-agnostic" cross-phase
 *     principle. See scorer.ts's computeFinalScore for the per-mode logic.
 *   - "embedding" mode uses a local, dependency-free text-similarity
 *     scorer (embeddings.ts) instead of a downloaded neural model — see
 *     that file's docblock for why, and the trade-off involved.
 *
 * v0.2 changes (see post-MVP guide):
 *   - fetch is now backed by a file-based cache (cache-file.ts) instead of
 *     MVP's in-memory Map, so repeated queries survive process restarts.
 *   - maxLatencyMs is now a real hard filter when both it and the original
 *     string-form `hardware` are provided AND a benchmark entry exists for
 *     that (model, hardware) pair (see filters.ts, benchmark.ts). Still
 *     unenforced otherwise — unknown values are never punished.
 *   - HuggingFace fetch failures now retry transient errors (429/5xx) with
 *     backoff before throwing a typed SmallmError subclass (errors.ts).
 *
 * Known MVP-era limitation, still present through v0.4: candidate models
 * from HuggingFace come only from its list endpoint, which does not return
 * context-window data, so `contextWindow` stays null/unknown for those
 * models and the context-fit score component stays neutral (50). Not part
 * of any shipped phase's scope yet — tracked as a future addition.
 */
export async function findModels(query: ModelQuery): Promise<ModelMatch[]> {
  // 1. validate
  const validated = validateQuery(query);

  // (v0.2) apply per-call cache options, if provided, before the fetch step.
  if (validated.cacheOptions) {
    configureCandidateModelsCache(validated.cacheOptions);
  }

  // 2. fetch — (v0.4) fan out to every requested provider, cached per
  //    (provider, task) pair, then merge before anything downstream sees them.
  const providerLists = await Promise.all(
    validated.providers.map((providerName) => {
      const provider = PROVIDERS[providerName];
      return getOrFetchCached(`${provider.name}:${validated.task}`, () => provider.listCandidates(validated));
    })
  );
  const rawCandidates: RawModel[] = providerLists.flat();
  const enriched = enrichWithParams(rawCandidates);

  // 3. hard-filter — mode-agnostic and provider-agnostic, runs identically regardless of scoringMode/providers
  const filtered = applyHardFilters(enriched, validated);

  // 4. score — mode-aware as of v0.3 (rule / embedding / hybrid)
  const expectedPipelineTag = mapTaskToPipelineTag(validated.task);
  const scored = filtered.map((model) => ({
    model,
    result: computeFinalScore(model, validated, expectedPipelineTag),
  }));

  // 5. tie-break + 6. sort (single stable sort using the tie-break-aware comparator)
  scored.sort((a, b) =>
    compareModels(
      { score: a.result.finalScore, downloads: a.model.downloads ?? 0 },
      { score: b.result.finalScore, downloads: b.model.downloads ?? 0 }
    )
  );

  // 7. limit
  const top = scored.slice(0, validated.limit);

  // 8. return — map to the public ModelMatch shape
  return top.map(({ model, result }): ModelMatch => ({
    name: model.id,
    provider: model.provider ?? "huggingface",
    paramsB: model.paramsB ?? null,
    contextWindow: model.contextWindow ?? null,
    reasonWhy: generateReasonWhyForResult(result),
    score: result.finalScore,
    scoringMode: result.scoringMode,
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
