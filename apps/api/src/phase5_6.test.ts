import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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
  gitWorkdir: string;
  bareRepo: string;
}

const contexts: TestContext[] = [];

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    API_PORT: 0,
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://localhost:5173",
    WORKFLOW_EXECUTION_TIMEOUT_MS: 300000,
    EXECUTION_HISTORY_RETENTION_DAYS: 30,
    EXECUTION_HISTORY_PRUNE_INTERVAL_MS: 3600000,
    SEED_SAMPLE_WORKFLOWS: false,
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
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
    LOG_STREAM_ENABLED: false,
    LOG_STREAM_FLUSH_INTERVAL_MS: 2000,
    LOG_STREAM_BUFFER_SIZE: 1000,
    LOG_STREAM_RETRY_MAX_ATTEMPTS: 2,
    LOG_STREAM_EVENT_RETENTION_DAYS: 14,
    LOG_STREAM_EVENT_PRUNE_INTERVAL_MS: 3600000,
    GIT_SYNC_ENABLED: true,
    GIT_SYNC_WORKDIR: "apps/api/data/git",
    GIT_BIN: "git",
    GIT_COMMAND_TIMEOUT_MS: 60000,
    WORKFLOW_VERSION_RETENTION: 100,
    ...overrides
  };
}

async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase5-6-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const gitWorkdir = path.join(tempDir, "git-workdir");
  const bareRepo = path.join(tempDir, "remote.git");
  fs.mkdirSync(bareRepo);
  spawnSync("git", ["init", "--bare", "-b", "main", bareRepo], { encoding: "utf8" });

  const store = await SqliteStore.create(dbPath);
  const config = makeConfig({ GIT_SYNC_WORKDIR: gitWorkdir, ...overrides });
  store.ensureDefaultProject();
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const ctx: TestContext = {
    app,
    store,
    authService,
    secretService,
    config,
    tempDir,
    gitWorkdir,
    bareRepo
  };
  contexts.push(ctx);
  return ctx;
}

function extractCookie(header: string | string[] | undefined, name: string): string {
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Cookie '${name}' was not set`);
  return cookie.split(";")[0]!;
}

async function loginUser(
  ctx: TestContext,
  input: { email: string; password: string; role: "admin" | "builder" | "operator" | "viewer" }
): Promise<{ cookie: string; userId: string }> {
  const registered = ctx.authService.register(input);
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: input.email, password: input.password }
  });
  return {
    cookie: extractCookie(response.headers["set-cookie"], ctx.config.SESSION_COOKIE_NAME),
    userId: registered.id
  };
}

async function loginAdmin(ctx: TestContext): Promise<string> {
  const { cookie } = await loginUser(ctx, {
    email: "admin@example.com",
    password: "admin-password",
    role: "admin"
  });
  return cookie;
}

function minimalWorkflow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      {
        id: "output",
        type: "output",
        name: "out",
        position: { x: 0, y: 0 },
        config: { outputKey: "result" }
      }
    ],
    edges: [],
    ...overrides
  };
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (!ctx) continue;
    await ctx.app.close();
    try {
      fs.rmSync(ctx.tempDir, { recursive: true, force: true });
    } catch {
      // Windows file lock — best effort cleanup.
    }
  }
});

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

describe("Phase 5.6 — Variables CRUD + template interpolation", () => {
  it("creates, lists, updates and deletes a variable", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);

    const create = await ctx.app.inject({
      method: "POST",
      url: "/api/variables",
      headers: { cookie },
      payload: { projectId: "default", key: "API_BASE_URL", value: "https://prod.example.com" }
    });
    expect(create.statusCode).toBe(200);
    const variableId = (create.json() as { variable: { id: string } }).variable.id;
    expect(variableId).toMatch(/^var_/);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/variables?projectId=default",
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    const variables = (list.json() as { variables: Array<{ key: string }> }).variables;
    expect(variables).toHaveLength(1);
    expect(variables[0]!.key).toBe("API_BASE_URL");

    const update = await ctx.app.inject({
      method: "PUT",
      url: `/api/variables/${variableId}`,
      headers: { cookie },
      payload: { value: "https://staging.example.com" }
    });
    expect(update.statusCode).toBe(200);
    expect((update.json() as { variable: { value: string } }).variable.value).toBe(
      "https://staging.example.com"
    );

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/variables/${variableId}`,
      headers: { cookie }
    });
    expect(del.statusCode).toBe(200);
  });

  it("rejects invalid variable keys and enforces project-scoped uniqueness", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const invalid = await ctx.app.inject({
      method: "POST",
      url: "/api/variables",
      headers: { cookie },
      payload: { projectId: "default", key: "1bad-key", value: "x" }
    });
    expect(invalid.statusCode).toBe(400);

    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/variables",
      headers: { cookie },
      payload: { projectId: "default", key: "MY_KEY", value: "a" }
    });
    expect(first.statusCode).toBe(200);
    const dup = await ctx.app.inject({
      method: "POST",
      url: "/api/variables",
      headers: { cookie },
      payload: { projectId: "default", key: "MY_KEY", value: "b" }
    });
    expect(dup.statusCode).toBe(400);
  });

  it("denies non-admin callers from viewing variables across projects", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "viewer@example.com",
      password: "viewer-password",
      role: "viewer"
    });
    const all = await ctx.app.inject({
      method: "GET",
      url: "/api/variables",
      headers: { cookie }
    });
    expect(all.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Workflow version history
// ---------------------------------------------------------------------------

describe("Phase 5.6 — Workflow version history + restore", () => {
  it("snapshots every save and can restore an earlier version", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);

    const v1 = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: minimalWorkflow("wf-v", { name: "v1" })
    });
    expect(v1.statusCode).toBe(200);

    const v2 = await ctx.app.inject({
      method: "PUT",
      url: "/api/workflows/wf-v",
      headers: { cookie },
      payload: minimalWorkflow("wf-v", { name: "v2" })
    });
    expect(v2.statusCode).toBe(200);

    const v3 = await ctx.app.inject({
      method: "PUT",
      url: "/api/workflows/wf-v",
      headers: { cookie },
      payload: minimalWorkflow("wf-v", { name: "v3" })
    });
    expect(v3.statusCode).toBe(200);

    const versions = await ctx.app.inject({
      method: "GET",
      url: "/api/workflows/wf-v/versions",
      headers: { cookie }
    });
    expect(versions.statusCode).toBe(200);
    const list = (versions.json() as { versions: Array<{ version: number }> }).versions;
    expect(list.length).toBe(3);
    // Most recent version first.
    expect(list[0]!.version).toBe(3);

    const restore = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows/wf-v/versions/1/restore",
      headers: { cookie }
    });
    expect(restore.statusCode).toBe(200);
    const restored = restore.json() as { name: string };
    expect(restored.name).toBe("v1");

    // Restore creates a new version entry.
    const afterRestore = await ctx.app.inject({
      method: "GET",
      url: "/api/workflows/wf-v/versions",
      headers: { cookie }
    });
    const after = (afterRestore.json() as { versions: Array<{ version: number; changeNote: string | null }> })
      .versions;
    expect(after.length).toBe(4);
    expect(after[0]!.changeNote).toMatch(/restored from v1/);
  });

  it("returns 404 for missing version or workflow", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    const missing = await ctx.app.inject({
      method: "GET",
      url: "/api/workflows/nope/versions",
      headers: { cookie }
    });
    expect(missing.statusCode).toBe(404);

    await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: minimalWorkflow("wf-x")
    });
    const badVersion = await ctx.app.inject({
      method: "GET",
      url: "/api/workflows/wf-x/versions/999",
      headers: { cookie }
    });
    expect(badVersion.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Git push/pull round-trip
// ---------------------------------------------------------------------------

describe("Phase 5.6 — Git push/pull round-trip with credential stubs", () => {
  it("pushes workflows+variables and pulls them back with credential stubs resolved", async () => {
    const ctxA = await createTestContext();
    const cookieA = await loginAdmin(ctxA);

    // Create a secret so workflows can reference it through a secretRef.
    const secret = ctxA.secretService.createSecret({
      name: "prod-openai",
      provider: "openai",
      value: "sk-prod-test"
    });

    const workflow = {
      id: "wf-git",
      name: "Git demo",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        {
          id: "http",
          type: "http_request",
          name: "HTTP",
          position: { x: 0, y: 0 },
          config: {
            method: "GET",
            urlTemplate: "https://api.example.com/health",
            authSecretRef: { secretId: secret.secretId }
          }
        },
        {
          id: "output",
          type: "output",
          name: "out",
          position: { x: 200, y: 0 },
          config: { outputKey: "result" }
        }
      ],
      edges: [{ id: "e1", source: "http", target: "output" }]
    };
    const wfResp = await ctxA.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: cookieA },
      payload: workflow
    });
    expect(wfResp.statusCode).toBe(200);

    await ctxA.app.inject({
      method: "POST",
      url: "/api/variables",
      headers: { cookie: cookieA },
      payload: { projectId: "default", key: "REGION", value: "us-east-1" }
    });

    // Point instance A at the bare repo.
    const configureA = await ctxA.app.inject({
      method: "PUT",
      url: "/api/git",
      headers: { cookie: cookieA },
      payload: { repoUrl: ctxA.bareRepo, defaultBranch: "main" }
    });
    expect(configureA.statusCode).toBe(200);

    const pushResp = await ctxA.app.inject({
      method: "POST",
      url: "/api/git/push",
      headers: { cookie: cookieA },
      payload: { branch: "main" }
    });
    expect(pushResp.statusCode).toBe(200);
    const push = pushResp.json() as {
      ok: boolean;
      branch?: string;
      workflowsExported?: number;
      variablesSynced?: number;
    };
    expect(push.ok).toBe(true);
    expect(push.branch).toBe("main");
    expect(push.workflowsExported).toBe(1);
    expect(push.variablesSynced).toBe(1);

    // Inspect the pushed file on the filesystem clone to verify credential stub.
    const workflowsDir = path.join(ctxA.gitWorkdir, "default", "workflows");
    const pushedFiles = fs.readdirSync(workflowsDir);
    expect(pushedFiles).toContain("wf-git.json");
    const pushed = JSON.parse(fs.readFileSync(path.join(workflowsDir, "wf-git.json"), "utf8")) as {
      nodes: Array<{ config?: Record<string, unknown> }>;
    };
    const ref = pushed.nodes[0]!.config!.authSecretRef as Record<string, unknown>;
    expect(ref.secretName).toBe("prod-openai");
    expect(ref.secretProvider).toBe("openai");
    expect(ref.secretId).toBeUndefined();

    // Instance B pulls the bare repo — it has NO local workflow yet, and a
    // pre-existing secret with the same name so the stub should resolve.
    const ctxB = await createTestContext();
    const cookieB = await loginAdmin(ctxB);
    const secretB = ctxB.secretService.createSecret({
      name: "prod-openai",
      provider: "openai",
      value: "sk-local-different"
    });

    await ctxB.app.inject({
      method: "PUT",
      url: "/api/git",
      headers: { cookie: cookieB },
      payload: { repoUrl: ctxA.bareRepo, defaultBranch: "main" }
    });

    const pullResp = await ctxB.app.inject({
      method: "POST",
      url: "/api/git/pull",
      headers: { cookie: cookieB },
      payload: { branch: "main" }
    });
    expect(pullResp.statusCode).toBe(200);
    const pull = pullResp.json() as {
      ok: boolean;
      workflowsImported?: number;
      variablesSynced?: number;
    };
    expect(pull.ok).toBe(true);
    expect(pull.workflowsImported).toBe(1);
    expect(pull.variablesSynced).toBe(1);

    const imported = ctxB.store.getWorkflow("wf-git");
    expect(imported).toBeTruthy();
    // The stub should have been resolved to the local secret id.
    const importedRef = imported!.nodes[0]!.config!.authSecretRef as Record<string, unknown>;
    expect(importedRef.secretId).toBe(secretB.secretId);
    expect(importedRef.secretName).toBeUndefined();

    const importedVars = await ctxB.app.inject({
      method: "GET",
      url: "/api/variables?projectId=default",
      headers: { cookie: cookieB }
    });
    const vars = (importedVars.json() as { variables: Array<{ key: string; value: string }> }).variables;
    const region = vars.find((v) => v.key === "REGION");
    expect(region?.value).toBe("us-east-1");
  });

  it("reports failure for a missing remote", async () => {
    const ctx = await createTestContext();
    const cookie = await loginAdmin(ctx);
    await ctx.app.inject({
      method: "PUT",
      url: "/api/git",
      headers: { cookie },
      payload: { repoUrl: path.join(ctx.tempDir, "does-not-exist.git"), defaultBranch: "main" }
    });
    const push = await ctx.app.inject({
      method: "POST",
      url: "/api/git/push",
      headers: { cookie },
      payload: { branch: "main" }
    });
    expect(push.statusCode).toBe(400);
    const body = push.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("denies non-admin git access", async () => {
    const ctx = await createTestContext();
    const { cookie } = await loginUser(ctx, {
      email: "builder@example.com",
      password: "builder-password",
      role: "builder"
    });
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/git",
      headers: { cookie }
    });
    expect(resp.statusCode).toBe(403);
  });
});
