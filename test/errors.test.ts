import { describe, it, expect } from "vitest";
import { SmallmError, HFApiError, RateLimitError, ValidationError } from "../src/errors";

describe("error hierarchy", () => {
  it("SmallmError is a real Error", () => {
    const err = new SmallmError("base error");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SmallmError");
    expect(err.message).toBe("base error");
  });

  it("HFApiError is a SmallmError and carries status", () => {
    const err = new HFApiError("api failed", 500);
    expect(err).toBeInstanceOf(SmallmError);
    expect(err).toBeInstanceOf(HFApiError);
    expect(err.status).toBe(500);
    expect(err.name).toBe("HFApiError");
  });

  it("RateLimitError is both an HFApiError and a SmallmError, defaults status to 429", () => {
    const err = new RateLimitError("rate limited");
    expect(err).toBeInstanceOf(SmallmError);
    expect(err).toBeInstanceOf(HFApiError);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(err.name).toBe("RateLimitError");
  });

  it("ValidationError is a SmallmError but NOT an HFApiError", () => {
    const err = new ValidationError("bad input");
    expect(err).toBeInstanceOf(SmallmError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(HFApiError);
    expect(err.name).toBe("ValidationError");
  });

  it("callers can distinguish error types via instanceof", () => {
    const errors: SmallmError[] = [
      new ValidationError("bad"),
      new HFApiError("down", 503),
      new RateLimitError("slow down"),
    ];

    const validationCount = errors.filter((e) => e instanceof ValidationError).length;
    const hfApiCount = errors.filter((e) => e instanceof HFApiError).length; // includes RateLimitError
    const rateLimitCount = errors.filter((e) => e instanceof RateLimitError).length;

    expect(validationCount).toBe(1);
    expect(hfApiCount).toBe(2);
    expect(rateLimitCount).toBe(1);
  });
});
