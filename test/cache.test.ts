import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TTLCache, fetchCandidateModelsCached, clearCandidateModelsCache } from "../src/cache";

describe("TTLCache", () => {
  it("returns undefined for a missing key", () => {
    const cache = new TTLCache<number>(1000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a stored value before it expires", () => {
    const cache = new TTLCache<number>(10_000);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
  });

  it("expires values after the TTL", () => {
    vi.useFakeTimers();
    const cache = new TTLCache<number>(1000);
    cache.set("a", 42);
    vi.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeUndefined();
    vi.useRealTimers();
  });

  it("clear() empties the cache", () => {
    const cache = new TTLCache<number>(10_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("fetchCandidateModelsCached", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearCandidateModelsCache();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "org/model-7B", pipeline_tag: "text-generation", downloads: 10 }],
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls fetch on first request for a task", async () => {
    await fetchCandidateModelsCached("chat");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not call fetch again for the same task within TTL", async () => {
    await fetchCandidateModelsCached("chat");
    await fetchCandidateModelsCached("chat");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("calls fetch separately for different tasks", async () => {
    await fetchCandidateModelsCached("chat");
    await fetchCandidateModelsCached("summarize");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
