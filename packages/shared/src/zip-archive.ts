/**
 * Phase 11.1 — a small, strict ZIP codec for audit bundles.
 *
 * Writes and reads plain ZIP files (no ZIP64, no encryption, stored or
 * deflated entries, UTF-8 names). Compression is injected (`node:zlib`
 * `deflateRawSync` / `inflateRawSync` in Node) so this module stays free of
 * Node built-ins and is shared by the API (writer) and the CLI (reader).
 *
 * The reader is deliberately strict because it feeds an integrity check:
 * a truncated file, trailing bytes, overlapping or out-of-order entries,
 * duplicate or unsafe names, a CRC mismatch or a size that differs from the
 * directory are all errors, never best-effort recoveries.
 */

export interface ZipEntryInput {
  path: string;
  data: Uint8Array;
}

export interface ZipWriteOptions {
  /** Raw DEFLATE (no zlib header). Entries are stored when omitted or when compression does not help. */
  deflateRaw?: (data: Uint8Array) => Uint8Array;
  /** Timestamp written on every entry; fixed so the same files give the same archive bytes. */
  modifiedAt?: Date;
}

export interface ZipReadOptions {
  inflateRaw: (data: Uint8Array, expectedBytes: number) => Uint8Array;
  /** Refuse archives whose entries expand past this many bytes in total. */
  maxTotalBytes?: number;
  /** Refuse archives with more entries than this. */
  maxEntries?: number;
}

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const VERSION = 20;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A relative, forward-slash path with no empty, `.` or `..` segments. */
export function isSafeZipPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\u0000") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: ((date.getUTCHours() & 0x1f) << 11) | ((date.getUTCMinutes() & 0x3f) << 5) | (Math.floor(date.getUTCSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getUTCMonth() + 1) & 0x0f) << 5) | (date.getUTCDate() & 0x1f)
  };
}

class ByteWriter {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(value: number): void {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  raw(data: Uint8Array): void {
    this.bytes.set(data, this.offset);
    this.offset += data.length;
  }

  done(): Uint8Array {
    return this.bytes;
  }
}

interface PreparedEntry {
  name: Uint8Array;
  method: number;
  crc: number;
  compressed: Uint8Array;
  size: number;
  offset: number;
}

export interface PreparedZip {
  /** Total archive size in bytes. */
  size: number;
  /** The archive as a sequence of chunks (one header or payload at a time), for streaming. */
  chunks(): Generator<Uint8Array>;
}

/**
 * Compresses every entry and lays out the archive without concatenating it,
 * so the caller knows the final size before sending a byte and can stream
 * the chunks.
 */
export function prepareZip(entries: ZipEntryInput[], options: ZipWriteOptions = {}): PreparedZip {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(options.modifiedAt ?? new Date(Date.UTC(1980, 0, 1)));
  const seen = new Set<string>();
  const prepared: PreparedEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!isSafeZipPath(entry.path)) throw new ZipFormatError(`Unsafe entry path '${entry.path}'`);
    if (seen.has(entry.path)) throw new ZipFormatError(`Duplicate entry path '${entry.path}'`);
    seen.add(entry.path);
    const name = encoder.encode(entry.path);
    if (name.length > MAX_UINT16) throw new ZipFormatError(`Entry path too long: '${entry.path}'`);
    const deflated = options.deflateRaw && entry.data.length > 0 ? options.deflateRaw(entry.data) : null;
    const useDeflate = deflated !== null && deflated.length < entry.data.length;
    const compressed = useDeflate ? deflated : entry.data;
    if (entry.data.length >= MAX_UINT32 || compressed.length >= MAX_UINT32) throw new ZipFormatError(`Entry '${entry.path}' is too large for a ZIP without ZIP64`);
    prepared.push({ name, method: useDeflate ? METHOD_DEFLATED : METHOD_STORED, crc: crc32(entry.data), compressed, size: entry.data.length, offset });
    offset += 30 + name.length + compressed.length;
  }
  if (prepared.length > MAX_UINT16) throw new ZipFormatError("Too many entries for a ZIP without ZIP64");
  const centralOffset = offset;
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  if (centralOffset + centralSize >= MAX_UINT32) throw new ZipFormatError("Archive is too large for a ZIP without ZIP64");
  const size = centralOffset + centralSize + 22;

  function* chunks(): Generator<Uint8Array> {
    for (const entry of prepared) {
      const header = new ByteWriter(30 + entry.name.length);
      header.u32(LOCAL_HEADER);
      header.u16(VERSION);
      header.u16(FLAG_UTF8);
      header.u16(entry.method);
      header.u16(stamp.time);
      header.u16(stamp.date);
      header.u32(entry.crc);
      header.u32(entry.compressed.length);
      header.u32(entry.size);
      header.u16(entry.name.length);
      header.u16(0);
      header.raw(entry.name);
      yield header.done();
      if (entry.compressed.length > 0) yield entry.compressed;
    }
    const central = new ByteWriter(centralSize + 22);
    for (const entry of prepared) {
      central.u32(CENTRAL_HEADER);
      central.u16(VERSION);
      central.u16(VERSION);
      central.u16(FLAG_UTF8);
      central.u16(entry.method);
      central.u16(stamp.time);
      central.u16(stamp.date);
      central.u32(entry.crc);
      central.u32(entry.compressed.length);
      central.u32(entry.size);
      central.u16(entry.name.length);
      central.u16(0);
      central.u16(0);
      central.u16(0);
      central.u16(0);
      central.u32(0);
      central.u32(entry.offset);
      central.raw(entry.name);
    }
    central.u32(END_OF_CENTRAL_DIRECTORY);
    central.u16(0);
    central.u16(0);
    central.u16(prepared.length);
    central.u16(prepared.length);
    central.u32(centralSize);
    central.u32(centralOffset);
    central.u16(0);
    yield central.done();
  }

  return { size, chunks };
}

/** The whole archive in one buffer. */
export function writeZip(entries: ZipEntryInput[], options: ZipWriteOptions = {}): Uint8Array {
  const prepared = prepareZip(entries, options);
  const out = new Uint8Array(prepared.size);
  let offset = 0;
  for (const chunk of prepared.chunks()) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function readZip(bytes: Uint8Array, options: ZipReadOptions): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (bytes.length < 22) throw new ZipFormatError("Not a ZIP archive: too short (truncated?)");

  // The end-of-central-directory record must end exactly at the end of the file.
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - MAX_UINT16);
  for (let index = bytes.length - 22; index >= lowest; index -= 1) {
    if (view.getUint32(index, true) === END_OF_CENTRAL_DIRECTORY && index + 22 + view.getUint16(index + 20, true) === bytes.length) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("Not a ZIP archive or truncated: end of central directory not found");
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) throw new ZipFormatError("Multi-disk archives are not supported");
  if (totalEntries === MAX_UINT16 || centralSize === MAX_UINT32 || centralOffset === MAX_UINT32) throw new ZipFormatError("ZIP64 archives are not supported");
  if (totalEntries > maxEntries) throw new ZipFormatError(`Archive has more than ${maxEntries} entries`);
  if (centralOffset + centralSize !== eocd) throw new ZipFormatError("Central directory does not end where the archive index says (truncated or padded archive)");

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  let pointer = centralOffset;
  let total = 0;
  for (let count = 0; count < totalEntries; count += 1) {
    if (pointer + 46 > eocd || view.getUint32(pointer, true) !== CENTRAL_HEADER) throw new ZipFormatError("Corrupt central directory entry");
    const flags = view.getUint16(pointer + 8, true);
    const method = view.getUint16(pointer + 10, true);
    const crc = view.getUint32(pointer + 16, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const size = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const next = pointer + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw new ZipFormatError("Corrupt central directory entry");
    let path: string;
    try {
      path = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    } catch {
      throw new ZipFormatError("Entry name is not valid UTF-8");
    }
    pointer = next;
    if (flags & FLAG_ENCRYPTED) throw new ZipFormatError(`Entry '${path}' is encrypted`);
    if (compressedSize === MAX_UINT32 || size === MAX_UINT32 || localOffset === MAX_UINT32) throw new ZipFormatError("ZIP64 archives are not supported");
    const isDirectory = path.endsWith("/");
    const cleanPath = isDirectory ? path.slice(0, -1) : path;
    if (!isSafeZipPath(cleanPath)) throw new ZipFormatError(`Unsafe entry path '${path}'`);
    if (names.has(path)) throw new ZipFormatError(`Duplicate entry '${path}'`);
    names.add(path);

    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== LOCAL_HEADER) throw new ZipFormatError(`Missing local header for '${path}'`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localNameLength !== nameLength || decoder.decode(localName) !== path) throw new ZipFormatError(`Local header name differs from the directory for '${path}'`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw new ZipFormatError(`Entry '${path}' runs past the end of the data (truncated archive)`);
    ranges.push({ start: localOffset, end: dataEnd });

    if (isDirectory) {
      if (size !== 0 || compressedSize !== 0) throw new ZipFormatError(`Directory entry '${path}' has content`);
      continue;
    }
    total += size;
    if (total > maxTotal) throw new ZipFormatError(`Archive expands past ${maxTotal} bytes`);
    const raw = bytes.subarray(dataStart, dataEnd);
    let data: Uint8Array;
    if (method === METHOD_STORED) {
      if (compressedSize !== size) throw new ZipFormatError(`Stored entry '${path}' has mismatched sizes`);
      data = raw;
    } else if (method === METHOD_DEFLATED) {
      try {
        data = options.inflateRaw(raw, size);
      } catch {
        throw new ZipFormatError(`Entry '${path}' does not decompress`);
      }
    } else {
      throw new ZipFormatError(`Entry '${path}' uses unsupported compression method ${method}`);
    }
    if (data.length !== size) throw new ZipFormatError(`Entry '${path}' has the wrong size`);
    if (crc32(data) !== crc) throw new ZipFormatError(`Entry '${path}' fails its CRC check`);
    entries.push({ path, data });
  }
  if (pointer !== eocd) throw new ZipFormatError("Unexpected bytes after the central directory entries");
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) throw new ZipFormatError("Entries overlap");
  }
  return entries;
}
