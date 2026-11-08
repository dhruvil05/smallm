import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { FileTTLCache, getOrFetchCached, defaultCacheDir, configureCandidateModelsCache } from "../src/cache-file";
import { validateQuery } from "../src/query";
import { fetchCandidateModels, mapTaskToPipelineTag } from "../src/registry/huggingface";
import { ollamaProvider } from "../src/registry/ollama";
import { HFApiError, SmallmError, ValidationError } from "../src/errors";
import { formatTable } from "../src/cli";
import { isRawModelArray } from "../src/validate";

/**
 * Regression tests for the security review fixes: cache poisoning / symlink
 * clobbering, unsafe clear(), unvalidated remote data, missing timeouts,
 * NaN validation gaps, inherited-property task lookup, terminal escapes.
 */

const isPosix = process.platform !== "win32";
const hashFile = (key: string) => crypto.createHash("sha256").update(key).digest("hex") + ".json";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smallm-sec-test-"));
}

describe("file cache hardening", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("default cache dir is per-user, not the shared OS temp dir", () => {
    if (!os.homedir()) return; // fallback path is only used without a home dir
    // The test setup points XDG_CACHE_HOME at a temp dir; check the real default.
    const savedXdg = process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CACHE_HOME;
    try {
      const dflt = path.resolve(defaultCacheDir());
      expect(dflt.startsWith(path.resolve(os.tmpdir()))).toBe(false);
    } finally {
      if (savedXdg !== undefined) process.env.XDG_CACHE_HOME = savedXdg;
    }
  });

  it("rejects a planted entry whose expiry exceeds the TTL (permanent poisoning)", async () => {
    const planted = { value: [{ id: "evil/backdoored-7B", provider: "huggingface", tags: [], downloads: 9e9 }], expiresAt: 8.64e15 };
    fs.writeFileSync(path.join(dir, hashFile("huggingface:chat")), JSON.stringify(planted));

    const fetchFn = vi.fn().mockResolvedValue([{ id: "real/model-1B", provider: "huggingface" }]);
    const result = await getOrFetchCached("huggingface:chat", fetchFn, { dir, ttlMs: 10_000 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result[0].id).toBe("real/model-1B");
  });

  it("rejects a cache entry with a malformed value instead of crashing downstream", async () => {
    const planted = { value: [{ id: 123, tags: "not-an-array" }], expiresAt: Date.now() + 1000 };
    fs.writeFileSync(path.join(dir, hashFile("huggingface:code")), JSON.stringify(planted));

    const fetchFn = vi.fn().mockResolvedValue([{ id: "real/model-1B" }]);
    await getOrFetchCached("huggingface:code", fetchFn, { dir, ttlMs: 10_000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("clear() deletes only cache-owned files, never other .json files in the dir", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const cache = new FileTTLCache<number>({ dir, ttlMs: 10_000 });
    cache.set("a", 1);
    cache.clear();
    expect(fs.existsSync(path.join(dir, "package.json"))).toBe(true);
    expect(cache.get("a")).toBeUndefined();
  });

  it("set() replaces a planted symlink instead of writing through it", () => {
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "original");
    const cacheDir = path.join(dir, "cache");
    fs.mkdirSync(cacheDir, { mode: 0o700 });
    try {
      fs.symlinkSync(victim, path.join(cacheDir, hashFile("k")));
    } catch {
      return; // symlink creation needs privileges on Windows — nothing to test there
    }

    new FileTTLCache<number>({ dir: cacheDir, ttlMs: 10_000 }).set("k", 1);
    expect(fs.readFileSync(victim, "utf-8")).toBe("original");
  });

  it("get() does not follow a symlinked entry", () => {
    const target = path.join(dir, "target.json");
    fs.writeFileSync(target, JSON.stringify({ value: 42, expiresAt: Date.now() + 1000 }));
    const cacheDir = path.join(dir, "cache");
    fs.mkdirSync(cacheDir, { mode: 0o700 });
    try {
      fs.symlinkSync(target, path.join(cacheDir, hashFile("k")));
    } catch {
      return;
    }
    expect(new FileTTLCache<number>({ dir: cacheDir, ttlMs: 10_000 }).get("k")).toBeUndefined();
  });

  it.runIf(isPosix)("writes cache files with owner-only permissions", () => {
    const cache = new FileTTLCache<number>({ dir, ttlMs: 10_000 });
    cache.set("a", 1);
    const mode = fs.statSync(path.join(dir, hashFile("a"))).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it.runIf(isPosix)("refuses a world-writable cache directory", () => {
    fs.chmodSync(dir, 0o777);
    expect(() => new FileTTLCache<number>({ dir })).toThrow(SmallmError);
  });

  it("rejects invalid cache options at construction", () => {
    expect(() => new FileTTLCache<number>({ dir, ttlMs: NaN })).toThrow(ValidationError);
    expect(() => new FileTTLCache<number>({ dir, ttlMs: -1 })).toThrow(ValidationError);
    expect(() => new FileTTLCache<number>({ dir: "" })).toThrow(ValidationError);
  });

  it("per-call cacheOptions do not replace the default cache for later calls", async () => {
    const defaultDir = tempDir();
    try {
      configureCandidateModelsCache({ dir: defaultDir, ttlMs: 10_000 });
      await getOrFetchCached("x:task", async () => [{ id: "a/b" }], { dir, ttlMs: 10_000 });
      await getOrFetchCached("x:task2", async () => [{ id: "c/d" }]);
      expect(fs.readdirSync(defaultDir)).toContain(hashFile("x:task2"));
      expect(fs.readdirSync(dir)).not.toContain(hashFile("x:task2"));
    } finally {
      fs.rmSync(defaultDir, { recursive: true, force: true });
    }
  });
});

describe("isRawModelArray", () => {
  it("accepts well-formed models and rejects bad shapes and control characters", () => {
    expect(isRawModelArray([{ id: "org/m-7B", tags: ["a"], downloads: 1, paramsB: 7, contextWindow: null }])).toBe(true);
    expect(isRawModelArray("nope")).toBe(false);
    expect(isRawModelArray([{ id: "evil\u001b[2Jname" }])).toBe(false);
    expect(isRawModelArray([{ id: "ok", downloads: Infinity }])).toBe(false);
    expect(isRawModelArray([{ id: "ok", provider: "elsewhere" }])).toBe(false);
  });
});

describe("query validation", () => {
  const base = { task: "chat", contextLength: 2048 };

  it.each([
    ["maxParamsB NaN", { maxParamsB: NaN }],
    ["maxParamsB Infinity", { maxParamsB: Infinity }],
    ["maxLatencyMs NaN", { maxLatencyMs: NaN }],
    ["vramGB NaN", { hardware: { type: "gpu", vramGB: NaN } }],
    ["cacheOptions not an object", { cacheOptions: "x" }],
    ["cacheOptions.dir not a string", { cacheOptions: { dir: 123 } }],
    ["cacheOptions.dir with null byte", { cacheOptions: { dir: "a\0b" } }],
    ["cacheOptions.ttlMs NaN", { cacheOptions: { ttlMs: NaN } }],
    ["cacheOptions.ttlMs negative", { cacheOptions: { ttlMs: -5 } }],
  ])("rejects %s", (_label, extra) => {
    expect(() => validateQuery({ ...base, ...(extra as object) } as never)).toThrow(ValidationError);
  });

  it("still accepts valid cacheOptions", () => {
    expect(() => validateQuery({ ...base, cacheOptions: { dir: "/some/dir", ttlMs: 0 } })).not.toThrow();
  });
});

describe("task lookup", () => {
  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])("passes %s through as a plain string", (task) => {
    expect(mapTaskToPipelineTag(task)).toBe(task);
  });
});

describe("HuggingFace response handling", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes an abort signal (request timeout) to fetch", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => [] });
    await fetchCandidateModels("chat");
    expect((global.fetch as any).mock.calls[0][1]).toEqual(expect.objectContaining({ signal: expect.anything() }));
  });

  it("throws a typed HFApiError for a non-array body", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ error: "x" }) });
    await expect(fetchCandidateModels("chat")).rejects.toBeInstanceOf(HFApiError);
  });

  it("throws a typed HFApiError for invalid JSON", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError("bad"); } });
    await expect(fetchCandidateModels("chat")).rejects.toBeInstanceOf(HFApiError);
  });

  it("rejects an oversized response by content-length", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === "content-length" ? String(100 * 1024 * 1024) : null) },
      json: async () => [],
    });
    await expect(fetchCandidateModels("chat")).rejects.toBeInstanceOf(HFApiError);
  });

  it("drops malformed items and sanitizes fields", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "good/model-1B", tags: ["en", 5, "evil\u001b[31m"], downloads: "lots", pipeline_tag: 7 },
        { id: 42 },
        null,
        { id: "bad\u001b]0;pwned\u0007" },
      ],
    });
    const result = await fetchCandidateModels("chat");
    expect(result).toEqual([
      { id: "good/model-1B", provider: "huggingface", pipeline_tag: undefined, tags: ["en"], downloads: 0 },
    ]);
  });

  it("wraps network failures in HFApiError and retries them", async () => {
    vi.useFakeTimers();
    (global.fetch as any).mockRejectedValue(new TypeError("fetch failed"));
    const promise = fetchCandidateModels("chat");
    promise.catch(() => {});
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).rejects.toBeInstanceOf(HFApiError);
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});

describe("Ollama response handling", () => {
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

  it("returns [] for a non-array models field", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ models: "nope" }) });
    expect(await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 })).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("returns [] for a null body", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => null });
    expect(await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 })).toEqual([]);
  });

  it("drops entries with unsafe names and non-string families", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: "llama3:8b", details: { parameter_size: "8B", families: ["llama", 1] } },
          { name: "x\u001b[2J" },
          { name: 5 },
        ],
      }),
    });
    const result = await ollamaProvider.listCandidates({ task: "chat", contextLength: 2048 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "llama3:8b", tags: ["llama"], paramsB: 8 });
  });
});

describe("CLI output", () => {
  it("strips terminal escape sequences from table output", () => {
    const out = formatTable([
      { name: "evil\u001b[2J\u001b]0;pwned\u0007", provider: "huggingface", paramsB: 1, contextWindow: null, reasonWhy: "ok\u009b31m", score: 50 },
    ]);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });
});
