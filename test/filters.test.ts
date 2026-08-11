import { describe, it, expect } from "vitest";
import { applyHardFilters } from "../src/filters";
import { HFModel, ModelQuery } from "../src/types";

const baseQuery: ModelQuery = { task: "chat", contextLength: 4096 };

function model(overrides: Partial<HFModel>): HFModel {
  return { id: "org/model", pipeline_tag: "text-generation", ...overrides };
}

describe("applyHardFilters", () => {
  it("excludes models over maxParamsB", () => {
    const models = [model({ id: "a", paramsB: 13 }), model({ id: "b", paramsB: 6 })];
    const result = applyHardFilters(models, { ...baseQuery, maxParamsB: 7 });
    expect(result.map((m) => m.id)).toEqual(["b"]);
  });

  it("lets models with unknown paramsB through, even with maxParamsB set", () => {
    const models = [model({ id: "a", paramsB: null })];
    const result = applyHardFilters(models, { ...baseQuery, maxParamsB: 7 });
    expect(result).toHaveLength(1);
  });

  it("excludes models with too-small contextWindow", () => {
    const models = [
      model({ id: "a", contextWindow: 2048 }),
      model({ id: "b", contextWindow: 8192 }),
    ];
    const result = applyHardFilters(models, baseQuery);
    expect(result.map((m) => m.id)).toEqual(["b"]);
  });

  it("lets models with unknown contextWindow through", () => {
    const models = [model({ id: "a", contextWindow: null })];
    const result = applyHardFilters(models, baseQuery);
    expect(result).toHaveLength(1);
  });

  it("excludes models whose pipeline_tag doesn't map to the task", () => {
    const models = [
      model({ id: "a", pipeline_tag: "text-classification" }),
      model({ id: "b", pipeline_tag: "text-generation" }),
    ];
    const result = applyHardFilters(models, baseQuery); // task: "chat" -> "text-generation"
    expect(result.map((m) => m.id)).toEqual(["b"]);
  });

  it("lets models with missing pipeline_tag through", () => {
    const models = [model({ id: "a", pipeline_tag: undefined })];
    const result = applyHardFilters(models, baseQuery);
    expect(result).toHaveLength(1);
  });

  it("applies all three filters together", () => {
    const models = [
      model({ id: "keeper", paramsB: 6.5, contextWindow: 8192, pipeline_tag: "text-generation" }),
      model({ id: "too-big", paramsB: 70, contextWindow: 8192, pipeline_tag: "text-generation" }),
      model({ id: "wrong-task", paramsB: 6.5, contextWindow: 8192, pipeline_tag: "translation" }),
      model({ id: "too-small-ctx", paramsB: 6.5, contextWindow: 1024, pipeline_tag: "text-generation" }),
    ];
    const result = applyHardFilters(models, { ...baseQuery, maxParamsB: 7 });
    expect(result.map((m) => m.id)).toEqual(["keeper"]);
  });
});
