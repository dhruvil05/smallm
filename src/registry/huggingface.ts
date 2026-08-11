import { HFModel } from "../types";

const HF_API_BASE = "https://huggingface.co/api/models";

/** Number of candidates to pull per query, per docx 6.3: fixed fetch limit, no pagination in MVP. */
const FETCH_LIMIT = 50;

export class HuggingFaceApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "HuggingFaceApiError";
  }
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

/**
 * Fetches candidate models from HuggingFace for a given task.
 * No API key required (public search endpoint, per docx 6.3).
 * Throws HuggingFaceApiError on non-200 responses — no retry/backoff (out of scope for MVP).
 */
export async function fetchCandidateModels(task: string): Promise<HFModel[]> {
  const pipelineTag = mapTaskToPipelineTag(task);
  const url = `${HF_API_BASE}?pipeline_tag=${encodeURIComponent(pipelineTag)}&limit=${FETCH_LIMIT}&sort=downloads&direction=-1`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new HuggingFaceApiError(
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
