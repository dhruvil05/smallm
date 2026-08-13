import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FileTTLCache,
  fetchCandidateModelsCached,
  clearCandidateModelsCache,
  configureCandidateModelsCache,
} from "../src/cache-file";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smallm-cache-test-"));
}

describe("FileTTLCache", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a missing key", () => {
    const cache = new FileTTLCache<number>({ dir, ttlMs: 10_000 });
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a stored value before it expires", () => {
    const cache = new FileTTLCache<{ a: number }>({ dir, ttlMs: 10_000 });
    cache.set("key", { a: 42 });
    expect(cache.get("key")).toEqual({ a: 42 });
  });

  it("(the whole point) survives being re-instantiated, simulating a process restart", () => {
    const cacheBeforeRestart = new FileTTLCache<string[]>({ dir, ttlMs: 10_000 });
    cacheBeforeRestart.set("models:chat", ["model-a", "model-b"]);

    // Simulate a fresh process: brand new instance pointed at the same dir.
    const cacheAfterRestart = new FileTTLCache<string[]>({ dir, ttlMs: 10_000 });
    expect(cacheAfterRestart.get("models:chat")).toEqual(["model-a", "model-b"]);
  });

  it("expires values after the TTL", () => {
    vi.useFakeTimers();
    const cache = new FileTTLCache<number>({ dir, ttlMs: 1000 });
    cache.set("a", 42);
    vi.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeUndefined();
    vi.useRealTimers();
  });

  it("clear() removes all entries", () => {
    const cache = new FileTTLCache<number>({ dir, ttlMs: 10_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("treats a corrupted cache file as a miss instead of throwing", () => {
    const cache = new FileTTLCache<number>({ dir, ttlMs: 10_000 });
    cache.set("a", 1);

    // Corrupt the underlying file directly.
    const files = fs.readdirSync(dir);
    fs.writeFileSync(path.join(dir, files[0]), "{not valid json");

    expect(() => cache.get("a")).not.toThrow();
    expect(cache.get("a")).toBeUndefined();
  });

  it("creates the cache directory if it doesn't exist yet", () => {
    const nestedDir = path.join(dir, "nested", "cache", "dir");
    expect(fs.existsSync(nestedDir)).toBe(false);
    new FileTTLCache<number>({ dir: nestedDir, ttlMs: 10_000 });
    expect(fs.existsSync(nestedDir)).toBe(true);
  });
});

describe("fetchCandidateModelsCached (file-backed)", () => {
  const originalFetch = global.fetch;
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    configureCandidateModelsCache({ dir, ttlMs: 10_000 });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "org/model-7B", pipeline_tag: "text-generation", downloads: 10 }],
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
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

  it("clearCandidateModelsCache() forces a fresh fetch afterward", async () => {
    await fetchCandidateModelsCached("chat");
    clearCandidateModelsCache();
    await fetchCandidateModelsCached("chat");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
