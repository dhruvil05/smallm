import { RawModel } from "../types";
import { Provider } from "./provider";
import { isSafeModelId, isSafeString, sanitizeTags } from "../validate";
import { readJsonWithLimit, ResponseTooLargeError } from "../http";

/**
 * Default local Ollama REST API address — Ollama's standard port, on the
 * explicit IPv4 loopback address Ollama binds by default. Not "localhost":
 * that resolves to ::1 first on many systems, so any other local user who
 * binds [::1]:11434 would answer instead of the real Ollama.
 */
const OLLAMA_API_BASE = "http://127.0.0.1:11434";

/** Local service, so a short timeout: a process holding the port without answering must not hang the call. */
export const OLLAMA_TIMEOUT_MS = 3_000;

/** Cap on how many local models are considered — guards against an absurd response. */
const MAX_OLLAMA_MODELS = 500;

/** Hard cap on the decompressed /api/tags body (~1 KB per model). */
const MAX_OLLAMA_RESPONSE_BYTES = 2 * 1024 * 1024;

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
  // (?<!\d): only start at the beginning of a digit run, keeping this linear-time.
  const match = parameterSize.match(/(?<!\d)(\d+(?:\.\d+)?)\s*[bB]/);
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
    // A local service never needs to redirect; refuse instead of following.
    response = await fetch(`${OLLAMA_API_BASE}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS), redirect: "error" });
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

  let data: Partial<OllamaTagsResponse> | null;
  try {
    data = (await readJsonWithLimit(response, MAX_OLLAMA_RESPONSE_BYTES)) as Partial<OllamaTagsResponse> | null;
  } catch (err) {
    const reason = err instanceof ResponseTooLargeError ? "response too large" : "could not parse response";
    console.warn(`[smallm] Local Ollama ${reason} — returning no Ollama candidates.`);
    return [];
  }

  const models = data && typeof data === "object" ? data.models ?? [] : null;
  if (!Array.isArray(models)) {
    console.warn("[smallm] Unexpected Ollama response shape — returning no Ollama candidates.");
    return [];
  }

  // Runtime shape check: drop entries without a safe string name; coerce the rest.
  const valid = models
    .filter((item): item is OllamaTagsItem => item !== null && typeof item === "object" && isSafeModelId(item.name))
    .slice(0, MAX_OLLAMA_MODELS)
    .map((item) => {
      const details = item.details && typeof item.details === "object" ? item.details : {};
      const parameterSize = isSafeString(details.parameter_size, 32) ? details.parameter_size : undefined;
      return { name: item.name, families: sanitizeTags(details.families), parameterSize };
    });

  return valid.map((item): RawModel => ({
    id: item.name,
    provider: "ollama",
    // Ollama doesn't classify models by HF-style pipeline_tag — leaving
    // this undefined means the task hard filter treats it as "unknown,
    // can't determine" and lets it through, same as any other missing
    // metadata (not a provider-specific special case).
    pipeline_tag: undefined,
    tags: item.families,
    // Ollama's local API doesn't expose a download-count concept.
    downloads: 0,
    paramsB: parseParamsB(item.parameterSize),
    paramsSource: item.parameterSize ? "tag" : "unknown",
    // Ollama doesn't report context window via this endpoint either — same
    // known limitation already flagged for HuggingFace models elsewhere.
    contextWindow: null,
  }));
}

export const ollamaProvider: Provider = {
  name: "ollama",
  listCandidates: async () => listOllamaModels(),
};
