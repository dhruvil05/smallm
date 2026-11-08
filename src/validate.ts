import { CacheOptions, ParamsSource, ProviderName, RawModel } from "./types";
import { ValidationError } from "./errors";

/**
 * Runtime shape checks for data that crosses a trust boundary: HTTP
 * responses (HuggingFace, Ollama) and on-disk cache files. TypeScript casts
 * don't check anything at runtime, so without these a malformed or hostile
 * payload would crash deep inside filters/scorer with a raw TypeError, or
 * inject unexpected values into results.
 */

/** Upper bound on a model id's length — HF ids are far shorter; anything longer is junk. */
const MAX_ID_LENGTH = 256;
const MAX_TAGS = 100;
const MAX_TAG_LENGTH = 128;
/** A cached candidate list is ~50 (HF) or ≤500 (Ollama) entries; anything far beyond that wasn't written by us. */
const MAX_CACHED_MODELS = 2000;

const PROVIDERS: ReadonlySet<string> = new Set<ProviderName>(["huggingface", "ollama"]);
const PARAMS_SOURCES: ReadonlySet<string> = new Set<ParamsSource>(["id", "tag", "config", "unknown"]);

/**
 * Characters that can hide or disguise text in a terminal: C0/C1 controls
 * (escape sequences), zero-width characters, bidi overrides/isolates
 * ("Trojan Source"-style reordering), line/paragraph separators and BOM.
 */
// eslint-disable-next-line no-control-regex
export const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const CONTROL_CHARS = UNSAFE_DISPLAY_CHARS;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty, bounded string with no control characters (rules out terminal escape sequences). */
export function isSafeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !CONTROL_CHARS.test(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Keeps only safe string tags, bounded in count and length. */
export function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t) => isSafeString(t, MAX_TAG_LENGTH)).slice(0, MAX_TAGS);
}

export function isSafeModelId(value: unknown): value is string {
  return isSafeString(value, MAX_ID_LENGTH);
}

/** Strict check that a single value is a well-formed RawModel (used for cache entries). */
function isRawModel(value: unknown): value is RawModel {
  if (!isObject(value)) return false;
  if (!isSafeModelId(value.id)) return false;
  if (value.provider !== undefined && (typeof value.provider !== "string" || !PROVIDERS.has(value.provider))) return false;
  if (value.pipeline_tag !== undefined && !isSafeString(value.pipeline_tag, MAX_TAG_LENGTH)) return false;
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > MAX_TAGS) return false;
    if (!value.tags.every((t) => isSafeString(t, MAX_TAG_LENGTH))) return false;
  }
  if (value.downloads !== undefined && !isFiniteNonNegative(value.downloads)) return false;
  if (value.paramsB !== undefined && value.paramsB !== null && !isFiniteNonNegative(value.paramsB)) return false;
  if (value.paramsSource !== undefined && (typeof value.paramsSource !== "string" || !PARAMS_SOURCES.has(value.paramsSource))) return false;
  if (value.contextWindow !== undefined && value.contextWindow !== null && !isFiniteNonNegative(value.contextWindow)) return false;
  return true;
}

/** True only if every element is a well-formed RawModel. A cache entry failing this is treated as a miss. */
export function isRawModelArray(value: unknown): value is RawModel[] {
  return Array.isArray(value) && value.length <= MAX_CACHED_MODELS && value.every(isRawModel);
}

// ---- cacheOptions ----

/** TTLs above this are clamped (not rejected), so an entry can never be pinned "forever". */
export const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True for Windows UNC and device paths (\\server\share, //server/share,
 * \\?\..., \\.\...). Creating a directory there makes Windows open an SMB
 * connection, which can leak the account's NTLM hash to whoever runs the server.
 */
function isWindowsNetworkOrDevicePath(dir: string): boolean {
  return /^[\\/]{2}/.test(dir);
}

/**
 * Single source of truth for cacheOptions validation (used by validateQuery
 * and by the FileTTLCache constructor). `label` prefixes error messages.
 */
export function validateCacheOptions(options: unknown, label = "cacheOptions"): asserts options is CacheOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ValidationError(`${label} must be an object when provided`);
  }
  const { dir, ttlMs } = options as { dir?: unknown; ttlMs?: unknown };
  if (dir !== undefined) {
    if (typeof dir !== "string" || dir.trim() === "" || dir.includes("\0")) {
      throw new ValidationError(`${label}.dir must be a non-empty path string when provided`);
    }
    if (process.platform === "win32" && isWindowsNetworkOrDevicePath(dir)) {
      throw new ValidationError(`${label}.dir must be a local path (UNC/network and device paths are not allowed)`);
    }
  }
  if (ttlMs !== undefined && (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0)) {
    throw new ValidationError(`${label}.ttlMs must be a finite, non-negative number when provided`);
  }
}
