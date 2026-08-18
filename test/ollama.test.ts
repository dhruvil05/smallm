import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ollamaProvider } from "../src/registry/ollama";

describe("ollamaProvider", () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;

  beforeEach(() => {
    global.fetch = vi.fn();
    console.warn = vi.fn(); // silence expected warnings in test output
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    vi.restoreAllMocks();
  });

  it("implements the Provider interface with name 'ollama'", () => {
    expect(ollamaProvider.name).toBe("ollama");
    expect(typeof ollamaProvider.listCandidates).toBe("function");
  });

  it("fetches from the local Ollama API and maps results to RawModel", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: "llama3:8b",
            model: "llama3:8b",
            details: { parameter_size: "8B", families: ["llama"], quantization_level: "Q4_0" },
          },
          {
            name: "tinyllama:latest",
            model: "tinyllama:latest",
            details: { parameter_size: "1.1B", families: ["llama"] },
          },
        ],
      }),
    });

    const results = await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 });

    expect(global.fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "llama3:8b",
      provider: "ollama",
      paramsB: 8,
      paramsSource: "tag",
      tags: ["llama"],
      pipeline_tag: undefined,
      contextWindow: null,
    });
    expect(results[1].paramsB).toBe(1.1);
  });

  it("returns paramsB: null with paramsSource 'unknown' when parameter_size is missing", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "mystery-model", details: {} }] }),
    });

    const results = await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 });
    expect(results[0].paramsB).toBeNull();
    expect(results[0].paramsSource).toBe("unknown");
  });

  it("(graceful degradation) returns an empty array, doesn't throw, when the connection fails", async () => {
    (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));

    const results = await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 });
    expect(results).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("(graceful degradation) returns an empty array, doesn't throw, on a non-2xx response", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 500 });

    const results = await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 });
    expect(results).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("(graceful degradation) returns an empty array, doesn't throw, on malformed JSON", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("invalid json");
      },
    });

    const results = await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 });
    expect(results).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("handles an empty models list from a running-but-empty Ollama installation", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });

    const results = await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 });
    expect(results).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled(); // this is a normal, not-erroring case
  });

  it("never attempts to pull, install, or download a model — only ever calls GET /api/tags", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });

    await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags");
  });
});
