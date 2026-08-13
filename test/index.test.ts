import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findModels } from "../src/index";
import { configureCandidateModelsCache, clearCandidateModelsCache } from "../src/cache-file";
import { InvalidQueryError } from "../src/query";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smallm-index-test-"));
}

describe("findModels (integration)", () => {
  const originalFetch = global.fetch;
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    configureCandidateModelsCache({ dir, ttlMs: 10_000 }); // isolated cache per test
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full pipeline: fetch -> filter -> score -> sort -> limit", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "org/tiny-1B-chat", pipeline_tag: "text-generation", tags: ["chat"], downloads: 500 },
        { id: "org/mid-6.5B-chat", pipeline_tag: "text-generation", tags: ["chat"], downloads: 800 },
        { id: "org/huge-70B-chat", pipeline_tag: "text-generation", tags: ["chat"], downloads: 5000 },
        { id: "org/wrong-task-model", pipeline_tag: "translation", tags: [], downloads: 100 },
      ],
    });

    const results = await findModels({
      task: "chat",
      contextLength: 4096,
      maxParamsB: 7,
      limit: 5,
    });

    // huge-70B excluded by maxParamsB, wrong-task excluded by task filter
    const names = results.map((r) => r.name);
    expect(names).not.toContain("org/huge-70B-chat");
    expect(names).not.toContain("org/wrong-task-model");
    expect(names).toContain("org/mid-6.5B-chat");
    expect(names).toContain("org/tiny-1B-chat");

    // mid-6.5B should score higher on size fit (closer to the 7B budget) than tiny-1B
    const mid = results.find((r) => r.name === "org/mid-6.5B-chat")!;
    const tiny = results.find((r) => r.name === "org/tiny-1B-chat")!;
    expect(mid.score).toBeGreaterThanOrEqual(tiny.score);

    // every result has a non-empty reasonWhy
    for (const r of results) {
      expect(r.reasonWhy.length).toBeGreaterThan(0);
      expect(r.provider).toBe("huggingface");
    }
  });

  it("respects the limit option", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        Array.from({ length: 10 }, (_, i) => ({
          id: `org/model-${i}-3B`,
          pipeline_tag: "text-generation",
          downloads: i,
        })),
    });

    const results = await findModels({ task: "chat", contextLength: 2048, limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("defaults limit to 5 when omitted", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        Array.from({ length: 10 }, (_, i) => ({
          id: `org/model-${i}-3B`,
          pipeline_tag: "text-generation",
          downloads: i,
        })),
    });

    const results = await findModels({ task: "chat", contextLength: 2048 });
    expect(results).toHaveLength(5);
  });

  it("throws InvalidQueryError before ever calling fetch", async () => {
    global.fetch = vi.fn();
    await expect(findModels({ task: "", contextLength: 2048 })).rejects.toThrow(InvalidQueryError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("propagates HuggingFace API errors instead of swallowing them (after exhausting retries)", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const promise = findModels({ task: "chat", contextLength: 2048 });
    promise.catch(() => {}); // avoid unhandled-rejection warning while timers advance
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    await expect(promise).rejects.toThrow();

    vi.useRealTimers();
  });

  it("returns an empty array (not an error) when nothing survives the filters", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "org/way-too-big-200B", pipeline_tag: "text-generation", downloads: 1 }],
    });

    const results = await findModels({ task: "chat", contextLength: 2048, maxParamsB: 7 });
    expect(results).toEqual([]);
  });

  it("(v0.2) results survive a simulated process restart via the file cache", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "org/model-5B", pipeline_tag: "text-generation", downloads: 42 }],
    });

    const first = await findModels({ task: "chat", contextLength: 2048, cacheOptions: { dir, ttlMs: 10_000 } });

    // Simulate a fresh process: reconfigure pointing at the same dir, don't clear it.
    configureCandidateModelsCache({ dir, ttlMs: 10_000 });
    const second = await findModels({ task: "chat", contextLength: 2048 });

    expect(global.fetch).toHaveBeenCalledTimes(1); // second call served from disk, not a new fetch
    expect(second).toEqual(first);
  });

  it("(v0.2) applies maxLatencyMs as a real filter when benchmark data + hardware are given", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        // benchmarked at 9800ms on cpu in the shipped dataset
        { id: "meta-llama/Llama-3-8B-Instruct", pipeline_tag: "text-generation", downloads: 100 },
      ],
    });

    const results = await findModels({
      task: "chat",
      contextLength: 2048,
      hardware: "cpu",
      maxLatencyMs: 2000,
    });

    expect(results).toEqual([]); // excluded — 9800ms > 2000ms budget on cpu
  });
});
