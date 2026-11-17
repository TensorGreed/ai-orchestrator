/**
 * Reads a fetch response body as it streams, with a hard cap on the bytes kept. Past the cap the read stops and the
 * rest of the body is cancelled, so a body with no (or a false) content-length cannot fill memory.
 *
 * The runtime's fetch decodes `Content-Encoding` (gzip, br, deflate) before the body reaches the reader, so the cap
 * counts decoded bytes: a decompression bomb stops at the cap. With `maxExpansion`, a body whose decoded size grows
 * past that multiple of its declared `content-length` (once more than `expansionFloorBytes` have been decoded) stops
 * early too.
 */

export class BodyTooLargeError extends Error {
  readonly maxBytes: number;
  readonly reason: "size" | "expansion";
  constructor(maxBytes: number, reason: "size" | "expansion" = "size") {
    super(reason === "size" ? `the response is larger than ${maxBytes} bytes.` : "the response expands far beyond its compressed size, so it was not read.");
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
    this.reason = reason;
  }
}

export interface ReadCappedOptions {
  /** Stop when decoded bytes exceed this multiple of the declared encoded length. Off when unset. */
  maxExpansion?: number;
  /** The expansion check starts only past this many decoded bytes. Default 1 MiB. */
  expansionFloorBytes?: number;
  /** Called with each chunk's arrival (e.g. to clear a first-byte timer). */
  onChunk?: () => void;
}

/** The body's bytes, at most `maxBytes`; throws BodyTooLargeError past the cap. */
export async function readBodyCapped(response: Response, maxBytes: number, options: ReadCappedOptions = {}): Promise<Uint8Array> {
  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const declared = Number(response.headers.get("content-length"));
  const encodedLength = encoding && encoding !== "identity" && Number.isFinite(declared) && declared > 0 ? declared : undefined;
  const floor = options.expansionFloorBytes ?? 1024 * 1024;
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    options.onChunk?.();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    if (options.maxExpansion && encodedLength !== undefined && total > floor && total / encodedLength > options.maxExpansion) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes, "expansion");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The body as UTF-8 text, at most `maxBytes`; throws BodyTooLargeError past the cap. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBodyCapped(response, maxBytes));
}
