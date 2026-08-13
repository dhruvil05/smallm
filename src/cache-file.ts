import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { CacheOptions, HFModel } from "./types";
import { fetchCandidateModels } from "./registry/huggingface";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes — same default as MVP's in-memory cache
const DEFAULT_DIR = path.join(os.tmpdir(), "smallm-cache");

interface FileCacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * File-based TTL cache — same conceptual interface as MVP's in-memory
 * TTLCache (get/set/clear), but each entry is a JSON file on disk, so it
 * survives process restarts. No database engine, per the v0.2 guide's
 * explicit "don't introduce SQLite/Postgres/etc." rule — this is still a
 * small library, not a service.
 */
export class FileTTLCache<T> {
  private dir: string;
  private ttlMs: number;

  constructor(options: CacheOptions = {}) {
    this.dir = options.dir ?? DEFAULT_DIR;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Maps a cache key to a safe filename (keys can contain arbitrary characters). */
  private filePathFor(key: string): string {
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    return path.join(this.dir, `${hash}.json`);
  }

  get(key: string): T | undefined {
    const filePath = this.filePathFor(key);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      return undefined; // file doesn't exist — not cached
    }

    let entry: FileCacheEntry<T>;
    try {
      entry = JSON.parse(raw);
    } catch {
      // Corrupted cache file — treat as a miss rather than crashing the caller.
      this.deleteFile(filePath);
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.deleteFile(filePath);
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: T): void {
    const filePath = this.filePathFor(key);
    const entry: FileCacheEntry<T> = { value, expiresAt: Date.now() + this.ttlMs };
    fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");
  }

  clear(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (file.endsWith(".json")) {
        this.deleteFile(path.join(this.dir, file));
      }
    }
  }

  private deleteFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone — fine
    }
  }
}

// Module-level singleton, matching MVP's cache.ts pattern. Options are
// applied on first use; call configureCandidateModelsCache() before the
// first findModels() call if you need non-default dir/ttl.
let candidateModelsCache: FileTTLCache<HFModel[]> | undefined;

/** Sets (or resets) the cache options used by fetchCandidateModelsCached. */
export function configureCandidateModelsCache(options: CacheOptions = {}): void {
  candidateModelsCache = new FileTTLCache<HFModel[]>(options);
}

function getCache(): FileTTLCache<HFModel[]> {
  if (!candidateModelsCache) {
    candidateModelsCache = new FileTTLCache<HFModel[]>();
  }
  return candidateModelsCache;
}

/**
 * (v0.2) Cached wrapper around fetchCandidateModels, backed by the
 * file-based cache instead of MVP's in-memory Map. Same call-site shape as
 * MVP's cache.ts — index.ts swaps its import and nothing else changes.
 */
export async function fetchCandidateModelsCached(task: string): Promise<HFModel[]> {
  const cache = getCache();
  const cached = cache.get(task);
  if (cached) return cached;

  const result = await fetchCandidateModels(task);
  cache.set(task, result);
  return result;
}

/** Exposed for tests that need to reset cache state between runs. */
export function clearCandidateModelsCache(): void {
  getCache().clear();
}
