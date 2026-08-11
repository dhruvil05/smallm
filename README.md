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
  hardware: "gpu-low",     // optional — informational, not enforced in MVP
  limit: 5,                 // optional — defaults to 5
});

console.log(results);
// [
//   {
//     name: "org/some-7b-chat-model",
//     provider: "huggingface",
//     paramsB: 6.5,
//     contextWindow: null,          // see "Known limitations" below
//     reasonWhy: "Strong task match, sufficient context window, and comfortably within your parameter limit.",
//     score: 87
//   },
//   ...
// ]
```

## API

### `findModels(query: ModelQuery): Promise<ModelMatch[]>`

The single public entry point. Validates the query, fetches live candidates from HuggingFace, applies hard filters, scores and ranks the survivors, and returns the top N.

### `ModelQuery`

| Field | Type | Required | Notes |
|---|---|---|---|
| `task` | `"summarize" \| "classify" \| "extract" \| "chat" \| "code" \| "translate" \| string` | yes | |
| `contextLength` | `number` | yes | Hard filter (tokens) |
| `hardware` | `"cpu" \| "gpu-low" \| "gpu-high"` | no | Informational only in MVP |
| `domain` | `string` | no | Used in scoring, not filtering |
| `maxParamsB` | `number` | no | Hard filter, e.g. `7` = "under 7B" |
| `maxLatencyMs` | `number` | no | Reserved for v0.2+, accepted but not enforced |
| `limit` | `number` | no | Defaults to `5` |

### `ModelMatch`

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | HuggingFace model id |
| `provider` | `"huggingface"` | |
| `paramsB` | `number \| null` | `null` if size couldn't be detected |
| `contextWindow` | `number \| null` | `null` if unknown (see limitations) |
| `reasonWhy` | `string` | Generated from the scoring breakdown |
| `score` | `number` | 0–100 |

## How scoring works

Hard filters (`maxParamsB`, `contextLength`, `task`) run **before** any scoring — a model that fails a hard filter never gets scored. Survivors are scored on four weighted components:

- **Task match** — 50%
- **Context window fit** — 20%
- **Size fit** — 15%
- **Domain match** — 15%

Unknown metadata (e.g. undetectable param count) is never punished or excluded — it gets a neutral mid-range score for that component only.

## Known limitations (MVP)

- `contextWindow` is currently always `null` — HuggingFace's list endpoint doesn't return it, and the MVP pipeline doesn't do a per-model detail fetch. This means the context-length hard filter rarely excludes anything, and the context-fit score is always neutral. A future version can add a detail-fetch enrichment step for shortlisted candidates.
- Sub-billion-parameter models (e.g. `125M`) aren't detected by the size regex and report `paramsB: null`.
- No retry/backoff — a failed HuggingFace API call throws directly.
- In-memory cache only — cache is lost on process restart.

## Development

```bash
npm install
npm run build   # compile TypeScript -> dist/
npm test         # run the unit + integration test suite
```
