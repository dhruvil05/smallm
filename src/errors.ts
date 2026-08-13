/** Base class for every error smallm throws. Lets callers do `instanceof SmallmError`. */
export class SmallmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmallmError";
    // Restore prototype chain (needed when compiling to older targets / extending Error in TS).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Non-2xx response from the HuggingFace API (excluding the 429 case, see RateLimitError). */
export class HFApiError extends SmallmError {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "HFApiError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Specifically a 429 from HuggingFace. Triggers retry/backoff — see registry/huggingface.ts. */
export class RateLimitError extends HFApiError {
  constructor(message: string, status: number = 429) {
    super(message, status);
    this.name = "RateLimitError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Bad ModelQuery input. Never retried — a malformed request will never succeed by retrying. */
export class ValidationError extends SmallmError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
