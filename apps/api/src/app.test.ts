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

async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-orchestrator-auth-test-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  const masterKey = crypto.randomBytes(32).toString("base64");

  const config: AppConfig = {
    API_PORT: 0,
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://localhost:5173",
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
    ...overrides
  };

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
});
