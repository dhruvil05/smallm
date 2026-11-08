import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readJsonWithLimit, ResponseTooLargeError } from "../src/http";
import { fetchCandidateModels } from "../src/registry/huggingface";
import { ollamaProvider } from "../src/registry/ollama";
import { validateQuery, MAX_TASK_LENGTH, MAX_DOMAIN_LENGTH } from "../src/query";
import { FileTTLCache, getOrFetchCached } from "../src/cache-file";
import { enrichWithParams, extractParamsB } from "../src/params";
import { isRawModelArray, MAX_CACHE_TTL_MS } from "../src/validate";
import { formatTable, parseArgs, CliUsageError } from "../src/cli";
import { findModels } from "../src/index";
import { HFApiError, SmallmError, ValidationError } from "../src/errors";

/**
 * Regression tests for the second (deeper) security pass: streamed body
 * caps, redirect policy, Ollama loopback address, query caps/dedupe/snapshot,
 * cache directory re-checks, sweeping, in-flight sharing, default-dir
 * fallback, linear-time size regex, Ollama sizes, invisible Unicode, CLI flags.
 */

const ch = (code: number) => String.fromCharCode(code);
const RLO = ch(0x202e); // right-to-left override
const ZWSP = ch(0x200b); // zero-width space
const LSEP = ch(0x2028); // line separator

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smallm-hard-test-"));
}

/** A real fetch Response streaming `totalBytes` in chunks with no content-length header. */
function chunkedResponse(totalBytes: number, chunkBytes = 64 * 1024): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const size = Math.min(chunkBytes, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(0x20));
      sent += size;
    },
  });
  return new Response(stream, { status: 200 });
}

describe("readJsonWithLimit", () => {
  it("parses a normal streamed body", async () => {
    expect(await readJsonWithLimit(new Response('[{"id":"a/b"}]'), 1024)).toEqual([{ id: "a/b" }]);
  });

  it("aborts a chunked body (no content-length) once it exceeds the cap", async () => {
    await expect(readJsonWithLimit(chunkedResponse(3 * 1024 * 1024), 1024 * 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("rejects early on an oversized declared content-length", async () => {
    const res = new Response("[]", { headers: { "content-length": String(10 * 1024 * 1024) } });
    await expect(readJsonWithLimit(res, 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe("HuggingFace network hardening", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects a huge chunked body with a typed, non-retried error", async () => {
    (global.fetch as any).mockImplementation(async () => chunkedResponse(8 * 1024 * 1024));
    await expect(fetchCandidateModels("chat")).rejects.toBeInstanceOf(HFApiError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("requests redirect: manual and refuses a redirect off HuggingFace", async () => {
    (global.fetch as any).mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }));
    await expect(fetchCandidateModels("chat")).rejects.toBeInstanceOf(HFApiError);
    expect((global.fetch as any).mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: "manual" }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an https→http downgrade even to a HuggingFace host", async () => {
    (global.fetch as any).mockResolvedValue(new Response(null, { status: 301, headers: { location: "http://huggingface.co/api/models" } }));
    await expect(fetchCandidateModels("chat")).rejects.toBeInstanceOf(HFApiError);
  });

  it("follows a redirect to another HTTPS HuggingFace host", async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://hf.co/api/models?x=1" } }))
      .mockResolvedValueOnce(new Response('[{"id":"org/m-1B","pipeline_tag":"text-generation"}]', { status: 200 }));
    const result = await fetchCandidateModels("chat");
    expect(result.map((m) => m.id)).toEqual(["org/m-1B"]);
    expect((global.fetch as any).mock.calls[1][0]).toBe("https://hf.co/api/models?x=1");
  });
});

describe("Ollama network hardening", () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  beforeEach(() => {
    global.fetch = vi.fn();
    console.warn = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    vi.restoreAllMocks();
  });

  it("calls the IPv4 loopback address (not 'localhost') and refuses redirects", async () => {
    (global.fetch as any).mockResolvedValue(new Response('{"models":[]}'));
    await ollamaProvider.listCandidates({ task: "chat", contextLength: 1 });
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/tags");
    expect(init).toEqual(expect.objectContaining({ redirect: "error" }));
  });

  it("returns [] (no crash, no OOM) for an oversized streamed body", async () => {
    (global.fetch as any).mockImplementation(async () => chunkedResponse(6 * 1024 * 1024));
    expect(await ollamaProvider.listCandidates({ task: "chat", contextLength: 1 })).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("query hardening", () => {
  const base = { task: "chat", contextLength: 2048 };

  it("caps task and domain length", () => {
    expect(() => validateQuery({ ...base, task: "x".repeat(MAX_TASK_LENGTH) })).not.toThrow();
    expect(() => validateQuery({ ...base, task: "x".repeat(MAX_TASK_LENGTH + 1) })).toThrow(ValidationError);
    expect(() => validateQuery({ ...base, domain: "d".repeat(MAX_DOMAIN_LENGTH + 1) })).toThrow(ValidationError);
  });

  it("de-duplicates providers, keeping order", () => {
    expect(validateQuery({ ...base, providers: ["ollama", "huggingface", "ollama", "huggingface"] }).providers).toEqual([
      "ollama",
      "huggingface",
    ]);
  });

  it("validates a snapshot, so a getter can't swap a value after it was checked", () => {
    let reads = 0;
    const tricky = {
      contextLength: 2048,
      get task() {
        reads++;
        return reads === 1 ? "chat" : "x".repeat(100000);
      },
    };
    const validated = validateQuery(tricky as never);
    expect(validated.task).toBe("chat");
    expect(reads).toBe(1);
  });

  it.runIf(process.platform === "win32")("rejects UNC / device cache paths on Windows", () => {
    for (const dir of ["\\\\attacker\\share\\x", "//attacker/share", "\\\\?\\C:\\x", "\\\\.\\pipe\\x"]) {
      expect(() => validateQuery({ ...base, cacheOptions: { dir } })).toThrow(ValidationError);
    }
  });

  it("findModels returns no duplicate results for repeated providers", async () => {
    const dir = tempDir();
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response('[{"id":"org/m-7B","pipeline_tag":"text-generation"}]')) as never;
    try {
      const r = await findModels({ ...base, providers: ["huggingface", "huggingface", "huggingface"], cacheOptions: { dir } });
      expect(r.map((m) => m.name)).toEqual(["org/m-7B"]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cache hardening (second pass)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("clamps an enormous TTL instead of letting entries live forever", () => {
    const cache = new FileTTLCache<number>({ dir, ttlMs: 1e300 });
    cache.set("k", 1);
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".json"))!;
    const { expiresAt } = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + MAX_CACHE_TTL_MS);
  });

  it("shares one upstream fetch between concurrent identical requests", async () => {
    const fetchFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return [{ id: "a/b" }];
    });
    await Promise.all(Array.from({ length: 25 }, () => getOrFetchCached("p:shared", fetchFn, { dir })));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejected in-flight fetch", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(getOrFetchCached("p:fail", failing, { dir })).rejects.toThrow("boom");
    const ok = vi.fn(async () => [{ id: "a/b" }]);
    await expect(getOrFetchCached("p:fail", ok, { dir })).resolves.toEqual([{ id: "a/b" }]);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("sweeps expired entries and stale temp files but nothing else", () => {
    const hex = (n: number) => n.toString(16).padStart(64, "0");
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    const expired = path.join(dir, `${hex(1)}.json`);
    const staleTemp = path.join(dir, `${hex(2)}.json.123.0123456789abcdef.tmp`);
    const unrelated = path.join(dir, "notes.json");
    for (const f of [expired, staleTemp, unrelated]) {
      fs.writeFileSync(f, "{}");
      fs.utimesSync(f, old, old);
    }

    new FileTTLCache<number>({ dir, ttlMs: 60_000 }).set("fresh", 1);

    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(staleTemp)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f))).toHaveLength(1);
  });

  it("caps the number of live cache files", () => {
    const hex = (n: number) => n.toString(16).padStart(64, "0");
    for (let i = 0; i < 1010; i++) fs.writeFileSync(path.join(dir, `${hex(i + 10)}.json`), "{}");
    new FileTTLCache<number>({ dir, ttlMs: 60 * 60 * 1000 }).set("new", 1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBeLessThanOrEqual(1000);
  });

  it("re-creates a cache directory that disappeared after construction", () => {
    const sub = path.join(dir, "cache");
    const cache = new FileTTLCache<number>({ dir: sub, ttlMs: 10_000 });
    fs.rmSync(sub, { recursive: true, force: true });
    cache.set("k", 7);
    expect(cache.get("k")).toBe(7);
  });

  it("wraps filesystem failures in a SmallmError that doesn't reveal the path", () => {
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "x");
    let caught: unknown;
    try {
      new FileTTLCache<number>({ dir: path.join(file, "sub") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmallmError);
    expect((caught as Error).message).not.toContain(dir);
    expect((caught as Error).message).not.toContain(os.userInfo().username);
  });

  it("falls back to an in-memory cache when the default directory is unusable", async () => {
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const originalXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = blocker; // default dir becomes <file>/smallm → ENOTDIR
    vi.resetModules();
    try {
      const fresh = await import("../src/cache-file");
      const fetchFn = vi.fn(async () => [{ id: "a/b" }]);
      await expect(fresh.getOrFetchCached("k", fetchFn)).resolves.toEqual([{ id: "a/b" }]);
      await fresh.getOrFetchCached("k", fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(1); // second call served from memory
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = originalXdg;
      vi.resetModules();
    }
  });
});

describe("params regex", () => {
  const OLD = /(\d+(?:\.\d+)?)[\-_]?[bB](?![a-zA-Z0-9])/;

  it("is linear-time on long digit runs", () => {
    const start = Date.now();
    extractParamsB({ id: "1".repeat(50_000) });
    expect(Date.now() - start).toBeLessThan(200); // was ~13 s
  });

  it("gives the same result as the previous regex on varied ids", () => {
    const samples = [
      "meta-llama/Llama-3-8B-Instruct", "org/model-7B", "x-1.1B", "Qwen2.5-0.5B", "phi-3_mini-3.8b", "model.7B",
      "bert-base", "B16-model", "70B-Instruct", "123.4.5B", "a12b", "v2-13b-chat", "12_B", "1.5.5B", "x9.99B-y", "7Bx",
    ];
    for (const id of samples) {
      const m = id.match(OLD);
      const expected = m ? parseFloat(m[1]) : null;
      expect(extractParamsB({ id }).paramsB, id).toBe(expected);
    }
  });
});

describe("Ollama-reported sizes", () => {
  it("enrichWithParams keeps a provider-reported size", () => {
    const [m] = enrichWithParams([{ id: "llama3:latest", provider: "ollama", paramsB: 70, paramsSource: "tag" }]);
    expect(m.paramsB).toBe(70);
  });

  it("maxParamsB now excludes a 70B Ollama model with no size in its name", async () => {
    const dir = tempDir();
    const originalFetch = global.fetch;
    const originalWarn = console.warn;
    console.warn = vi.fn();
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "llama3:latest", details: { parameter_size: "70.6B" } }, { name: "tiny:latest", details: { parameter_size: "1.1B" } }] }))
    ) as never;
    try {
      const r = await findModels({ task: "chat", contextLength: 1, providers: ["ollama"], maxParamsB: 7, cacheOptions: { dir } });
      expect(r.map((x) => x.name)).toEqual(["tiny:latest"]);
    } finally {
      global.fetch = originalFetch;
      console.warn = originalWarn;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("invisible / reordering Unicode", () => {
  it("validators reject bidi overrides, zero-width chars and line separators", () => {
    for (const id of [`org/${RLO}ldom`, `org${ZWSP}/llama`, `a${LSEP}b`]) {
      expect(isRawModelArray([{ id }]), JSON.stringify(id)).toBe(false);
    }
  });

  it("CLI table strips them", () => {
    const out = formatTable([{ name: `evil${RLO}gnp.exe${ZWSP}`, provider: "ollama", paramsB: 1, contextWindow: null, reasonWhy: `ok${LSEP}`, score: 1 }]);
    for (const c of [RLO, ZWSP, LSEP]) expect(out.includes(c)).toBe(false);
  });
});

describe("CLI flag handling", () => {
  it("rejects --hardware-vram without --hardware-type instead of silently dropping it", () => {
    expect(() => parseArgs(["--task", "chat", "--context", "1", "--hardware-vram", "8"])).toThrow(CliUsageError);
  });

  it("does not take the next --flag as a value", () => {
    expect(() => parseArgs(["--task", "--json", "--context", "1"])).toThrow(CliUsageError);
  });

  it("still accepts negative-looking values (single dash) for library validation", () => {
    expect(parseArgs(["--task", "chat", "--context", "-5"]).query.contextLength).toBe(-5);
  });

  it("warns (keeping documented precedence) when both hardware forms are given", () => {
    const parsed = parseArgs(["--task", "chat", "--context", "1", "--hardware", "gpu-low", "--hardware-type", "gpu", "--max-latency", "100"]);
    expect(parsed.query.hardware).toEqual({ type: "gpu" });
    expect(parsed.warnings.join(" ")).toMatch(/ignored/);
    expect(parsed.warnings.join(" ")).toMatch(/max-latency/);
  });
});
