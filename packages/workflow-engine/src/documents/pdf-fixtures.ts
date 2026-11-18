import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * PDF documents built in code for the tests (no binary fixtures in the repository): ordinary ones with text,
 * comments, form fields, links and properties, and malicious shapes that must stay inside the reader's limits.
 * Test helper only; not exported from the package.
 */

type Body = string | Buffer;

/** A PDF from its objects (object n is `objects[n - 1]`), with a correct cross-reference table unless `xref` replaces it. */
export function buildPdf(objects: Body[], options: { root?: number; info?: number; trailerExtra?: string; xref?: (offsets: number[]) => string } = {}): Uint8Array {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), typeof body === "string" ? Buffer.from(body, "latin1") : body, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xrefAt = length;
  const table =
    options.xref?.(offsets) ??
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${options.root ?? 1} 0 R${options.info ? ` /Info ${options.info} 0 R` : ""}${options.trailerExtra ?? ""} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(Buffer.from(table + trailer, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

/** A PDF string literal with ( ) \ escaped. */
export function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/g, (char) => `\\${char}`)})`;
}

/** A content stream that writes each line with Helvetica, top down. */
export function textContent(lines: readonly string[]): string {
  return `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `${pdfString(line)} Tj T*`).join(" ")} ET`;
}

function stream(content: Buffer | string, extra = ""): Buffer {
  const data = typeof content === "string" ? Buffer.from(content, "latin1") : content;
  return Buffer.concat([Buffer.from(`<< /Length ${data.length}${extra} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
}

export interface TextPdfOptions {
  /** Per page (same order): comments as { text, author }. */
  comments?: Array<Array<{ text: string; author?: string }>>;
  /** Per page: text form fields as { name, value }. */
  fields?: Array<Array<{ name: string; value: string }>>;
  /** Per page: link addresses. */
  links?: string[][];
  /** Document information dictionary entries. */
  info?: Record<string, string>;
}

/** A PDF with one page per entry of `pages` (each a list of lines), and optional comments, fields, links and properties. */
export function textPdf(pages: ReadonlyArray<readonly string[]>, options: TextPdfOptions = {}): Uint8Array {
  // 1 catalog, 2 pages, 3 font, then per page: page, content, annotations...; then the info dictionary.
  const objects: Body[] = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  const pageRefs: number[] = [];
  const fieldRefs: number[] = [];
  pages.forEach((lines, index) => {
    const pageNumber = objects.length + 1;
    objects.push("");
    objects.push(stream(textContent(lines)));
    const contentNumber = objects.length;
    const annots: number[] = [];
    for (const comment of options.comments?.[index] ?? []) {
      objects.push(`<< /Type /Annot /Subtype /Text /Rect [72 600 92 620] /Contents ${pdfString(comment.text)}${comment.author ? ` /T ${pdfString(comment.author)}` : ""} >>`);
      annots.push(objects.length);
    }
    for (const field of options.fields?.[index] ?? []) {
      objects.push(`<< /Type /Annot /Subtype /Widget /FT /Tx /T ${pdfString(field.name)} /V ${pdfString(field.value)} /Rect [72 500 272 520] /P ${pageNumber} 0 R >>`);
      annots.push(objects.length);
      fieldRefs.push(objects.length);
    }
    for (const link of options.links?.[index] ?? []) {
      objects.push(`<< /Type /Annot /Subtype /Link /Rect [72 400 272 420] /A << /S /URI /URI ${pdfString(link)} >> >>`);
      annots.push(objects.length);
    }
    objects[pageNumber - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R` +
      `${annots.length > 0 ? ` /Annots [${annots.map((ref) => `${ref} 0 R`).join(" ")}]` : ""} >>`;
    pageRefs.push(pageNumber);
  });
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${fieldRefs.length > 0 ? ` /AcroForm << /Fields [${fieldRefs.map((ref) => `${ref} 0 R`).join(" ")}] >>` : ""} >>`;
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`;
  let info: number | undefined;
  if (options.info) {
    objects.push(`<< ${Object.entries(options.info).map(([key, value]) => `/${key} ${pdfString(value)}`).join(" ")} >>`);
    info = objects.length;
  }
  return buildPdf(objects, info ? { info } : {});
}

/** A page with only an image drawn on it (a scanned page): no text layer. */
export function scannedPdf(pageCount = 1): Uint8Array {
  const objects: Body[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const image = stream(Buffer.alloc(8 * 8, 0x80), " /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8");
  objects.push(image);
  const pageRefs: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    objects.push(stream("q 612 0 0 792 0 0 cm /Im1 Do Q"));
    const content = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 3 0 R >> >> /Contents ${content} 0 R >>`);
    pageRefs.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`;
  return buildPdf(objects);
}

// ---------------------------------------------------------------------------
// Malicious shapes
// ---------------------------------------------------------------------------

const BASE_PAGE = (content: number, resources = "<< /Font << /F1 3 0 R >> >>") => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${content} 0 R >>`;
const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

/** A cross-reference table that claims two billion entries (and a trailer /Size to match). */
export function hugeXrefPdf(): Uint8Array {
  const objects: Body[] = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", HELVETICA, BASE_PAGE(5), stream(textContent(["huge xref"]))];
  return buildPdf(objects, {
    trailerExtra: " /Size 2000000000",
    xref: (offsets) => `xref\n0 2000000000\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`
  });
}

/** A cross-reference stream whose /Index and /W claim two billion wide entries. */
export function hugeXrefStreamPdf(): Uint8Array {
  const objects: Body[] = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", HELVETICA, BASE_PAGE(5), stream(textContent(["huge xref stream"]))];
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n", "latin1")];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), typeof body === "string" ? Buffer.from(body, "latin1") : body, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xrefAt = length;
  const data = Buffer.alloc(64, 1);
  parts.push(Buffer.from(`6 0 obj\n<< /Type /XRef /Size 2147483647 /Index [0 2147483647] /W [4 4 4] /Root 1 0 R /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

/** Arrays and dictionaries nested `depth` levels deep in the page dictionary. */
export function deepNestingPdf(depth = 100_000): Uint8Array {
  const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
  const dicts = `${"<< /A ".repeat(depth)}1${" >>".repeat(depth)}`;
  const objects: Body[] = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", HELVETICA, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Deep ${nested} /DeepDict ${dicts} >>`, stream(textContent(["deep nesting"]))];
  return buildPdf(objects);
}

/** A page tree whose Kids chain `depth` intermediate nodes deep. */
export function deepPageTreePdf(depth = 50_000): Uint8Array {
  // 1 catalog, 2 root pages node, 3 font, 4.. chain of Pages nodes, then the page and its content.
  const objects: Body[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", HELVETICA];
  const first = 4;
  for (let index = 0; index < depth; index += 1) objects.push("");
  const pageNumber = objects.length + 1;
  objects.push("");
  objects.push(stream(textContent(["deep tree"])));
  objects[1] = `<< /Type /Pages /Kids [${first} 0 R] /Count 1 >>`;
  for (let index = 0; index < depth; index += 1) {
    const number = first + index;
    const kid = index === depth - 1 ? pageNumber : number + 1;
    objects[number - 1] = `<< /Type /Pages /Parent ${index === 0 ? 2 : number - 1} 0 R /Kids [${kid} 0 R] /Count 1 >>`;
  }
  objects[pageNumber - 1] = `<< /Type /Page /Parent ${first + depth - 1} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`;
  return buildPdf(objects);
}

/**
 * The shape of the CVE-2024-4367 proof of concept: a Type1 font whose FontMatrix (in the font dictionary and in the
 * embedded font program) carries a string that would close the generated code and run `payload` in a pdf.js that
 * compiles glyphs with eval. The page also has ordinary text, which must still be read.
 */
export function fontMatrixPocPdf(payload: string, lines: readonly string[] = ["font matrix page"]): Uint8Array {
  const injected = `(0\\); ${payload.replace(/[\\()]/g, (char) => `\\${char}`)}; //)`;
  const program = [
    "%!PS-AdobeFont-1.0: Evil 001.000",
    "11 dict begin",
    "/FontName /Evil def",
    "/FontType 1 def",
    `/FontMatrix [1 2 3 4 5 ${injected}] readonly def`,
    "/FontBBox {0 0 1000 1000} readonly def",
    "/Encoding StandardEncoding def",
    "currentdict end",
    "currentfile eexec"
  ].join("\n");
  const objects: Body[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    HELVETICA,
    BASE_PAGE(5, "<< /Font << /F1 3 0 R /F2 6 0 R >> >>"),
    stream(`${textContent(lines)} BT /F2 12 Tf 72 600 Td (abc) Tj ET`),
    `<< /Type /Font /Subtype /Type1 /BaseFont /Evil /FirstChar 97 /LastChar 99 /Widths [500 500 500] /FontMatrix [1 2 3 4 5 ${injected}] /FontDescriptor 7 0 R >>`,
    "<< /Type /FontDescriptor /FontName /Evil /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile 8 0 R >>",
    stream(program, ` /Length1 ${program.length} /Length2 0 /Length3 0`)
  ];
  return buildPdf(objects);
}

/** A content stream of `operators` text-showing operators (an endless page for the time limit). */
export function endlessContentPdf(operators = 2_000_000): Uint8Array {
  const content = Buffer.from("BT /F1 12 Tf 72 720 Td " + "(x) Tj 0 0 Td ".repeat(operators) + "ET", "latin1");
  const objects: Body[] = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", HELVETICA, BASE_PAGE(5), stream(deflateSync(content), " /Filter /FlateDecode")];
  return buildPdf(objects);
}

/** A content stream with no `endstream` and a /Length past the end of the file. */
export function unterminatedStreamPdf(): Uint8Array {
  const objects: Body[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    HELVETICA,
    BASE_PAGE(5),
    `<< /Length 2147483647 >>\nstream\n${textContent(["never ends"])} `
  ];
  return buildPdf(objects);
}

/** A form XObject that draws itself (an endless recursion if followed). */
export function selfDrawingPdf(): Uint8Array {
  const objects: Body[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    HELVETICA,
    BASE_PAGE(5, "<< /Font << /F1 3 0 R >> /XObject << /X1 6 0 R >> >>"),
    stream(`${textContent(["self drawing"])} /X1 Do`),
    stream("BT /F1 12 Tf (loop) Tj ET /X1 Do", " /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /X1 6 0 R >> >>")
  ];
  return buildPdf(objects);
}

/** A page whose content stream decodes (FlateDecode) to `decodedMb` MB of spaces: a decompression bomb. */
export function flateBombPdf(decodedMb = 200): Uint8Array {
  const compressed = deflateSync(Buffer.alloc(decodedMb * 1024 * 1024, 0x20), { level: 9 });
  const objects: Body[] = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", HELVETICA, BASE_PAGE(5), stream(compressed, " /Filter /FlateDecode")];
  return buildPdf(objects);
}

// ---------------------------------------------------------------------------
// Encryption (standard security handler, revision 2, RC4 40-bit)
// ---------------------------------------------------------------------------

const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[index] = data[index]! ^ s[(s[i]! + s[j]!) & 0xff]!;
  }
  return out;
}

const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();
const padded = (password: string) => Buffer.concat([Buffer.from(password, "latin1"), PAD]).subarray(0, 32);

/**
 * A one-page PDF encrypted with the standard security handler (RC4, 40-bit). With an empty `userPassword` anyone can
 * open it (only the owner password restricts it); with another one it needs that password.
 */
export function encryptedPdf(lines: readonly string[], userPassword: string, ownerPassword = "owner"): Uint8Array {
  const id = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const permissions = -4;
  const o = rc4(md5(padded(ownerPassword)).subarray(0, 5), padded(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const key = md5(padded(userPassword), o, p, id).subarray(0, 5);
  const u = rc4(key, PAD);
  const objectKey = (number: number) => md5(key, Buffer.from([number & 0xff, (number >> 8) & 0xff, (number >> 16) & 0xff, 0, 0])).subarray(0, 10);
  const content = rc4(objectKey(5), Buffer.from(textContent(lines), "latin1"));
  const objects: Body[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    HELVETICA,
    BASE_PAGE(5),
    stream(content),
    `<< /Filter /Standard /V 1 /R 2 /O <${o.toString("hex")}> /U <${u.toString("hex")}> /P ${permissions} >>`
  ];
  return buildPdf(objects, { trailerExtra: ` /Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]` });
}
