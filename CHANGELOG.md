# Changelog

## v0.6.0

**Goal:** security hardening, from two review passes (manual review, an independent adversarial review, fuzzing and proof-of-concept attacks). No new features. Released as a minor version because a few changes can break existing callers — see **Upgrading from 0.5** below.

### Upgrading from 0.5

Most callers need no changes: `findModels()` with normal input, the exported types and error classes, and the CLI's documented flags all work as before. Check these if they apply to you:

1. **Imports from inside `dist/` no longer resolve.** `package.json` now has an `exports` map, so only `smallm` (and `smallm/package.json`) can be imported. Code like `require("smallm/dist/cache-file")` now fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Import from `smallm` instead; internal helpers such as `configureCandidateModelsCache` are no longer public.
2. **The CLI rejects two flag mistakes it used to accept silently.**
   - `--hardware-vram <gb>` without `--hardware-type` now exits with an error (before, the VRAM filter was silently skipped). Add `--hardware-type gpu` (or `cpu`).
   - A flag followed directly by another flag (e.g. `--task --json`) now reports a missing value instead of using `--json` as the value.
   - Giving both `--hardware` and `--hardware-type` still works as documented (the structured form wins) but now prints a warning.
3. **New `ValidationError`s for input that used to be accepted:**
   - `task` longer than 512 characters, or `domain` longer than 128.
   - `NaN` or `Infinity` for `maxParamsB`, `maxLatencyMs` or `hardware.vramGB` (these used to silently disable the filter).
   - On Windows, a UNC/network or device path (`\\server\share`, `\\?\…`, `\\.\…`) as `cacheOptions.dir`.
   - A non-string/empty `cacheOptions.dir`, or a negative/non-finite `cacheOptions.ttlMs`.
4. **New `SmallmError` for unsafe cache directories (Linux/macOS):** an explicit `cacheOptions.dir` / `--cache-dir` owned by another user, world-writable, or a symlink owned by another user is refused. Use a directory you own (`chmod 700` it if needed).
5. **Behavior changes that don't throw:**
   - The default cache moved from `os.tmpdir()/smallm-cache` to a per-user directory (`$XDG_CACHE_HOME/smallm`, `~/.cache/smallm`, `~/Library/Caches/smallm`, or `%LOCALAPPDATA%\smallm\cache`). The first run after upgrading fetches fresh data; the old temp directory is ignored and can be deleted.
   - If the default cache directory can't be used, an in-memory cache is used instead of failing.
   - Repeated `providers` entries are ignored, so results are no longer duplicated.
   - Ollama-reported sizes now count, so `maxParamsB` / `vramGB` can exclude Ollama models (e.g. a 70B `llama3:latest`) that previously slipped through.
   - Ollama is contacted at `http://127.0.0.1:11434` instead of `localhost`. A setup where Ollama listens only on IPv6 is no longer found.
   - `cacheOptions.ttlMs` above 7 days is capped at 7 days.
   - Unexpected (non-`SmallmError`) CLI errors print one line; set `SMALLM_DEBUG=1` for the full error.
6. **Node.js 18 or newer** is declared in `engines` (npm warns on older versions). Older Node never worked, since it has no built-in `fetch`.

### Security
- **File cache moved out of the shared temp dir.** The default was `os.tmpdir()/smallm-cache` (`/tmp` on Linux/macOS, writable by every local user), which let another user plant poisoned recommendations or symlinks that overwrite the victim's files. The default is now a per-user cache dir, created `0700`; on POSIX a cache dir owned by another user or world-writable is refused with a `SmallmError`.
- Cache writes are atomic (exclusive-create temp file, mode `0600`, then rename), so a planted symlink is replaced, never written through. Reads skip symlinks, non-regular and oversized files.
- Cache entries are rejected if their expiry exceeds the configured TTL or their value isn't a well-formed `RawModel[]`.
- `clear()` now deletes only cache-owned files (`<sha256>.json` and its temp files). Previously it deleted every `.json` in the directory, e.g. `package.json` with `--cache-dir .`.
- Per-call `cacheOptions` use a cache scoped to that call and no longer overwrite the module-level default for later/concurrent calls.
- HuggingFace and Ollama responses are checked at runtime: non-array bodies raise `HFApiError` (HF) or yield no candidates (Ollama); items without a safe string id are dropped; tags/downloads/pipeline_tag are coerced. Ids and tags containing control characters are rejected.
- Request timeouts: 10s per HuggingFace attempt, 3s for local Ollama. Network failures and timeouts are now wrapped in `HFApiError` and retried like 5xx.
- Response bodies are size-capped while streaming (after decompression): 5 MB for HuggingFace, 2 MB for Ollama. The earlier `content-length` check alone was bypassed by chunked or compressed responses, and a 150 MB body could crash the process with out-of-memory.
- Ollama is called at `http://127.0.0.1:11434` instead of `localhost`. `localhost` resolves to `::1` first on many systems, so any local user listening on `[::1]:11434` could answer instead of the real Ollama (which binds 127.0.0.1).
- HuggingFace redirects are followed manually and only to HTTPS `huggingface.co` / `hf.co` hosts (max 3); Ollama redirects are refused.
- `task` is capped at 512 characters and `domain` at 128 (unbounded values pinned memory in the embedding cache and burned CPU). `providers` are de-duplicated (duplicates multiplied upstream requests and results). Concurrent identical lookups share one in-flight request.
- `validateQuery` validates a snapshot of the query, so getters can't change a value after it was checked.
- `cacheOptions.dir`: Windows UNC/network and device paths are rejected (creating them can leak the account's NTLM hash over SMB). `cacheOptions.ttlMs` above 7 days is clamped.
- Cache directory is re-verified before every read/write; a symlink at the path must be owned by the current user; the default directory is forced to `0700`. Cache filesystem errors are `SmallmError`s without the path in the message. If the default directory is unusable, an in-memory cache is used instead of failing the lookup.
- Cache reads open with `O_NOFOLLOW | O_NONBLOCK` (POSIX) and check the open descriptor, closing a swap-after-check race (symlink / FIFO / device).
- Expired cache files are swept periodically (at most every 60 s, on write), with a cap of 1000 files; previously one-off keys accumulated forever.
- The parameter-size regex is now linear-time (a 50,000-digit tag took ~13 s); results are unchanged.
- Validators and CLI output now also strip/reject zero-width, bidi override/isolate, line-separator and BOM characters (lookalike-name spoofing).
- `validateQuery` now rejects `NaN`/`Infinity` for `maxParamsB`, `maxLatencyMs` and `hardware.vramGB` (previously `--max-params abc` silently disabled the size filter), and validates `cacheOptions.dir` / `cacheOptions.ttlMs`.
- Task → pipeline_tag lookup uses an own-property check, so tasks like `toString` / `constructor` / `__proto__` no longer resolve to inherited members.
- CLI strips control characters from table output and error messages (no terminal escape injection) and prints a one-line message instead of a stack trace for unexpected errors (`SMALLM_DEBUG=1` restores the full error).
- Dev dependencies updated via `npm audit fix` (8 advisories → 3 moderate, all in eslint's `minimatch`; none ship to users).

### Fixed
- Ollama-reported model sizes (`parameter_size`) are no longer overwritten with "unknown", so `maxParamsB` / `vramGB` now apply to models like `llama3:latest`.
- CLI: `--hardware-vram` without `--hardware-type` is now an error (it was silently ignored); a flag followed by another `--flag` reports a missing value; giving both `--hardware` and `--hardware-type` prints a warning (the documented precedence is unchanged).

### Changed
- `package.json`: `engines.node >= 18`, `dist/` is cleaned before every build, and `prepublishOnly` runs the tests and a fresh build.
- Tests now run against an isolated cache directory (`vitest.config.ts` + `test/setup-isolated-cache.ts`). Previously, tests that mock `fetch` wrote fixture results into the real default cache, which a real `smallm` run on the same machine would then serve until they expired.
- **Breaking:** `package.json` now has an `exports` map. Only the package root (`smallm`) and `smallm/package.json` can be imported; deep imports such as `smallm/dist/cache-file` no longer resolve. The CLI binary is unaffected.

### Known limitations
- On Windows, the permissions (ACLs) of a custom `cacheOptions.dir` / `--cache-dir` are not checked — Node has no ACL API without native add-ons. Don't point it at a folder other users can write to (e.g. under `C:\Users\Public` or a new folder in `C:\`). The default location under `%LOCALAPPDATA%` is per-user.
- Ollama data is only as trustworthy as the local machine: if Ollama isn't running, any local process can listen on `127.0.0.1:11434`.

---

## v0.5.0

**Goal:** optional CLI — a thin wrapper around `findModels()`, greenlit after explicit discussion (this phase was marked "only if scope is revisited" in the roadmap, not scheduled by default).

### Added
- `src/cli.ts` — `npx smallm find [flags]`. Every flag maps 1:1 to a `ModelQuery` field; the file contains zero scoring/filtering/provider logic. `parseArgs()` and `formatTable()` are pure, independently tested functions; `main()` is the only part that touches `console`/`process.exit`.
- Human-readable table output by default (`formatTable()`); `--json` flag for raw `ModelMatch[]` output.
- `bin.smallm` field in `package.json` pointing at `dist/cli.js`; a `postbuild` script `chmod`s it executable.
- Structured `--hardware-type`/`--hardware-vram` flags mapping to the v0.4 `HardwareSpec` object form, alongside the original `--hardware <string>` flag for the v0.1-v0.3 string enum — structured form takes precedence if both are given.

### Compatibility
- **No library contract change** — `ModelQuery`, `ModelMatch`, and `findModels()` are untouched by this phase. The CLI is purely additive tooling on top of the existing library.
- CLI input is never independently validated — flags are mapped to a `ModelQuery` object and handed directly to `findModels()`, which performs the same validation (and throws the same typed errors) as any other caller. This was a deliberate choice per the "no business logic beyond flag parsing and output formatting" rule, not an oversight.
- Verified end-to-end against the real compiled `dist/cli.js` binary (not just unit-tested): usage/help output, an unknown-flag error, a missing-required-field library error, a real HuggingFace API failure (blocked by this build environment's network allowlist — confirmed the typed error surfaces cleanly rather than crashing), and Ollama's graceful-degradation path when unreachable.
- A dedicated test (`"produces the exact same result set as calling findModels() directly with equivalent arguments"`) directly checks the v0.5 Definition of Done: CLI output is byte-for-byte identical to calling the library function directly.

---

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
