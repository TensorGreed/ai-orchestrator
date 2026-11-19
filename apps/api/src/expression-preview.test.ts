/**
 * The editor's preview of a template field renders it as a run does: path bodies by path (node ids with a dash and
 * number segments work), `results` and `$node()` from the node outputs the editor sends, expressions in the sandbox.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-expr-preview-"));
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: masterKey,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(dir, "sync")
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, masterKey), authService);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    try {
      await store.close();
    } catch {
      // Already closed by the app.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await authService.register({ email: "builder@example.com", password: "Builder-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "builder@example.com", password: "Builder-Pass-123!" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const preview = async (expression: string, mode: "template" | "expression" | "condition", context: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url: "/api/expressions/preview", headers: { cookie }, payload: { expression, mode, context } });
    expect(response.statusCode).toBe(200);
    return response.json() as { ok: boolean; result?: unknown; error?: string; missing?: unknown };
  };
  return { preview };
}

const CONTEXT = {
  input: { note: "between", results: "a parent's field", user_prompt: "hi" },
  vars: { region: "eu" },
  workflow: { id: "wf-1", name: "Flow" },
  executionId: "ex-1",
  nodeOutputs: { "http_request-abc12": { id: "42", items: [{ title: "first" }] } }
};

describe("expression preview", () => {
  it("renders a template as a run does: dashed node ids, number segments, results and $node()", async () => {
    const { preview } = await boot();
    const template =
      "{{results.http_request-abc12.id}}|{{results.http_request-abc12.items.0.title}}|{{ $node('http_request-abc12').output.id }}|" +
      "{{ results['http_request-abc12'].items.length }}|{{note}}|{{user_prompt}}|{{vars.region}}|{{workflow.name}}|{{execution.id}}|{{missing.path}}";
    expect(await preview(template, "template", CONTEXT)).toEqual({
      ok: true,
      result: "42|first|42|1|between|hi|eu|Flow|ex-1|",
      missing: [{ body: "missing.path", reason: "missing" }]
    });
  });

  it("lists each {{ }} of a template that rendered nothing, and nothing when every value is there", async () => {
    const { preview } = await boot();
    expect(await preview("{{note}} {{vars.region}}", "template", CONTEXT)).toEqual({ ok: true, result: "between eu", missing: [] });
    expect(await preview("{{results.http_request-abc12.nope}}{{ $json.a.b }}", "template", CONTEXT)).toEqual({
      ok: true,
      result: "",
      missing: [
        { body: "results.http_request-abc12.nope", reason: "missing" },
        { body: "$json.a.b", reason: "expression_failed" }
      ]
    });
  });

  it("keeps expression mode as it was: the body is JavaScript", async () => {
    const { preview } = await boot();
    expect(await preview("$vars.region + '-' + $node('http_request-abc12').output.id", "expression", CONTEXT)).toEqual({ ok: true, result: "eu-42" });
    expect(await preview("{{ note.toUpperCase() }}", "expression", CONTEXT)).toEqual({ ok: true, result: "BETWEEN" });
  });

  it("condition mode judges the text as an IF node does", async () => {
    const { preview } = await boot();
    const context = { ...CONTEXT, input: { ...CONTEXT.input, userScore: 95, answer: "no" } };
    expect(await preview("{{userScore}} > 90", "condition", context)).toEqual({ ok: true, result: true, missing: [] });
    expect(await preview("{{answer}} === 'true'", "condition", context)).toEqual({ ok: true, result: false, missing: [] });
    expect(await preview("{{results.http_request-abc12.id}} === '42'", "condition", context)).toEqual({ ok: true, result: true, missing: [] });
    expect(await preview("{{note}}", "condition", context)).toEqual({ ok: true, result: true, missing: [] });
    expect(await preview("{{score}} > 90 && {{ $json.user.name }}", "condition", context)).toEqual({
      ok: true,
      result: false,
      missing: [
        { body: "score", reason: "missing" },
        { body: "$json.user.name", reason: "expression_failed" }
      ]
    });
    const bad = await preview("{{answer}} == done", "condition", context);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/IF condition/);
  });
});
