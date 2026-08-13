import { describe, it, expect } from "vitest";
import { lookupLatencyMs, benchmarkDatasetSize } from "../src/benchmark";

describe("lookupLatencyMs", () => {
  it("returns a latency value for a known (model, hardware) pair", () => {
    const result = lookupLatencyMs("meta-llama/Llama-3-8B-Instruct", "gpu-low");
    expect(result).toBe(850);
  });

  it("returns different values for the same model on different hardware", () => {
    const gpuLow = lookupLatencyMs("meta-llama/Llama-3-8B-Instruct", "gpu-low");
    const gpuHigh = lookupLatencyMs("meta-llama/Llama-3-8B-Instruct", "gpu-high");
    const cpu = lookupLatencyMs("meta-llama/Llama-3-8B-Instruct", "cpu");
    expect(gpuHigh).toBeLessThan(gpuLow!);
    expect(cpu).toBeGreaterThan(gpuLow!);
  });

  it("returns null for a model with no benchmark entry at all", () => {
    const result = lookupLatencyMs("some-org/totally-unbenchmarked-model", "gpu-low");
    expect(result).toBeNull();
  });

  it("returns null for a known model on an unbenchmarked hardware bucket", () => {
    // TinyLlama has cpu and gpu-low entries but no gpu-high entry in the dataset
    const result = lookupLatencyMs("TinyLlama/TinyLlama-1.1B-Chat-v1.0", "gpu-high");
    expect(result).toBeNull();
  });
});

describe("benchmarkDatasetSize", () => {
  it("reports a positive number of loaded entries", () => {
    expect(benchmarkDatasetSize()).toBeGreaterThan(0);
  });
});
