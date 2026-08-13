import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchCandidateModels, mapTaskToPipelineTag, HuggingFaceApiError } from "../src/registry/huggingface";
import { HFApiError, RateLimitError, ValidationError } from "../src/errors";

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
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper: starts the given async operation, immediately attaches a silent
   * catch (so fake-timer advancement doesn't trigger an unhandled-rejection
   * warning before the real assertion attaches its own handler), then flushes
   * timers so backoff sleeps resolve.
   */
  async function runWithFakeTimers<T>(startOperation: () => Promise<T>): Promise<T> {
    const promise = startOperation();
    promise.catch(() => {}); // prevent spurious unhandled-rejection warning
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    return promise;
  }

  it("fetches and maps candidate models on success (no retry needed)", async () => {
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

  it("throws a typed error (backward-compat: HuggingFaceApiError === HFApiError) on a non-transient 4xx", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 404 });

    await expect(fetchCandidateModels("chat")).rejects.toThrow(HuggingFaceApiError);
    expect(global.fetch).toHaveBeenCalledTimes(1); // 404 is not transient — no retry
  });

  it("does not swallow the error status on non-transient failure", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 400 });

    try {
      await fetchCandidateModels("chat");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HFApiError);
      expect((err as HFApiError).status).toBe(400);
    }
  });

  it("(v0.2) throws RateLimitError specifically on a 429", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 429 });

    await expect(runWithFakeTimers(() => fetchCandidateModels("chat"))).rejects.toBeInstanceOf(RateLimitError);
  });

  it("(v0.2) retries on 429, then succeeds if a later attempt works", async () => {
    let callCount = 0;
    (global.fetch as any).mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return { ok: false, status: 429 };
      }
      return {
        ok: true,
        json: async () => [{ id: "org/model", pipeline_tag: "text-generation", downloads: 1 }],
      };
    });

    const result = await runWithFakeTimers(() => fetchCandidateModels("chat"));

    expect(callCount).toBe(3); // failed twice, succeeded on 3rd
    expect(result).toHaveLength(1);
  });

  it("(v0.2) retries on 5xx up to MAX_RETRIES then surfaces the error", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 503 });

    await expect(runWithFakeTimers(() => fetchCandidateModels("chat"))).rejects.toBeInstanceOf(HFApiError);

    // 1 initial attempt + 3 retries = 4 total calls
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("(v0.2) does NOT retry on non-transient 4xx errors", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 401 });

    await expect(fetchCandidateModels("chat")).rejects.toBeInstanceOf(HFApiError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("ValidationError is distinct from HFApiError", () => {
  it("confirms the two error families don't cross-match instanceof checks", () => {
    const validation = new ValidationError("bad query");
    const hfApi = new HFApiError("api down", 500);
    expect(validation).not.toBeInstanceOf(HFApiError);
    expect(hfApi).not.toBeInstanceOf(ValidationError);
  });
});
