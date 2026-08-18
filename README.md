# smallm

Find the right small language model (SLM) for a task, based on given context.

`smallm` does a **live lookup against the HuggingFace public API** and runs a **rule-based scoring engine** (task match, size fit, context window, domain tag) to rank candidates — no embeddings, no local registry, no config files.

## Install

```bash
npm install smallm
```

## Usage

```ts
import { findModels } from "smallm";

const results = await findModels({
  task: "chat",           // "summarize" | "classify" | "extract" | "chat" | "code" | "translate" | string
  contextLength: 8192,    // required — hard filter, in tokens
  maxParamsB: 7,           // optional — hard filter, "under 7B"
  domain: "medical",       // optional — used in scoring only
  hardware: "gpu-low",     // optional — required (along with maxLatencyMs) to enforce latency
  maxLatencyMs: 2000,       // optional — v0.2: real hard filter when benchmark data exists
  scoringMode: "rule",       // optional — v0.3: "rule" (default) | "embedding" | "hybrid"
  limit: 5,                   // optional — defaults to 5
});

console.log(results);
// [
//   {
//     name: "org/some-7b-chat-model",
//     provider: "huggingface",
//     paramsB: 6.5,
//     contextWindow: null,          // see "Known limitations" below
//     reasonWhy: "Strong task match, sufficient context window, and comfortably within your parameter limit.",
//     score: 87,
//     scoringMode: "rule"
//   },
//   ...
// ]
```

### Multi-provider (v0.4)

```ts
// Query a locally running Ollama installation instead of (or alongside) HuggingFace.
await findModels({ task: "chat", contextLength: 4096, providers: ["ollama"] });
await findModels({ task: "chat", contextLength: 4096, providers: ["huggingface", "ollama"] });

// Structured hardware — widened, not replacing the original string enum.
await findModels({ task: "chat", contextLength: 4096, hardware: { type: "gpu", vramGB: 8 } });
await findModels({ task: "chat", contextLength: 4096, hardware: "gpu-low" }); // still works
```

**Prerequisite for `providers: ["ollama"]`:** Ollama must be running locally (`ollama serve`, or the desktop app) and reachable at `http://localhost:11434`. If it isn't, `smallm` doesn't throw or crash the whole call — it logs a warning and simply returns no Ollama candidates, so a mixed `["huggingface", "ollama"]` query still returns your HuggingFace results.

**Important:** `HardwareSpec.vramGB` filtering uses an **estimated** footprint (~2GB VRAM per 1B params, a common fp16 rule of thumb) — not a measured or authoritative figure. It's meant to rule out obviously-too-large models, not to guarantee something fits.

### Scoring modes (v0.3)

```ts
// Default — identical to v0.1/v0.2 behavior. Matches on exact task/pipeline_tag mapping.
await findModels({ task: "chat", contextLength: 4096, scoringMode: "rule" });

// Scores purely on text similarity between your task string and each model's
// available text (id, pipeline_tag, tags) — useful for free-text tasks that
// don't map neatly onto the fixed task enum.
await findModels({ task: "pull key dates and amounts from scanned invoices", contextLength: 4096, scoringMode: "embedding" });

// Blends both: hybridScore = ruleScore * 0.60 + embeddingScore * 0.40 (locked weights — rule score still dominates).
await findModels({ task: "chat", contextLength: 4096, scoringMode: "hybrid" });
```

### Multi-provider + structured hardware (v0.4)

```ts
// Query Ollama's locally installed models instead of (or alongside) HuggingFace.
// Requires a running local Ollama installation — see "Ollama prerequisite" below.
await findModels({ task: "chat", contextLength: 4096, providers: ["ollama"] });

await findModels({ task: "chat", contextLength: 4096, providers: ["huggingface", "ollama"] });

// Structured hardware spec — widens (doesn't replace) the original string enum.
await findModels({
  task: "chat",
  contextLength: 4096,
  hardware: { type: "gpu", vramGB: 8 }, // excludes models estimated to not fit
});

// Old string-enum form still works exactly as before:
await findModels({ task: "chat", contextLength: 4096, hardware: "gpu-low" });
```

**Ollama prerequisite:** `providers: ["ollama"]` (or including `"ollama"` in a multi-provider list) expects a local Ollama installation running at `http://localhost:11434`. If it's not running or not installed, `smallm` doesn't throw or crash the whole query — it logs a warning and simply contributes zero Ollama candidates, so a mixed `["huggingface", "ollama"]` query still returns HuggingFace results normally. Ollama itself is never installed, started, or asked to download models by this package — it only queries what's already available locally.

**`vramGB` filtering is a heuristic, not a measured constraint.** There's no standard "how much VRAM does model X need" figure available from either provider's listing API, so `smallm` estimates it from `paramsB` using a commonly-cited rule of thumb (~2GB VRAM per 1B parameters, roughly fp16 inference). A model quantized to 4-bit would actually need much less — this estimate is conservative/pessimistic in that case. Treat `vramGB` filtering as a rough guide, not a guarantee.

### Handling errors (v0.2)

```ts
import { findModels, ValidationError, RateLimitError, HFApiError } from "smallm";

try {
  await findModels({ task: "chat", contextLength: 4096 });
} catch (err) {
  if (err instanceof ValidationError) {
    // your query was malformed — fix it, retrying won't help
  } else if (err instanceof RateLimitError) {
    // HuggingFace rate-limited us — smallm already retried 3x with backoff before this threw
  } else if (err instanceof HFApiError) {
    // some other non-2xx from HuggingFace
  }
}
```

## API

### `findModels(query: ModelQuery): Promise<ModelMatch[]>`

The single public entry point. Validates the query, fetches live candidates from HuggingFace (cached, retrying transient failures), applies hard filters, scores and ranks the survivors, and returns the top N.

### `ModelQuery`

| Field | Type | Required | Notes |
|---|---|---|---|
| `task` | `"summarize" \| "classify" \| "extract" \| "chat" \| "code" \| "translate" \| string` | yes | |
| `contextLength` | `number` | yes | Hard filter (tokens) |
| `hardware` | `"cpu" \| "gpu-low" \| "gpu-high" \| { type: "cpu" \| "gpu"; vramGB?: number }` | no | String enum: required alongside `maxLatencyMs` to enforce latency filtering (v0.2). Object form (v0.4): `vramGB` enables the estimated-footprint hard filter. |
| `domain` | `string` | no | Used in scoring, not filtering |
| `maxParamsB` | `number` | no | Hard filter, e.g. `7` = "under 7B" |
| `maxLatencyMs` | `number` | no | **v0.2:** real hard filter when a benchmark entry exists for the (model, string-enum `hardware`) pair. No entry = not enforced. |
| `scoringMode` | `"rule" \| "embedding" \| "hybrid"` | no | **v0.3:** which scoring strategy to use. Defaults to `"rule"`. |
| `providers` | `("huggingface" \| "ollama")[]` | no | **v0.4:** which registries to query. Defaults to `["huggingface"]`. |
| `limit` | `number` | no | Defaults to `5` |
| `cacheOptions` | `{ dir?: string; ttlMs?: number }` | no | **v0.2:** configure the file-based cache. Defaults: OS temp dir + `/smallm-cache`, 5-minute TTL |

### `ModelMatch`

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Provider-specific model id |
| `provider` | `"huggingface" \| "ollama"` | **v0.4:** widened from the literal `"huggingface"` |
| `paramsB` | `number \| null` | `null` if size couldn't be detected |
| `contextWindow` | `number \| null` | `null` if unknown (see limitations) |
| `reasonWhy` | `string` | Generated from the scoring breakdown |
| `score` | `number` | 0–100 |
| `scoringMode` | `"rule" \| "embedding" \| "hybrid"` | **v0.3:** which mode produced this result's score |

### Errors (v0.2)

All thrown errors extend `SmallmError`:

- `ValidationError` — bad `ModelQuery` input. Never retried.
- `HFApiError` — non-2xx response from HuggingFace (base class; carries `.status`).
- `RateLimitError` — `HFApiError` subclass specifically for HTTP 429.

`findModels` retries transient HuggingFace failures (429 and any 5xx) up to 3 times with exponential backoff (500ms / 1000ms / 2000ms) before throwing.

## How scoring works

Hard filters run **before** any scoring — a model that fails a hard filter never gets scored, regardless of `scoringMode` or which `providers` it came from:

- `maxParamsB`, `contextLength`, `task` (MVP)
- `maxLatencyMs` when a benchmark entry exists for the (model, string-enum `hardware`) pair (v0.2)
- `hardware.vramGB` when an estimated footprint exceeds it (v0.4, heuristic — see "Known limitations")

Survivors are scored. In `"rule"` mode (the default) that's four weighted components:

- **Task match** — 50%
- **Context window fit** — 20%
- **Size fit** — 15%
- **Domain match** — 15%

`"embedding"` mode scores purely on text similarity instead; `"hybrid"` blends both 60/40 (rule/embedding). See "Scoring modes (v0.3)" above.

Unknown metadata (e.g. undetectable param count, no benchmark entry, unreachable Ollama) is never punished or excluded — it gets a neutral mid-range score for that component only, or is simply not filtered on.

## Known limitations

- **Embedding mode uses lexical, not semantic, similarity.** The v0.3 `"embedding"`/`"hybrid"` scoring modes are backed by a small, local, dependency-free character-trigram hashing scheme (see `src/embeddings.ts`) — not a downloaded neural embedding model. It's genuinely offline and free, but two phrases that are semantically close yet share few characters (e.g. "extract key-value pairs from invoices" vs. "structured data extraction") will score lower than a real embedding model would give them.
- **`vramGB` filtering is a heuristic, not a measured constraint.** Estimated from `paramsB` at ~2GB/1B params (roughly fp16). Quantized models need much less — this estimate skews conservative in that case. See "Multi-provider + structured hardware (v0.4)" above.
- **Benchmark data is illustrative, not measured.** The shipped `src/data/benchmarks.json` contains a small set of placeholder latency numbers for demonstration and testing — not real measured inference latency. Replace it with genuinely benchmarked data before relying on `maxLatencyMs` exclusions in production.
- `contextWindow` is currently always `null` for every provider — neither HuggingFace's list endpoint nor Ollama's `/api/tags` returns it, and the pipeline doesn't do a per-model detail fetch. This means the context-length hard filter rarely excludes anything, and the context-fit score is always neutral. Tracked as a possible future addition.
- Ollama candidates never have a `pipeline_tag`, so the task hard filter always lets them through (same "unknown, don't exclude" rule as everywhere else) — task relevance for Ollama results relies entirely on scoring, not filtering.
- Sub-billion-parameter models (e.g. `125M`) aren't detected by the size regex and report `paramsB: null`.
- File-based cache only — no database engine. Cache entries are per-process-agnostic (survive restarts) but there's no cross-machine sharing.

## Development

```bash
npm install
npm run build   # compile TypeScript -> dist/
npm test         # run the unit + integration test suite
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

