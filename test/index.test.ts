import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findModels } from "../src/index";
import { clearCandidateModelsCache } from "../src/cache";
import { InvalidQueryError } from "../src/query";

describe("findModels (integration)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearCandidateModelsCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
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

  it("propagates HuggingFace API errors instead of swallowing them", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(findModels({ task: "chat", contextLength: 2048 })).rejects.toThrow();
  });

  it("returns an empty array (not an error) when nothing survives the filters", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "org/way-too-big-200B", pipeline_tag: "text-generation", downloads: 1 }],
    });

    const results = await findModels({ task: "chat", contextLength: 2048, maxParamsB: 7 });
    expect(results).toEqual([]);
  });
});
