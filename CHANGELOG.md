# Changelog

## v0.2.0

**Goal:** close MVP's honest shortcuts — real latency enforcement, persistent cache, typed errors.

### Added
- `maxLatencyMs` is now a real hard filter, enforced when both `hardware` and `maxLatencyMs` are provided *and* a benchmark entry exists for that `(modelId, hardware)` pair. No entry = not enforced (unknown values are never punished, same rule as MVP).
- `src/data/benchmarks.json` — checked-in benchmark dataset (`BenchmarkEntry[]`). **Values are illustrative placeholders for this build, not real measured latency** — replace with genuine measurements before relying on this filter in production.
- `src/benchmark.ts` — `lookupLatencyMs(modelId, hardware)` lookup helper.
- Typed error hierarchy (`src/errors.ts`): `SmallmError` (base) → `HFApiError` (carries `.status`) → `RateLimitError` (429 specifically); `ValidationError` for bad input. All exported from the package root.
- Retry-with-backoff for transient HuggingFace failures (429 / 5xx): up to 3 retries, exponential backoff (500ms / 1000ms / 2000ms). Non-transient errors (other 4xx) throw immediately — retrying can't fix a malformed request or an auth problem.
- `src/cache-file.ts` — file-based TTL cache, replacing MVP's in-memory `Map`. Cache entries are JSON files on disk, keyed by a SHA-256 hash of the cache key, so they survive process restarts.
- `cacheOptions?: { dir?: string; ttlMs?: number }` field on `ModelQuery` — optional, configures the file cache. Omitting it uses the same defaults as before (OS temp dir + `/smallm-cache`, 5-minute TTL).

### Changed
- `index.ts` now imports from `cache-file.ts` instead of `cache.ts` — same call-site shape, per the locked pipeline order (validate → fetch → hard-filter → score → tie-break → sort → limit → return), which is unchanged.
- Query validation errors now throw `ValidationError` (a `SmallmError` subclass) instead of a bare `Error` subclass. `InvalidQueryError` is kept as a backward-compatible alias for the same class.
- `fetchCandidateModels` now throws `HFApiError` / `RateLimitError` instead of the old `HuggingFaceApiError`. `HuggingFaceApiError` is kept as a backward-compatible alias for `HFApiError`.

### Removed
- `src/cache.ts` (MVP's in-memory-only cache) — superseded by `cache-file.ts` per this phase's explicit "replaces MVP's in-memory Map" scope.

### Compatibility
- All v0.1 fields keep their meaning; `cacheOptions` and `maxLatencyMs` enforcement are additive. Existing `import { findModels } from "smallm"` code needs no changes to keep working.

---

## v0.1.0 (MVP)

Initial release. Rule-based matching against the live HuggingFace API.

- `findModels(query: ModelQuery): Promise<ModelMatch[]>` — single public entry point.
- Hard filters: `maxParamsB`, `contextLength`, `task` compatibility.
- Weighted scoring: task match (50%), context window fit (20%), size fit (15%), domain match (15%).
- Unknown metadata never excluded or penalized — neutral mid-range score instead.
- In-memory TTL cache to avoid duplicate HuggingFace calls.
- `maxLatencyMs` accepted on `ModelQuery` for API stability but not enforced (see v0.2).
