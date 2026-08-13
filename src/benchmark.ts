import { BenchmarkEntry } from "./types";
import benchmarkData from "./data/benchmarks.json";

/**
 * Loaded once at module init from the checked-in dataset.
 * NOTE: the shipped src/data/benchmarks.json numbers are illustrative
 * placeholders for this build — replace with real measured data before
 * relying on maxLatencyMs exclusions in production.
 */
const ENTRIES: BenchmarkEntry[] = benchmarkData.entries as BenchmarkEntry[];

/** Keyed by `${modelId}::${hardware}` for O(1) lookup. */
const INDEX: Map<string, BenchmarkEntry> = new Map(
  ENTRIES.map((entry) => [benchmarkKey(entry.modelId, entry.hardware), entry])
);

function benchmarkKey(modelId: string, hardware: string): string {
  return `${modelId}::${hardware}`;
}

/**
 * Looks up measured latency for a (model, hardware) pair.
 * Returns null if no benchmark entry exists — per Section on unknown-value
 * handling, "no data" must never be treated as "too slow." Callers (filters.ts)
 * must let the model through when this returns null.
 */
export function lookupLatencyMs(modelId: string, hardware: string): number | null {
  const entry = INDEX.get(benchmarkKey(modelId, hardware));
  return entry ? entry.avgLatencyMs : null;
}

/** Exposed for tests/debugging — total number of loaded benchmark entries. */
export function benchmarkDatasetSize(): number {
  return ENTRIES.length;
}
