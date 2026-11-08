import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { CacheOptions, HFModel } from "./types";
import { SmallmError } from "./errors";
import { fetchCandidateModels } from "./registry/huggingface";
import { isRawModelArray, validateCacheOptions, MAX_CACHE_TTL_MS } from "./validate";
import { TTLCache } from "./cache";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes — same default as MVP's in-memory cache

/** Cache files larger than this are ignored — a legit candidate list is a few KB. */
const MAX_CACHE_FILE_BYTES = 5 * 1024 * 1024;

/** Expired files are swept at most this often per cache instance (on set). */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** After sweeping expired files, keep at most this many (oldest removed first). */
const MAX_CACHE_FILES = 1000;
/** Leftover temp files (from a crash mid-write) older than this are removed by the sweep. */
const STALE_TEMP_MS = 60 * 1000;

/** Only files matching these are ever read or deleted by the cache — see clear()/sweep(). */
const CACHE_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;
const TEMP_FILE_PATTERN = /^[0-9a-f]{64}\.json\.\d+\.[0-9a-f]{16}\.tmp$/;

/**
 * Open flags for reading an entry: never follow a symlink (ELOOP instead)
 * and never block on a FIFO. Both constants are POSIX-only; on Windows they
 * are undefined and the lstat pre-check in readEntryFile() is what applies.
 */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

const isPosix = process.platform !== "win32" && typeof process.getuid === "function";

/**
 * Per-user cache directory. Deliberately NOT os.tmpdir(): on Linux/macOS
 * that is shared and world-writable (/tmp), which let any local user
 * pre-create the cache dir and plant poisoned entries or symlinks.
 */
export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "smallm");

  let home = "";
  try {
    home = os.homedir();
  } catch {
    // Some sandboxes have no passwd entry; fall through to the temp fallback.
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
    if (localAppData) return path.join(localAppData, "smallm", "cache");
  } else if (process.platform === "darwin" && home) {
    return path.join(home, "Library", "Caches", "smallm");
  } else if (home) {
    return path.join(home, ".cache", "smallm");
  }

  // No home directory at all (rare: some containers). Fall back to temp, but
  // namespaced per user; ensureSafeDir() still verifies ownership.
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `smallm-cache-${uid}`);
}

function unsafeDir(reason: string): SmallmError {
  return new SmallmError(
    `Refusing to use the cache directory: it ${reason}. Pass a different cacheOptions.dir / --cache-dir.`
  );
}

/**
 * Creates the directory (0700) if needed and refuses one another user could
 * tamper with. On POSIX:
 *   - a symlink at the path itself must be owned by the current user
 *     (blocks an attacker pre-creating the path as a link to elsewhere);
 *   - the target must be a directory owned by the current user;
 *   - the default directory is forced to 0700; a caller-chosen directory
 *     must not be world-writable (group-writable is allowed so that
 *     user-private-group setups with umask 002 keep working).
 * Windows: the default location (%LOCALAPPDATA%) is protected by per-user
 * ACLs. Node has no ACL API, so caller-chosen Windows paths are not checked
 * — documented in CacheOptions.dir.
 * Every failure is a SmallmError whose message does not include the path.
 */
function ensureSafeDir(dir: string, isDefault: boolean): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const linkStat = fs.lstatSync(dir);
    if (linkStat.isSymbolicLink() && isPosix && linkStat.uid !== process.getuid!()) {
      throw unsafeDir("is a symlink owned by another user");
    }
    const stat = linkStat.isSymbolicLink() ? fs.statSync(dir) : linkStat;
    if (!stat.isDirectory()) {
      throw unsafeDir("is not a directory");
    }

    if (isPosix) {
      if (stat.uid !== process.getuid!()) {
        throw unsafeDir("is owned by another user");
      }
      if (isDefault && (stat.mode & 0o077) !== 0) {
        fs.chmodSync(dir, 0o700);
      } else if (!isDefault && (stat.mode & 0o002) !== 0) {
        throw unsafeDir("is world-writable");
      }
    }
  } catch (err) {
    if (err instanceof SmallmError) throw err;
    const code = (err as NodeJS.ErrnoException | null)?.code ?? "unknown error";
    const wrapped = new SmallmError(`Cannot use the cache directory (${code})`);
    (wrapped as { cause?: unknown }).cause = err;
    throw wrapped;
  }
}

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
 *
 * Hardening:
 *   - the directory is re-verified before every get/set (not just once), so
 *     a directory deleted and re-created by someone else is noticed;
 *   - entries are written atomically (exclusive-create temp file, mode
 *     0600, then rename — never follows a planted symlink);
 *   - reads open with O_NOFOLLOW|O_NONBLOCK and check the open descriptor,
 *     so a swap to a symlink/FIFO/device after the check doesn't matter,
 *     and read at most MAX_CACHE_FILE_BYTES;
 *   - entries whose expiry exceeds the TTL or whose value fails the
 *     validator are discarded;
 *   - expired files are swept periodically, with a file-count cap.
 */
export class FileTTLCache<T> {
  private dir: string;
  private ttlMs: number;
  private isDefaultDir: boolean;
  private validate?: (value: unknown) => value is T;
  private lastSweep = 0;

  constructor(options: CacheOptions = {}, validate?: (value: unknown) => value is T) {
    validateCacheOptions(options);
    this.isDefaultDir = options.dir === undefined;
    this.dir = path.resolve(options.dir ?? defaultCacheDir());
    // Clamp rather than reject, so existing callers with long TTLs keep working.
    this.ttlMs = Math.min(options.ttlMs ?? DEFAULT_TTL_MS, MAX_CACHE_TTL_MS);
    this.validate = validate;
    ensureSafeDir(this.dir, this.isDefaultDir);
  }

  /** Re-checks the directory; a failure makes get() miss and set() skip, never throw. */
  private dirIsUsable(): boolean {
    try {
      ensureSafeDir(this.dir, this.isDefaultDir);
      return true;
    } catch {
      return false;
    }
  }

  /** Maps a cache key to a safe filename (keys can contain arbitrary characters). */
  private filePathFor(key: string): string {
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    return path.join(this.dir, `${hash}.json`);
  }

  /** Reads an entry file safely, or returns undefined (and removes junk) if it isn't a small regular file. */
  private readEntryFile(filePath: string): string | undefined {
    let linkStat: fs.Stats;
    try {
      linkStat = fs.lstatSync(filePath);
    } catch {
      return undefined; // not cached
    }
    if (!linkStat.isFile() || linkStat.size > MAX_CACHE_FILE_BYTES) {
      this.deleteFile(filePath);
      return undefined;
    }

    let fd: number;
    try {
      fd = fs.openSync(filePath, READ_FLAGS);
    } catch {
      return undefined; // vanished, or swapped for a symlink (ELOOP)
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_CACHE_FILE_BYTES) return undefined;
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const n = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
        if (n === 0) break;
        offset += n;
      }
      if (offset > stat.size) return undefined; // grew while reading — not ours
      return buffer.subarray(0, offset).toString("utf-8");
    } catch {
      return undefined;
    } finally {
      fs.closeSync(fd);
    }
  }

  get(key: string): T | undefined {
    if (!this.dirIsUsable()) return undefined;
    const filePath = this.filePathFor(key);

    const raw = this.readEntryFile(filePath);
    if (raw === undefined) return undefined;

    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      // Corrupted cache file — treat as a miss rather than crashing the caller.
      this.deleteFile(filePath);
      return undefined;
    }

    if (typeof entry !== "object" || entry === null) {
      this.deleteFile(filePath);
      return undefined;
    }
    const { expiresAt, value } = entry as Partial<FileCacheEntry<unknown>>;

    const now = Date.now();
    const valid =
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      now <= expiresAt &&
      // An entry claiming to live longer than our TTL wasn't written by us — reject.
      expiresAt <= now + this.ttlMs &&
      (this.validate ? this.validate(value) : true);

    if (!valid) {
      this.deleteFile(filePath);
      return undefined;
    }

    return value as T;
  }

  /** Best-effort: a failed cache write never fails the caller. */
  set(key: string, value: T): void {
    if (!this.dirIsUsable()) return;
    const filePath = this.filePathFor(key);
    const entry: FileCacheEntry<T> = { value, expiresAt: Date.now() + this.ttlMs };
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;

    try {
      // "wx" = O_CREAT|O_EXCL: fails if anything (including a symlink) already exists at tempPath.
      fs.writeFileSync(tempPath, JSON.stringify(entry), { encoding: "utf-8", flag: "wx", mode: 0o600 });
      // rename replaces the destination entry itself — a symlink there is replaced, not followed.
      fs.renameSync(tempPath, filePath);
    } catch {
      this.deleteFile(tempPath);
    }

    this.sweep();
  }

  /**
   * Removes expired entries (by mtime) and stale temp files, then trims to
   * MAX_CACHE_FILES. Without this, an entry is only deleted if its exact key
   * is read again, so one-off keys accumulate forever.
   */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;

    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    const live: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const file of files) {
      const isEntry = CACHE_FILE_PATTERN.test(file);
      const isTemp = !isEntry && TEMP_FILE_PATTERN.test(file);
      if (!isEntry && !isTemp) continue;

      const filePath = path.join(this.dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filePath);
      } catch {
        continue;
      }
      const age = now - stat.mtimeMs;
      if (isTemp) {
        if (age > STALE_TEMP_MS) this.deleteFile(filePath);
      } else if (age > this.ttlMs) {
        this.deleteFile(filePath);
      } else {
        live.push({ filePath, mtimeMs: stat.mtimeMs });
      }
    }

    if (live.length > MAX_CACHE_FILES) {
      live.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const { filePath } of live.slice(0, live.length - MAX_CACHE_FILES)) this.deleteFile(filePath);
    }
  }

  /** Removes only files this cache created (hash-named entries and leftover temp files) — never anything else in the directory. */
  clear(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (CACHE_FILE_PATTERN.test(file) || TEMP_FILE_PATTERN.test(file)) {
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

/** What getOrFetchCached needs from a cache — satisfied by both FileTTLCache and the in-memory TTLCache. */
interface CandidateCache {
  get(key: string): HFModel[] | undefined;
  set(key: string, value: HFModel[]): void;
  clear(): void;
}

// Module-level default cache, matching MVP's cache.ts pattern. Created
// lazily on first use; configureCandidateModelsCache() replaces it.
let candidateModelsCache: CandidateCache | undefined;

/**
 * Caches for explicit per-call cacheOptions, keyed by (dir, ttl). Per-call
 * options never overwrite the module-level default, so one caller's
 * options can't leak into later/concurrent calls that didn't pass any.
 */
const MAX_SCOPED_CACHES = 16;
const scopedCaches = new Map<string, FileTTLCache<HFModel[]>>();

/**
 * In-flight fetches keyed by cache key: concurrent identical requests share
 * one upstream call instead of each missing the cache and fetching.
 */
const inflight = new Map<string, Promise<HFModel[]>>();

/** Sets (or resets) the default cache options used when a call passes no cacheOptions. Throws if the directory is unusable. */
export function configureCandidateModelsCache(options: CacheOptions = {}): void {
  candidateModelsCache = new FileTTLCache<HFModel[]>(options, isRawModelArray);
}

function getCache(options?: CacheOptions): CandidateCache {
  if (options) {
    validateCacheOptions(options);
    const ttl = Math.min(options.ttlMs ?? DEFAULT_TTL_MS, MAX_CACHE_TTL_MS);
    const key = `${path.resolve(options.dir ?? defaultCacheDir())}\0${ttl}`;
    let cache = scopedCaches.get(key);
    if (!cache) {
      // Explicitly requested directory: an unusable one is an error the caller should see.
      cache = new FileTTLCache<HFModel[]>(options, isRawModelArray);
      if (scopedCaches.size >= MAX_SCOPED_CACHES) {
        const oldest = scopedCaches.keys().next().value;
        if (oldest !== undefined) scopedCaches.delete(oldest);
      }
      scopedCaches.set(key, cache);
    }
    return cache;
  }

  if (!candidateModelsCache) {
    try {
      candidateModelsCache = new FileTTLCache<HFModel[]>({}, isRawModelArray);
    } catch {
      // The default directory is unusable (e.g. pre-created by another user,
      // read-only home). Don't fail the whole lookup over a cache: degrade to
      // the in-memory cache for this process.
      candidateModelsCache = new TTLCache<HFModel[]>(DEFAULT_TTL_MS);
    }
  }
  return candidateModelsCache;
}

/**
 * (v0.2) Cached wrapper around fetchCandidateModels, backed by the
 * file-based cache instead of MVP's in-memory Map. Kept for backward
 * compatibility (this exact function existed pre-v0.4) — built on the
 * generic getOrFetchCached below, key-namespaced to "huggingface" so it
 * can't collide with other providers' cache entries.
 */
export async function fetchCandidateModelsCached(task: string): Promise<HFModel[]> {
  return getOrFetchCached(`huggingface:${task}`, () => fetchCandidateModels(task));
}

/**
 * (v0.4) Generic cached-fetch helper, used by index.ts to cache each
 * requested provider's candidate list independently (keyed by
 * `${providerName}:${task}`, so HuggingFace and Ollama results for the
 * same task never collide). Not provider-specific itself — any async
 * producer of RawModel[] can use this. Pass `options` to use a cache
 * scoped to those options instead of the module-level default.
 */
export async function getOrFetchCached(
  key: string,
  fetchFn: () => Promise<HFModel[]>,
  options?: CacheOptions
): Promise<HFModel[]> {
  const cache = getCache(options);
  const cached = cache.get(key);
  if (cached) return cached;

  let pending = inflight.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(fetchFn)
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  const result = await pending;
  cache.set(key, result);
  return result;
}

/** Exposed for tests that need to reset cache state between runs. */
export function clearCandidateModelsCache(): void {
  getCache().clear();
}
