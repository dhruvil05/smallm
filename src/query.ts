import { ModelQuery, ScoringMode, ProviderName, HardwareSpec } from "./types";
import { ValidationError } from "./errors";

const VALID_HARDWARE = new Set(["cpu", "gpu-low", "gpu-high"]);
const VALID_SCORING_MODES = new Set(["rule", "embedding", "hybrid"]);
const VALID_PROVIDERS = new Set(["huggingface", "ollama"]);
const VALID_HARDWARE_SPEC_TYPES = new Set(["cpu", "gpu"]);
const DEFAULT_LIMIT = 5;
const DEFAULT_SCORING_MODE = "rule";
const DEFAULT_PROVIDERS: ProviderName[] = ["huggingface"];

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
  query: ModelQuery
): ModelQuery & { limit: number; scoringMode: ScoringMode; providers: ProviderName[] } {
  if (!query || typeof query !== "object") {
    throw new ValidationError("query must be an object");
  }

  if (typeof query.task !== "string" || query.task.trim() === "") {
    throw new ValidationError("query.task is required and must be a non-empty string");
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
    if (query.hardware.vramGB !== undefined && (typeof query.hardware.vramGB !== "number" || query.hardware.vramGB <= 0)) {
      throw new ValidationError("query.hardware.vramGB must be a positive number when provided");
    }
  }

  if (query.domain !== undefined && (typeof query.domain !== "string" || query.domain.trim() === "")) {
    throw new ValidationError("query.domain must be a non-empty string when provided");
  }

  if (query.maxParamsB !== undefined && (typeof query.maxParamsB !== "number" || query.maxParamsB <= 0)) {
    throw new ValidationError("query.maxParamsB must be a positive number when provided");
  }

  if (query.maxLatencyMs !== undefined && (typeof query.maxLatencyMs !== "number" || query.maxLatencyMs <= 0)) {
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

  return {
    ...query,
    limit: query.limit ?? DEFAULT_LIMIT,
    scoringMode: query.scoringMode ?? DEFAULT_SCORING_MODE,
    providers: query.providers ?? DEFAULT_PROVIDERS,
  };
}
