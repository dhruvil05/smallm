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

**Important:** the "embedding" similarity here is a small, local, dependency-free **character-trigram hashing scheme** — not a downloaded neural embedding model. It's genuinely offline/free with no license concerns, but it captures lexical/surface similarity (shared substrings), not deep semantic meaning. See `src/embeddings.ts`'s docblock for the full trade-off and how to swap in a real neural embedding model later.

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
| `hardware` | `"cpu" \| "gpu-low" \| "gpu-high"` | no | Required alongside `maxLatencyMs` to enforce latency filtering (v0.2) |
| `domain` | `string` | no | Used in scoring, not filtering |
| `maxParamsB` | `number` | no | Hard filter, e.g. `7` = "under 7B" |
| `maxLatencyMs` | `number` | no | **v0.2:** real hard filter when a benchmark entry exists for the (model, `hardware`) pair. No entry = not enforced. |
| `scoringMode` | `"rule" \| "embedding" \| "hybrid"` | no | **v0.3:** which scoring strategy to use. Defaults to `"rule"`. |
| `limit` | `number` | no | Defaults to `5` |
| `cacheOptions` | `{ dir?: string; ttlMs?: number }` | no | **v0.2:** configure the file-based cache. Defaults: OS temp dir + `/smallm-cache`, 5-minute TTL |

### `ModelMatch`

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | HuggingFace model id |
| `provider` | `"huggingface"` | |
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

Hard filters (`maxParamsB`, `contextLength`, `task`, and — as of v0.2 — `maxLatencyMs`) run **before** any scoring — a model that fails a hard filter never gets scored. Survivors are scored on four weighted components:

- **Task match** — 50%
- **Context window fit** — 20%
- **Size fit** — 15%
- **Domain match** — 15%

Unknown metadata (e.g. undetectable param count, no benchmark entry) is never punished or excluded — it gets a neutral mid-range score for that component only, or is simply not filtered on.

## Known limitations

- **Embedding mode uses lexical, not semantic, similarity.** The v0.3 `"embedding"`/`"hybrid"` scoring modes are backed by a small, local, dependency-free character-trigram hashing scheme (see `src/embeddings.ts`) — not a downloaded neural embedding model. It's genuinely offline and free, but two phrases that are semantically close yet share few characters (e.g. "extract key-value pairs from invoices" vs. "structured data extraction") will score lower than a real embedding model would give them.
- **Benchmark data is illustrative, not measured.** The shipped `src/data/benchmarks.json` contains a small set of placeholder latency numbers for demonstration and testing — not real measured inference latency. Replace it with genuinely benchmarked data before relying on `maxLatencyMs` exclusions in production.
- `contextWindow` is currently always `null` — HuggingFace's list endpoint doesn't return it, and the pipeline doesn't do a per-model detail fetch. This means the context-length hard filter rarely excludes anything, and the context-fit score is always neutral. Tracked as a possible future addition.
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

