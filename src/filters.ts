import { HFModel, ModelQuery } from "./types";
import { mapTaskToPipelineTag } from "./registry/huggingface";
import { lookupLatencyMs } from "./benchmark";
import { isHardwareEnumString, isHardwareSpec } from "./query";

/**
 * (v0.4) Rough VRAM-per-billion-parameters estimate for fp16 inference,
 * used only to translate paramsB into an estimated footprint for the
 * HardwareSpec.vramGB filter below. The doc specifies "use vramGB when
 * present" but no exact formula — this is a commonly-cited heuristic
 * (~2GB VRAM per 1B params at fp16), not a measured or authoritative
 * figure. Flagged here and in the README as an approximation.
 */
const ESTIMATED_GB_PER_BILLION_PARAMS = 2;

/**
 * Applies hard filters before any scoring happens. A model failing ANY
 * filter is excluded outright — it never reaches scorer.ts. Unknown values
 * never cause exclusion (MVP Section 4.4's rule, carried forward per the
 * v0.2/v0.3/v0.4 guides' "unknown data is never punished" cross-phase
 * principle). Provider-agnostic throughout — never branches on
 * model.provider (v0.4 Do's/Don'ts).
 */
export function applyHardFilters(models: HFModel[], query: ModelQuery): HFModel[] {
  const expectedPipelineTag = mapTaskToPipelineTag(query.task);

  return models.filter((model) => {
    // 1. maxParamsB — known + over budget => exclude. Unknown => let through.
    if (
      query.maxParamsB !== undefined &&
      model.paramsB != null &&
      model.paramsB > query.maxParamsB
    ) {
      return false;
    }

    // 2. contextLength — known + too small => exclude. Unknown => let through.
    if (model.contextWindow != null && model.contextWindow < query.contextLength) {
      return false;
    }

    // 3. task compatibility — pipeline_tag present but doesn't map => exclude.
    //    Missing pipeline_tag entirely is treated as "can't determine", not excluded.
    //    (Ollama candidates never set pipeline_tag, so they're never excluded here —
    //    same "unknown, let through" rule, not a provider-specific carve-out.)
    if (model.pipeline_tag && model.pipeline_tag !== expectedPipelineTag) {
      return false;
    }

    // 4. (v0.2) maxLatencyMs — only enforced when benchmark data exists AND
    //    hardware is the original string-enum form (the benchmark dataset is
    //    keyed by that enum, not by arbitrary HardwareSpec objects). No
    //    benchmark entry => let through, same unknown-value rule.
    if (query.maxLatencyMs !== undefined && isHardwareEnumString(query.hardware)) {
      const measuredLatency = lookupLatencyMs(model.id, query.hardware);
      if (measuredLatency !== null && measuredLatency > query.maxLatencyMs) {
        return false;
      }
    }

    // 5. (v0.4) HardwareSpec.vramGB — known paramsB + known vramGB budget +
    //    estimated footprint exceeds it => exclude. Unknown paramsB, or no
    //    vramGB given, => let through (unknown-value rule again).
    if (isHardwareSpec(query.hardware) && query.hardware.vramGB !== undefined && model.paramsB != null) {
      const estimatedVramGB = model.paramsB * ESTIMATED_GB_PER_BILLION_PARAMS;
      if (estimatedVramGB > query.hardware.vramGB) {
        return false;
      }
    }

    return true;
  });
}
