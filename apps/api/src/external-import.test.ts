/**
 * External workflow import — route tests for POST /api/workflows/import/external.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { workflowSchema, type Workflow } from "@ai-orchestrator/shared";
import { validateWorkflowGraph, type ImportReport } from "@ai-orchestrator/workflow-engine";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "samples", "external-imports");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-external-import-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    await context.app.close();
    try {
      context.store.close();
    } catch {
      // The store may already be closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

function extractCookie(setCookieHeader: string | string[] | undefined, cookieName: string): string {
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const cookie = values.find((value) => value.startsWith(`${cookieName}=`));
  if (!cookie) throw new Error(`Cookie '${cookieName}' was not set`);
  return cookie.split(";")[0];
}

async function login(context: TestContext, role: "admin" | "builder" | "operator" | "viewer"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${role}: ${response.body}`);
  return extractCookie(response.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
}

interface ImportResponse {
  workflow: Workflow;
  report: ImportReport;
  dryRun?: boolean;
}

describe("POST /api/workflows/import/external", () => {
  it("returns the converted workflow and report on a dry run without creating a row", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");

    const response = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: loadFixture("if-two-branches"), dryRun: true }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ImportResponse>();
    expect(body.dryRun).toBe(true);
    expect(body.workflow.id).toBe("wf-import-order_approval");
    expect(body.workflow.nodes.map((node) => node.type)).toContain("if_node");
    expect(body.report.summary).toEqual({ total: 6, mapped: 6, approximated: 0, unsupported: 0 });
    expect(body.report.nodes).toHaveLength(6);
    expect(validateWorkflowGraph(body.workflow).valid).toBe(true);

    expect(context.store.getWorkflow("wf-import-order_approval")).toBeNull();
    const audit = context.store.listAuditLogs({ eventType: "workflow.import_external" });
    expect(audit.items).toHaveLength(0);
  });

  it("accepts the export as sourceText", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");

    const response = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { sourceText: JSON.stringify(loadFixture("switch-three-outputs")), dryRun: true }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ImportResponse>();
    expect(body.workflow.nodes.find((node) => node.type === "switch_node")).toBeDefined();
    expect(body.report.sourceName).toBe("Event router");
  });

  it("creates the workflow in the given project and folder, versions it and records an audit event", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");

    const projectResponse = await context.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { id: "client-work", name: "Client Work" }
    });
    expect(projectResponse.statusCode).toBe(200);
    const folderResponse = await context.app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { id: "imports", name: "Imports", projectId: "client-work" }
    });
    expect(folderResponse.statusCode).toBe(200);

    const response = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: loadFixture("ai-agent-tools"), projectId: "client-work", folderId: "imports", name: "Support agent (imported)" }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ImportResponse>();
    expect(body.dryRun).toBeUndefined();
    expect(body.workflow.id).toBe("wf-import-support_agent");
    expect(body.workflow.name).toBe("Support agent (imported)");
    expect(body.workflow.projectId).toBe("client-work");
    expect(body.workflow.folderId).toBe("imports");
    expect(body.report.summary.total).toBe(8);

    const stored = context.store.getWorkflow("wf-import-support_agent");
    expect(stored).not.toBeNull();
    expect(stored?.projectId).toBe("client-work");
    expect(stored?.folderId).toBe("imports");
    const parsed = workflowSchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    expect(validateWorkflowGraph(stored).valid).toBe(true);
    expect(stored?.edges.filter((edge) => edge.sourceHandle === "tool")).toHaveLength(2);

    const audit = context.store.listAuditLogs({ eventType: "workflow.import_external" });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ eventType: "workflow.import_external", resourceId: "wf-import-support_agent" });
  });

  it("gives a second import of the same export a unique id", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");

    for (const expectedId of ["wf-import-nightly_digest", "wf-import-nightly_digest-2"]) {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/workflows/import/external",
        headers: { cookie },
        payload: { source: loadFixture("schedule-code-execute") }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<ImportResponse>().workflow.id).toBe(expectedId);
      expect(context.store.getWorkflow(expectedId)).not.toBeNull();
    }
  });

  it("rejects a viewer with 403", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "viewer");

    const response = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: loadFixture("webhook-http-set"), dryRun: true }
    });

    expect(response.statusCode).toBe(403);
    expect(context.store.getWorkflow("wf-import-lead_enrichment_webhook")).toBeNull();
  });

  it("requires authentication", async () => {
    const context = await createTestContext();
    const response = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      payload: { source: loadFixture("webhook-http-set") }
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 400 with a useful message for malformed input", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");

    const missingNodes = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: { name: "Not an export" } }
    });
    expect(missingNodes.statusCode).toBe(400);
    expect(missingNodes.json<{ error: string }>().error).toContain("'nodes' array");

    const untypedNode = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: { nodes: [{ name: "Mystery" }], connections: {} } }
    });
    expect(untypedNode.statusCode).toBe(400);
    expect(untypedNode.json<{ error: string }>().error).toContain("no 'type'");

    const badJson = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { sourceText: "{ not json" }
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json<{ error: string }>().error).toContain("sourceText is not valid JSON");

    const nothing = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { dryRun: true }
    });
    expect(nothing.statusCode).toBe(400);
    expect(nothing.json<{ error: string }>().error).toContain("'source'");

    const badPayload = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: loadFixture("if-two-branches"), dryRun: "yes" }
    });
    expect(badPayload.statusCode).toBe(400);
    expect(badPayload.json<{ error: string }>().error).toBe("Invalid external import payload");
  });

  it("rejects unknown projects and folders, and folders outside the target project", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    context.store.upsertProject({ id: "other", name: "Other", createdBy: "builder@example.com" });
    context.store.upsertFolder({ id: "other-folder", name: "Other folder", projectId: "other" });

    const unknownProject = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: loadFixture("if-two-branches"), projectId: "missing" }
    });
    expect(unknownProject.statusCode).toBe(400);
    expect(unknownProject.json<{ error: string }>().error).toBe("Target project does not exist");

    const unknownFolder = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: loadFixture("if-two-branches"), folderId: "missing" }
    });
    expect(unknownFolder.statusCode).toBe(400);
    expect(unknownFolder.json<{ error: string }>().error).toBe("Target folder does not exist");

    const mismatch = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: loadFixture("if-two-branches"), projectId: "default", folderId: "other-folder" }
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json<{ error: string }>().error).toContain("belongs to project 'other'");

    const derived = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source: loadFixture("if-two-branches"), folderId: "other-folder", dryRun: true }
    });
    expect(derived.statusCode).toBe(200);
    expect(derived.json<ImportResponse>().workflow.projectId).toBe("other");
  });

  it("never echoes credential values and lists secrets to resolve by name only", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");

    const source = loadFixture("ai-agent-tools");
    const nodes = source.nodes as Array<Record<string, unknown>>;
    const model = nodes.find((node) => node.name === "OpenAI Chat Model");
    if (!model) throw new Error("fixture node not found");
    model.credentials = {
      openAiApi: { id: "cred_7", name: "OpenAI account", apiKey: "sk-live-must-never-leak", data: "encrypted:must-never-leak" }
    };

    const response = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import/external",
      headers: { cookie },
      payload: { source }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("must-never-leak");
    const body = response.json<ImportResponse>();
    expect(body.report.secretsToResolve).toEqual([
      { secretId: "import-openaiapi-openai_account", credentialType: "openAiApi", credentialName: "OpenAI account", nodeIds: ["openai_chat_model"] },
      { secretId: "import-httpbearerauth-orders_mcp_token", credentialType: "httpBearerAuth", credentialName: "Orders MCP token", nodeIds: ["orders_mcp"] }
    ]);

    const stored = context.store.getWorkflow(body.workflow.id);
    expect(JSON.stringify(stored)).not.toContain("must-never-leak");
    const audit = context.store.listAuditLogs({ eventType: "workflow.import_external" });
    expect(JSON.stringify(audit.items)).not.toContain("must-never-leak");
    expect(context.store.listSecrets()).toHaveLength(0);
  });
});
