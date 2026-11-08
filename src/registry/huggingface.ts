import { HFModel } from "../types";
import { HFApiError, RateLimitError } from "../errors";
import { Provider } from "./provider";
import { isSafeModelId, isSafeString, sanitizeTags } from "../validate";
import { readJsonWithLimit, ResponseTooLargeError } from "../http";

const HF_API_BASE = "https://huggingface.co/api/models";

/** Number of candidates to pull per query, per docx 6.3: fixed fetch limit, no pagination in MVP. */
const FETCH_LIMIT = 50;

/** Per-attempt request timeout — without one, a stalled connection hangs the caller forever. */
export const FETCH_TIMEOUT_MS = 10_000;

/** Hard cap on the decompressed body — 50 list items is a few tens of KB. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Redirects are followed only to HTTPS huggingface.co / hf.co hosts, at most this many times. */
const MAX_REDIRECTS = 3;
const ALLOWED_REDIRECT_HOST = /(^|\.)(huggingface\.co|hf\.co)$/i;

/** Backward-compatible alias — v0.1 threw this name; v0.2 throws the same class under a new name. */
export { HFApiError as HuggingFaceApiError };

/** (v0.2) Retry policy: cap at 3 attempts, exponential backoff, only for transient failures. */
const MAX_RETRIES = 3;
const BACKOFF_SCHEDULE_MS = [500, 1000, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for 429 (rate limit), any 5xx, and network failures/timeouts (no
 * HTTP status at all) — the only cases worth retrying.
 */
function isTransient(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Maps our public `task` values to HuggingFace's pipeline_tag vocabulary.
 * Unknown/custom task strings pass through unchanged so query.task can
 * still be a free string per the contract.
 */
const TASK_TO_PIPELINE_TAG: Readonly<Record<string, string>> = {
  summarize: "summarization",
  classify: "text-classification",
  extract: "token-classification",
  chat: "text-generation",
  code: "text-generation",
  translate: "translation",
};

export function mapTaskToPipelineTag(task: string): string {
  // Own-property check: a plain lookup returns inherited members for tasks
  // like "toString", "constructor" or "__proto__".
  return Object.prototype.hasOwnProperty.call(TASK_TO_PIPELINE_TAG, task) ? TASK_TO_PIPELINE_TAG[task] : task;
}

/**
 * Raw shape of a single item from HuggingFace's /api/models list endpoint.
 * We only pick the fields we actually use.
 */
interface HFApiListItem {
  id: string;
  pipeline_tag?: string;
  tags?: string[];
  downloads?: number;
}

/** A single fetch attempt — no retry logic here, that lives in fetchCandidateModels. */
function networkFailureReason(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? `timed out after ${FETCH_TIMEOUT_MS}ms` : "network error";
}

/**
 * fetch with redirects followed manually, and only to HTTPS HuggingFace
 * hosts. Default fetch follows any redirect, so a compromised or spoofed
 * upstream could bounce the request to an internal or plain-http URL.
 */
async function fetchFollowingSafeRedirects(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, { signal, redirect: "manual" });
    const location = response.status >= 300 && response.status < 400 ? response.headers?.get?.("location") : null;
    if (!location) return response;

    const next = new URL(location, current);
    if (next.protocol !== "https:" || !ALLOWED_REDIRECT_HOST.test(next.hostname)) {
      throw new HFApiError(`HuggingFace API redirected to a disallowed location (${next.protocol}//${next.hostname})`, response.status);
    }
    current = next.toString();
  }
  throw new HFApiError("HuggingFace API redirected too many times", 310);
}

async function fetchOnce(url: string): Promise<HFModel[]> {
  // One timeout covers the redirects, headers and body read together.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFollowingSafeRedirects(url, signal);
  } catch (err) {
    if (err instanceof HFApiError) throw err;
    // Network failure or timeout: wrap in a typed error (no status => retryable).
    throw new HFApiError(`HuggingFace API request failed: ${networkFailureReason(err)}`);
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new RateLimitError(`HuggingFace API rate-limited the request (429)`);
    }
    throw new HFApiError(
      `HuggingFace API request failed with status ${response.status}`,
      response.status
    );
  }

  let data: unknown;
  try {
    data = await readJsonWithLimit(response, MAX_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      throw new HFApiError(`HuggingFace API response too large (over ${MAX_RESPONSE_BYTES} bytes)`, response.status);
    }
    if (err instanceof SyntaxError) {
      throw new HFApiError("HuggingFace API returned invalid JSON", response.status);
    }
    // Connection dropped or timed out mid-body: retryable, like a failed request.
    throw new HFApiError(`HuggingFace API request failed: ${networkFailureReason(err)}`);
  }

  if (!Array.isArray(data)) {
    throw new HFApiError("HuggingFace API returned an unexpected response shape", response.status);
  }

  // Runtime shape check: drop items without a safe string id; coerce the rest.
  return (data as Partial<HFApiListItem>[])
    .filter((item) => item !== null && typeof item === "object" && isSafeModelId(item.id))
    .slice(0, FETCH_LIMIT)
    .map((item): HFModel => ({
      id: item.id as string,
      provider: "huggingface",
      pipeline_tag: isSafeString(item.pipeline_tag, 128) ? item.pipeline_tag : undefined,
      tags: sanitizeTags(item.tags),
      downloads: typeof item.downloads === "number" && Number.isFinite(item.downloads) && item.downloads >= 0 ? item.downloads : 0,
    }));
}

/**
 * Fetches candidate models from HuggingFace for a given task.
 * No API key required (public search endpoint, per docx 6.3).
 *
 * (v0.2) Retries transient failures (429 / 5xx) up to MAX_RETRIES times with
 * exponential backoff (500ms, 1000ms, 2000ms). Non-transient failures
 * (4xx other than 429) are thrown immediately — retrying them can't help.
 * All thrown errors are typed SmallmError subclasses (see errors.ts).
 */
export async function fetchCandidateModels(task: string): Promise<HFModel[]> {
  const pipelineTag = mapTaskToPipelineTag(task);
  const url = `${HF_API_BASE}?pipeline_tag=${encodeURIComponent(pipelineTag)}&limit=${FETCH_LIMIT}&sort=downloads&direction=-1`;

  let lastError: HFApiError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      if (!(err instanceof HFApiError)) throw err; // unexpected error shape — don't swallow it

      const canRetry = isTransient(err.status) && attempt < MAX_RETRIES;
      lastError = err;

      if (!canRetry) throw err;

      await sleep(BACKOFF_SCHEDULE_MS[attempt]);
    }
  }

  // Unreachable in practice (the loop always returns or throws), but keeps TS happy
  // and gives a sane fallback if MAX_RETRIES were ever set to a negative number.
  throw lastError ?? new HFApiError("HuggingFace API request failed with no response");
}

/**
 * (v0.4) Provider implementation wrapping fetchCandidateModels — no behavior
 * change to the underlying fetch/retry/error logic above, this just adapts
 * the existing function to the shared Provider interface so index.ts can
 * treat HuggingFace the same way it treats every other provider.
 */
export const huggingfaceProvider: Provider = {
  name: "huggingface",
  listCandidates: (query) => fetchCandidateModels(query.task),
};
