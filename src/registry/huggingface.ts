import { HFModel } from "../types";
import { HFApiError, RateLimitError } from "../errors";

const HF_API_BASE = "https://huggingface.co/api/models";

/** Number of candidates to pull per query, per docx 6.3: fixed fetch limit, no pagination in MVP. */
const FETCH_LIMIT = 50;

/** Backward-compatible alias — v0.1 threw this name; v0.2 throws the same class under a new name. */
export { HFApiError as HuggingFaceApiError };

/** (v0.2) Retry policy: cap at 3 attempts, exponential backoff, only for transient failures. */
const MAX_RETRIES = 3;
const BACKOFF_SCHEDULE_MS = [500, 1000, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for 429 (rate limit) and any 5xx — the only cases worth retrying. */
function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Maps our public `task` values to HuggingFace's pipeline_tag vocabulary.
 * Unknown/custom task strings pass through unchanged so query.task can
 * still be a free string per the contract.
 */
const TASK_TO_PIPELINE_TAG: Record<string, string> = {
  summarize: "summarization",
  classify: "text-classification",
  extract: "token-classification",
  chat: "text-generation",
  code: "text-generation",
  translate: "translation",
};

export function mapTaskToPipelineTag(task: string): string {
  return TASK_TO_PIPELINE_TAG[task] ?? task;
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
async function fetchOnce(url: string): Promise<HFModel[]> {
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 429) {
      throw new RateLimitError(`HuggingFace API rate-limited the request (429)`);
    }
    throw new HFApiError(
      `HuggingFace API request failed with status ${response.status}`,
      response.status
    );
  }

  const data = (await response.json()) as HFApiListItem[];

  return data.map((item): HFModel => ({
    id: item.id,
    pipeline_tag: item.pipeline_tag,
    tags: item.tags ?? [],
    downloads: item.downloads ?? 0,
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

      const status = err.status ?? 0;
      const canRetry = isTransient(status) && attempt < MAX_RETRIES;
      lastError = err;

      if (!canRetry) throw err;

      await sleep(BACKOFF_SCHEDULE_MS[attempt]);
    }
  }

  // Unreachable in practice (the loop always returns or throws), but keeps TS happy
  // and gives a sane fallback if MAX_RETRIES were ever set to a negative number.
  throw lastError ?? new HFApiError("HuggingFace API request failed with no response");
}
