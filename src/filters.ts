import { HFModel, ModelQuery } from "./types";
import { mapTaskToPipelineTag } from "./registry/huggingface";
import { lookupLatencyMs } from "./benchmark";

/**
 * Applies hard filters before any scoring happens. A model failing ANY
 * filter is excluded outright — it never reaches scorer.ts. Unknown values
 * never cause exclusion (MVP Section 4.4's rule, carried forward per the
 * v0.2 guide's "unknown data is never punished" cross-phase principle).
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
    if (model.pipeline_tag && model.pipeline_tag !== expectedPipelineTag) {
      return false;
    }

    // 4. (v0.2) maxLatencyMs — only enforced when benchmark data exists AND
    //    hardware is specified (latency is meaningless without a hardware
    //    context). No benchmark entry => let through, same unknown-value rule.
    if (query.maxLatencyMs !== undefined && query.hardware !== undefined) {
      const measuredLatency = lookupLatencyMs(model.id, query.hardware);
      if (measuredLatency !== null && measuredLatency > query.maxLatencyMs) {
        return false;
      }
    }

    return true;
  });
}
