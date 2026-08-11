import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchCandidateModels, mapTaskToPipelineTag, HuggingFaceApiError } from "../src/registry/huggingface";

describe("mapTaskToPipelineTag", () => {
  it("maps known task values to HF pipeline tags", () => {
    expect(mapTaskToPipelineTag("chat")).toBe("text-generation");
    expect(mapTaskToPipelineTag("summarize")).toBe("summarization");
    expect(mapTaskToPipelineTag("classify")).toBe("text-classification");
    expect(mapTaskToPipelineTag("extract")).toBe("token-classification");
    expect(mapTaskToPipelineTag("translate")).toBe("translation");
    expect(mapTaskToPipelineTag("code")).toBe("text-generation");
  });

  it("passes through unknown/custom task strings unchanged", () => {
    expect(mapTaskToPipelineTag("some-custom-task")).toBe("some-custom-task");
  });
});

describe("fetchCandidateModels", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches and maps candidate models on success", async () => {
    const mockResponse = [
      { id: "meta-llama/Llama-3-8B-Instruct", pipeline_tag: "text-generation", tags: ["chat"], downloads: 1000 },
      { id: "some-org/tiny-model", pipeline_tag: "text-generation", downloads: 50 },
    ];

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await fetchCandidateModels("chat");

    expect(global.fetch).toHaveBeenCalledOnce();
    const calledUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain("huggingface.co/api/models");
    expect(calledUrl).toContain("pipeline_tag=text-generation");

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("meta-llama/Llama-3-8B-Instruct");
    expect(result[1].tags).toEqual([]); // defaults missing tags to empty array
  });

  it("throws HuggingFaceApiError on non-200 response", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
    });

    await expect(fetchCandidateModels("chat")).rejects.toThrow(HuggingFaceApiError);
  });

  it("does not swallow the error status", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
    });

    try {
      await fetchCandidateModels("chat");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HuggingFaceApiError);
      expect((err as HuggingFaceApiError).status).toBe(500);
    }
  });
});
