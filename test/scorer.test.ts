import { describe, it, expect } from "vitest";
import { scoreModel, generateReasonWhy, compareModels } from "../src/scorer";
import { HFModel, ModelQuery } from "../src/types";

const EXPECTED_TAG = "text-generation";
const baseQuery: ModelQuery = { task: "chat", contextLength: 4096, limit: 5 };

function model(overrides: Partial<HFModel>): HFModel {
  return { id: "org/model", pipeline_tag: EXPECTED_TAG, ...overrides };
}

describe("scoreModel", () => {
  it("gives full task score for exact pipeline_tag match", () => {
    const result = scoreModel(model({}), baseQuery, EXPECTED_TAG);
    expect(result.task).toBe(100);
  });

  it("gives neutral task score when pipeline_tag is missing", () => {
    const result = scoreModel(model({ pipeline_tag: undefined }), baseQuery, EXPECTED_TAG);
    expect(result.task).toBe(50);
  });

  it("gives neutral context score when contextWindow unknown", () => {
    const result = scoreModel(model({ contextWindow: null }), baseQuery, EXPECTED_TAG);
    expect(result.context).toBe(50);
  });

  it("gives higher context score for more headroom above requirement", () => {
    const tight = scoreModel(model({ contextWindow: 4096 }), baseQuery, EXPECTED_TAG);
    const generous = scoreModel(model({ contextWindow: 16384 }), baseQuery, EXPECTED_TAG);
    expect(generous.context).toBeGreaterThan(tight.context);
    expect(tight.context).toBe(50);
    expect(generous.context).toBe(100);
  });

  it("gives neutral size score when paramsB unknown", () => {
    const result = scoreModel(model({ paramsB: null }), baseQuery, EXPECTED_TAG);
    expect(result.size).toBe(50);
  });

  it("gives neutral size score when no maxParamsB budget given", () => {
    const result = scoreModel(model({ paramsB: 7 }), baseQuery, EXPECTED_TAG);
    expect(result.size).toBe(50);
  });

  it("scores size closer to budget higher than far under budget", () => {
    const closeToLimit = scoreModel(model({ paramsB: 6.5 }), { ...baseQuery, maxParamsB: 7 }, EXPECTED_TAG);
    const farUnder = scoreModel(model({ paramsB: 1 }), { ...baseQuery, maxParamsB: 7 }, EXPECTED_TAG);
    expect(closeToLimit.size).toBeGreaterThan(farUnder.size);
  });

  it("gives neutral domain score when domain not requested", () => {
    const result = scoreModel(model({ tags: ["medical"] }), baseQuery, EXPECTED_TAG);
    expect(result.domain).toBe(50);
  });

  it("gives full domain score on tag match, 0 on mismatch", () => {
    const match = scoreModel(model({ tags: ["medical"] }), { ...baseQuery, domain: "medical" }, EXPECTED_TAG);
    const noMatch = scoreModel(model({ tags: ["legal"] }), { ...baseQuery, domain: "medical" }, EXPECTED_TAG);
    expect(match.domain).toBe(100);
    expect(noMatch.domain).toBe(0);
  });

  it("computes total using locked weights (50/20/15/15)", () => {
    // task=100, context=50(unknown), size=50(no budget), domain=50(not requested)
    const result = scoreModel(model({}), baseQuery, EXPECTED_TAG);
    const expectedTotal = Math.round(100 * 0.5 + 50 * 0.2 + 50 * 0.15 + 50 * 0.15);
    expect(result.total).toBe(expectedTotal);
  });
});

describe("generateReasonWhy", () => {
  it("produces a non-empty, punctuated sentence", () => {
    const text = generateReasonWhy({ task: 100, context: 100, size: 90, domain: 100, total: 96 });
    expect(text.length).toBeGreaterThan(0);
    expect(text.endsWith(".")).toBe(true);
    expect(text[0]).toMatch(/[A-Z]/);
  });

  it("reflects a weak breakdown differently than a strong one", () => {
    const strong = generateReasonWhy({ task: 100, context: 100, size: 90, domain: 100, total: 96 });
    const weak = generateReasonWhy({ task: 0, context: 0, size: 10, domain: 0, total: 5 });
    expect(strong).not.toBe(weak);
  });
});

describe("compareModels (tie-break)", () => {
  it("ranks higher score first when scores differ by more than 1", () => {
    const result = compareModels({ score: 90, downloads: 10 }, { score: 80, downloads: 9999 });
    expect(result).toBeLessThan(0); // a comes first
  });

  it("breaks near-ties (within 1 point) using downloads", () => {
    const result = compareModels({ score: 80, downloads: 100 }, { score: 80.5, downloads: 500 });
    // b has more downloads, so b should rank first -> positive means b first
    expect(result).toBeGreaterThan(0);
  });
});
