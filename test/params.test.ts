import { describe, it, expect } from "vitest";
import { extractParamsB, enrichWithParams } from "../src/params";
import { HFModel } from "../src/types";

function model(overrides: Partial<HFModel>): HFModel {
  return { id: "org/model", ...overrides };
}

describe("extractParamsB", () => {
  it("extracts whole-number params from id", () => {
    const result = extractParamsB(model({ id: "meta-llama/Llama-3-8B-Instruct" }));
    expect(result).toEqual({ paramsB: 8, paramsSource: "id" });
  });

  it("extracts decimal params from id", () => {
    const result = extractParamsB(model({ id: "TinyLlama/TinyLlama-1.1B-Chat-v1.0" }));
    expect(result).toEqual({ paramsB: 1.1, paramsSource: "id" });
  });

  it("extracts large params with lowercase b", () => {
    const result = extractParamsB(model({ id: "some-org/giant-model-70b" }));
    expect(result).toEqual({ paramsB: 70, paramsSource: "id" });
  });

  it("falls back to tags when id has no match", () => {
    const result = extractParamsB(model({ id: "org/mystery-model", tags: ["chat", "7B", "instruct"] }));
    expect(result).toEqual({ paramsB: 7, paramsSource: "tag" });
  });

  it("returns unknown when neither id nor tags match", () => {
    const result = extractParamsB(model({ id: "org/bert-base-uncased", tags: ["fill-mask"] }));
    expect(result).toEqual({ paramsB: null, paramsSource: "unknown" });
  });

  it("does not false-positive on words like 'Bert'", () => {
    const result = extractParamsB(model({ id: "google-bert/bert-base-cased" }));
    expect(result.paramsB).toBeNull();
  });

  it("does not match sub-billion (M) sizes as B", () => {
    const result = extractParamsB(model({ id: "facebook/opt-125m" }));
    expect(result.paramsB).toBeNull();
    expect(result.paramsSource).toBe("unknown");
  });

  it("handles missing tags array gracefully", () => {
    const result = extractParamsB(model({ id: "org/no-tags-model" }));
    expect(result.paramsB).toBeNull();
  });
});

describe("enrichWithParams", () => {
  it("enriches every model in a list without mutating originals", () => {
    const input: HFModel[] = [
      model({ id: "org/model-7B" }),
      model({ id: "org/other-model" }),
    ];
    const result = enrichWithParams(input);

    expect(result[0].paramsB).toBe(7);
    expect(result[1].paramsB).toBeNull();
    expect(input[0].paramsB).toBeUndefined(); // original untouched
  });
});
