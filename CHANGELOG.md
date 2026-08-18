# Changelog

## v0.4.0

**Goal:** query more than just HuggingFace, and filter on real hardware constraints instead of a coarse enum.

### Added
- `Provider` interface (`src/registry/provider.ts`): `{ name, listCandidates(query) }`. Both `huggingfaceProvider` (`registry/huggingface.ts`) and the new `ollamaProvider` (`registry/ollama.ts`) implement it.
- `RawModel` type (`types.ts`) — the shared shape every provider maps its data into before candidates reach `filters.ts`/`scorer.ts`. Those two files remain fully provider-agnostic; they never branch on `model.provider`. (`HFModel` is kept as a backward-compatible type alias for `RawModel` — no existing internal call sites or test fixtures needed changes.)
- `providers?: ("huggingface" | "ollama")[]` field on `ModelQuery` — optional, defaults to `["huggingface"]`. Additive; omitting it preserves v0.1–v0.3 behavior exactly (only the HuggingFace endpoint is ever called).
- `registry/ollama.ts` — queries a local Ollama installation (`GET http://localhost:11434/api/tags`) for already-available models. Never pulls, installs, or downloads a model. If Ollama isn't running or errors, it logs a warning and contributes an empty candidate list rather than rejecting the whole `findModels()` call — so a mixed `["huggingface", "ollama"]` query still returns HuggingFace results normally.
- `HardwareSpec` type: `{ type: "cpu" | "gpu"; vramGB?: number }`. `ModelQuery.hardware` is **widened** to accept this in addition to the original `"cpu" | "gpu-low" | "gpu-high"` string enum — existing string-enum callers are unaffected.
- New hard filter in `filters.ts`: when `hardware` is the `HardwareSpec` object form and `vramGB` is given, models are excluded if their estimated VRAM footprint (`paramsB * 2GB`, a documented heuristic — not a measured figure) exceeds it. Unknown `paramsB` or missing `vramGB` → not filtered, same unknown-value rule as everywhere else.
- `index.ts`'s fetch step now fans out to every requested provider in parallel and merges results before hard-filtering. Each `(provider, task)` pair is cached independently via a new generic `getOrFetchCached()` helper in `cache-file.ts`.
- `ModelMatch.provider` widened from the literal `"huggingface"` to `"huggingface" | "ollama"`.

### Changed
- `filters.ts`'s `maxLatencyMs` check now only looks up benchmark data when `hardware` is the original string-enum form (the benchmark dataset is keyed by that enum, not by arbitrary `HardwareSpec` objects) — passing a `HardwareSpec` object alongside `maxLatencyMs` simply doesn't enforce that filter, rather than erroring.
- `cache-file.ts`'s `fetchCandidateModelsCached()` is now implemented on top of the new generic `getOrFetchCached()`, key-namespaced to `"huggingface:${task}"`. Kept as a backward-compatible export; existing tests pass unmodified.

### Compatibility
- `filters.ts` and `scorer.ts` were not touched beyond the new `vramGB` filter — both remain fully provider-agnostic, never inspecting `model.provider`.
- All 12 pre-existing `index.test.ts` integration tests pass unmodified; default behavior (`providers` omitted) makes exactly the same HuggingFace-only calls as before.
- `HFModel` (used throughout `filters.ts`, `scorer.ts`, `params.ts`, and their tests) is preserved as a type alias for `RawModel` — zero call sites needed renaming.

---

## v0.3.0

**Goal:** optional embedding-similarity scoring for free-text tasks that don't map neatly onto the fixed task enum.

### Added
- `scoringMode?: "rule" | "embedding" | "hybrid"` field on `ModelQuery` — optional, defaults to `"rule"`. Additive; omitting it preserves v0.1/v0.2 behavior exactly.
- `scoringMode?: "rule" | "embedding" | "hybrid"` field on `ModelMatch` — reports which mode actually produced the result.
- `src/embeddings.ts` — `embed(text)` and `cosineSimilarity(a, b)`. **Uses a small, local, self-authored character-trigram hashing scheme, not a downloaded neural embedding model** — the build/test environment couldn't verify a HuggingFace-hosted model download path, so this ships a fully offline, dependency-free alternative instead. Captures lexical similarity, not deep semantic meaning; see the file's docblock for the full trade-off and how to swap in a real model later. Embeddings are cached in-memory (keyed by exact text) so repeated calls don't recompute.
- `"embedding"` scoring mode: score is purely `scoreEmbeddingSimilarity(model, query.task)`, comparing the free-text task against each candidate's available text signals (id, pipeline_tag, tags — the list endpoint doesn't provide real model descriptions, same limitation as `contextWindow`).
- `"hybrid"` scoring mode: `finalScore = ruleScore * 0.60 + embeddingScore * 0.40` (locked weights, rule score still dominates per spec intent).
- `scorer.ts`: `computeFinalScore()` (mode-aware wrapper around the existing `scoreModel()`) and `generateReasonWhyForResult()` (mode-aware `reasonWhy` text, adds a semantic-similarity note for `"embedding"`/`"hybrid"` modes).

### Changed
- `index.ts`'s score step now calls `computeFinalScore()` instead of `scoreModel()` directly. The rest of the locked pipeline order (validate → fetch → hard-filter → score → tie-break → sort → limit → return) is unchanged — hard filters run identically regardless of `scoringMode`, per the "filters stay mode-agnostic" cross-phase principle.

### Compatibility
- `scoreModel()` itself is untouched — all 14 pre-existing rule-scoring unit tests pass unmodified. `scoringMode` defaults to `"rule"`, so v0.1/v0.2 callers see byte-for-byte identical scoring behavior with no code changes required.

---

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
