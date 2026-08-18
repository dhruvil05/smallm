import { RawModel } from "../types";
import { Provider } from "./provider";

/** Default local Ollama REST API address — this is Ollama's standard local port. */
const OLLAMA_API_BASE = "http://localhost:11434";

/**
 * Raw shape of a single item from Ollama's GET /api/tags endpoint
 * (lists models already pulled/available in the local Ollama installation).
 * We only pick the fields we actually use.
 */
interface OllamaTagsItem {
  name: string;
  model?: string;
  details?: {
    parameter_size?: string; // e.g. "7B", "13B", "1.1B"
    families?: string[];
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaTagsItem[];
}

/**
 * Extracts a billions-of-params number from Ollama's `parameter_size`
 * string (e.g. "7B" -> 7, "1.1B" -> 1.1). Returns null if unparseable —
 * same "unknown, don't guess" posture as params.ts uses for HuggingFace ids.
 */
function parseParamsB(parameterSize: string | undefined): number | null {
  if (!parameterSize) return null;
  const match = parameterSize.match(/(\d+(?:\.\d+)?)\s*[bB]/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Queries a locally running Ollama installation for available models.
 *
 * Per the v0.4 guide's Do's/Don'ts: "handle Ollama-not-running gracefully
 * (empty results + a clear error, not a crash)". Interpreted here as: never
 * let a connection failure reject the whole findModels() call (that would
 * be surprising when Ollama is just one of possibly several providers being
 * queried) — instead, log a clear, actionable message and resolve to an
 * empty candidate list. This mirrors the unknown-value philosophy used
 * throughout the rest of the package: absence of data is never treated as
 * a hard failure.
 *
 * Also per Do's/Don'ts: this ONLY queries what's already available locally.
 * It never attempts to pull, install, or download a model.
 */
async function listOllamaModels(): Promise<RawModel[]> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_API_BASE}/api/tags`);
  } catch {
    console.warn(
      `[smallm] Could not reach local Ollama at ${OLLAMA_API_BASE} — is Ollama running? Returning no Ollama candidates.`
    );
    return [];
  }

  if (!response.ok) {
    console.warn(
      `[smallm] Local Ollama responded with status ${response.status} — returning no Ollama candidates.`
    );
    return [];
  }

  let data: OllamaTagsResponse;
  try {
    data = (await response.json()) as OllamaTagsResponse;
  } catch {
    console.warn("[smallm] Could not parse Ollama's response — returning no Ollama candidates.");
    return [];
  }

  return (data.models ?? []).map((item): RawModel => ({
    id: item.name,
    provider: "ollama",
    // Ollama doesn't classify models by HF-style pipeline_tag — leaving
    // this undefined means the task hard filter treats it as "unknown,
    // can't determine" and lets it through, same as any other missing
    // metadata (not a provider-specific special case).
    pipeline_tag: undefined,
    tags: item.details?.families ?? [],
    // Ollama's local API doesn't expose a download-count concept.
    downloads: 0,
    paramsB: parseParamsB(item.details?.parameter_size),
    paramsSource: item.details?.parameter_size ? "tag" : "unknown",
    // Ollama doesn't report context window via this endpoint either — same
    // known limitation already flagged for HuggingFace models elsewhere.
    contextWindow: null,
  }));
}

export const ollamaProvider: Provider = {
  name: "ollama",
  listCandidates: async () => listOllamaModels(),
};
