import { ModelQuery } from "./types";

const VALID_HARDWARE = new Set(["cpu", "gpu-low", "gpu-high"]);
const DEFAULT_LIMIT = 5;

export class InvalidQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryError";
  }
}

/**
 * Validates a raw ModelQuery and returns a normalized copy
 * (limit defaulted to 5 if omitted). Throws InvalidQueryError on bad input.
 */
export function validateQuery(query: ModelQuery): ModelQuery & { limit: number } {
  if (!query || typeof query !== "object") {
    throw new InvalidQueryError("query must be an object");
  }

  if (typeof query.task !== "string" || query.task.trim() === "") {
    throw new InvalidQueryError("query.task is required and must be a non-empty string");
  }

  if (typeof query.contextLength !== "number" || !Number.isFinite(query.contextLength) || query.contextLength <= 0) {
    throw new InvalidQueryError("query.contextLength is required and must be a positive number");
  }

  if (query.hardware !== undefined && !VALID_HARDWARE.has(query.hardware)) {
    throw new InvalidQueryError(`query.hardware must be one of: ${[...VALID_HARDWARE].join(", ")}`);
  }

  if (query.domain !== undefined && (typeof query.domain !== "string" || query.domain.trim() === "")) {
    throw new InvalidQueryError("query.domain must be a non-empty string when provided");
  }

  if (query.maxParamsB !== undefined && (typeof query.maxParamsB !== "number" || query.maxParamsB <= 0)) {
    throw new InvalidQueryError("query.maxParamsB must be a positive number when provided");
  }

  if (query.maxLatencyMs !== undefined && (typeof query.maxLatencyMs !== "number" || query.maxLatencyMs <= 0)) {
    throw new InvalidQueryError("query.maxLatencyMs must be a positive number when provided");
  }

  if (query.limit !== undefined && (typeof query.limit !== "number" || !Number.isInteger(query.limit) || query.limit <= 0)) {
    throw new InvalidQueryError("query.limit must be a positive integer when provided");
  }

  return {
    ...query,
    limit: query.limit ?? DEFAULT_LIMIT,
  };
}
