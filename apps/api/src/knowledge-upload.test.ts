/**
 * Knowledge base uploads take PDFs and refuse what is not text: the end-user validation uploaded a PDF and got its raw
 * source ("%PDF-1.4 1 0 obj ...") stored as a chunk. A PDF's text is read page by page (each chunk says its page), a
 * scanned PDF is refused with a clear message, and office files and other binary files never become chunks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { looksBinary } from "./services/knowledge-upload.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  config: AppConfig;
  tempDir: string;
  cookie: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-kb-upload-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  await authService.register({ email: "kb@example.com", password: "kb-Pass-12345!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "kb@example.com", password: "kb-Pass-12345!" } });
  const raw = login.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
  const context: TestContext = { app, store, config, tempDir, cookie };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

/** A small PDF: one page per entry (its lines); an empty entry is a page without text (as a scanned page has). */
function pdf(pages: string[][]): Buffer {
  const esc = (text: string) => `(${text.replace(/[\\()]/g, (char) => `\\${char}`)})`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: number[] = [];
  for (const lines of pages) {
    const content = lines.length > 0 ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `${esc(line)} Tj T*`).join(" ")} ET` : "q 0.5 g 72 72 468 648 re f Q";
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const LOYALTY = pdf([
  ["Loyalty programme", "Members earn 2 points per dollar spent."],
  ["Redeeming points", "100 points take 5 dollars off any order."]
]);

async function knowledgeBase(context: TestContext): Promise<string> {
  const created = await context.app.inject({ method: "POST", url: "/api/knowledge-bases", headers: { cookie: context.cookie }, payload: { name: "docs", embedderId: "token-embedder" } });
  expect(created.statusCode, created.body).toBe(200);
  return created.json<{ knowledgeBase: { id: string } }>().knowledgeBase.id;
}

const upload = (context: TestContext, kbId: string, payload: Record<string, unknown>) =>
  context.app.inject({ method: "POST", url: `/api/knowledge-bases/${kbId}/upload`, headers: { cookie: context.cookie }, payload });

const chunksOf = async (context: TestContext, kbId: string) =>
  (await context.app.inject({ method: "GET", url: `/api/knowledge-bases/${kbId}/chunks`, headers: { cookie: context.cookie } })).json<{
    chunks: Array<{ content: string; metadata: Record<string, unknown> | null }>;
  }>().chunks;

describe("knowledge base upload: PDFs", () => {
  it("reads a PDF's text page by page; every chunk says its page, and no raw PDF source is stored", async () => {
    const context = await createTestContext();
    const kbId = await knowledgeBase(context);
    const response = await upload(context, kbId, { filename: "loyalty.pdf", contentBase64: LOYALTY.toString("base64") });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ sourceId: "loyalty.pdf", documentsLoaded: 2, chunksInserted: 2, kind: "pdf", pageCount: 2 });
    expect(response.json<{ notice?: string }>().notice).toBeUndefined();

    const chunks = await chunksOf(context, kbId);
    expect(chunks.map((chunk) => chunk.metadata?.page).sort()).toEqual([1, 2]);
    const first = chunks.find((chunk) => chunk.metadata?.page === 1)!;
    expect(first.content).toContain("Members earn 2 points per dollar spent.");
    expect(first.metadata).toMatchObject({ kind: "pdf", pageCount: 2, sourceId: "loyalty.pdf" });
    for (const chunk of chunks) {
      expect(chunk.content).not.toMatch(/%PDF|endobj|\/Type/);
    }

    // The page numbers come back with search results too.
    const search = await context.app.inject({ method: "POST", url: `/api/knowledge-bases/${kbId}/search`, headers: { cookie: context.cookie }, payload: { query: "redeeming points", topK: 1 } });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json<{ results: Array<{ metadata: { page?: number } }> }>().results[0]!.metadata.page).toBe(2);
  });

  it("refuses a scanned PDF (no text layer) with a clear message, and says which pages it skipped of a partly scanned one", async () => {
    const context = await createTestContext();
    const kbId = await knowledgeBase(context);
    const scanned = await upload(context, kbId, { filename: "scan.pdf", contentBase64: pdf([[], []]).toString("base64") });
    expect(scanned.statusCode, scanned.body).toBe(400);
    expect(scanned.json()).toMatchObject({ code: "pdf_no_text" });
    expect(scanned.json<{ error: string }>().error).toMatch(/no text layer.*scanned.*not supported/i);
    expect(await chunksOf(context, kbId)).toEqual([]);

    const partly = await upload(context, kbId, { filename: "partly.pdf", contentBase64: pdf([["Opening hours are 9 to 5."], []]).toString("base64") });
    expect(partly.statusCode, partly.body).toBe(200);
    expect(partly.json()).toMatchObject({ documentsLoaded: 1, pageCount: 2 });
    expect(partly.json<{ notice: string }>().notice).toMatch(/1 page has no text layer \(scanned\) and was skipped/);
  });

  it("refuses a PDF sent as text (the validation's repro: the browser read the file as text) and stores nothing", async () => {
    const context = await createTestContext();
    const kbId = await knowledgeBase(context);
    // What `file.text()` gives for a PDF: its source with invalid bytes replaced.
    const asText = new TextDecoder().decode(LOYALTY);
    const response = await upload(context, kbId, { filename: "loyalty.pdf", content: asText });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: "pdf_as_text" });
    // Without a file name too: the content says it is a PDF.
    const unnamed = await upload(context, kbId, { content: asText });
    expect(unnamed.statusCode, unnamed.body).toBe(400);
    expect(await chunksOf(context, kbId)).toEqual([]);
  });

  it("refuses a damaged PDF", async () => {
    const context = await createTestContext();
    const kbId = await knowledgeBase(context);
    const damaged = await upload(context, kbId, { filename: "broken.pdf", contentBase64: Buffer.from("%PDF-1.7\nnot a real document").toString("base64") });
    expect(damaged.statusCode, damaged.body).toBe(400);
    expect(damaged.json<{ error: string }>().error).toMatch(/could not be read/i);
    expect(await chunksOf(context, kbId)).toEqual([]);
  });
});

describe("knowledge base upload: files that are not text", () => {
  it("refuses Word and other office files with a message that says what to upload instead", async () => {
    const context = await createTestContext();
    const kbId = await knowledgeBase(context);
    // A DOCX is a zip archive.
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(200)]);
    const response = await upload(context, kbId, { filename: "policy.docx", contentBase64: docx.toString("base64") });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: "office_file" });
    expect(response.json<{ error: string }>().error).toMatch(/Save it as a PDF .* or as plain text/);
    // Read as text by an older client: refused too.
    const asText = await upload(context, kbId, { filename: "policy.docx", content: new TextDecoder().decode(docx) });
    expect(asText.statusCode, asText.body).toBe(400);
    expect(asText.json()).toMatchObject({ code: "office_file" });
    expect(await chunksOf(context, kbId)).toEqual([]);
  });

  it("refuses images and other binary files, whatever their name; text sent as bytes is loaded as text", async () => {
    const context = await createTestContext();
    const kbId = await knowledgeBase(context);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300)]);
    for (const filename of ["photo.png", "notes.txt"]) {
      const response = await upload(context, kbId, { filename, contentBase64: png.toString("base64") });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: "not_text" });
    }
    const binaryAsText = await upload(context, kbId, { filename: "photo.png", content: new TextDecoder().decode(png) });
    expect(binaryAsText.statusCode, binaryAsText.body).toBe(400);
    expect(await chunksOf(context, kbId)).toEqual([]);

    const markdown = await upload(context, kbId, { filename: "faq.md", contentBase64: Buffer.from("# FAQ\n\nRefunds take 5 days.").toString("base64") });
    expect(markdown.statusCode, markdown.body).toBe(200);
    expect(markdown.json()).toMatchObject({ kind: "markdown", chunksInserted: 1 });
  });

  it("reads text files in UTF-16 or Latin-1 sent as bytes, takes a data: URL, and an empty contentBase64 next to text", async () => {
    const context = await createTestContext();
    const kbId = await knowledgeBase(context);
    const text = "Les remboursements prennent cinq jours ouvrés. Café, crème, déjà, été, à côté.";
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const latin1 = Buffer.from(text, "latin1");
    for (const [filename, bytes] of [["utf16.txt", utf16], ["latin1.txt", latin1]] as const) {
      const response = await upload(context, kbId, { filename, contentBase64: bytes.toString("base64") });
      expect(response.statusCode, response.body).toBe(200);
    }
    const dataUrl = await upload(context, kbId, { filename: "data.txt", contentBase64: `data:text/plain;base64,${Buffer.from("Shipping is free over 50 dollars.").toString("base64")}` });
    expect(dataUrl.statusCode, dataUrl.body).toBe(200);
    const both = await upload(context, kbId, { filename: "both.md", content: "# Both\n\nText wins when the bytes are empty.", contentBase64: "" });
    expect(both.statusCode, both.body).toBe(200);
    const contents = (await chunksOf(context, kbId)).map((chunk) => chunk.content).join("\n");
    expect(contents.match(/ouvrés/g)).toHaveLength(2);
    expect(contents).toContain("Shipping is free");
    expect(contents).toContain("Text wins");
  });

  it("a text file that only mentions %PDF- near its start is loaded as text", async () => {
    const context = await createTestContext();
    const kbId = await knowledgeBase(context);
    const notes = "Notes on file headers: a PDF starts with %PDF- and a version number.\n";
    const response = await upload(context, kbId, { filename: "notes.txt", contentBase64: Buffer.from(notes).toString("base64") });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ kind: "text", chunksInserted: 1 });
  });

  it("tells binary from text", () => {
    expect(looksBinary("Plain text with tabs\tand\r\nline breaks, accents (café) and emoji 🙂")).toBe(false);
    expect(looksBinary("one stray � in a long enough text is fine")).toBe(false);
    expect(looksBinary("a\u0000b")).toBe(true);
    expect(looksBinary("�\u0001�\u0002 short binary")).toBe(true);
  });
});

describe("keyless retrieval: the Token embedder searches hybrid by default", () => {
  const DOCUMENTS = [
    { sourceId: "shipping.txt", content: "Shipping: orders leave the warehouse in two days and take three to five days to arrive by post." },
    { sourceId: "refund-policy.md", content: "Refunds: once we receive the return, refunds take five to seven business days to reach your card." },
    { sourceId: "loyalty.md", content: "Loyalty: members earn two points for every dollar they spend in the store." }
  ];

  async function seededKnowledgeBase(context: TestContext): Promise<string> {
    const kbId = await knowledgeBase(context);
    for (const document of DOCUMENTS) {
      const response = await upload(context, kbId, { filename: document.sourceId, content: document.content });
      expect(response.statusCode, response.body).toBe(200);
    }
    return kbId;
  }

  it("the Knowledge page's test search ranks hybrid and says so", async () => {
    const context = await createTestContext();
    const kbId = await seededKnowledgeBase(context);
    const search = await context.app.inject({ method: "POST", url: `/api/knowledge-bases/${kbId}/search`, headers: { cookie: context.cookie }, payload: { query: "how long do refunds take?", topK: 3 } });
    expect(search.statusCode, search.body).toBe(200);
    const body = search.json<{ mode: string; results: Array<{ metadata: { sourceId?: string; retrieval?: { mode?: string } } }> }>();
    expect(body.mode).toBe("hybrid");
    expect(body.results[0]!.metadata.sourceId).toBe("refund-policy.md");
    expect(body.results[0]!.metadata.retrieval?.mode).toBe("hybrid");
  });

  it("a RAG Retrieve node with the Token embedder and no search mode runs hybrid; a mode it sets wins", async () => {
    const context = await createTestContext();
    const kbId = await seededKnowledgeBase(context);
    const retrieve = (config: Record<string, unknown>) => ({
      id: "wf-keyless",
      name: "Keyless",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "q", type: "text_input", name: "Q", position: { x: 0, y: 0 }, config: { text: "how long do refunds take?" } },
        { id: "retrieve", type: "rag_retrieve", name: "Retrieve", position: { x: 200, y: 0 }, config: { queryTemplate: "{{text}}", topK: 1, embedderId: "token-embedder", vectorStoreId: "knowledge-base", knowledgeBaseId: kbId, ...config } },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { outputKey: "context" } }
      ],
      edges: [
        { id: "e1", source: "q", target: "retrieve" },
        { id: "e2", source: "retrieve", target: "out" }
      ]
    });
    const run = async (config: Record<string, unknown>) => {
      const saved = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie: context.cookie }, payload: retrieve(config) });
      expect(saved.statusCode, saved.body).toBe(200);
      const executed = await context.app.inject({ method: "POST", url: "/api/workflows/wf-keyless/execute", headers: { cookie: context.cookie }, payload: {} });
      expect(executed.statusCode, executed.body).toBe(200);
      const node = executed.json<{ nodeResults: Array<{ nodeId: string; output?: { documents?: Array<{ metadata?: { sourceId?: string; retrieval?: { mode?: string } } }> } }> }>().nodeResults.find((result) => result.nodeId === "retrieve")!;
      return node.output!.documents![0]!.metadata!;
    };
    const unset = await run({});
    expect(unset.retrieval?.mode).toBe("hybrid");
    expect(unset.sourceId).toBe("refund-policy.md");
    expect((await run({ searchMode: "vector" })).retrieval?.mode).not.toBe("hybrid");
  });
});
