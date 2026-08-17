import { describe, it, expect, beforeEach } from "vitest";
import {
  computeFinalScore,
  generateReasonWhyForResult,
  scoreEmbeddingSimilarity,
} from "../src/scorer";
import { clearEmbeddingCache } from "../src/embeddings";
import { HFModel, ModelQuery } from "../src/types";

const EXPECTED_TAG = "text-generation";
const baseQuery: ModelQuery = { task: "chat", contextLength: 4096, limit: 5 };

function model(overrides: Partial<HFModel>): HFModel {
  return { id: "org/chat-model-7B", pipeline_tag: EXPECTED_TAG, tags: ["chat", "conversational"], ...overrides };
}

describe("scoreEmbeddingSimilarity", () => {
  beforeEach(() => clearEmbeddingCache());

  it("returns a score in [0, 100]", () => {
    const score = scoreEmbeddingSimilarity(model({}), "chat conversational assistant");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("scores a lexically closer task text higher than a distant one", () => {
    const chatModel = model({ id: "org/chat-model-7B", tags: ["chat", "conversational"] });
    const closeScore = scoreEmbeddingSimilarity(chatModel, "chat conversational model");
    const farScore = scoreEmbeddingSimilarity(chatModel, "legal document translation");
    expect(closeScore).toBeGreaterThan(farScore);
  });
});

describe("computeFinalScore", () => {
  beforeEach(() => clearEmbeddingCache());

  it("defaults to 'rule' mode when scoringMode is omitted — matches scoreModel's total exactly", () => {
    const result = computeFinalScore(model({}), baseQuery, EXPECTED_TAG);
    expect(result.scoringMode).toBe("rule");
    expect(result.finalScore).toBe(result.ruleBreakdown.total);
    expect(result.embeddingScore).toBeUndefined();
  });

  it("'rule' mode is identical to pre-v0.3 behavior when explicitly set", () => {
    const result = computeFinalScore(model({}), { ...baseQuery, scoringMode: "rule" }, EXPECTED_TAG);
    expect(result.finalScore).toBe(result.ruleBreakdown.total);
  });

  it("'embedding' mode uses only the embedding score, ignoring rule total", () => {
    const result = computeFinalScore(
      model({ paramsB: 999 }), // would tank a rule-based size score if it mattered here
      { ...baseQuery, scoringMode: "embedding" },
      EXPECTED_TAG
    );
    expect(result.scoringMode).toBe("embedding");
    expect(result.embeddingScore).toBeDefined();
    expect(result.finalScore).toBe(Math.round(result.embeddingScore!));
  });

  it("'hybrid' mode blends rule and embedding scores using the locked 60/40 formula exactly", () => {
    const result = computeFinalScore(model({}), { ...baseQuery, scoringMode: "hybrid" }, EXPECTED_TAG);
    const expected = Math.round(result.ruleBreakdown.total * 0.6 + result.embeddingScore! * 0.4);
    expect(result.finalScore).toBe(expected);
  });

  it("rule score still dominates in hybrid mode (per spec intent) for a strong rule / weak embedding case", () => {
    // Strong rule match (exact task, no domain/size constraints -> neutral 50s except task=100)
    const strongRuleModel = model({ id: "org/xyz123-abc789", tags: [] }); // weird id -> low embedding similarity to "chat"
    const result = computeFinalScore(strongRuleModel, { ...baseQuery, scoringMode: "hybrid" }, EXPECTED_TAG);
    // rule total should contribute the majority share
    const ruleContribution = result.ruleBreakdown.total * 0.6;
    const embeddingContribution = (result.embeddingScore ?? 0) * 0.4;
    expect(ruleContribution).toBeGreaterThanOrEqual(embeddingContribution);
  });
});

describe("generateReasonWhyForResult", () => {
  beforeEach(() => clearEmbeddingCache());

  it("produces the same text as generateReasonWhy for 'rule' mode", () => {
    const result = computeFinalScore(model({}), baseQuery, EXPECTED_TAG);
    const text = generateReasonWhyForResult(result);
    expect(text.length).toBeGreaterThan(0);
    expect(text.endsWith(".")).toBe(true);
  });

  it("produces embedding-specific text for 'embedding' mode", () => {
    const result = computeFinalScore(model({}), { ...baseQuery, scoringMode: "embedding" }, EXPECTED_TAG);
    const text = generateReasonWhyForResult(result);
    expect(text.toLowerCase()).toContain("semantic similarity");
  });

  it("produces a combined rule+embedding sentence for 'hybrid' mode", () => {
    const result = computeFinalScore(model({}), { ...baseQuery, scoringMode: "hybrid" }, EXPECTED_TAG);
    const text = generateReasonWhyForResult(result);
    expect(text.toLowerCase()).toContain("semantic similarity");
    expect(text.endsWith(".")).toBe(true);
  });
});
