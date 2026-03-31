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
  authService: AuthService;
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
    authService,
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
});
