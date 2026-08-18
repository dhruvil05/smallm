import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs, formatTable, main, CliUsageError, USAGE } from "../src/cli";
import { ModelMatch } from "../src/types";

describe("parseArgs", () => {
  it("maps --task and --context to the required ModelQuery fields", () => {
    const { query } = parseArgs(["--task", "chat", "--context", "4096"]);
    expect(query.task).toBe("chat");
    expect(query.contextLength).toBe(4096);
  });

  it("maps every optional flag 1:1 to its ModelQuery field", () => {
    const { query } = parseArgs([
      "--task", "chat",
      "--context", "4096",
      "--max-params", "7",
      "--domain", "medical",
      "--max-latency", "2000",
      "--scoring-mode", "hybrid",
      "--limit", "3",
    ]);
    expect(query.maxParamsB).toBe(7);
    expect(query.domain).toBe("medical");
    expect(query.maxLatencyMs).toBe(2000);
    expect(query.scoringMode).toBe("hybrid");
    expect(query.limit).toBe(3);
  });

  it("parses --providers as a comma-separated array", () => {
    const { query } = parseArgs(["--task", "chat", "--context", "4096", "--providers", "huggingface,ollama"]);
    expect(query.providers).toEqual(["huggingface", "ollama"]);
  });

  it("parses --hardware as the original string-enum form", () => {
    const { query } = parseArgs(["--task", "chat", "--context", "4096", "--hardware", "gpu-low"]);
    expect(query.hardware).toBe("gpu-low");
  });

  it("parses --hardware-type + --hardware-vram as the structured HardwareSpec form", () => {
    const { query } = parseArgs([
      "--task", "chat", "--context", "4096",
      "--hardware-type", "gpu", "--hardware-vram", "8",
    ]);
    expect(query.hardware).toEqual({ type: "gpu", vramGB: 8 });
  });

  it("omits vramGB from HardwareSpec when only --hardware-type is given", () => {
    const { query } = parseArgs(["--task", "chat", "--context", "4096", "--hardware-type", "cpu"]);
    expect(query.hardware).toEqual({ type: "cpu" });
  });

  it("structured hardware form takes precedence over the string form if both given", () => {
    const { query } = parseArgs([
      "--task", "chat", "--context", "4096",
      "--hardware", "gpu-low", "--hardware-type", "gpu", "--hardware-vram", "8",
    ]);
    expect(query.hardware).toEqual({ type: "gpu", vramGB: 8 });
  });

  it("parses --cache-dir and --cache-ttl into cacheOptions", () => {
    const { query } = parseArgs([
      "--task", "chat", "--context", "4096",
      "--cache-dir", "/tmp/my-cache", "--cache-ttl", "60000",
    ]);
    expect(query.cacheOptions).toEqual({ dir: "/tmp/my-cache", ttlMs: 60000 });
  });

  it("sets json: true only when --json is passed", () => {
    expect(parseArgs(["--task", "chat", "--context", "4096"]).json).toBe(false);
    expect(parseArgs(["--task", "chat", "--context", "4096", "--json"]).json).toBe(true);
  });

  it("sets showHelp: true for --help or -h", () => {
    expect(parseArgs(["--help"]).showHelp).toBe(true);
    expect(parseArgs(["-h"]).showHelp).toBe(true);
  });

  it("throws CliUsageError on an unknown flag — does NOT silently ignore it", () => {
    expect(() => parseArgs(["--task", "chat", "--context", "4096", "--bogus-flag"])).toThrow(CliUsageError);
  });

  it("throws CliUsageError when a flag is missing its value", () => {
    expect(() => parseArgs(["--task"])).toThrow(CliUsageError);
  });

  it("does NOT validate values itself — e.g. passes through a non-numeric --context as NaN for the library to reject", () => {
    // This is intentional: parseArgs is a thin mapper. Validation is the
    // library's job (validateQuery), not the CLI's — per the "no business
    // logic beyond flag parsing and output formatting" rule.
    const { query } = parseArgs(["--task", "chat", "--context", "not-a-number"]);
    expect(Number.isNaN(query.contextLength)).toBe(true);
  });

  it("never calls process.exit or touches the network — pure function", () => {
    const exitSpy = vi.spyOn(process, "exit");
    parseArgs(["--task", "chat", "--context", "4096"]);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe("formatTable", () => {
  const sampleResults: ModelMatch[] = [
    {
      name: "org/some-model-7b",
      provider: "huggingface",
      paramsB: 6.5,
      contextWindow: null,
      reasonWhy: "Strong task match, sufficient context window.",
      score: 87,
      scoringMode: "rule",
    },
  ];

  it("returns a friendly message for an empty result set", () => {
    expect(formatTable([])).toBe("No matching models found.");
  });

  it("includes a header row and every result's key fields", () => {
    const table = formatTable(sampleResults);
    expect(table).toContain("NAME");
    expect(table).toContain("PROVIDER");
    expect(table).toContain("SCORE");
    expect(table).toContain("org/some-model-7b");
    expect(table).toContain("huggingface");
    expect(table).toContain("87");
  });

  it("shows '?' for a null paramsB instead of 'null'", () => {
    const table = formatTable([{ ...sampleResults[0], paramsB: null }]);
    expect(table).toContain("?");
    expect(table).not.toContain("null");
  });

  it("truncates a very long reasonWhy rather than breaking table alignment", () => {
    const longReason = "x".repeat(200);
    const table = formatTable([{ ...sampleResults[0], reasonWhy: longReason }]);
    const lines = table.split("\n");
    // every row should be the same length (fixed-width columns + separators)
    const lengths = new Set(lines.map((l) => l.length));
    expect(lengths.size).toBe(1);
  });

  it("defaults MODE to 'rule' when scoringMode is undefined on a result", () => {
    const { scoringMode, ...withoutMode } = sampleResults[0];
    const table = formatTable([withoutMode as ModelMatch]);
    expect(table).toMatch(/rule/);
  });
});

describe("main (end-to-end, no business logic beyond parse+format)", () => {
  const originalFetch = global.fetch;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("prints usage and returns exit code 1 when called with no args", async () => {
    const code = await main([]);
    expect(code).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(USAGE);
  });

  it("prints usage and returns exit code 0 for --help", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(USAGE);
  });

  it("returns exit code 1 for an unknown command", async () => {
    const code = await main(["frobnicate"]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns exit code 1 and prints an error for an unknown flag", async () => {
    const code = await main(["find", "--task", "chat", "--context", "4096", "--bogus"]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("calls findModels() and prints a table by default on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "org/model-5B", pipeline_tag: "text-generation", downloads: 10 }],
    });

    const code = await main(["find", "--task", "chat", "--context", "2048"]);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("org/model-5B");
    expect(printed).toContain("SCORE");
  });

  it("prints raw JSON instead of a table when --json is passed", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "org/model-5B", pipeline_tag: "text-generation", downloads: 10 }],
    });

    const code = await main(["find", "--task", "chat", "--context", "2048", "--json"]);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(() => JSON.parse(printed)).not.toThrow();
    const parsed = JSON.parse(printed);
    expect(parsed[0].name).toBe("org/model-5B");
  });

  it("surfaces a library ValidationError as a clean CLI error, not a crash", async () => {
    const code = await main(["find", "--context", "2048"]); // missing required --task
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    const printedError = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printedError).toMatch(/task/i);
  });

  it("produces the exact same result set as calling findModels() directly with equivalent arguments", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "org/chat-model-6B", pipeline_tag: "text-generation", tags: ["chat"], downloads: 50 },
      ],
    });

    const { findModels } = await import("../src/index");
    const direct = await findModels({ task: "chat", contextLength: 4096, maxParamsB: 7 });

    const code = await main(["find", "--task", "chat", "--context", "4096", "--max-params", "7", "--json"]);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c) => c[0]).join("\n");
    const viaCli = JSON.parse(printed);

    expect(viaCli).toEqual(direct);
  });
});
