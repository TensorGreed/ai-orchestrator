/**
 * Phase 11.1 — signed run manifests and audit bundles over the API: a
 * manifest built from a real run (fake model, MCP mock tool call, RAG
 * citation), secrets kept out of manifests, bundles and logs, byte-identical
 * regeneration, refusal of runs in progress, RBAC, the export audit event,
 * the generated signing key stored through SecretService, rotation, the
 * size cap, retention and migration 29.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  auditBundleSignatureSchema,
  auditBundleSignedBytes,
  canonicalJson,
  readZip,
  runManifestAttestationBytes,
  runManifestSchema,
  type AuditSigningKeysResponse,
  type RunManifestView,
  type Workflow
} from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { AuditBundleService } from "./services/audit-bundle-service.js";
import { AuditSigningService, auditKeyIdFor, ed25519PublicKeyFromRaw } from "./services/audit-signing-service.js";
import { SecretService } from "./services/secret-service.js";
import { UsageService } from "./services/usage-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
  dbPath: string;
}

const contexts: TestContext[] = [];
const closers: Array<() => Promise<void>> = [];
const PLANTED = "sk-planted-AUDIT-value-9f8e7d6c5b4a39281706";

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-audit-bundles-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, secretService, config, tempDir, dbPath };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length > 0) await closers.pop()!();
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "DELETE", url: string, cookie?: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** A local OpenAI-style endpoint that plays back scripted replies; `echoAuth` leaks the bearer token into the reply. */
async function startFakeModel(script: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>; usage?: [number, number] }>, echoAuth = false) {
  let index = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = script[Math.min(index, script.length - 1)]!;
      index += 1;
      const content = echoAuth ? `${reply.content ?? ""} (auth was ${String(request.headers.authorization ?? "")})` : reply.content ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content,
                tool_calls: (reply.toolCalls ?? []).map((entry) => ({ id: entry.id, type: "function", function: { name: entry.name, arguments: JSON.stringify(entry.args) } }))
              }
            }
          ],
          ...(reply.usage ? { usage: { prompt_tokens: reply.usage[0], completion_tokens: reply.usage[1] } } : {})
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${address.port}/v1`;
}

interface RunSetup {
  executionId: string;
  serverId: string;
  secretId: string;
  workflow: Workflow;
}

/** rag_retrieve → agent (fake model + registry MCP mock tool) → extract_citations → output. */
async function runAuditedWorkflow(context: TestContext, cookie: string, options: { echoAuth?: boolean; workflowId?: string; projectId?: string; finalContent?: string } = {}): Promise<RunSetup> {
  const secret = await call(context, "POST", "/api/secrets", cookie, { name: "Model key", provider: "openai", value: PLANTED, projectId: "default" });
  expect(secret.statusCode).toBe(200);
  const secretId = secret.json<{ id: string }>().id;
  const server = await call(context, "POST", "/api/mcp/servers", cookie, { name: "Mock tools", adapterId: "mock-mcp", probeEnabled: false });
  expect(server.statusCode).toBe(201);
  const serverId = server.json<{ server: { id: string } }>().server.id;
  const kb = await call(context, "POST", "/api/knowledge-bases", cookie, { name: "FAQ", embedderId: "token-embedder" });
  const kbId = kb.json<{ knowledgeBase: { id: string } }>().knowledgeBase.id;
  await call(context, "POST", `/api/knowledge-bases/${kbId}/ingest`, cookie, {
    sourceId: "auth-faq",
    documents: [{ content: "Reset your password using the recovery email link." }]
  });
  const baseUrl = await startFakeModel(
    [
      { toolCalls: [{ id: "c1", name: "mock-mcp__calculator", args: { expression: "1+1" } }], usage: [100, 10] },
      { content: options.finalContent ?? "Use the recovery link [1].", usage: [50, 5] }
    ],
    options.echoAuth
  );
  const workflowId = options.workflowId ?? "wf-audit";
  const workflow: Workflow = {
    id: workflowId,
    name: "Audited support",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: options.projectId ?? "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      {
        id: "retrieve",
        type: "rag_retrieve",
        name: "Retrieve",
        position: { x: 150, y: 0 },
        config: { queryTemplate: "reset password", topK: 1, embedderId: "token-embedder", vectorStoreId: "knowledge-base", knowledgeBaseId: kbId }
      },
      {
        id: "agent",
        type: "agent_orchestrator",
        name: "Agent",
        position: { x: 300, y: 0 },
        config: { systemPromptTemplate: "You answer support questions.", userPromptTemplate: "Answer using: {{documents.0.text}}", maxIterations: 3, toolCallingEnabled: true }
      },
      {
        id: "model",
        type: "llm_call",
        name: "Model",
        position: { x: 300, y: 160 },
        config: {
          provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl, secretRef: { secretId }, temperature: 0.2, extra: { maxRetries: 0 } }
        }
      },
      { id: "tool", type: "mcp_tool", name: "Registry tools", position: { x: 440, y: 160 }, config: { registryServerId: serverId, toolName: "calculator" } },
      { id: "cite", type: "extract_citations", name: "Cite", position: { x: 450, y: 0 }, config: { answerPath: "answer", documentsPath: "documents" } },
      { id: "output", type: "output", name: "Output", position: { x: 600, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e0", source: "start", target: "retrieve" },
      { id: "e1", source: "retrieve", target: "agent" },
      { id: "e2", source: "retrieve", target: "cite" },
      { id: "e3", source: "agent", target: "cite" },
      { id: "e4", source: "cite", target: "output" },
      { id: "e5", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "e6", source: "agent", sourceHandle: "tool", target: "tool" }
    ]
  };
  expect((await call(context, "POST", "/api/workflows", cookie, workflow)).statusCode).toBe(200);
  const run = await call(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, {});
  expect(run.statusCode).toBe(200);
  const body = run.json<{ status: string; executionId: string }>();
  expect(body.status).toBe("success");
  return { executionId: body.executionId, serverId, secretId, workflow };
}

function unzip(bytes: Buffer): Map<string, Buffer> {
  const entries = readZip(new Uint8Array(bytes), { inflateRaw: (data, expected) => new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, expected) })) });
  return new Map(entries.map((entry) => [entry.path, Buffer.from(entry.data)]));
}

const sha256 = (data: Uint8Array | string) => crypto.createHash("sha256").update(data).digest("hex");

/** Offline verification, as the CLI does it, against a given base64 public key. */
function verifyBundle(bytes: Buffer, publicKeyBase64: string): boolean {
  const files = unzip(bytes);
  const signature = auditBundleSignatureSchema.parse(JSON.parse(files.get("signature.json")!.toString("utf8")));
  const { signature: sig, ...body } = signature;
  const raw = Buffer.from(publicKeyBase64, "base64");
  if (signature.keyId !== auditKeyIdFor(raw)) return false;
  if (!crypto.verify(null, Buffer.from(auditBundleSignedBytes(body)), ed25519PublicKeyFromRaw(raw), Buffer.from(sig, "base64"))) return false;
  const listed = new Set(signature.index.files.map((file) => file.path));
  for (const [file] of files) if (file !== "signature.json" && !listed.has(file)) return false;
  for (const entry of signature.index.files) {
    const data = files.get(entry.path);
    if (!data || sha256(data) !== entry.sha256 || data.length !== entry.bytes) return false;
  }
  return sha256(files.get("manifest.json")!) === signature.index.manifestDigest;
}

describe("run manifests", () => {
  it("builds a manifest from a real run: model calls, MCP tool call, citations, prompts, totals and guard verdicts", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { executionId, serverId, secretId, workflow } = await runAuditedWorkflow(context, admin.cookie);

    const response = await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie);
    expect(response.statusCode).toBe(200);
    const view = response.json<RunManifestView>();
    const manifest = runManifestSchema.parse(view.manifest);
    expect(view.digest).toBe(sha256(canonicalJson(view.manifest)));
    expect(view.keyId).toMatch(/^[a-f0-9]{16}$/);
    expect(manifest.deployment.keyId).toBe(view.keyId);
    expect(manifest.run).toMatchObject({ executionId, status: "success", triggerType: "manual", subject: "admin@example.com" });

    // Workflow version and its stable hash, captured when the run finished.
    expect(manifest.workflow).toMatchObject({ id: "wf-audit", source: "captured", workflowVersion: 1, nodeCount: 7, edgeCount: 7 });
    expect(manifest.workflow.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.workflow.savedVersion).toBe(1);

    // Node configs keep the secret reference only.
    const modelNode = manifest.nodes.find((node) => node.id === "model")!;
    expect(modelNode.config).toMatchObject({ provider: { providerId: "openai", secretRef: { secretId } } });
    const agentNode = manifest.nodes.find((node) => node.id === "agent")!;
    expect(agentNode.status).toBe("success");
    expect(agentNode.outputDigest).toMatch(/^[a-f0-9]{64}$/);

    // One model call per agent iteration, with parameters, tokens and cost.
    expect(manifest.modelCalls).toHaveLength(2);
    expect(manifest.modelCalls[0]).toMatchObject({ nodeId: "agent", iteration: 1, providerId: "openai", model: "gpt-4o-mini", inputTokens: 100, outputTokens: 10 });
    expect(manifest.modelCalls[0]!.parameters).toMatchObject({ temperature: 0.2 });
    expect(manifest.modelCalls[0]!.parameters).not.toHaveProperty("secretRef");
    expect(manifest.modelCalls[0]!.costUsd).toBeGreaterThan(0);
    expect(manifest.totals).toMatchObject({ inputTokens: 150, outputTokens: 15, totalTokens: 165, modelCalls: 2, toolCalls: 1 });
    expect(manifest.totals.costUsd).toBeGreaterThan(0);

    // The MCP tool call: registry server, identity, schema snapshot hash, digests, outcome.
    expect(manifest.toolCalls).toHaveLength(1);
    expect(manifest.toolCalls[0]).toMatchObject({
      nodeId: "agent",
      iteration: 1,
      toolCallId: "c1",
      toolName: "calculator",
      adapterId: "mock-mcp",
      registryServerId: serverId,
      serverIdentity: "adapter:mock-mcp",
      outcome: "ok",
      argsDigest: sha256(canonicalJson({ expression: "1+1" }))
    });
    expect(manifest.toolCalls[0]!.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.mcpServers).toEqual([expect.objectContaining({ registryServerId: serverId, adapterId: "mock-mcp", name: "Mock tools" })]);

    // Prompts: templates and rendered text.
    expect(manifest.prompts).toEqual(
      expect.arrayContaining([
        { nodeId: "agent", role: "system", template: "You answer support questions.", rendered: expect.stringMatching(/^You answer support questions\./) },
        { nodeId: "agent", role: "user", template: "Answer using: {{documents.0.text}}", rendered: "Answer using: Reset your password using the recovery email link." }
      ])
    );

    // Citations: the retrieved chunk and the cited marker, by digest.
    const cited = manifest.citations.find((citation) => citation.nodeId === "cite");
    expect(cited).toMatchObject({ marker: "[1]", sourceId: "auth-faq", textDigest: sha256("Reset your password using the recovery email link.") });
    expect(manifest.citations.find((citation) => citation.nodeId === "retrieve")).toMatchObject({ marker: null, index: 1, sourceId: "auth-faq" });

    // Guard verdicts (default profile) without evidence.
    expect(manifest.extensions?.guard?.summary.verdicts).toBeGreaterThan(0);
    expect(JSON.stringify(manifest.extensions?.guard)).not.toContain("evidence");

    // The attestation verifies with the listed public key.
    const keys = (await call(context, "GET", "/api/audit/signing-keys", admin.cookie)).json<AuditSigningKeysResponse>();
    const active = keys.keys.find((key) => key.keyId === view.keyId)!;
    expect(
      crypto.verify(
        null,
        Buffer.from(runManifestAttestationBytes({ executionId, manifestDigest: view.digest, keyId: view.keyId, signedAt: view.signedAt })),
        ed25519PublicKeyFromRaw(Buffer.from(active.publicKey, "base64")),
        Buffer.from(view.signature, "base64")
      )
    ).toBe(true);
    expect(workflow.nodes).toHaveLength(7);
  });

  it("is immutable and regenerates byte-identically from the same records", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);
    const first = (await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie)).json<RunManifestView>();
    const second = (await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie)).json<RunManifestView>();
    expect(second.digest).toBe(first.digest);
    expect(second.signedAt).toBe(first.signedAt);
    const record = context.store.getExecutionManifest(executionId)!;

    // A second generator over the same records, at the same moment, writes the same bytes.
    const signing = new AuditSigningService(context.store, context.secretService);
    const pricing = new UsageService(context.store);
    const generator = new AuditBundleService({
      store: context.store,
      signing,
      secrets: context.secretService,
      priceTurn: (providerId, model, input, output, cached) => pricing.estimateCostUsd(providerId, model, input, output, cached),
      catalogEntries: () => [],
      maxBundleBytes: 10_000_000,
      now: () => new Date(first.signedAt)
    });
    const history = context.store.getExecutionHistory(executionId)!;
    const rebuilt = generator.buildManifest(history, record.runContext as Parameters<AuditBundleService["buildManifest"]>[1]);
    const rebuiltAgain = generator.buildManifest(history, record.runContext as Parameters<AuditBundleService["buildManifest"]>[1]);
    expect(canonicalJson(rebuilt)).toBe(canonicalJson(rebuiltAgain));
    expect(canonicalJson(rebuilt)).toBe(record.manifestJson);

    // Two exports carry the same manifest bytes.
    const bundleA = unzip((await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie)).rawPayload);
    const bundleB = unzip((await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie)).rawPayload);
    expect(bundleA.get("manifest.json")!.equals(bundleB.get("manifest.json")!)).toBe(true);
    expect(bundleA.get("manifest.json")!.toString("utf8")).toBe(record.manifestJson);

    // Saving again never overwrites a stored manifest.
    context.store.saveExecutionManifest({ executionId, manifestJson: "{}", manifestDigest: "0".repeat(64), keyId: "x", signature: "y", signedAt: new Date().toISOString() });
    expect(context.store.getExecutionManifest(executionId)!.manifestJson).toBe(record.manifestJson);
    context.store.saveExecutionRunContext(executionId, { version: 1, replaced: true }, new Date().toISOString());
    expect((context.store.getExecutionManifest(executionId)!.runContext as Record<string, unknown>).replaced).toBeUndefined();
  });

  it("records every tool-call outcome, including refused calls, and approval decisions", async () => {
    const context = await createTestContext();
    const signing = new AuditSigningService(context.store, context.secretService);
    const service = new AuditBundleService({ store: context.store, signing, secrets: context.secretService, priceTurn: () => null, catalogEntries: () => [], maxBundleBytes: 10_000_000 });
    const outcomes: Array<[string | undefined, string]> = [
      [undefined, "ok"],
      ["MCP tool 'write_file' on server 'Files' is blocked by policy 'no writes' for role viewer.", "policy_blocked"],
      ["Tool call 'write_file' was blocked by the guard: injection. Do not retry it with the same arguments.", "guard_blocked"],
      ["Rate limited: 10 calls per minute", "rate_limited"],
      ["Concurrency limit: 2 calls in flight", "concurrency_limited"],
      ["Circuit open: the server failed 5 times", "breaker_rejected"],
      ["ECONNRESET", "error"]
    ];
    const now = new Date().toISOString();
    const history = {
      id: "exec-outcomes",
      workflowId: "wf-missing",
      workflowName: null,
      status: "success",
      startedAt: now,
      completedAt: now,
      durationMs: 1,
      triggerType: "manual",
      triggeredBy: "ana@example.com",
      input: null,
      output: null,
      customData: null,
      error: null,
      createdAt: now,
      nodeResults: [
        {
          nodeId: "agent",
          status: "success",
          startedAt: now,
          output: {
            steps: [
              {
                iteration: 1,
                requestedTools: outcomes.map((_, index) => ({ id: `c${index}`, name: "files__write_file", arguments: { path: `/tmp/${index}` } })),
                toolResults: outcomes.map(([error], index) => ({ toolCallId: `c${index}`, toolName: "files__write_file", ...(error ? { error } : { output: { ok: true } }) }))
              }
            ],
            _mcpTools: { files__write_file: { adapterId: "http-mcp", toolName: "write_file" } }
          }
        },
        { nodeId: "gate", status: "success", startedAt: now, input: { decision: "reject", actedBy: "lee@example.com", reason: "Not during the freeze" }, output: { rejected: true } }
      ]
    };
    const manifest = service.buildManifest(history, null);
    expect(manifest.toolCalls.map((entry) => entry.outcome)).toEqual(outcomes.map(([, outcome]) => outcome));
    expect(manifest.toolCalls[1]).toMatchObject({ toolName: "write_file", adapterId: "http-mcp", serverIdentity: "adapter:http-mcp", argsDigest: sha256(canonicalJson({ path: "/tmp/1" })), resultDigest: null });
    expect(manifest.approvals).toEqual([{ nodeId: "gate", decision: "reject", actedBy: "lee@example.com", reason: "Not during the freeze", decidedAt: now }]);
    expect(manifest.workflow.source).toBe("unavailable");
    expect(runManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("refuses runs that are still in progress", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    context.store.upsertWorkflow({ id: "wf-live", name: "Live", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
    for (const status of ["running", "waiting_approval"]) {
      const id = `exec-${status}`;
      context.store.saveExecutionHistory({ id, workflowId: "wf-live", status, startedAt: new Date().toISOString() });
      const manifest = await call(context, "GET", `/api/executions/${id}/manifest`, admin.cookie);
      expect(manifest.statusCode).toBe(409);
      expect(manifest.json<{ code: string }>().code).toBe("in_progress");
      expect((await call(context, "GET", `/api/executions/${id}/bundle`, admin.cookie)).statusCode).toBe(409);
      expect(context.store.getExecutionManifest(id)).toBeNull();
    }
    expect((await call(context, "GET", "/api/executions/nope/manifest", admin.cookie)).statusCode).toBe(404);
  });
});

describe("secrets stay out", () => {
  it("never puts a secret value in the manifest, the bundle, the audit log or the API logs", async () => {
    const writes: string[] = [];
    const capture = (chunk: unknown) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    };
    const originalWrite = fs.write;
    const originalWriteSync = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      capture(data);
      return (originalWriteSync as (...args: unknown[]) => number)(fd, data, ...rest);
    }) as typeof fs.writeSync);
    vi.spyOn(fs, "write").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      capture(data);
      return (originalWrite as (...args: unknown[]) => void)(fd, data, ...rest);
    }) as typeof fs.write);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      capture(chunk);
      return true;
    }) as typeof process.stdout.write);

    const context = await createTestContext({ LOG_LEVEL: "info" });
    const admin = await login(context, "admin");
    // The fake model echoes the bearer token into its answer, so the run's own output carries the secret.
    const { executionId } = await runAuditedWorkflow(context, admin.cookie, { echoAuth: true });
    expect(JSON.stringify(context.store.getExecutionHistory(executionId))).toContain(PLANTED);

    const manifest = await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body).not.toContain(PLANTED);
    expect(context.store.getExecutionManifest(executionId)!.manifestJson).not.toContain(PLANTED);

    const bundle = await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie);
    expect(bundle.statusCode).toBe(200);
    expect(bundle.rawPayload.includes(Buffer.from(PLANTED))).toBe(false);
    const files = unzip(bundle.rawPayload);
    for (const [name, data] of files) expect(data.includes(Buffer.from(PLANTED)), name).toBe(false);
    const agentFile = [...files.entries()].find(([name]) => /^execution\/nodes\/\d{3}-agent\.json$/.test(name));
    expect(agentFile?.[1].toString("utf8")).toContain("[REDACTED]");

    const keys = await call(context, "GET", "/api/audit/signing-keys", admin.cookie);
    expect(keys.body).not.toContain(PLANTED);

    const auditRows = context.store.listAuditLogs({ pageSize: 200 });
    expect(JSON.stringify(auditRows)).not.toContain(PLANTED);

    stdout.mockRestore();
    const logged = writes.join("");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(PLANTED);
    // The generated signing key's seed is never written anywhere either.
    const keyRow = context.store.listAuditSigningKeys()[0]!;
    const seed = context.secretService.resolveInternalSecret(keyRow.secretId!)!;
    expect(seed).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(logged).not.toContain(seed);
    expect(bundle.rawPayload.includes(Buffer.from(seed))).toBe(false);
    expect(manifest.body).not.toContain(seed);
    expect(keys.body).not.toContain(seed);
    expect(logged).toContain(keyRow.keyId);
  });
});

describe("secrets equal to words the manifest schema fixes", () => {
  it("keeps run and node statuses when a secret is the word 'success', and still scrubs it from free text", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie, { finalContent: "success" });
    const history = JSON.stringify(context.store.getExecutionHistory(executionId));
    expect(history).toContain('"answer":"success"');
    const secret = await call(context, "POST", "/api/secrets", admin.cookie, { name: "Status word", provider: "custom", value: "success", projectId: "default" });
    expect(secret.statusCode).toBe(200);

    const response = await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie);
    expect(response.statusCode).toBe(200);
    const manifest = runManifestSchema.parse(response.json<RunManifestView>().manifest);
    expect(manifest.run.status).toBe("success");
    expect(manifest.nodes.find((node) => node.id === "agent")!.status).toBe("success");

    // Bundle files are free text: the word is scrubbed everywhere, statuses included.
    const bundle = await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie);
    expect(bundle.statusCode).toBe(200);
    const files = unzip(bundle.rawPayload);
    const agentFile = [...files.entries()].find(([name]) => /^execution\/nodes\/\d{3}-agent\.json$/.test(name))![1].toString("utf8");
    expect(agentFile).toContain('"answer": "[REDACTED]"');
    expect(agentFile).not.toContain("success");
    expect(files.get("execution/run.json")!.toString("utf8")).not.toContain("success");
    expect(files.get("manifest.json")!.toString("utf8")).toBe(context.store.getExecutionManifest(executionId)!.manifestJson);
  });

  it("generates the manifest when secrets equal enum values, literals or field names it requires", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);
    for (const value of ["captured", "system", "Ed25519", "workflow"]) {
      expect((await call(context, "POST", "/api/secrets", admin.cookie, { name: `Word ${value.length}`, provider: "custom", value })).statusCode).toBe(200);
    }
    const response = await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie);
    expect(response.statusCode).toBe(200);
    const manifest = runManifestSchema.parse(response.json<RunManifestView>().manifest);
    expect(manifest.workflow.source).toBe("captured");
    expect(manifest.deployment.algorithm).toBe("Ed25519");
    expect(manifest.prompts.map((prompt) => prompt.role)).toContain("system");
    const bundle = await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie);
    expect(bundle.statusCode).toBe(200);
  });

  it("still fails closed when a secret lands in a format-constrained field", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);
    const workflowHash = (context.store.getExecutionManifest(executionId)!.runContext as { workflowHash: string }).workflowHash;
    expect(workflowHash).toMatch(/^[a-f0-9]{64}$/);
    const secret = await call(context, "POST", "/api/secrets", admin.cookie, { name: "Digest fragment", provider: "custom", value: workflowHash.slice(8, 24), projectId: "default" });
    expect(secret.statusCode).toBe(200);
    expect(secret.json<{ warnings: string[] }>().warnings).toEqual([]);

    const response = await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(workflowHash.slice(8, 24));
    expect(context.store.getExecutionManifest(executionId)!.manifestJson).toBeFalsy();
  });
});

describe("secret save warnings", () => {
  it("warns, without echoing the value, when a secret matches a word run records keep", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const flagged = await call(context, "POST", "/api/secrets", admin.cookie, { name: "Status word", provider: "custom", value: "success", projectId: "default" });
    expect(flagged.statusCode).toBe(200);
    const body = flagged.json<{ id: string; warnings: string[] }>();
    expect(body.id).toBeTruthy();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/common word used in run records/);
    expect(flagged.body.replace(/"name":"Status word"/, "")).not.toMatch(/success/i);
    // The secret is still saved.
    expect(await context.secretService.resolveSecret({ secretId: body.id })).toBe("success");

    const unique = await call(context, "POST", "/api/secrets", admin.cookie, { name: "Model key", provider: "openai", value: PLANTED, projectId: "default" });
    expect(unique.statusCode).toBe(200);
    expect(unique.json<{ warnings: string[] }>().warnings).toEqual([]);
    expect(unique.body).not.toContain(PLANTED);
  });
});

describe("secret scrubbing in bundles", () => {
  const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");
  const escaped = (value: string) => JSON.stringify(value).slice(1, -1);
  const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

  it("scrubs secrets that need JSON escaping, every secret the deployment holds, text outputs, and leaves out binary outputs that carry one", async () => {
    const ENV_KEY = "sk-env-OPENAI-key-0011223344";
    const context = await createTestContext({ OPENAI_API_KEY: ENV_KEY });
    const admin = await login(context, "admin");
    const tricky = {
      quote: 'pa"ss\\word-12"34',
      pem: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdefXYZ0123456789\n-----END PRIVATE KEY-----\n",
      unicode: "clé-sécrète-日本-🚀-x",
      control: "tab\there-ctl\u0007-99"
    };
    for (const [name, value] of Object.entries(tricky)) {
      expect((await call(context, "POST", "/api/secrets", admin.cookie, { name, provider: "generic", value })).statusCode).toBe(200);
    }
    // Not referenced by any workflow: a secret of another project and an MCP OAuth token set.
    const OTHER_PROJECT = "other-project-secret-value-77";
    context.secretService.createSecret({ name: "elsewhere", provider: "generic", value: OTHER_PROJECT, projectId: "elsewhere" });
    const OAUTH_TOKEN = "oauth-access-TOKEN-1234567890";
    context.secretService.createSecret({ name: "oauth", provider: "mcp_oauth", value: JSON.stringify({ access_token: OAUTH_TOKEN, token_type: "Bearer" }) });
    // Too short to scrub without mangling unrelated text.
    context.secretService.createSecret({ name: "short", provider: "generic", value: "ab12z" });

    const secrets = [...Object.values(tricky), OTHER_PROJECT, OAUTH_TOKEN, ENV_KEY];
    const now = new Date().toISOString();
    context.store.saveExecutionHistory({
      id: "exec-scrub",
      workflowId: "wf-scrub-gone",
      status: "success",
      startedAt: now,
      completedAt: now,
      outputJson: { answer: `env ${ENV_KEY}` },
      nodeResultsJson: [
        {
          nodeId: "render",
          status: "success",
          startedAt: now,
          completedAt: now,
          output: {
            text: `all: ${secrets.join(" | ")} and ab12z`,
            [`key ${tricky.quote}`]: "secret in a key",
            report: { filename: "report.txt", dataUrl: `data:text/plain;base64,${b64(`report ${tricky.pem} ${tricky.unicode}`)}` },
            table: { filename: "table.csv", dataUrl: `data:text/csv;base64,${b64(`a,b\n${OTHER_PROJECT},2\n`)}` },
            chart: { filename: "chart.png", dataUrl: `data:image/png;base64,${b64(Buffer.concat([PNG_HEADER, Buffer.from(ENV_KEY)]))}` },
            wide: { filename: "wide.png", dataUrl: `data:image/png;base64,${b64(Buffer.concat([PNG_HEADER, Buffer.from(OAUTH_TOKEN, "utf16le")]))}` },
            clean: { filename: "clean.png", dataUrl: `data:image/png;base64,${b64(Buffer.concat([PNG_HEADER, Buffer.from("nothing to hide")]))}` }
          },
          activity: [{ at: now, message: `called with ${tricky.quote} and ${tricky.control}` }],
          warnings: [`careful: ${tricky.pem}`]
        },
        { nodeId: "fail", status: "error", startedAt: now, completedAt: now, error: `boom ${tricky.unicode} ${OAUTH_TOKEN}` }
      ]
    });

    const manifest = await call(context, "GET", "/api/executions/exec-scrub/manifest", admin.cookie);
    expect(manifest.statusCode).toBe(200);
    const bundle = await call(context, "GET", "/api/executions/exec-scrub/bundle", admin.cookie);
    expect(bundle.statusCode).toBe(200);
    const files = unzip(bundle.rawPayload);
    for (const [name, data] of files) {
      for (const secret of secrets) {
        expect(data.includes(Buffer.from(secret)), `${name} has a raw secret`).toBe(false);
        expect(data.includes(Buffer.from(escaped(secret))), `${name} has an escaped secret`).toBe(false);
        expect(data.includes(Buffer.from(secret, "utf16le")), `${name} has a UTF-16 secret`).toBe(false);
      }
    }
    expect(manifest.body.includes(OTHER_PROJECT) || manifest.body.includes(ENV_KEY)).toBe(false);

    // Node file: secrets replaced, short values kept, text data URLs scrubbed inside their base64, binary ones replaced.
    const nodeFile = JSON.parse(files.get("execution/nodes/001-render.json")!.toString("utf8")) as { output: Record<string, unknown> };
    expect(String(nodeFile.output.text)).toContain("[REDACTED]");
    expect(String(nodeFile.output.text)).toContain("ab12z");
    expect(Object.keys(nodeFile.output)).toContain("key [REDACTED]");
    const report = nodeFile.output.report as { dataUrl: string };
    const decoded = Buffer.from(report.dataUrl.split(",")[1]!, "base64").toString("utf8");
    expect(decoded).toBe("report [REDACTED] [REDACTED]");
    expect((nodeFile.output.chart as { dataUrl: string }).dataUrl).toBe("[REDACTED]");
    expect((nodeFile.output.clean as { dataUrl: string }).dataUrl.startsWith("data:image/png;base64,")).toBe(true);

    // Outputs: text scrubbed, binary with a secret left out, clean binary kept.
    const names = [...files.keys()];
    const reportFile = names.find((name) => /^outputs\/render\/\d{2}-report\.txt$/.test(name))!;
    expect(files.get(reportFile)!.toString("utf8")).toBe("report [REDACTED] [REDACTED]");
    expect(names.find((name) => name.endsWith("-table.csv"))).toBeTruthy();
    expect(names.some((name) => name.endsWith("-chart.png"))).toBe(false);
    expect(names.some((name) => name.endsWith("-wide.png"))).toBe(false);
    expect(names.some((name) => name.endsWith("-clean.png"))).toBe(true);
    const redactions = JSON.parse(files.get("redactions.json")!.toString("utf8")) as {
      format: string;
      omitted: Array<{ path: string; reason: string }>;
      scrubbed: Array<{ path: string }>;
    };
    expect(redactions.format).toBe("l2m.audit-bundle-redactions");
    expect(redactions.omitted.map((entry) => entry.path).sort()).toEqual([
      expect.stringMatching(/^outputs\/render\/\d{2}-chart\.png$/),
      expect.stringMatching(/^outputs\/render\/\d{2}-wide\.png$/)
    ]);
    expect(redactions.omitted[0]!.reason).toContain("image/png");
    expect(redactions.scrubbed.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["execution/nodes/001-render.json", "execution/nodes/002-fail.json", "execution/run.json", "execution/logs.jsonl", reportFile])
    );
    const logs = files.get("execution/logs.jsonl")!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logs.some((line) => line.source === "node_activity" && line.message === "called with [REDACTED] and [REDACTED]")).toBe(true);

    // The signed index covers redactions.json, and the bundle still verifies.
    const keys = (await call(context, "GET", "/api/audit/signing-keys", admin.cookie)).json<AuditSigningKeysResponse>();
    expect(verifyBundle(bundle.rawPayload, keys.keys[0]!.publicKey)).toBe(true);
    const signature = auditBundleSignatureSchema.parse(JSON.parse(files.get("signature.json")!.toString("utf8")));
    expect(signature.index.files.some((entry) => entry.path === "redactions.json")).toBe(true);
  });
});

describe("SecretService.valuesForScrubbing", () => {
  it("covers local, internal and cached external secrets, and credential fields of JSON values, without fetching anything", async () => {
    const context = await createTestContext();
    const service = context.secretService;
    service.createSecret({ name: "local", provider: "generic", value: "local-value-123456", projectId: "any-project" });
    service.createSecret({
      name: "bundle",
      provider: "mcp_oauth",
      value: JSON.stringify({ headers: { Authorization: "Bearer bundle-bearer-token-42" }, token_type: "Bearer", scope: "read" })
    });
    const external = service.createExternalSecret({ name: "vault", provider: "generic", externalProviderId: "missing-provider", externalKey: "path/to/key" });
    const encrypt = (service as unknown as { encrypt: (value: string) => { iv: string; authTag: string; ciphertext: string } }).encrypt.bind(service);
    context.store.upsertExternalSecretCacheEntry({ secretId: external.secretId, ...encrypt("external-cached-value-99"), expiresAt: new Date(Date.now() - 1000).toISOString() });
    const values = service.valuesForScrubbing();
    expect(values).toEqual(expect.arrayContaining(["local-value-123456", "Bearer bundle-bearer-token-42", "bundle-bearer-token-42", "external-cached-value-99"]));
    expect(values).not.toContain("__external__");
    expect(values).not.toContain("read");
    expect(values).not.toContain("Bearer");
  });
});

describe("audit bundle export", () => {
  it("exports a signed zip that verifies offline and is audit-logged", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);
    const response = await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toContain(`l2m-audit-${executionId}.zip`);
    expect(Number(response.headers["content-length"])).toBe(response.rawPayload.length);
    const files = unzip(response.rawPayload);
    const names = [...files.keys()];
    expect(names.slice(0, 3)).toEqual(["manifest.json", "signature.json", "README.txt"]);
    expect(names).toEqual(expect.arrayContaining(["workflow.json", "execution/run.json", "execution/trace.json", "execution/logs.jsonl"]));
    expect(names.some((name) => /^execution\/nodes\/\d{3}-agent\.json$/.test(name))).toBe(true);
    expect(files.get("README.txt")!.toString("utf8")).toContain("l2m audit verify");

    // workflow.json hashes to the manifest's workflow hash.
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as { workflow: { hash: string }; nodes: Array<{ id: string; outputDigest: string | null }> };
    expect(sha256(canonicalJson(JSON.parse(files.get("workflow.json")!.toString("utf8"))))).toBe(manifest.workflow.hash);
    // Node files match the manifest's digests.
    const agentFile = JSON.parse(files.get(names.find((name) => name.endsWith("-agent.json"))!)!.toString("utf8")) as { output: unknown };
    expect(sha256(canonicalJson(agentFile.output))).toBe(manifest.nodes.find((node) => node.id === "agent")!.outputDigest);

    const keys = (await call(context, "GET", "/api/audit/signing-keys", admin.cookie)).json<AuditSigningKeysResponse>();
    expect(verifyBundle(response.rawPayload, keys.keys[0]!.publicKey)).toBe(true);

    const audit = context.store.listAuditLogs({ eventType: "execution.audit_bundle.export" });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ outcome: "success", actorEmail: "admin@example.com", resourceType: "execution", resourceId: executionId });
    expect(audit.items[0]!.metadata).toMatchObject({ manifestDigest: response.headers["x-l2m-manifest-digest"], keyId: keys.activeKeyId });
  });

  it("follows execution read access: viewers of the workflow can export, others cannot", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const viewer = await login(context, "viewer");
    const builder = await login(context, "builder");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);

    expect((await call(context, "GET", `/api/executions/${executionId}/manifest`)).statusCode).toBe(401);
    expect((await call(context, "GET", `/api/executions/${executionId}/bundle`)).statusCode).toBe(401);
    expect((await call(context, "GET", `/api/executions/${executionId}/manifest`, viewer.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", `/api/executions/${executionId}/bundle`, viewer.cookie)).statusCode).toBe(200);

    // A builder locked out of the workflow's project is told the run does not exist.
    context.store.upsertProject({ id: "hidden", name: "Hidden" });
    context.store.upsertCustomRole({ id: "none-hidden", projectId: "hidden", name: "No access", permissions: [] });
    context.store.upsertProjectRole({ userId: builder.id, projectId: "hidden", role: "custom", customRoleId: "none-hidden" });
    const workflow = context.store.getWorkflow("wf-audit")!;
    context.store.upsertWorkflow({ ...workflow, projectId: "hidden" });
    expect((await call(context, "GET", `/api/executions/${executionId}/manifest`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", `/api/executions/${executionId}/bundle`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie)).statusCode).toBe(200);

    // Runs of a deleted workflow are admin-only.
    context.store.upsertWorkflow({ ...workflow, projectId: "default" });
    context.store.saveExecutionHistory({ id: "exec-orphan", workflowId: "wf-gone", status: "success", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    expect((await call(context, "GET", "/api/executions/exec-orphan/manifest", viewer.cookie)).statusCode).toBe(404);
    const orphan = await call(context, "GET", "/api/executions/exec-orphan/manifest", admin.cookie);
    expect(orphan.statusCode).toBe(200);
    expect(orphan.json<RunManifestView>().manifest.workflow.source).toBe("unavailable");

    // Signing keys are admin-only.
    expect((await call(context, "GET", "/api/audit/signing-keys", viewer.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/audit/signing-keys", builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/audit/signing-keys/rotate", builder.cookie)).statusCode).toBe(403);
  });

  it("caps the bundle size with a clear error", async () => {
    const context = await createTestContext({ AUDIT_BUNDLE_MAX_BYTES: "1024" });
    const admin = await login(context, "admin");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);
    const response = await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie);
    expect(response.statusCode).toBe(413);
    const body = response.json<{ error: string; code: string }>();
    expect(body.code).toBe("too_large");
    expect(body.error).toMatch(/over the 1024-byte limit \(AUDIT_BUNDLE_MAX_BYTES\)/);
    const audit = context.store.listAuditLogs({ eventType: "execution.audit_bundle.export" });
    expect(audit.items[0]).toMatchObject({ outcome: "failure" });
    // The manifest alone is still available.
    expect((await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie)).statusCode).toBe(200);
  });

  it("prunes a cached manifest only when it is past the audit-log retention and its execution history is gone", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);
    const first = (await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie)).json<RunManifestView>();
    expect(context.store.getExecutionManifest(executionId)?.manifestJson).toBeTruthy();
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();

    // Past the retention, but the history is kept: the manifest stays and is served unchanged, never regenerated.
    context.store.pruneAuditLogs({ before: future });
    expect(context.store.getExecutionManifest(executionId)?.manifestJson).toBeTruthy();
    const again = (await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie)).json<RunManifestView>();
    expect(again).toEqual(first);

    // History gone, manifest still inside the retention: kept.
    context.store.pruneExecutionHistory({ before: future });
    expect(context.store.getExecutionHistory(executionId)).toBeNull();
    context.store.pruneAuditLogs({ before: past });
    expect(context.store.getExecutionManifest(executionId)?.manifestJson).toBeTruthy();

    // Both: pruned.
    context.store.pruneAuditLogs({ before: future });
    expect(context.store.getExecutionManifest(executionId)).toBeNull();
    expect((await call(context, "GET", `/api/executions/${executionId}/manifest`, admin.cookie)).statusCode).toBe(404);
  });

  it("puts only this execution's audit rows in logs.jsonl, with actor emails for admins only", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const viewer = await login(context, "viewer");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);
    // A row that merely mentions the id deeper in its metadata is not about this execution.
    context.store.writeAuditLog({
      id: "unrelated-row",
      eventType: "other.event",
      category: "system",
      action: "other",
      outcome: "success",
      actorEmail: "someone@example.com",
      metadata: { parent: { executionId } }
    });
    expect((await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie)).statusCode).toBe(200);
    const auditLines = (bytes: Buffer) =>
      unzip(bytes)
        .get("execution/logs.jsonl")!
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.source === "audit_log");

    const forViewer = auditLines((await call(context, "GET", `/api/executions/${executionId}/bundle`, viewer.cookie)).rawPayload);
    expect(forViewer.length).toBeGreaterThan(0);
    expect(forViewer.some((line) => line.eventType === "other.event")).toBe(false);
    for (const line of forViewer) expect(line).not.toHaveProperty("actorEmail");
    expect(forViewer.find((line) => line.eventType === "execution.audit_bundle.export")).toMatchObject({ actorUserId: admin.id, actorRole: "admin" });

    const forAdmin = auditLines((await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie)).rawPayload);
    expect(forAdmin.some((line) => line.eventType === "other.event")).toBe(false);
    expect(forAdmin.find((line) => line.actorUserId === viewer.id)).toMatchObject({ actorEmail: "viewer@example.com", actorRole: "viewer" });
  });
});

describe("internal secret providers", () => {
  it("cannot be created through the API, and their share routes answer like a missing secret", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const created = await call(context, "POST", "/api/secrets", admin.cookie, { name: "sneaky", provider: "audit_signing", value: "x".repeat(32) });
    expect(created.statusCode).toBe(400);
    expect(created.body).not.toContain("internal");
    expect((await call(context, "POST", "/api/secrets", admin.cookie, { name: "oauth", provider: "mcp_oauth", value: "token-value" })).statusCode).toBe(400);

    await call(context, "GET", "/api/audit/signing-keys", admin.cookie);
    const internalId = context.store.listAuditSigningKeys()[0]!.secretId!;
    for (const id of [internalId, "sec_does_not_exist"]) {
      const list = await call(context, "GET", `/api/secrets/${id}/shares`, admin.cookie);
      const share = await call(context, "POST", `/api/secrets/${id}/shares`, admin.cookie, { projectId: "default" });
      const unshare = await call(context, "DELETE", `/api/secrets/${id}/shares/default`, admin.cookie);
      expect([list.statusCode, share.statusCode, unshare.statusCode]).toEqual([404, 404, 404]);
      expect(list.json()).toEqual({ error: "Secret not found" });
      expect(share.json()).toEqual({ error: "Secret not found" });
    }
    // Ordinary secrets still share.
    const ordinary = (await call(context, "POST", "/api/secrets", admin.cookie, { name: "ok", provider: "generic", value: "ordinary-value" })).json<{ id: string }>();
    expect((await call(context, "GET", `/api/secrets/${ordinary.id}/shares`, admin.cookie)).statusCode).toBe(200);
  });
});

describe("signing keys", () => {
  it("generates a key on first use, stores it through SecretService and keeps it out of the secrets API", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    expect(context.store.listAuditSigningKeys()).toEqual([]);
    const response = await call(context, "GET", "/api/audit/signing-keys", admin.cookie);
    expect(response.statusCode).toBe(200);
    const body = response.json<AuditSigningKeysResponse>();
    expect(body.canRotate).toBe(true);
    expect(body.keys).toHaveLength(1);
    const key = body.keys[0]!;
    expect(key).toMatchObject({ keyId: body.activeKeyId, algorithm: "Ed25519", source: "generated", status: "active" });
    expect(Object.keys(key).sort()).toEqual(["algorithm", "createdAt", "keyId", "publicKey", "publicKeyPem", "retiredAt", "source", "status"]);
    expect(key.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(key.keyId).toBe(auditKeyIdFor(Buffer.from(key.publicKey, "base64")));

    const record = context.store.listAuditSigningKeys()[0]!;
    expect(record.secretId).toMatch(/^sec_/);
    const row = context.store.getSecret(record.secretId!)!;
    expect(row.provider).toBe("audit_signing");
    // Stored encrypted: the ciphertext is not the seed.
    const seed = context.secretService.resolveInternalSecret(record.secretId!)!;
    expect(row.ciphertext).not.toContain(seed);
    // Hidden from the secrets list, refused to node configs, not deletable through the generic route.
    const secrets = await call(context, "GET", "/api/secrets", admin.cookie);
    expect(secrets.json<Array<{ id: string }>>().map((entry) => entry.id)).not.toContain(record.secretId);
    expect(await context.secretService.resolveSecret({ secretId: record.secretId! })).toBeUndefined();
    expect((await call(context, "DELETE", `/api/secrets/${record.secretId}`, admin.cookie)).statusCode).toBe(404);
    expect(context.store.getSecret(record.secretId!)).toBeTruthy();
  });

  it("rotates: new exports use the new key, old bundles still verify with the retired public key", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { executionId } = await runAuditedWorkflow(context, admin.cookie);
    const before = (await call(context, "GET", "/api/audit/signing-keys", admin.cookie)).json<AuditSigningKeysResponse>();
    const oldKey = before.keys[0]!;
    const oldSecretId = context.store.listAuditSigningKeys()[0]!.secretId!;
    const oldBundle = (await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie)).rawPayload;

    const rotated = await call(context, "POST", "/api/audit/signing-keys/rotate", admin.cookie);
    expect(rotated.statusCode).toBe(201);
    const after = rotated.json<{ key: { keyId: string; publicKey: string }; keys: AuditSigningKeysResponse }>();
    expect(after.key.keyId).not.toBe(oldKey.keyId);
    expect(after.keys.activeKeyId).toBe(after.key.keyId);
    expect(after.keys.keys.find((key) => key.keyId === oldKey.keyId)).toMatchObject({ status: "retired", publicKey: oldKey.publicKey });
    expect(after.keys.keys.find((key) => key.keyId === oldKey.keyId)!.retiredAt).toBeTruthy();
    // The retired key's private half is gone.
    expect(context.store.getSecret(oldSecretId)).toBeNull();

    const newBundle = (await call(context, "GET", `/api/executions/${executionId}/bundle`, admin.cookie)).rawPayload;
    expect(verifyBundle(oldBundle, oldKey.publicKey)).toBe(true);
    expect(verifyBundle(newBundle, after.key.publicKey)).toBe(true);
    expect(verifyBundle(oldBundle, after.key.publicKey)).toBe(false);
    expect(verifyBundle(newBundle, oldKey.publicKey)).toBe(false);
    // The manifest itself is unchanged and still names the key that was active when it was generated.
    expect(unzip(oldBundle).get("manifest.json")!.equals(unzip(newBundle).get("manifest.json")!)).toBe(true);

    const audit = context.store.listAuditLogs({ eventType: "audit.signing_key.rotated" });
    expect(audit.items[0]!.metadata).toMatchObject({ keyId: after.key.keyId, previousKeyId: oldKey.keyId });
  });

  it("uses AUDIT_SIGNING_KEY_BASE64 when set, without storing a secret, and refuses API rotation", async () => {
    const seed = crypto.randomBytes(32);
    const context = await createTestContext({ AUDIT_SIGNING_KEY_BASE64: seed.toString("base64") });
    const admin = await login(context, "admin");
    const body = (await call(context, "GET", "/api/audit/signing-keys", admin.cookie)).json<AuditSigningKeysResponse>();
    const expected = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" }));
    const raw = expected.export({ format: "der", type: "spki" }).subarray(-32);
    expect(body.activeKeyId).toBe(auditKeyIdFor(raw));
    expect(body.canRotate).toBe(false);
    expect(body.keys[0]).toMatchObject({ source: "env", publicKey: Buffer.from(raw).toString("base64") });
    expect(context.store.listAuditSigningKeys()[0]!.secretId).toBeNull();
    const rotate = await call(context, "POST", "/api/audit/signing-keys/rotate", admin.cookie);
    expect(rotate.statusCode).toBe(409);
    expect(rotate.json<{ error: string }>().error).toContain("AUDIT_SIGNING_KEY_BASE64");
  });

  it("rejects a malformed AUDIT_SIGNING_KEY_BASE64", () => {
    expect(() => parseConfig({ SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"), AUDIT_SIGNING_KEY_BASE64: "c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(parseConfig({ SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"), AUDIT_SIGNING_KEY_BASE64: "" }).AUDIT_SIGNING_KEY_BASE64).toBeUndefined();
  });
});

describe("migration 29", () => {
  it("adds execution_manifests and audit_signing_keys in Postgres DDL with a down path", () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    // Unique; version numbers are reserved per feature branch, so one may be missing until that branch lands.
    expect(new Set(versions).size).toBe(versions.length);
    expect(Math.max(...versions)).toBeGreaterThanOrEqual(29);
    const migration = MIGRATIONS.find((entry) => entry.version === 29)!;
    expect(migration.description).toContain("11.1");
    for (const table of ["execution_manifests", "audit_signing_keys"]) {
      expect(migration.up).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migration.down).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const fragment of [
      "execution_id TEXT PRIMARY KEY",
      "run_context_json TEXT",
      "manifest_digest TEXT",
      "signed_at TIMESTAMPTZ",
      "created_at TIMESTAMPTZ NOT NULL",
      "key_id TEXT PRIMARY KEY",
      "public_key TEXT NOT NULL",
      "secret_id TEXT",
      "retired_at TIMESTAMPTZ",
      "WHERE status = 'active'"
    ]) {
      expect(migration.up).toContain(fragment);
    }
  });

  it("creates the same tables in SQLite, with one active key at most", async () => {
    const context = await createTestContext();
    const db = new Database(context.dbPath, { readonly: true });
    try {
      const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns("execution_manifests")).toEqual(["execution_id", "run_context_json", "manifest_json", "manifest_digest", "key_id", "signature", "signed_at", "created_at"]);
      expect(columns("audit_signing_keys")).toEqual(["key_id", "algorithm", "public_key", "source", "secret_id", "status", "created_at", "retired_at"]);
    } finally {
      db.close();
    }
    const now = new Date().toISOString();
    expect(context.store.activateAuditSigningKey({ keyId: "a".repeat(16), algorithm: "Ed25519", publicKey: "x", source: "generated", secretId: null, createdAt: now }, null)).toBe(true);
    // A writer that expected no active key loses the race instead of creating a second active key.
    expect(context.store.activateAuditSigningKey({ keyId: "b".repeat(16), algorithm: "Ed25519", publicKey: "y", source: "generated", secretId: null, createdAt: now }, null)).toBe(false);
    expect(context.store.listAuditSigningKeys().filter((key) => key.status === "active")).toHaveLength(1);
  });
});
