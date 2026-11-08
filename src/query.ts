import { ModelQuery, ScoringMode, ProviderName, HardwareSpec } from "./types";
import { ValidationError } from "./errors";
import { validateCacheOptions } from "./validate";

/**
 * Length caps. `task` is sent to HuggingFace, used as a cache key, and
 * embedded (and memoized) in embedding/hybrid mode; `domain` is compared
 * against every tag. Unbounded, either one lets a caller burn CPU/memory.
 * 512 leaves plenty of room for free-text task descriptions.
 */
export const MAX_TASK_LENGTH = 512;
export const MAX_DOMAIN_LENGTH = 128;

const SCALAR_FIELDS = ["task", "contextLength", "maxParamsB", "domain", "maxLatencyMs", "limit", "scoringMode"] as const;

const VALID_HARDWARE = new Set(["cpu", "gpu-low", "gpu-high"]);
const VALID_SCORING_MODES = new Set(["rule", "embedding", "hybrid"]);
const VALID_PROVIDERS = new Set(["huggingface", "ollama"]);
const VALID_HARDWARE_SPEC_TYPES = new Set(["cpu", "gpu"]);
const DEFAULT_LIMIT = 5;
const DEFAULT_SCORING_MODE = "rule";
const DEFAULT_PROVIDERS: ProviderName[] = ["huggingface"];

/** A real, finite number greater than zero. Rejects NaN and Infinity, which `typeof x === "number"` lets through. */
function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** True for the original v0.1-v0.3 hardware string enum. */
export function isHardwareEnumString(
  hardware: unknown
): hardware is "cpu" | "gpu-low" | "gpu-high" {
  return typeof hardware === "string" && VALID_HARDWARE.has(hardware);
}

/** True for the v0.4 structured HardwareSpec form. */
export function isHardwareSpec(hardware: unknown): hardware is HardwareSpec {
  return typeof hardware === "object" && hardware !== null && "type" in hardware;
}

/**
 * Backward-compatible alias. As of v0.2, query validation throws the typed
 * ValidationError (a SmallmError subclass, see errors.ts) — this name is
 * kept so any existing `catch (e) { if (e instanceof InvalidQueryError) }`
 * code from v0.1 keeps working unchanged (it's the same class, not a copy).
 */
export { ValidationError as InvalidQueryError };

/**
 * Validates a raw ModelQuery and returns a normalized copy
 * (limit defaulted to 5 if omitted). Throws InvalidQueryError on bad input.
 */
export function validateQuery(
  rawQuery: ModelQuery
): ModelQuery & { limit: number; scoringMode: ScoringMode; providers: ProviderName[] } {
  if (!rawQuery || typeof rawQuery !== "object") {
    throw new ValidationError("query must be an object");
  }

  // Read every field exactly once into a plain snapshot, then validate and
  // return the snapshot. Validating the caller's object and returning a
  // spread of it would re-read getters, letting a value change after it
  // was checked. Unknown extra fields are dropped.
  const query = snapshotQuery(rawQuery);

  if (typeof query.task !== "string" || query.task.trim() === "") {
    throw new ValidationError("query.task is required and must be a non-empty string");
  }
  if (query.task.length > MAX_TASK_LENGTH) {
    throw new ValidationError(`query.task must be at most ${MAX_TASK_LENGTH} characters`);
  }

  if (typeof query.contextLength !== "number" || !Number.isFinite(query.contextLength) || query.contextLength <= 0) {
    throw new ValidationError("query.contextLength is required and must be a positive number");
  }

  if (query.hardware !== undefined && !isHardwareEnumString(query.hardware) && !isHardwareSpec(query.hardware)) {
    throw new ValidationError(
      `query.hardware must be one of: ${[...VALID_HARDWARE].join(", ")}, or a { type, vramGB? } object`
    );
  }
  if (isHardwareSpec(query.hardware)) {
    if (!VALID_HARDWARE_SPEC_TYPES.has(query.hardware.type)) {
      throw new ValidationError(`query.hardware.type must be one of: ${[...VALID_HARDWARE_SPEC_TYPES].join(", ")}`);
    }
    if (query.hardware.vramGB !== undefined && !isPositiveFinite(query.hardware.vramGB)) {
      throw new ValidationError("query.hardware.vramGB must be a positive number when provided");
    }
  }

  if (query.domain !== undefined && (typeof query.domain !== "string" || query.domain.trim() === "")) {
    throw new ValidationError("query.domain must be a non-empty string when provided");
  }
  if (query.domain !== undefined && query.domain.length > MAX_DOMAIN_LENGTH) {
    throw new ValidationError(`query.domain must be at most ${MAX_DOMAIN_LENGTH} characters`);
  }

  if (query.maxParamsB !== undefined && !isPositiveFinite(query.maxParamsB)) {
    throw new ValidationError("query.maxParamsB must be a positive number when provided");
  }

  if (query.maxLatencyMs !== undefined && !isPositiveFinite(query.maxLatencyMs)) {
    throw new ValidationError("query.maxLatencyMs must be a positive number when provided");
  }

  if (query.limit !== undefined && (typeof query.limit !== "number" || !Number.isInteger(query.limit) || query.limit <= 0)) {
    throw new ValidationError("query.limit must be a positive integer when provided");
  }

  if (query.scoringMode !== undefined && !VALID_SCORING_MODES.has(query.scoringMode)) {
    throw new ValidationError(`query.scoringMode must be one of: ${[...VALID_SCORING_MODES].join(", ")}`);
  }

  if (query.providers !== undefined) {
    if (!Array.isArray(query.providers) || query.providers.length === 0) {
      throw new ValidationError("query.providers must be a non-empty array when provided");
    }
    for (const p of query.providers) {
      if (!VALID_PROVIDERS.has(p)) {
        throw new ValidationError(`query.providers entries must be one of: ${[...VALID_PROVIDERS].join(", ")}`);
      }
    }
  }

  if (query.cacheOptions !== undefined) {
    validateCacheOptions(query.cacheOptions, "query.cacheOptions");
  }

  return {
    ...query,
    limit: query.limit ?? DEFAULT_LIMIT,
    scoringMode: query.scoringMode ?? DEFAULT_SCORING_MODE,
    // De-duplicated (order kept): repeated entries would fetch the same
    // provider again and return every model multiple times.
    providers: query.providers ? [...new Set(query.providers)] : DEFAULT_PROVIDERS,
  };
}

/** Copies each known field once (nested hardware/providers/cacheOptions too). See validateQuery. */
function snapshotQuery(raw: ModelQuery): ModelQuery {
  const snap: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) {
    const value = (raw as unknown as Record<string, unknown>)[key];
    if (value !== undefined) snap[key] = value;
  }

  const hardware = raw.hardware as unknown;
  if (hardware !== undefined) {
    if (typeof hardware === "object" && hardware !== null && "type" in hardware) {
      const h = hardware as { type: unknown; vramGB?: unknown };
      const vramGB = h.vramGB;
      snap.hardware = { type: h.type, ...(vramGB !== undefined ? { vramGB } : {}) };
    } else {
      snap.hardware = hardware;
    }
  }

  const providers = raw.providers as unknown;
  if (providers !== undefined) snap.providers = Array.isArray(providers) ? Array.from(providers) : providers;

  const cacheOptions = raw.cacheOptions as unknown;
  if (cacheOptions !== undefined) {
    if (typeof cacheOptions === "object" && cacheOptions !== null && !Array.isArray(cacheOptions)) {
      const c = cacheOptions as { dir?: unknown; ttlMs?: unknown };
      const dir = c.dir;
      const ttlMs = c.ttlMs;
      snap.cacheOptions = { ...(dir !== undefined ? { dir } : {}), ...(ttlMs !== undefined ? { ttlMs } : {}) };
    } else {
      snap.cacheOptions = cacheOptions;
    }
  }

  return snap as unknown as ModelQuery;
}
