import { ModelQuery, RawModel, ProviderName } from "../types";

/**
 * A model registry that can list candidate models for a query. Both
 * registry/huggingface.ts and registry/ollama.ts implement this. filters.ts
 * and scorer.ts never see provider-specific shapes — only the shared
 * RawModel — so they stay fully provider-agnostic (v0.4 Do's/Don'ts).
 */
export interface Provider {
  name: ProviderName;
  listCandidates(query: ModelQuery): Promise<RawModel[]>;
}
