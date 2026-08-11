import { describe, it, expect } from "vitest";
import { validateQuery, InvalidQueryError } from "../src/query";
import { ModelQuery } from "../src/types";

const baseQuery: ModelQuery = { task: "chat", contextLength: 4096 };

describe("validateQuery", () => {
  it("accepts a minimal valid query and defaults limit to 5", () => {
    const result = validateQuery(baseQuery);
    expect(result.limit).toBe(5);
    expect(result.task).toBe("chat");
  });

  it("preserves an explicit limit", () => {
    const result = validateQuery({ ...baseQuery, limit: 10 });
    expect(result.limit).toBe(10);
  });

  it("throws when task is missing", () => {
    expect(() => validateQuery({ ...baseQuery, task: "" })).toThrow(InvalidQueryError);
  });

  it("throws when contextLength is missing or invalid", () => {
    // @ts-expect-error testing runtime validation of a required field
    expect(() => validateQuery({ task: "chat" })).toThrow(InvalidQueryError);
    expect(() => validateQuery({ ...baseQuery, contextLength: -1 })).toThrow(InvalidQueryError);
  });

  it("throws on invalid hardware value", () => {
    // @ts-expect-error testing runtime validation
    expect(() => validateQuery({ ...baseQuery, hardware: "quantum" })).toThrow(InvalidQueryError);
  });

  it("accepts valid hardware values", () => {
    expect(() => validateQuery({ ...baseQuery, hardware: "gpu-low" })).not.toThrow();
  });

  it("throws on non-positive maxParamsB", () => {
    expect(() => validateQuery({ ...baseQuery, maxParamsB: 0 })).toThrow(InvalidQueryError);
    expect(() => validateQuery({ ...baseQuery, maxParamsB: -7 })).toThrow(InvalidQueryError);
  });

  it("accepts a valid maxParamsB", () => {
    expect(() => validateQuery({ ...baseQuery, maxParamsB: 7 })).not.toThrow();
  });

  it("throws on non-integer or non-positive limit", () => {
    expect(() => validateQuery({ ...baseQuery, limit: 0 })).toThrow(InvalidQueryError);
    expect(() => validateQuery({ ...baseQuery, limit: 2.5 })).toThrow(InvalidQueryError);
  });

  it("throws on empty domain string", () => {
    expect(() => validateQuery({ ...baseQuery, domain: "" })).toThrow(InvalidQueryError);
  });

  it("throws on non-positive maxLatencyMs even though it's unenforced downstream", () => {
    expect(() => validateQuery({ ...baseQuery, maxLatencyMs: -100 })).toThrow(InvalidQueryError);
  });
});
