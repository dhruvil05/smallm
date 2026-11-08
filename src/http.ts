/**
 * Small HTTP helpers shared by the registry providers.
 *
 * readJsonWithLimit: a `content-length` check alone is not a size limit —
 * chunked responses omit the header and compressed responses report the
 * compressed size. This reads the (already-decompressed) body stream and
 * aborts as soon as it exceeds the cap, so a hostile or broken server can't
 * exhaust memory before JSON.parse ever runs.
 */

export class ResponseTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`response body exceeded ${limitBytes} bytes`);
    this.name = "ResponseTooLargeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface StreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/**
 * Parses a JSON body, reading at most `maxBytes` (after decompression).
 * Throws ResponseTooLargeError past the cap, or SyntaxError for invalid JSON.
 */
export async function readJsonWithLimit(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseTooLargeError(maxBytes);
  }

  const body = (response as { body?: { getReader?: () => StreamReader } | null }).body;
  if (!body || typeof body.getReader !== "function") {
    // No stream available (e.g. a minimal test double). Real fetch Responses
    // always take the streaming path below.
    return response.json();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
  return JSON.parse(text);
}
