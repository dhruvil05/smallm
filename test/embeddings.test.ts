import { describe, it, expect, beforeEach } from "vitest";
import { embed, cosineSimilarity, clearEmbeddingCache, embeddingCacheSize } from "../src/embeddings";

describe("embed", () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  it("returns a fixed-length numeric vector", () => {
    const vec = embed("summarize this document");
    expect(vec).toHaveLength(256);
    expect(vec.every((v) => typeof v === "number")).toBe(true);
  });

  it("is deterministic — same text produces the same vector", () => {
    const a = embed("chat conversational assistant");
    const b = embed("chat conversational assistant");
    expect(a).toEqual(b);
  });

  it("produces an L2-normalized vector (magnitude ~1) for non-empty text", () => {
    const vec = embed("some text to embed");
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it("caches repeated calls instead of recomputing", () => {
    expect(embeddingCacheSize()).toBe(0);
    embed("some model description text");
    expect(embeddingCacheSize()).toBe(1);
    embed("some model description text"); // same text again
    expect(embeddingCacheSize()).toBe(1); // still just one entry
    embed("different text");
    expect(embeddingCacheSize()).toBe(2);
  });

  it("clearEmbeddingCache() empties the cache", () => {
    embed("a");
    embed("b");
    expect(embeddingCacheSize()).toBe(2);
    clearEmbeddingCache();
    expect(embeddingCacheSize()).toBe(0);
  });
});

describe("performance (informational, not a strict SLA)", () => {
  beforeEach(() => clearEmbeddingCache());

  it("(v0.3 build-order step 6 note) embedding computation is sub-millisecond-scale, not LLM-inference-scale", () => {
    // Not a hard assertion of an exact number (that would be flaky across
    // machines) — just confirms embed() is orders of magnitude faster than
    // the LLM inference latencies in src/data/benchmarks.json (hundreds to
    // thousands of ms), which is *why* embedding latency isn't tracked there.
    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      clearEmbeddingCache(); // force recompute each time, not cache hits
      embed(`sample model description text number ${i} with several words`);
    }
    const elapsedMs = performance.now() - start;
    const avgPerCallMs = elapsedMs / iterations;

    // Generous upper bound (10ms/call) — the real number is typically
    // well under 1ms; this just guards against a pathological regression.
    expect(avgPerCallMs).toBeLessThan(10);
  });
});

describe("cosineSimilarity", () => {
  it("returns ~1 for identical text embeddings", () => {
    const a = embed("translate this sentence to french");
    const b = embed("translate this sentence to french");
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("returns a higher score for lexically similar text than for dissimilar text", () => {
    const query = embed("chat conversational assistant model");
    const similar = embed("chat conversational chatbot model");
    const dissimilar = embed("translate french documents legal");

    const simToSimilar = cosineSimilarity(query, similar);
    const simToDissimilar = cosineSimilarity(query, dissimilar);

    expect(simToSimilar).toBeGreaterThan(simToDissimilar);
  });

  it("throws on mismatched vector lengths", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow();
  });
});
