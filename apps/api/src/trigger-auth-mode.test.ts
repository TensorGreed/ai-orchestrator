/**
 * Fail closed: a live trigger whose Auth Mode is set to a value it does not know (a typo, a padded value, a hand-edited
 * import) refuses every call instead of reading it as public. Unset keeps the trigger's default.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { UNKNOWN_AUTH_MODE_CODE, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

const opened: Array<{ app: FastifyInstance; store: Store; tempDir: string }> = [];

async function context() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-auth-mode-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS));
  await app.ready();
  opened.push({ app, store, tempDir });
  return { app, store };
}

afterEach(async () => {
  while (opened.length > 0) {
    const entry = opened.pop()!;
    await entry.app.close();
    try {
      await entry.store.close();
    } catch {
      // Already closed.
    }
    fs.rmSync(entry.tempDir, { recursive: true, force: true });
  }
});

function flow(id: string, trigger: { type: string; config: Record<string, unknown> }): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "start", type: trigger.type, name: "Start", position: { x: 0, y: 0 }, config: trigger.config },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "ran" } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  } as Workflow;
}

describe("a trigger with an Auth Mode it does not know refuses every call", () => {
  it("webhook, form, chat and MCP tool answer 500 unknown_auth_mode and start no run; known modes still work", async () => {
    const { app, store } = await context();
    await store.upsertWorkflow(flow("wf-hook", { type: "webhook_input", config: { path: "typo-hook", method: "POST", authMode: " bearer_token" } }));
    await store.upsertWorkflow(flow("wf-form", { type: "form_trigger", config: { path: "typo-form", title: "F", fields: [{ name: "a", label: "A", type: "text" }], authMode: "sesion" } }));
    await store.upsertWorkflow(flow("wf-chat", { type: "chat_trigger", config: { authMode: "Bearer" } }));
    await store.upsertWorkflow(flow("wf-tool", { type: "mcp_server_trigger", config: { path: "typo-tool", toolName: "typo_tool", authMode: "token" } }));
    const calls = [
      await app.inject({ method: "POST", url: "/webhook/typo-hook", payload: {} }),
      await app.inject({ method: "POST", url: "/api/forms/typo-form", headers: { accept: "application/json" }, payload: { a: "x" } }),
      await app.inject({ method: "POST", url: "/api/chat/wf-chat", payload: { message: "hi" } }),
      await app.inject({ method: "POST", url: "/api/mcp-server/typo-tool/invoke", payload: { arguments: {} } })
    ];
    for (const response of calls) {
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toMatchObject({ code: UNKNOWN_AUTH_MODE_CODE, error: expect.stringMatching(/is not one this trigger knows/) });
    }
    const page = await app.inject({ method: "GET", url: "/api/forms/typo-form" });
    expect(page.statusCode).toBe(500);
    expect((await store.listExecutionHistory({ page: 1, pageSize: 10 })).total).toBe(0);

    // Unset is the default (public), as before.
    await store.upsertWorkflow(flow("wf-open", { type: "webhook_input", config: { path: "open-hook", method: "POST" } }));
    expect((await app.inject({ method: "POST", url: "/webhook/open-hook", payload: {} })).statusCode).toBe(200);
  });
});
