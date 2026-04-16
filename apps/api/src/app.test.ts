import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WORKFLOW_SCHEMA_VERSION, type Workflow } from "@ai-orchestrator/shared";
import type { AppConfig } from "./config";
import { createApp } from "./app";
import { SqliteStore } from "./db/database";
import { AuthService } from "./services/auth-service";
import { SecretService } from "./services/secret-service";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const testContexts: TestContext[] = [];

function createValidWorkflow(id: string): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowVersion: 1,
    nodes: [
      {
        id: "node-output",
        type: "output",
        name: "Output",
        position: { x: 240, y: 120 },
        config: {
          outputKey: "result"
        }
      }
    ],
    edges: []
  };
}

function createLinearWorkflow(id: string): Workflow {
  return {
    id,
    name: `Linear ${id}`,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowVersion: 1,
    nodes: [
      {
        id: "text-node",
        type: "text_input",
        name: "Text Input",
        position: { x: 40, y: 120 },
        config: {
          text: "default text"
        }
      },
      {
        id: "output-node",
        type: "output",
        name: "Output",
        position: { x: 280, y: 120 },
        config: {
          outputKey: "result",
          responseTemplate: "{{text}}"
        }
      }
    ],
    edges: [
      {
        id: "edge-text-output",
        source: "text-node",
        target: "output-node"
      }
    ]
  };
}

function createWebhookWorkflow(
  id: string,
  webhookConfig: Record<string, unknown>
): Workflow {
  return {
    id,
    name: `Webhook ${id}`,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowVersion: 1,
    nodes: [
      {
        id: "webhook-node",
        type: "webhook_input",
        name: "Webhook",
        position: { x: 40, y: 80 },
        config: {
          path: `secure-${id}`,
          method: "POST",
          passThroughFields: ["user_prompt", "system_prompt", "session_id", "variables"],
          ...webhookConfig
        }
      },
      {
        id: "output-node",
        type: "output",
        name: "Output",
        position: { x: 260, y: 80 },
        config: {
          outputKey: "result",
          responseTemplate: "{{user_prompt}}"
        }
      }
    ],
    edges: [
      {
        id: "edge-webhook-output",
        source: "webhook-node",
        target: "output-node"
      }
    ]
  };
}

function extractCookie(setCookieHeader: string | string[] | undefined, cookieName: string): string {
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const cookie = values.find((value) => value.startsWith(`${cookieName}=`));
  if (!cookie) {
    throw new Error(`Cookie '${cookieName}' was not set`);
  }

  const firstPart = cookie.split(";")[0];
  if (!firstPart) {
    throw new Error(`Cookie '${cookieName}' is malformed`);
  }
  return firstPart;
}

async function createRoleSession(
  context: TestContext,
  input: { email: string; password: string; role: "admin" | "builder" | "operator" | "viewer" }
): Promise<string> {
  context.authService.register(input);
  const login = await context.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: input.email,
      password: input.password
    }
  });
  if (login.statusCode !== 200) {
    throw new Error(`Unable to login test role '${input.role}': ${login.body}`);
  }
  return extractCookie(login.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-orchestrator-auth-test-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  const masterKey = crypto.randomBytes(32).toString("base64");

  const config: AppConfig = {
    API_PORT: 0,
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://localhost:5173",
    WORKFLOW_EXECUTION_TIMEOUT_MS: 300000,
    EXECUTION_HISTORY_RETENTION_DAYS: 30,
    EXECUTION_HISTORY_PRUNE_INTERVAL_MS: 3600000,
    SEED_SAMPLE_WORKFLOWS: false,
    SECRET_MASTER_KEY_BASE64: masterKey,
    SESSION_COOKIE_NAME: "ao_session",
    SESSION_TTL_HOURS: 24,
    COOKIE_SECURE: false,
    AUTH_ALLOW_PUBLIC_REGISTER: false,
    BOOTSTRAP_ADMIN_EMAIL: undefined,
    BOOTSTRAP_ADMIN_PASSWORD: undefined,
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    OLLAMA_BASE_URL: undefined,
    API_KEY_DEFAULT_EXPIRY_DAYS: 0,
    MFA_ENABLED: false,
    MFA_ENFORCE: false,
    MFA_ISSUER: "ai-orchestrator-test",
    SAML_ENABLED: false,
    SAML_ENTRY_POINT: undefined,
    SAML_ISSUER: undefined,
    SAML_CALLBACK_URL: undefined,
    SAML_IDP_CERT: undefined,
    SAML_GROUPS_ATTRIBUTE: "groups",
    LDAP_ENABLED: false,
    LDAP_URL: undefined,
    LDAP_BIND_DN: undefined,
    LDAP_BIND_PASSWORD: undefined,
    LDAP_BASE_DN: undefined,
    LDAP_USER_FILTER: "(mail={{email}})",
    LDAP_GROUPS_ATTRIBUTE: "memberOf",
    EXTERNAL_SECRETS_CACHE_TTL_MS: 300000,
    AUDIT_LOG_ENABLED: true,
    AUDIT_LOG_RETENTION_DAYS: 365,
    AUDIT_LOG_PRUNE_INTERVAL_MS: 3600000,
    LOG_STREAM_ENABLED: true,
    LOG_STREAM_FLUSH_INTERVAL_MS: 2000,
    LOG_STREAM_BUFFER_SIZE: 1000,
    LOG_STREAM_RETRY_MAX_ATTEMPTS: 3,
    LOG_STREAM_EVENT_RETENTION_DAYS: 14,
    LOG_STREAM_EVENT_PRUNE_INTERVAL_MS: 3600000,
    GIT_SYNC_ENABLED: true,
    GIT_SYNC_WORKDIR: "apps/api/data/git",
    GIT_BIN: "git",
    GIT_COMMAND_TIMEOUT_MS: 60000,
    WORKFLOW_VERSION_RETENTION: 100,
    METRICS_ENABLED: true,
    METRICS_PREFIX: "ao",
    METRICS_INCLUDE_PROCESS: true,
    METRICS_SLO_SUCCESS_TARGET: 0.99,
    METRICS_SLO_P95_LATENCY_MS: 30000,
    TRACING_ENABLED: false,
    TRACING_ENDPOINT: undefined,
    TRACING_SERVICE_NAME: "ai-orchestrator",
    ...overrides
  };

  store.ensureDefaultProject();
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();

  const context: TestContext = {
    app,
    store,
    authService,
    secretService,
    config,
    tempDir
  };
  testContexts.push(context);
  return context;
}

afterEach(async () => {
  while (testContexts.length > 0) {
    const context = testContexts.pop();
    if (!context) {
      continue;
    }
    await context.app.close();
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

describe("helper chat page", () => {
  it("serves the helper chat html page", async () => {
    const context = await createTestContext();
    const response = await context.app.inject({
      method: "GET",
      url: "/helper-chat"
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers["content-type"] ?? "")).toContain("text/html");
    expect(response.body).toContain("Workflow Chat Helper");
  });
});

describe("auth + rbac API", () => {
  it("supports register/login/me/logout happy path", async () => {
    const context = await createTestContext();

    const registerResponse = await context.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "admin@example.com",
        password: "TestPass123!"
      }
    });
    expect(registerResponse.statusCode).toBe(200);
    const registerBody = registerResponse.json<{ user: { role: string; email: string } }>();
    expect(registerBody.user.email).toBe("admin@example.com");
    expect(registerBody.user.role).toBe("admin");

    const loginResponse = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "admin@example.com",
        password: "TestPass123!"
      }
    });
    expect(loginResponse.statusCode).toBe(200);
    const sessionCookie = extractCookie(loginResponse.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);

    const meResponse = await context.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: sessionCookie
      }
    });
    expect(meResponse.statusCode).toBe(200);
    const meBody = meResponse.json<{ user: { email: string; role: string } }>();
    expect(meBody.user.email).toBe("admin@example.com");
    expect(meBody.user.role).toBe("admin");

    const logoutResponse = await context.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: sessionCookie
      }
    });
    expect(logoutResponse.statusCode).toBe(200);

    const meAfterLogout = await context.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: sessionCookie
      }
    });
    expect(meAfterLogout.statusCode).toBe(401);
    expect(meAfterLogout.json<{ error: string }>().error).toBe("Session expired or invalid");
  });

  it("returns 401/403 on protected routes when unauthorized", async () => {
    const context = await createTestContext();

    const noSession = await context.app.inject({
      method: "GET",
      url: "/api/workflows"
    });
    expect(noSession.statusCode).toBe(401);
    expect(noSession.json<{ error: string }>().error).toBe("Authentication required");

    context.authService.register({
      email: "viewer@example.com",
      password: "ViewerPass123!",
      role: "viewer"
    });

    const loginViewer = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "viewer@example.com",
        password: "ViewerPass123!"
      }
    });
    const viewerCookie = extractCookie(loginViewer.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);

    const forbiddenCreate = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: viewerCookie
      },
      payload: createValidWorkflow("wf-viewer-denied")
    });
    expect(forbiddenCreate.statusCode).toBe(403);
    expect(forbiddenCreate.json<{ error: string }>().error).toBe("Insufficient permissions");
  });

  it("enforces role matrix for viewer/operator/builder/admin", async () => {
    const context = await createTestContext();
    const users = [
      { email: "admin@example.com", password: "AdminPass123!", role: "admin" as const },
      { email: "builder@example.com", password: "BuilderPass123!", role: "builder" as const },
      { email: "operator@example.com", password: "OperatorPass123!", role: "operator" as const },
      { email: "viewer@example.com", password: "ViewerPass123!", role: "viewer" as const }
    ];

    for (const user of users) {
      context.authService.register(user);
    }

    const sessionCookies: Record<string, string> = {};
    for (const user of users) {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: user.email,
          password: user.password
        }
      });
      expect(response.statusCode).toBe(200);
      sessionCookies[user.role] = extractCookie(response.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
    }

    const viewerRead = await context.app.inject({
      method: "GET",
      url: "/api/workflows",
      headers: { cookie: sessionCookies.viewer }
    });
    expect(viewerRead.statusCode).toBe(200);

    const operatorRead = await context.app.inject({
      method: "GET",
      url: "/api/definitions",
      headers: { cookie: sessionCookies.operator }
    });
    expect(operatorRead.statusCode).toBe(200);

    const viewerSecrets = await context.app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { cookie: sessionCookies.viewer }
    });
    expect(viewerSecrets.statusCode).toBe(403);

    const builderWorkflowCreate = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: sessionCookies.builder },
      payload: createValidWorkflow("wf-builder-create")
    });
    expect(builderWorkflowCreate.statusCode).toBe(200);

    const operatorWorkflowCreate = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: sessionCookies.operator },
      payload: createValidWorkflow("wf-operator-denied")
    });
    expect(operatorWorkflowCreate.statusCode).toBe(403);

    const builderSecrets = await context.app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { cookie: sessionCookies.builder }
    });
    expect(builderSecrets.statusCode).toBe(200);

    const builderWebhookExecute = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/execute",
      headers: { cookie: sessionCookies.builder },
      payload: {
        workflow_id: "wf-builder-create",
        system_prompt: "sys",
        user_prompt: "user"
      }
    });
    expect(builderWebhookExecute.statusCode).not.toBe(401);
    expect(builderWebhookExecute.statusCode).not.toBe(403);

    const operatorWebhookExecute = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/execute",
      headers: { cookie: sessionCookies.operator },
      payload: {
        workflow_id: "wf-builder-create",
        system_prompt: "sys",
        user_prompt: "user"
      }
    });
    expect(operatorWebhookExecute.statusCode).toBe(403);

    const adminCreateAdmin = await context.app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: sessionCookies.admin },
      payload: {
        email: "second-admin@example.com",
        password: "SecondAdmin123!",
        role: "admin"
      }
    });
    expect(adminCreateAdmin.statusCode).toBe(200);

    const builderCreateAdmin = await context.app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: sessionCookies.builder },
      payload: {
        email: "blocked-admin@example.com",
        password: "BlockedAdmin123!",
        role: "admin"
      }
    });
    expect(builderCreateAdmin.statusCode).toBe(403);
  });

  it("allows builder to delete a workflow and returns 404 for repeat delete", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-delete@example.com",
      password: "BuilderDelete123!",
      role: "builder"
    });

    const workflowId = "wf-delete-target";
    const createResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builderCookie },
      payload: createValidWorkflow(workflowId)
    });
    expect(createResponse.statusCode).toBe(200);

    const deleteResponse = await context.app.inject({
      method: "DELETE",
      url: `/api/workflows/${workflowId}`,
      headers: { cookie: builderCookie }
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json<{ ok: boolean }>().ok).toBe(true);

    const secondDeleteResponse = await context.app.inject({
      method: "DELETE",
      url: `/api/workflows/${workflowId}`,
      headers: { cookie: builderCookie }
    });
    expect(secondDeleteResponse.statusCode).toBe(404);
  });

  it("allows builder to duplicate a workflow with a different name", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-duplicate@example.com",
      password: "BuilderDuplicate123!",
      role: "builder"
    });

    const sourceWorkflow = createValidWorkflow("wf-duplicate-source");
    sourceWorkflow.name = "CM Reports";

    const createResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builderCookie },
      payload: sourceWorkflow
    });
    expect(createResponse.statusCode).toBe(200);

    const duplicateResponse = await context.app.inject({
      method: "POST",
      url: `/api/workflows/${sourceWorkflow.id}/duplicate`,
      headers: { cookie: builderCookie },
      payload: {
        name: "CM Reports - QA Copy"
      }
    });
    expect(duplicateResponse.statusCode).toBe(200);
    const duplicated = duplicateResponse.json<Workflow>();
    expect(duplicated.id).not.toBe(sourceWorkflow.id);
    expect(duplicated.name).toBe("CM Reports - QA Copy");
    expect(duplicated.workflowVersion).toBe(1);
    expect(duplicated.nodes).toEqual(sourceWorkflow.nodes);
    expect(duplicated.edges).toEqual(sourceWorkflow.edges);

    const listResponse = await context.app.inject({
      method: "GET",
      url: "/api/workflows",
      headers: { cookie: builderCookie }
    });
    expect(listResponse.statusCode).toBe(200);
    const workflows = listResponse.json<Array<{ id: string }>>();
    expect(workflows.some((item) => item.id === sourceWorkflow.id)).toBe(true);
    expect(workflows.some((item) => item.id === duplicated.id)).toBe(true);
  });

  it("rejects workflow duplication for viewer role", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-duplicate-seed@example.com",
      password: "BuilderDuplicateSeed123!",
      role: "builder"
    });
    const viewerCookie = await createRoleSession(context, {
      email: "viewer-duplicate-denied@example.com",
      password: "ViewerDuplicateDenied123!",
      role: "viewer"
    });

    const sourceWorkflow = createValidWorkflow("wf-duplicate-denied-source");
    const createResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builderCookie },
      payload: sourceWorkflow
    });
    expect(createResponse.statusCode).toBe(200);

    const duplicateResponse = await context.app.inject({
      method: "POST",
      url: `/api/workflows/${sourceWorkflow.id}/duplicate`,
      headers: { cookie: viewerCookie },
      payload: {
        name: "Viewer Attempt Copy"
      }
    });
    expect(duplicateResponse.statusCode).toBe(403);
  });

  it("allows builder to test Azure connector configuration through API", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-azure-connector@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const response = await context.app.inject({
      method: "POST",
      url: "/api/connectors/test",
      headers: {
        cookie: builderCookie
      },
      payload: {
        connectorId: "azure-storage",
        connectorConfig: {
          operation: "list_containers",
          useDemoFallback: true
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; message: string }>();
    expect(body.ok).toBe(true);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("allows builder to test all Azure connector node families through API", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-azure-connectors-all@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const connectorPayloads: Array<{ connectorId: string; connectorConfig: Record<string, unknown> }> = [
      {
        connectorId: "azure-storage",
        connectorConfig: {
          operation: "list_containers",
          useDemoFallback: true
        }
      },
      {
        connectorId: "azure-cosmos-db",
        connectorConfig: {
          operation: "query_items",
          queryText: "SELECT TOP 1 * FROM c",
          useDemoFallback: true
        }
      },
      {
        connectorId: "azure-monitor",
        connectorConfig: {
          operation: "query_logs",
          queryText: "Heartbeat | take 1",
          useDemoFallback: true
        }
      },
      {
        connectorId: "azure-ai-search",
        connectorConfig: {
          operation: "vector_search",
          indexName: "demo-index",
          queryText: "hello",
          useDemoFallback: true
        }
      },
      {
        connectorId: "qdrant",
        connectorConfig: {
          operation: "get_ranked_documents",
          collectionName: "demo",
          queryText: "hello",
          useDemoFallback: true
        }
      }
    ];

    for (const payload of connectorPayloads) {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/connectors/test",
        headers: {
          cookie: builderCookie
        },
        payload
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ ok: boolean; message: string }>();
      expect(body.ok).toBe(true);
      expect(body.message.length).toBeGreaterThan(0);
    }
  });

  it("allows builder to test LLM provider connectivity and returns provider errors safely", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-provider-test@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const response = await context.app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers: {
        cookie: builderCookie
      },
      payload: {
        provider: {
          providerId: "unknown_provider",
          model: "demo-model"
        }
      }
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ ok: boolean; message: string }>();
    expect(body.ok).toBe(false);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("rejects provider test for non-builder roles", async () => {
    const context = await createTestContext();
    const viewerCookie = await createRoleSession(context, {
      email: "viewer-provider-test@example.com",
      password: "ViewerPass123!",
      role: "viewer"
    });

    const response = await context.app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers: {
        cookie: viewerCookie
      },
      payload: {
        provider: {
          providerId: "ollama",
          model: "llama3.1"
        }
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("validates provider test payload", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-provider-test-validation@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const response = await context.app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers: {
        cookie: builderCookie
      },
      payload: {
        provider: {
          providerId: "",
          model: ""
        }
      }
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string }>();
    expect(body.error).toBe("Invalid provider test payload");
  });
});

describe("secured webhook execution", () => {
  it("supports bearer token auth and rejects invalid token", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-webhook@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const token = "bearer-secret-token";
    const secretRef = context.secretService.createSecret({
      name: "webhook-bearer-token",
      provider: "webhook",
      value: token
    });

    const workflow = createWebhookWorkflow("wf-webhook-bearer", {
      authMode: "bearer_token",
      authHeaderName: "authorization",
      secretRef
    });

    const saveResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: builderCookie
      },
      payload: workflow
    });
    expect(saveResponse.statusCode).toBe(200);

    const validResponse = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-bearer",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        user_prompt: "hello bearer"
      }
    });
    expect(validResponse.statusCode).toBe(200);
    expect(validResponse.json<{ output?: { result?: string } }>().output?.result).toBe("hello bearer");

    const invalidResponse = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-bearer",
      headers: {
        authorization: "Bearer wrong-token"
      },
      payload: {
        user_prompt: "hello bearer"
      }
    });
    expect(invalidResponse.statusCode).toBe(401);
  });

  it("supports hmac auth and rejects invalid signatures and replay", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-hmac@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const hmacSecret = "hmac-shared-key";
    const secretRef = context.secretService.createSecret({
      name: "webhook-hmac-key",
      provider: "webhook",
      value: hmacSecret
    });

    const workflow = createWebhookWorkflow("wf-webhook-hmac", {
      authMode: "hmac_sha256",
      signatureHeaderName: "x-webhook-signature",
      timestampHeaderName: "x-webhook-timestamp",
      replayToleranceSeconds: 300,
      secretRef
    });

    const saveResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: builderCookie
      },
      payload: workflow
    });
    expect(saveResponse.statusCode).toBe(200);

    const rawBody = JSON.stringify({
      user_prompt: "hello hmac"
    });
    const timestamp = `${Math.floor(Date.now() / 1000)}`;
    const signature = crypto.createHmac("sha256", hmacSecret).update(`${timestamp}.${rawBody}`).digest("hex");

    const success = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-hmac",
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature
      },
      payload: rawBody
    });
    expect(success.statusCode).toBe(200);

    const badSignature = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-hmac",
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": `${Math.floor(Date.now() / 1000)}`,
        "x-webhook-signature": "deadbeef"
      },
      payload: rawBody
    });
    expect(badSignature.statusCode).toBe(403);

    const staleTimestamp = `${Math.floor(Date.now() / 1000) - 3600}`;
    const staleSignature = crypto.createHmac("sha256", hmacSecret).update(`${staleTimestamp}.${rawBody}`).digest("hex");
    const staleRequest = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-hmac",
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": staleTimestamp,
        "x-webhook-signature": staleSignature
      },
      payload: rawBody
    });
    expect(staleRequest.statusCode).toBe(403);

    const replay = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-hmac",
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature
      },
      payload: rawBody
    });
    expect(replay.statusCode).toBe(403);
  });

  it("returns cached result for duplicate idempotency key and 409 for conflicts", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-idempotency@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const workflow = createWebhookWorkflow("wf-webhook-idempotent", {
      authMode: "none",
      idempotencyEnabled: true,
      idempotencyHeaderName: "idempotency-key"
    });

    const saveResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: builderCookie
      },
      payload: workflow
    });
    expect(saveResponse.statusCode).toBe(200);

    const first = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-idempotent",
      headers: {
        "idempotency-key": "idem-1"
      },
      payload: {
        user_prompt: "first run"
      }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ idempotency?: { reused?: boolean } }>().idempotency?.reused).toBe(false);

    const duplicate = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-idempotent",
      headers: {
        "idempotency-key": "idem-1"
      },
      payload: {
        user_prompt: "first run"
      }
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json<{ idempotency?: { reused?: boolean } }>().idempotency?.reused).toBe(true);

    const conflicting = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-idempotent",
      headers: {
        "idempotency-key": "idem-1"
      },
      payload: {
        user_prompt: "changed payload"
      }
    });
    expect(conflicting.statusCode).toBe(409);
  });

  it("accepts buffer webhook payloads containing JSON and resolves user_prompt", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-buffer-webhook@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const workflow = createWebhookWorkflow("wf-webhook-buffer-payload", {
      authMode: "none"
    });

    const saveResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: builderCookie
      },
      payload: workflow
    });
    expect(saveResponse.statusCode).toBe(200);

    const payloadBuffer = Buffer.from(
      JSON.stringify({
        user_prompt: "buffer payload prompt"
      }),
      "utf8"
    );

    const response = await context.app.inject({
      method: "POST",
      url: "/webhook/secure-wf-webhook-buffer-payload",
      headers: {
        "content-type": "application/json"
      },
      payload: payloadBuffer
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ output?: { result?: string } }>().output?.result).toBe("buffer payload prompt");
  });
});

describe("execution resilience and lifecycle", () => {
  it("persists terminal node statuses without leaving nodes in running state", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-terminal-status@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const workflowId = "wf-terminal-status";
    const workflow = createWebhookWorkflow(workflowId, {
      authMode: "none"
    });

    const saveResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: builderCookie
      },
      payload: workflow
    });
    expect(saveResponse.statusCode).toBe(200);

    const runResponse = await context.app.inject({
      method: "POST",
      url: `/webhook-test/secure-${workflowId}`,
      payload: {
        user_prompt: "terminal run"
      }
    });
    expect(runResponse.statusCode).toBe(200);

    const historyList = await context.app.inject({
      method: "GET",
      url: `/api/executions?workflowId=${workflowId}&page=1&pageSize=1`,
      headers: {
        cookie: builderCookie
      }
    });
    expect(historyList.statusCode).toBe(200);
    const listBody = historyList.json<{
      items: Array<{ id: string; status: string }>;
    }>();
    expect(listBody.items.length).toBeGreaterThan(0);
    expect(listBody.items[0]?.status).toBe("success");

    const executionId = listBody.items[0]?.id ?? "";
    const historyDetail = await context.app.inject({
      method: "GET",
      url: `/api/executions/${executionId}`,
      headers: {
        cookie: builderCookie
      }
    });
    expect(historyDetail.statusCode).toBe(200);
    const detailBody = historyDetail.json<{
      status: string;
      nodeResults: Array<{ status: string }>;
      completedAt: string | null;
    }>();
    expect(detailBody.status).toBe("success");
    expect(detailBody.completedAt).not.toBeNull();
    expect(detailBody.nodeResults.every((entry) => entry.status !== "running")).toBe(true);
  });

  it("continues execution successfully when execution-history persistence fails", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-persist-fail@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const workflowId = "wf-persist-failure";
    const createResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: builderCookie
      },
      payload: createValidWorkflow(workflowId)
    });
    expect(createResponse.statusCode).toBe(200);

    const originalSaveExecutionHistory = context.store.saveExecutionHistory.bind(context.store);
    context.store.saveExecutionHistory = (() => {
      throw new Error("simulated execution history write failure");
    }) as SqliteStore["saveExecutionHistory"];

    try {
      const executeResponse = await context.app.inject({
        method: "POST",
        url: `/api/workflows/${workflowId}/execute`,
        headers: {
          cookie: builderCookie
        },
        payload: {
          input: {
            prompt: "resilience check"
          }
        }
      });
      expect(executeResponse.statusCode).toBe(200);
      const body = executeResponse.json<{ status: string }>();
      expect(body.status).toBe("success");
    } finally {
      context.store.saveExecutionHistory = originalSaveExecutionHistory;
    }
  });

  it("supports executing from a selected start node onward", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-start-node@example.com",
      password: "BuilderPass123!",
      role: "builder"
    });

    const workflowId = "wf-start-node";
    const createResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: builderCookie
      },
      payload: createLinearWorkflow(workflowId)
    });
    expect(createResponse.statusCode).toBe(200);

    const executeResponse = await context.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execute`,
      headers: {
        cookie: builderCookie
      },
      payload: {
        startNodeId: "output-node",
        input: {
          text: "from-selected-step"
        }
      }
    });

    expect(executeResponse.statusCode).toBe(200);
    const body = executeResponse.json<{
      status: string;
      nodeResults: Array<{ nodeId: string }>;
      output?: { result?: string };
    }>();
    expect(body.status).toBe("success");
    expect(body.nodeResults.map((entry) => entry.nodeId)).toEqual(["output-node"]);
    expect(body.output?.result).toBe("from-selected-step");
  });

  it("pins node output and reuses it during execution without calling the node executor", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-pin-data@example.com",
      password: "BuilderPinData123!",
      role: "builder"
    });

    const workflowId = "wf-pin-data";
    const workflow: Workflow = {
      id: workflowId,
      name: "Pinned Data Workflow",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "code-node",
          type: "code_node",
          name: "External Substitute",
          position: { x: 40, y: 120 },
          config: {
            code: "throw new Error('should not run');"
          }
        },
        {
          id: "output-node",
          type: "output",
          name: "Output",
          position: { x: 280, y: 120 },
          config: {
            outputKey: "result",
            responseTemplate: "{{safe}}"
          }
        }
      ],
      edges: [
        {
          id: "edge-code-output",
          source: "code-node",
          target: "output-node"
        }
      ]
    };

    const createResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builderCookie },
      payload: workflow
    });
    expect(createResponse.statusCode).toBe(200);

    const pinResponse = await context.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflowId}/pins/code-node`,
      headers: { cookie: builderCookie },
      payload: {
        data: {
          safe: "pinned-output"
        }
      }
    });
    expect(pinResponse.statusCode).toBe(200);

    const executeResponse = await context.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execute`,
      headers: { cookie: builderCookie },
      payload: {}
    });
    expect(executeResponse.statusCode).toBe(200);
    const body = executeResponse.json<{
      status: string;
      output?: { result?: string };
      nodeResults: Array<{ nodeId: string; warnings?: string[] }>;
    }>();
    expect(body.status).toBe("success");
    expect(body.output?.result).toBe("pinned-output");
    expect(body.nodeResults.find((entry) => entry.nodeId === "code-node")?.warnings).toContain(
      "Used pinned data; node executor was not called."
    );
  });

  it("executes a single node with provided previous parent outputs", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-single-node@example.com",
      password: "BuilderSingleNode123!",
      role: "builder"
    });

    const workflowId = "wf-single-node";
    const createResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: {
        cookie: builderCookie
      },
      payload: createLinearWorkflow(workflowId)
    });
    expect(createResponse.statusCode).toBe(200);

    const executeResponse = await context.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execute`,
      headers: {
        cookie: builderCookie
      },
      payload: {
        startNodeId: "output-node",
        runMode: "single_node",
        nodeOutputs: {
          "text-node": {
            text: "previous-output",
            user_prompt: "previous-output"
          }
        }
      }
    });

    expect(executeResponse.statusCode).toBe(200);
    const body = executeResponse.json<{
      status: string;
      nodeResults: Array<{ nodeId: string }>;
      output?: { result?: string };
    }>();
    expect(body.status).toBe("success");
    expect(body.nodeResults.map((entry) => entry.nodeId)).toEqual(["output-node"]);
    expect(body.output?.result).toBe("previous-output");
  });

  it("filters execution history by workflow, status, date range, and stores custom execution data", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-history-filters@example.com",
      password: "BuilderHistory123!",
      role: "builder"
    });

    const workflowId = "wf-history-filters";
    const workflow: Workflow = {
      id: workflowId,
      name: "History Filters Workflow",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "manual",
          type: "manual_trigger",
          name: "Manual",
          position: { x: 0, y: 80 },
          config: { label: "Run" }
        },
        {
          id: "output-node",
          type: "output",
          name: "Output",
          position: { x: 220, y: 80 },
          config: {
            outputKey: "result",
            responseTemplate: "{{ $execution.customData.batch }}"
          }
        }
      ],
      edges: [{ id: "edge-manual-output", source: "manual", target: "output-node" }]
    };

    const createResponse = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builderCookie },
      payload: workflow
    });
    expect(createResponse.statusCode).toBe(200);

    const startedFrom = new Date(Date.now() - 60_000).toISOString();
    const executeResponse = await context.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execute`,
      headers: { cookie: builderCookie },
      payload: {
        customData: {
          batch: "alpha",
          source: "test"
        }
      }
    });
    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json<{ output?: { result?: string } }>().output?.result).toBe("alpha");
    const startedTo = new Date(Date.now() + 60_000).toISOString();

    const historyResponse = await context.app.inject({
      method: "GET",
      url:
        `/api/executions?workflowId=${workflowId}&status=success` +
        `&startedFrom=${encodeURIComponent(startedFrom)}&startedTo=${encodeURIComponent(startedTo)}`,
      headers: { cookie: builderCookie }
    });
    expect(historyResponse.statusCode).toBe(200);
    const historyBody = historyResponse.json<{
      total: number;
      items: Array<{ id: string; customData: { batch?: string } }>;
    }>();
    expect(historyBody.total).toBe(1);
    expect(historyBody.items[0]?.customData.batch).toBe("alpha");

    const detailResponse = await context.app.inject({
      method: "GET",
      url: `/api/executions/${historyBody.items[0]?.id}`,
      headers: { cookie: builderCookie }
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailBody = detailResponse.json<{ customData: { batch?: string }; output?: { result?: string } }>();
    expect(detailBody.customData.batch).toBe("alpha");
    expect(detailBody.output?.result).toBe("alpha");
  });

  it("retries a failed execution from history", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-history-retry@example.com",
      password: "BuilderRetry123!",
      role: "builder"
    });

    const workflowId = "wf-history-retry";
    const makeWorkflow = (code: string): Workflow => ({
      id: workflowId,
      name: "History Retry Workflow",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "code-node",
          type: "code_node",
          name: "Code",
          position: { x: 40, y: 80 },
          config: { code }
        },
        {
          id: "output-node",
          type: "output",
          name: "Output",
          position: { x: 260, y: 80 },
          config: {
            outputKey: "result",
            responseTemplate: "{{value}}"
          }
        }
      ],
      edges: [{ id: "edge-code-output", source: "code-node", target: "output-node" }]
    });

    expect((await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builderCookie },
      payload: makeWorkflow("throw new Error('first run failed');")
    })).statusCode).toBe(200);

    const failedRun = await context.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execute`,
      headers: { cookie: builderCookie },
      payload: {}
    });
    expect(failedRun.statusCode).toBe(400);

    const failedHistory = await context.app.inject({
      method: "GET",
      url: `/api/executions?workflowId=${workflowId}&status=error&page=1&pageSize=1`,
      headers: { cookie: builderCookie }
    });
    expect(failedHistory.statusCode).toBe(200);
    const failedExecutionId = failedHistory.json<{ items: Array<{ id: string }> }>().items[0]?.id ?? "";
    expect(failedExecutionId).not.toBe("");

    expect((await context.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflowId}`,
      headers: { cookie: builderCookie },
      payload: makeWorkflow("return { value: 'recovered' };")
    })).statusCode).toBe(200);

    const retryResponse = await context.app.inject({
      method: "POST",
      url: `/api/executions/${failedExecutionId}/retry`,
      headers: { cookie: builderCookie },
      payload: {}
    });
    expect(retryResponse.statusCode).toBe(200);
    const retryBody = retryResponse.json<{ status: string; output?: { result?: string } }>();
    expect(retryBody.status).toBe("success");
    expect(retryBody.output?.result).toBe("recovered");
  });

  it("cancels a running execution from history", async () => {
    const context = await createTestContext();
    const builderCookie = await createRoleSession(context, {
      email: "builder-history-cancel@example.com",
      password: "BuilderCancel123!",
      role: "builder"
    });

    const workflowId = "wf-history-cancel";
    const workflow: Workflow = {
      id: workflowId,
      name: "History Cancel Workflow",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "wait-node",
          type: "wait_node",
          name: "Wait",
          position: { x: 40, y: 80 },
          config: { delayMs: 5000, maxDelayMs: 5000 }
        },
        {
          id: "output-node",
          type: "output",
          name: "Output",
          position: { x: 260, y: 80 },
          config: { responseTemplate: "done", outputKey: "result" }
        }
      ],
      edges: [{ id: "edge-wait-output", source: "wait-node", target: "output-node" }]
    };

    expect((await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builderCookie },
      payload: workflow
    })).statusCode).toBe(200);

    const runPromise = context.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execute`,
      headers: { cookie: builderCookie },
      payload: {}
    });

    let executionId = "";
    for (let attempt = 0; attempt < 40 && !executionId; attempt += 1) {
      await delay(50);
      const listResponse = await context.app.inject({
        method: "GET",
        url: `/api/executions?workflowId=${workflowId}&status=running&page=1&pageSize=1`,
        headers: { cookie: builderCookie }
      });
      const items = listResponse.json<{ items: Array<{ id: string }> }>().items;
      executionId = items[0]?.id ?? "";
    }
    expect(executionId).not.toBe("");

    const cancelResponse = await context.app.inject({
      method: "POST",
      url: `/api/executions/${executionId}/cancel`,
      headers: { cookie: builderCookie },
      payload: { reason: "test cancellation" }
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json<{ status: string; abortedActiveRun: boolean }>().abortedActiveRun).toBe(true);

    const runResponse = await runPromise;
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json<{ status: string }>().status).toBe("canceled");

    const detailResponse = await context.app.inject({
      method: "GET",
      url: `/api/executions/${executionId}`,
      headers: { cookie: builderCookie }
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailBody = detailResponse.json<{ status: string; nodeResults: Array<{ status: string }> }>();
    expect(detailBody.status).toBe("canceled");
    expect(detailBody.nodeResults.some((entry) => entry.status === "canceled")).toBe(true);
  });

  it("prunes execution history older than a retention cutoff", async () => {
    const context = await createTestContext();
    const oldStartedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recentStartedAt = new Date().toISOString();

    context.store.saveExecutionHistory({
      id: "exec-old",
      workflowId: "wf-old",
      workflowName: "Old Workflow",
      status: "success",
      startedAt: oldStartedAt,
      completedAt: oldStartedAt
    });
    context.store.saveExecutionHistory({
      id: "exec-recent",
      workflowId: "wf-recent",
      workflowName: "Recent Workflow",
      status: "success",
      startedAt: recentStartedAt,
      completedAt: recentStartedAt
    });

    const deleted = context.store.pruneExecutionHistory({
      before: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    });
    expect(deleted).toBe(1);
    expect(context.store.getExecutionHistory("exec-old")).toBeNull();
    expect(context.store.getExecutionHistory("exec-recent")).not.toBeNull();
  });
});

describe("node definitions surface (Phase 1 + 2)", () => {
  it("exposes all 23 new Phase 1 + Phase 2 node types via /api/definitions", async () => {
    const context = await createTestContext();
    context.authService.register({
      email: "viewer@example.com",
      password: "ViewerPass123!",
      role: "viewer"
    });
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "viewer@example.com", password: "ViewerPass123!" }
    });
    const cookie = extractCookie(login.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);

    const response = await context.app.inject({
      method: "GET",
      url: "/api/definitions",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ nodes: Array<{ type: string }> }>();
    const types = new Set(body.nodes.map((n) => n.type));

    const required = [
      "sub_workflow_trigger",
      "error_trigger",
      "filter_node",
      "stop_and_error",
      "noop_node",
      "aggregate_node",
      "split_out_node",
      "sort_node",
      "limit_node",
      "remove_duplicates_node",
      "summarize_node",
      "compare_datasets_node",
      "rename_keys_node",
      "edit_fields_node",
      "date_time_node",
      "crypto_node",
      "jwt_node",
      "xml_node",
      "html_node",
      "convert_to_file_node",
      "extract_from_file_node",
      "compression_node",
      "edit_image_node"
    ];
    for (const type of required) {
      expect(types.has(type), `expected node type ${type}`).toBe(true);
    }
  });
});

describe("Phase 3.1 Tier 1 integrations surface", () => {
  it("exposes all Tier 1 node types in /api/definitions and /api/integrations", async () => {
    const context = await createTestContext();
    context.authService.register({
      email: "viewer-tier1@example.com",
      password: "ViewerPass123!",
      role: "viewer"
    });
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "viewer-tier1@example.com", password: "ViewerPass123!" }
    });
    const cookie = extractCookie(login.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);

    const defResp = await context.app.inject({
      method: "GET",
      url: "/api/definitions",
      headers: { cookie }
    });
    expect(defResp.statusCode).toBe(200);
    const defBody = defResp.json<{ nodes: Array<{ type: string }> }>();
    const nodeTypes = new Set(defBody.nodes.map((n) => n.type));
    const expectedNodeTypes = [
      "slack_send_message",
      "slack_trigger",
      "smtp_send_email",
      "imap_email_trigger",
      "google_sheets_read",
      "google_sheets_append",
      "google_sheets_update",
      "google_sheets_trigger",
      "postgres_query",
      "postgres_trigger",
      "mysql_query",
      "mongo_operation",
      "redis_command",
      "redis_trigger",
      "github_action",
      "github_webhook_trigger"
    ];
    for (const t of expectedNodeTypes) {
      expect(nodeTypes.has(t), `missing node type ${t}`).toBe(true);
    }

    const intResp = await context.app.inject({
      method: "GET",
      url: "/api/integrations",
      headers: { cookie }
    });
    expect(intResp.statusCode).toBe(200);
    const intBody = intResp.json<{
      integrations: Array<{ id: string; label: string; logoPath: string; nodeTypes: string[] }>;
    }>();
    const ids = new Set(intBody.integrations.map((i) => i.id));
    const expectedIds = [
      "http",
      "slack",
      "smtp",
      "imap",
      "gmail",
      "google-sheets",
      "postgresql",
      "mysql",
      "mongodb",
      "redis",
      "github"
    ];
    for (const id of expectedIds) {
      expect(ids.has(id), `missing integration ${id}`).toBe(true);
    }
    for (const integration of intBody.integrations) {
      expect(integration.logoPath).toMatch(/^\/logos\/.+\.svg$/);
      expect(integration.nodeTypes.length).toBeGreaterThan(0);
    }
  });
});

describe("Phase 3.5 trigger system expansion", () => {
  async function registerAndLogin(
    context: TestContext,
    role: "admin" | "builder" | "viewer"
  ): Promise<string> {
    const email = `${role}-35-${Date.now()}@example.com`;
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "TestPass123!" }
    });
    if (login.statusCode === 200) {
      return extractCookie(login.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
    }
    context.authService.register({ email, password: "TestPass123!", role });
    const retry = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "TestPass123!" }
    });
    if (retry.statusCode !== 200) throw new Error(`login failed: ${retry.body}`);
    return extractCookie(retry.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
  }

  it("exposes all Phase 3.5 trigger node definitions", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "viewer");
    const res = await context.app.inject({
      method: "GET",
      url: "/api/definitions",
      headers: { cookie }
    });
    expect(res.statusCode).toBe(200);
    const nodeTypes = new Set(res.json<{ nodes: Array<{ type: string }> }>().nodes.map((n) => n.type));
    for (const t of [
      "manual_trigger",
      "form_trigger",
      "chat_trigger",
      "file_trigger",
      "rss_trigger",
      "sse_trigger",
      "mcp_server_trigger",
      "kafka_trigger",
      "rabbitmq_trigger",
      "mqtt_trigger"
    ]) {
      expect(nodeTypes.has(t), `missing ${t}`).toBe(true);
    }
  });

  it("manual_trigger runs a workflow with payload merged into context", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "builder");

    const workflow: Workflow = {
      id: "manual-wf-1",
      name: "Manual Demo",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "trigger",
          type: "manual_trigger",
          name: "Manual",
          position: { x: 0, y: 0 },
          config: { label: "Run" }
        },
        {
          id: "out",
          type: "output",
          name: "Out",
          position: { x: 200, y: 0 },
          config: { outputKey: "result", responseTemplate: "echo:{{user_prompt}}" }
        }
      ],
      edges: [{ id: "e1", source: "trigger", target: "out" }]
    };
    context.store.upsertWorkflow(workflow);

    const res = await context.app.inject({
      method: "POST",
      url: "/api/triggers/manual/manual-wf-1",
      headers: { cookie },
      payload: { user_prompt: "hello-manual" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; status: string }>();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("success");
  });

  it("form_trigger renders HTML and accepts submissions", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "builder");

    const workflow: Workflow = {
      id: "form-wf-1",
      name: "Form Demo",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "form",
          type: "form_trigger",
          name: "Form",
          position: { x: 0, y: 0 },
          config: {
            path: "contact-demo",
            title: "Contact",
            submitLabel: "Send",
            authMode: "public",
            successMessage: "Thanks!",
            fields: [{ name: "name", label: "Name", type: "text", required: true }]
          }
        },
        {
          id: "out",
          type: "output",
          name: "Out",
          position: { x: 200, y: 0 },
          config: { outputKey: "result", responseTemplate: "hi:{{name}}" }
        }
      ],
      edges: [{ id: "e1", source: "form", target: "out" }]
    };
    context.store.upsertWorkflow(workflow);

    const htmlRes = await context.app.inject({
      method: "GET",
      url: "/api/forms/contact-demo"
    });
    expect(htmlRes.statusCode).toBe(200);
    expect(String(htmlRes.headers["content-type"] ?? "")).toContain("text/html");
    expect(htmlRes.body).toContain('name="name"');
    expect(htmlRes.body).toContain("Contact");

    const submit = await context.app.inject({
      method: "POST",
      url: "/api/forms/contact-demo",
      headers: { accept: "application/json" },
      payload: { name: "Alice" }
    });
    expect(submit.statusCode).toBe(200);
    const body = submit.json<{ ok: boolean; status: string }>();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("success");

    const missing = await context.app.inject({
      method: "GET",
      url: "/api/forms/does-not-exist"
    });
    expect(missing.statusCode).toBe(404);
    void cookie;
  });

  it("chat_trigger generates a session_id when none is provided", async () => {
    const context = await createTestContext();
    await registerAndLogin(context, "builder");

    const workflow: Workflow = {
      id: "chat-wf-1",
      name: "Chat Demo",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "chat",
          type: "chat_trigger",
          name: "Chat",
          position: { x: 0, y: 0 },
          config: { authMode: "public", sessionNamespace: "ns" }
        },
        {
          id: "out",
          type: "output",
          name: "Out",
          position: { x: 200, y: 0 },
          config: { outputKey: "result", responseTemplate: "got:{{message}}" }
        }
      ],
      edges: [{ id: "e1", source: "chat", target: "out" }]
    };
    context.store.upsertWorkflow(workflow);

    const res = await context.app.inject({
      method: "POST",
      url: "/api/chat/chat-wf-1",
      payload: { message: "hello chat" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; session_id: string; status: string }>();
    expect(body.ok).toBe(true);
    expect(body.session_id).toMatch(/.+/);
    expect(body.status).toBe("success");
  });

  it("mcp_server_trigger exposes manifest + invoke endpoints", async () => {
    const context = await createTestContext();
    await registerAndLogin(context, "builder");

    const workflow: Workflow = {
      id: "mcp-wf-1",
      name: "MCP Demo",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "mcp",
          type: "mcp_server_trigger",
          name: "MCP",
          position: { x: 0, y: 0 },
          config: {
            path: "demo",
            toolName: "echo",
            toolDescription: "Echo the input",
            authMode: "public",
            inputSchema: { type: "object", properties: { q: { type: "string" } } }
          }
        },
        {
          id: "out",
          type: "output",
          name: "Out",
          position: { x: 200, y: 0 },
          config: { outputKey: "result", responseTemplate: "answered:{{q}}" }
        }
      ],
      edges: [{ id: "e1", source: "mcp", target: "out" }]
    };
    context.store.upsertWorkflow(workflow);

    const manifest = await context.app.inject({
      method: "GET",
      url: "/api/mcp-server/demo/manifest"
    });
    expect(manifest.statusCode).toBe(200);
    const manifestBody = manifest.json<{ name: string; inputSchema: unknown }>();
    expect(manifestBody.name).toBe("echo");

    const invoke = await context.app.inject({
      method: "POST",
      url: "/api/mcp-server/demo/invoke",
      payload: { arguments: { q: "ping" } }
    });
    expect(invoke.statusCode).toBe(200);
    const invokeBody = invoke.json<{ ok: boolean }>();
    expect(invokeBody.ok).toBe(true);
  });
});

describe("Phase 4.2 workflow organization", () => {
  async function registerAndLogin(
    context: TestContext,
    role: "admin" | "builder" | "viewer"
  ): Promise<string> {
    const email = `${role}-42-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    context.authService.register({ email, password: "TestPass123!", role });
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "TestPass123!" }
    });
    if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
    return extractCookie(login.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
  }

  function makeWorkflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
    return {
      id,
      name: `WF ${id}`,
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: 1,
      nodes: [
        {
          id: "out",
          type: "output",
          name: "Out",
          position: { x: 0, y: 0 },
          config: { outputKey: "result", responseTemplate: "ok" }
        }
      ],
      edges: [],
      ...overrides
    };
  }

  it("bootstraps the default project and returns it from GET /api/projects", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "viewer");
    const res = await context.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ projects: Array<{ id: string; name: string }> }>();
    expect(body.projects.find((p) => p.id === "default")).toBeDefined();
  });

  it("create + move workflow into a custom project and folder, then filter list", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "builder");

    const projectRes = await context.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "Client Work", description: "Everything for clients" }
    });
    expect(projectRes.statusCode).toBe(200);
    const project = projectRes.json<{ id: string; name: string }>();
    expect(project.id).toMatch(/.+/);

    const folderRes = await context.app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "Inbound", projectId: project.id }
    });
    expect(folderRes.statusCode).toBe(200);
    const folder = folderRes.json<{ id: string }>();

    context.store.upsertWorkflow(makeWorkflow("wf-move-1", { name: "To move" }));

    const moveRes = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-move-1/move",
      headers: { cookie },
      payload: { projectId: project.id, folderId: folder.id, tags: ["alpha", "beta"] }
    });
    expect(moveRes.statusCode).toBe(200);
    const moved = moveRes.json<{ projectId: string; folderId: string; tags: string[] }>();
    expect(moved.projectId).toBe(project.id);
    expect(moved.folderId).toBe(folder.id);
    expect(moved.tags).toEqual(["alpha", "beta"]);

    const byProject = await context.app.inject({
      method: "GET",
      url: `/api/workflows?projectId=${project.id}`,
      headers: { cookie }
    });
    expect(byProject.statusCode).toBe(200);
    const projectList = byProject.json<Array<{ id: string; tags?: string[] }>>();
    expect(projectList.some((w) => w.id === "wf-move-1")).toBe(true);

    const byTag = await context.app.inject({
      method: "GET",
      url: `/api/workflows?tag=alpha`,
      headers: { cookie }
    });
    expect(byTag.statusCode).toBe(200);
    const tagList = byTag.json<Array<{ id: string }>>();
    expect(tagList.some((w) => w.id === "wf-move-1")).toBe(true);

    const byFolder = await context.app.inject({
      method: "GET",
      url: `/api/workflows?folderId=${folder.id}`,
      headers: { cookie }
    });
    expect(byFolder.statusCode).toBe(200);
    const folderList = byFolder.json<Array<{ id: string }>>();
    expect(folderList.length).toBe(1);
    expect(folderList[0]!.id).toBe("wf-move-1");
  });

  it("search filters by name (case-insensitive substring)", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "builder");
    context.store.upsertWorkflow(makeWorkflow("wf-s-1", { name: "Customer Onboarding Agent" }));
    context.store.upsertWorkflow(makeWorkflow("wf-s-2", { name: "Invoice Processor" }));

    const res = await context.app.inject({
      method: "GET",
      url: "/api/workflows?search=onboard",
      headers: { cookie }
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<{ id: string }>>();
    expect(list.map((w) => w.id)).toEqual(["wf-s-1"]);
  });

  it("duplicate preserves tags/folder/project from source", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "builder");

    const projectRes = await context.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "X" }
    });
    const project = projectRes.json<{ id: string }>();
    const folderRes = await context.app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "Y", projectId: project.id }
    });
    const folder = folderRes.json<{ id: string }>();

    context.store.upsertWorkflow(
      makeWorkflow("wf-src", {
        name: "Src",
        tags: ["production"],
        projectId: project.id,
        folderId: folder.id
      })
    );

    const dupRes = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-src/duplicate",
      headers: { cookie },
      payload: { name: "Copy" }
    });
    expect(dupRes.statusCode).toBe(200);
    const dup = dupRes.json<{ id: string; tags?: string[]; projectId?: string; folderId?: string }>();
    expect(dup.tags).toEqual(["production"]);
    expect(dup.projectId).toBe(project.id);
    expect(dup.folderId).toBe(folder.id);
  });

  it("secrets scope to the project when listed with ?projectId", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "builder");
    const projectRes = await context.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "P" }
    });
    const project = projectRes.json<{ id: string }>();

    await context.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: { name: "Default secret", provider: "custom", value: "secret-a" }
    });
    await context.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: {
        name: "Project secret",
        provider: "custom",
        value: "secret-b",
        projectId: project.id
      }
    });

    const defaultList = await context.app.inject({
      method: "GET",
      url: "/api/secrets?projectId=default",
      headers: { cookie }
    });
    expect(defaultList.statusCode).toBe(200);
    const defaults = defaultList.json<Array<{ name: string; projectId: string }>>();
    expect(defaults.some((s) => s.name === "Default secret")).toBe(true);
    expect(defaults.some((s) => s.name === "Project secret")).toBe(false);

    const projectList = await context.app.inject({
      method: "GET",
      url: `/api/secrets?projectId=${project.id}`,
      headers: { cookie }
    });
    expect(projectList.statusCode).toBe(200);
    const projectSecrets = projectList.json<Array<{ name: string }>>();
    expect(projectSecrets.some((s) => s.name === "Project secret")).toBe(true);
    expect(projectSecrets.some((s) => s.name === "Default secret")).toBe(false);
  });

  it("refuses to delete the default project", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "builder");
    const res = await context.app.inject({
      method: "DELETE",
      url: "/api/projects/default",
      headers: { cookie }
    });
    expect(res.statusCode).toBe(400);
  });

  it("deleting a folder orphans its workflows (moves them out of folder) without deleting them", async () => {
    const context = await createTestContext();
    const cookie = await registerAndLogin(context, "builder");
    const folderRes = await context.app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie },
      payload: { name: "Tmp", projectId: "default" }
    });
    const folder = folderRes.json<{ id: string }>();
    context.store.upsertWorkflow(
      makeWorkflow("wf-fld", { folderId: folder.id })
    );

    const del = await context.app.inject({
      method: "DELETE",
      url: `/api/folders/${folder.id}`,
      headers: { cookie }
    });
    expect(del.statusCode).toBe(200);

    const wf = context.store.getWorkflow("wf-fld");
    expect(wf).not.toBeNull();
    expect(wf?.folderId).toBeUndefined();
  });
});
