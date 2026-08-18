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

  it("(v0.2) excludes a model whose benchmarked latency exceeds maxLatencyMs", () => {
    const models = [model({ id: "meta-llama/Llama-3-8B-Instruct" })]; // cpu: 9800ms in dataset
    const result = applyHardFilters(models, {
      ...baseQuery,
      hardware: "cpu",
      maxLatencyMs: 2000,
    });
    expect(result).toHaveLength(0);
  });

  it("(v0.2) keeps a model whose benchmarked latency is within maxLatencyMs", () => {
    const models = [model({ id: "meta-llama/Llama-3-8B-Instruct" })]; // gpu-high: 320ms
    const result = applyHardFilters(models, {
      ...baseQuery,
      hardware: "gpu-high",
      maxLatencyMs: 2000,
    });
    expect(result).toHaveLength(1);
  });

  it("(v0.2) does not exclude a model with no benchmark entry, even with maxLatencyMs set", () => {
    const models = [model({ id: "some-org/unbenchmarked-model" })];
    const result = applyHardFilters(models, {
      ...baseQuery,
      hardware: "cpu",
      maxLatencyMs: 100,
    });
    expect(result).toHaveLength(1);
  });

  it("(v0.4) does not enforce maxLatencyMs at all when hardware isn't specified", () => {
    // Can't judge latency without knowing which hardware bucket applies.
    const models = [model({ id: "meta-llama/Llama-3-8B-Instruct" })]; // cpu would be 9800ms
    const result = applyHardFilters(models, {
      ...baseQuery,
      maxLatencyMs: 100,
      // no hardware specified
    });
    expect(result).toHaveLength(1);
  });

  it("(v0.4) does not enforce maxLatencyMs when hardware is a HardwareSpec object (benchmark keyed by string enum only)", () => {
    const models = [model({ id: "meta-llama/Llama-3-8B-Instruct" })]; // cpu string-enum entry: 9800ms
    const result = applyHardFilters(models, {
      ...baseQuery,
      maxLatencyMs: 100,
      hardware: { type: "cpu" }, // HardwareSpec form, not the string enum
    });
    expect(result).toHaveLength(1); // not excluded — no matching benchmark key for the object form
  });

  it("(v0.4) excludes a model whose estimated VRAM footprint exceeds HardwareSpec.vramGB", () => {
    const models = [model({ id: "org/big-model", paramsB: 13 })]; // ~26GB estimated at 2GB/B
    const result = applyHardFilters(models, {
      ...baseQuery,
      hardware: { type: "gpu", vramGB: 8 },
    });
    expect(result).toHaveLength(0);
  });

  it("(v0.4) keeps a model whose estimated VRAM footprint fits within vramGB", () => {
    const models = [model({ id: "org/small-model", paramsB: 3 })]; // ~6GB estimated at 2GB/B
    const result = applyHardFilters(models, {
      ...baseQuery,
      hardware: { type: "gpu", vramGB: 8 },
    });
    expect(result).toHaveLength(1);
  });

  it("(v0.4) does not exclude on vramGB when paramsB is unknown", () => {
    const models = [model({ id: "org/mystery-model", paramsB: null })];
    const result = applyHardFilters(models, {
      ...baseQuery,
      hardware: { type: "gpu", vramGB: 1 }, // tiny budget, but unknown paramsB => let through
    });
    expect(result).toHaveLength(1);
  });

  it("(v0.4) does not exclude on vramGB when vramGB itself isn't specified", () => {
    const models = [model({ id: "org/huge-model", paramsB: 200 })];
    const result = applyHardFilters(models, {
      ...baseQuery,
      hardware: { type: "gpu" }, // no vramGB given
    });
    expect(result).toHaveLength(1);
  });

  it("(v0.4) never excludes based on model.provider — filters stay provider-agnostic", () => {
    const models = [
      model({ id: "org/hf-model", provider: "huggingface", paramsB: 5 }),
      model({ id: "org/ollama-model", provider: "ollama", paramsB: 5, pipeline_tag: undefined }),
    ];
    const result = applyHardFilters(models, { ...baseQuery, maxParamsB: 7 });
    expect(result).toHaveLength(2); // both pass identically — provider never inspected
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
