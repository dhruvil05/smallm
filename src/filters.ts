import { HFModel, ModelQuery } from "./types";
import { mapTaskToPipelineTag } from "./registry/huggingface";

/**
 * Applies the three hard filters from Section 4.2, IN THIS ORDER, before any
 * scoring happens. A model failing ANY filter is excluded outright — it never
 * reaches scorer.ts. Unknown values never cause exclusion (Section 4.4).
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

    return true;
  });
}
