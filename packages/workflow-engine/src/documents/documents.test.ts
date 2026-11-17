import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentError } from "./errors.js";
import { decodeDocument, looksLikeHtml, sniffKind } from "./sniff.js";
import { extractHtmlText, HTML_MAX_DEPTH } from "./html.js";
import { parseCsv } from "./csv.js";
import { extractDocument } from "./extract.js";
import { fetchDocument } from "./fetch.js";
import { scanExtractedDocument, sensitiveDocumentScanner } from "./scan.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const scanner = sensitiveDocumentScanner({ dictionaries: [] });

async function scan(text: string | Uint8Array, mediaType?: string, protect?: (value: string, dataClass: string) => Promise<string>) {
  const bytes = typeof text === "string" ? utf8(text) : text;
  const document = extractDocument({ bytes, mediaType: mediaType ?? null });
  return { document, outcome: await scanExtractedDocument(document, bytes, { scanner, ...(protect ? { protect } : {}) }) };
}

async function expectDocumentError(promise: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as DocumentError).code).toBe(code);
    return error as DocumentError;
  }
  throw new Error(`expected DocumentError ${code}`);
}

describe("sniffing and decoding", () => {
  it("refuses PDF, zip, images and executables by their bytes whatever the declared type", async () => {
    for (const [bytes, pattern] of [
      [utf8("%PDF-1.7\n..."), /PDF/],
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), /Zip and Office/],
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), /Images/],
      [new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]), /Executable/],
      [new Uint8Array([0x61, 0x62, 0x00, 0x63]), /binary/]
    ] as const) {
      const error = await expectDocumentError(() => extractDocument({ bytes, mediaType: "text/plain" }), "unsupported_type");
      expect(error.message).toMatch(pattern);
      expect(error.status).toBe(400);
    }
  });

  it("decodes by BOM, declared charset, HTML meta charset, strict UTF-8, then windows-1252", () => {
    expect(decodeDocument(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xc3, 0xa9]))).toEqual({ text: "hé", encoding: "utf-8" });
    expect(decodeDocument(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0xe9, 0x00]))).toEqual({ text: "hé", encoding: "utf-16le" });
    expect(decodeDocument(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0xe9]))).toEqual({ text: "hé", encoding: "utf-16be" });
    expect(decodeDocument(new Uint8Array([0x68, 0xe9]), "iso-8859-2").encoding).toBe("iso-8859-2");
    const meta = utf8('<html><head><meta charset="iso-8859-15"></head>');
    expect(decodeDocument(meta).encoding).toBe("iso-8859-15");
    expect(decodeDocument(utf8("plain é"))).toEqual({ text: "plain é", encoding: "utf-8" });
    // Invalid UTF-8 (a lone 0xE9) falls back to windows-1252.
    expect(decodeDocument(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toEqual({ text: "café", encoding: "windows-1252" });
    // An unknown or `replacement` charset label is ignored.
    expect(decodeDocument(utf8("ok"), "no-such-charset").encoding).toBe("utf-8");
    expect(decodeDocument(utf8("ok"), "iso-2022-kr").encoding).toBe("utf-8");
  });

  it("reads by content, records a mismatch, and never trusts the declared type", () => {
    expect(sniffKind("<!doctype html><p>x</p>", "text", "text/plain")).toMatchObject({ kind: "html", typeMismatch: true });
    expect(sniffKind('{"a":1}', "csv", "text/csv")).toMatchObject({ kind: "json", typeMismatch: true });
    expect(sniffKind("just words", "csv", "text/csv")).toMatchObject({ kind: "text", typeMismatch: true });
    expect(sniffKind("a,b\n1,2\n3,4", "csv", "text/csv")).toMatchObject({ kind: "csv", typeMismatch: false });
    // CSV is never guessed without a declared type: commas in prose stay text.
    expect(sniffKind("a,b\n1,2", null, null)).toMatchObject({ kind: "text", typeMismatch: false });
    expect(sniffKind("# Title", "markdown", "text/markdown")).toMatchObject({ kind: "markdown", typeMismatch: false });
    expect(sniffKind("plain", null, "application/pdf")).toMatchObject({ kind: "text", typeMismatch: true });
  });

  it("refuses JSON that was declared but does not parse, without echoing its content", async () => {
    const error = await expectDocumentError(() => extractDocument({ bytes: utf8('{"secret": "alice@example.com"'), mediaType: "application/json" }), "invalid_document");
    expect(error.message).not.toContain("alice");
  });
});

describe("HTML", () => {
  it("drops scripts, styles and comments, keeps block line breaks, and reports hidden text and attributes apart", () => {
    const html = extractHtmlText(`<!doctype html><html><head><title>T</title><style>.a{}</style><script>var leak = "x@y.z"</script></head>
      <body><!-- c@d.e --><h1>Hello</h1><p>Mail <b>bob@example.com</b> now</p>
      <div hidden>hid@example.com</div><span style="display: none">also@example.com</span><p aria-hidden="true">aria@example.com</p>
      <img alt="photo of alt@example.com" src="x.png"><input value="val@example.com"><noscript>ns@example.com</noscript>
      <svg><text>svg@example.com</text></svg><template>tpl@example.com</template></body></html>`);
    expect(html.visible).toBe("T\n\nHello\n\nMail bob@example.com now");
    expect(html.hidden).toContain("hid@example.com");
    expect(html.hidden).toContain("also@example.com");
    expect(html.hidden).toContain("aria@example.com");
    expect(html.attributes).toEqual([
      { tag: "img", attribute: "alt", text: "photo of alt@example.com" },
      { tag: "input", attribute: "value", text: "val@example.com" }
    ]);
    const all = JSON.stringify(html);
    for (const dropped of ["x@y.z", "c@d.e", "ns@example.com", "svg@example.com", "tpl@example.com"]) expect(all).not.toContain(dropped);
  });

  it("locates findings in visible text, attributes and hidden text", async () => {
    const { outcome } = await scan('<html><body><p>first</p><p>write to bob@example.com</p><img alt="a@example.com"><div hidden>h@example.com</div></body></html>', "text/html");
    expect(outcome.findings.map((finding) => finding.location.label)).toEqual(["visible text, line 3, column 10", "alt of <img>", "hidden text, line 1, column 1"]);
    expect(outcome.findings.every((finding) => !finding.maskedPreview.includes("bob@example.com"))).toBe(true);
    expect(outcome.riskLevel).toBe("medium");
  });

  it("parses nested markup up to the depth limit", () => {
    const depth = HTML_MAX_DEPTH - 1;
    const html = `${"<div>".repeat(depth)}deep@example.com${"</div>".repeat(depth)}`;
    expect(extractHtmlText(html).visible).toBe("deep@example.com");
  });

  it("refuses deep or never-closed nesting quickly instead of parsing it in quadratic time", async () => {
    for (const html of [`${"<div>".repeat(50_000)}x${"</div>".repeat(50_000)}`, `${"<b>".repeat(200_000)}${"</i>".repeat(200_000)}`]) {
      const started = Date.now();
      await expectDocumentError(() => extractHtmlText(html), "too_large");
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });

  it("sniffs HTML after many leading comments in linear time", () => {
    const comments = "<!---->".repeat(5_000);
    const started = Date.now();
    expect(looksLikeHtml(`${comments}<!doctype html><p>x`)).toBe(true);
    expect(looksLikeHtml(`${comments}x`)).toBe(false);
    expect(looksLikeHtml(`${"<!--".repeat(40)}${"-".repeat(4_000)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("JSON", () => {
  it("scans strings and keys with pointers, and never puts a non-name key in a pointer", async () => {
    const { outcome } = await scan(JSON.stringify({ users: [{ email: "a@example.com" }], "b@example.com": "x", "a/b": "c@example.com" }), "application/json");
    expect(outcome.findings.map((finding) => finding.location.label)).toEqual(["/users/0/email", "/{#1} (key)", "/{#2}"]);
  });

  it("refuses JSON past the depth or node limits", async () => {
    const deep = `${"[".repeat(70)}1${"]".repeat(70)}`;
    await expectDocumentError(() => extractDocument({ bytes: utf8(deep), mediaType: "application/json" }), "too_large");
    const wide = JSON.stringify(Array.from({ length: 50 }, (_, i) => i));
    await expectDocumentError(() => extractDocument({ bytes: utf8(wide), mediaType: "application/json", limits: { jsonMaxNodes: 10 } }), "too_large");
  });

  it("writes a key that holds a finding by position wherever it appears in a pointer", async () => {
    const { outcome } = await scan(JSON.stringify({ "bob@example.com": { note: "c@example.com" } }), "application/json");
    expect(outcome.findings.map((finding) => finding.location.label)).toEqual(["/{#0} (key)", "/{#0}/note"]);
    expect(JSON.stringify(outcome.findings)).not.toContain("bob");
  });

  it("keeps both members when two keys redact to the same text", async () => {
    const { outcome } = await scan(JSON.stringify({ "a@example.com": 1, "b@example.com": 2 }), "application/json", async () => "[EMAIL]");
    expect(JSON.parse(outcome.redactedText!)).toEqual({ "[EMAIL]": 1, "[EMAIL] (2)": 2 });
  });

  it("redacts in place and keeps the shape", async () => {
    const { outcome } = await scan(JSON.stringify({ a: "mail a@example.com", n: 3 }), "application/json", async (_value, dataClass) => `[${dataClass.toUpperCase()}]`);
    expect(JSON.parse(outcome.redactedText!)).toEqual({ a: "mail [EMAIL]", n: 3 });
  });
});

describe("CSV", () => {
  it("parses quotes, embedded line breaks and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, ""y""","line1\nline2"\r\n', ",", 10)).toEqual([
      ["a", "b"],
      ['x, "y"', "line1\nline2"]
    ]);
  });

  it("locates findings by row, column and header", async () => {
    const { outcome } = await scan("name,email\nAda,ada@example.com\nBob,bob@example.com\n", "text/csv");
    expect(outcome.findings.map((finding) => finding.location)).toEqual([
      { kind: "csv", row: 2, column: 2, field: "email", label: "row 2, column 2 (email)" },
      { kind: "csv", row: 3, column: 2, field: "email", label: "row 3, column 2 (email)" }
    ]);
  });

  it("never shows a header that holds a finding as a field name", async () => {
    const { outcome } = await scan("id,ada@example.com\n1,bob@example.com\n", "text/csv");
    expect(outcome.findings.map((finding) => finding.location.label)).toEqual(["row 1, column 2", "row 2, column 2"]);
  });

  it("refuses more cells than the limit", async () => {
    await expectDocumentError(() => extractDocument({ bytes: utf8(`${",".repeat(20)}\n`.repeat(5)), mediaType: "text/csv", limits: { csvMaxCells: 50 } }), "too_large");
    expect(() => parseCsv("a,b\nc,d\n", ",", 10, 3)).toThrow(DocumentError);
  });

  it("refuses more rows than the limit", async () => {
    await expectDocumentError(() => extractDocument({ bytes: utf8("a,b\n1,2\n3,4\n5,6\n"), mediaType: "text/csv", limits: { csvMaxRows: 2 } }), "too_large");
  });

  it("redacts cells and re-quotes them", async () => {
    const { outcome } = await scan("k,v\nx,a@example.com\n", "text/csv", async () => "[EMAIL, 1]");
    expect(outcome.redactedText).toBe('k,v\nx,"[EMAIL, 1]"');
  });
});

describe("text, limits and truncation", () => {
  it("reports line and column in text and Markdown", async () => {
    const { outcome } = await scan("# Notes\n\nCall +1 415 555 0100 or mail a@example.com\n", "text/markdown");
    expect(outcome.findings.map((finding) => [finding.dataClass, finding.location.label])).toEqual([
      ["phone", "line 3, column 6"],
      ["email", "line 3, column 30"]
    ]);
  });

  it("refuses more bytes than the limit and says truncated (with the covered range) past the character limit", async () => {
    await expectDocumentError(() => extractDocument({ bytes: utf8("x".repeat(20)), limits: { maxBytes: 10 } }), "too_large");
    const bytes = utf8(`${"a".repeat(30)} z@example.com`);
    const document = extractDocument({ bytes, limits: { maxChars: 20 } });
    expect(document).toMatchObject({ truncated: true, covered: { chars: 20, of: 44 } });
    const outcome = await scanExtractedDocument(document, bytes, { scanner, protect: async () => "[X]" });
    expect(outcome.total).toBe(0);
    expect(outcome.redactedText).not.toContain("z@example.com");
    expect(outcome.redactedText).toContain("not checked");
  });

  it("lists at most maxFindings but counts them all", async () => {
    const bytes = utf8(Array.from({ length: 5 }, (_, i) => `u${i}@example.com`).join("\n"));
    const document = extractDocument({ bytes });
    const outcome = await scanExtractedDocument(document, bytes, { scanner, maxFindings: 2 });
    expect(outcome).toMatchObject({ total: 5, findingsTruncated: true, countsByClass: { email: 5 } });
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.documentId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("fetchDocument", () => {
  const seen: http.IncomingHttpHeaders[] = [];
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      seen.push(request.headers);
      const path = (request.url ?? "/").split("?")[0];
      if (path === "/doc") {
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("contact a@example.com");
      } else if (path === "/bomb") {
        // 8 MB of zeros compress to a few KB: the cap on decoded bytes must stop it.
        const body = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x61));
        response.setHeader("content-encoding", "gzip");
        response.setHeader("content-length", String(body.byteLength));
        response.end(body);
      } else if (path === "/ratio") {
        const body = gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x61));
        response.setHeader("content-encoding", "gzip");
        response.setHeader("content-length", String(body.byteLength));
        response.end(body);
      } else if (path === "/to-private") {
        response.statusCode = 302;
        response.setHeader("location", "http://10.0.0.5/secret");
        response.end();
      } else if (path === "/to-other-host") {
        response.statusCode = 302;
        response.setHeader("location", "http://elsewhere.test/doc");
        response.end();
      } else if (path === "/slow") {
        setTimeout(() => response.end("late"), 2_000);
      } else if (path === "/missing") {
        response.statusCode = 404;
        response.end("nope");
      } else {
        response.end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const open = { denyPrivate: false, allowlist: [] };

  it("fetches without cookies or credentials and logs only the origin and a path hash", async () => {
    seen.length = 0;
    const fetched = await fetchDocument(`${base}/doc?token=abc`, { outbound: open });
    expect(new TextDecoder().decode(fetched.bytes)).toBe("contact a@example.com");
    expect(fetched.mediaType).toBe("text/plain; charset=utf-8");
    expect(fetched.origin).toBe(base);
    expect(fetched.pathHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(fetched.origin)).not.toContain("token");
    expect(seen[0]!.cookie).toBeUndefined();
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it("refuses a URL with a user name or password", async () => {
    await expectDocumentError(fetchDocument(`http://user:pass@127.0.0.1:1/doc`, { outbound: open }), "invalid_url");
  });

  it("stops a gzip bomb at the decoded-byte cap", async () => {
    const error = await expectDocumentError(fetchDocument(`${base}/bomb`, { outbound: open, maxBytes: 1024 * 1024 }), "too_large");
    expect(error.status).toBe(400);
  });

  it("stops a body that expands more than 100 times past 1 MiB", async () => {
    const error = await expectDocumentError(fetchDocument(`${base}/ratio`, { outbound: open, maxBytes: 5 * 1024 * 1024 }), "too_large");
    expect(error.message).toMatch(/expands/);
  });

  it("refuses a redirect to a private address under denyPrivate", async () => {
    const resolver = async (host: string) => (host === "docs.test" ? ["93.184.216.34"] : ["10.0.0.5"]);
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      return target.startsWith("http://docs.test") ? new Response(null, { status: 302, headers: { location: "http://10.0.0.5/secret" } }) : new Response("internal");
    }) as typeof fetch;
    const error = await expectDocumentError(fetchDocument("http://docs.test/x", { outbound: { denyPrivate: true, allowlist: [] }, resolver, fetchImpl }), "blocked_url");
    expect(error.status).toBe(422);
    expect(error.reason).toBe("address_blocked");
  });

  it("refuses a loopback URL under denyPrivate before connecting", async () => {
    seen.length = 0;
    await expectDocumentError(fetchDocument(`${base}/doc`, { outbound: { denyPrivate: true, allowlist: [] } }), "blocked_url");
    expect(seen).toHaveLength(0);
  });

  it("refuses a name that rebinds to a blocked address at connect time", async () => {
    seen.length = 0;
    let calls = 0;
    const rebinding = async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const port = (server.address() as AddressInfo).port;
    await expectDocumentError(fetchDocument(`http://rebind.test:${port}/doc`, { outbound: { denyPrivate: true, allowlist: [] }, resolver: rebinding }), "blocked_url");
    expect(seen).toHaveLength(0);
  });

  it("checks the host allow-list on the URL and on every redirect", async () => {
    await expectDocumentError(fetchDocument(`${base}/doc`, { outbound: open, allowHost: (host) => host === "docs.test" }), "host_not_allowed");
    const error = await expectDocumentError(fetchDocument(`${base}/to-other-host`, { outbound: open, allowHost: (host) => host === "127.0.0.1" }), "host_not_allowed");
    expect(error.status).toBe(403);
    expect(error.message).toContain("elsewhere.test");
  });

  it("times out on a server that does not answer, and reports error statuses", async () => {
    await expectDocumentError(fetchDocument(`${base}/slow`, { outbound: open, firstByteTimeoutMs: 100, timeoutMs: 1_000 }), "timeout");
    await expectDocumentError(fetchDocument(`${base}/missing`, { outbound: open }), "fetch_failed");
  });

  it("refuses non-http schemes", async () => {
    await expectDocumentError(fetchDocument("file:///etc/passwd", { outbound: open }), "blocked_url");
  });
});
