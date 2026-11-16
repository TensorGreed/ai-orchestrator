/**
 * Signed webhook deliveries are checked against the bytes that arrived, not a re-serialisation of the parsed body:
 * every body below has whitespace and key order that JSON.stringify would not reproduce. Slack is acknowledged at once
 * and its run goes on in the background; a redelivered Slack event_id or GitHub delivery id starts no second run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-webhook-signatures-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, secretService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    await context.store.close();
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

function triggerWorkflow(id: string, triggerType: string, triggerConfig: Record<string, unknown>): Workflow {
  return {
    id,
    name: `Signed ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "trigger", type: triggerType, name: "Trigger", position: { x: 0, y: 0 }, config: triggerConfig },
      { id: "out", type: "output", name: "Output", position: { x: 200, y: 0 }, config: { outputKey: "result" } }
    ],
    edges: [{ id: "e1", source: "trigger", target: "out" }]
  } as Workflow;
}

async function saveWorkflow(context: TestContext, workflow: Workflow): Promise<void> {
  await context.store.upsertWorkflow(workflow);
}

async function runsOf(context: TestContext, workflowId: string): Promise<number> {
  return (await context.store.listExecutionHistory({ workflowId, pageSize: 100 })).total;
}

async function waitForRuns(context: TestContext, workflowId: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const finished = (await context.store.listExecutionHistory({ workflowId, pageSize: 100 })).items.filter(
      (item) => item.status !== "running" && item.status !== "queued"
    );
    if (finished.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} finished run(s) of ${workflowId}`);
}

// Two spaces, a newline and keys out of alphabetical order: JSON.stringify(JSON.parse(body)) differs from body.
const PRETTY_BODY = '{\n  "zeta": 1,\n  "alpha" : "two words",\n  "nested": {"b": true, "a": [1, 2]}\n}';

describe("signed webhooks hash the body as it arrived", () => {
  it("re-serialising the test body would not reproduce it", () => {
    expect(JSON.stringify(JSON.parse(PRETTY_BODY))).not.toBe(PRETTY_BODY);
  });

  it("GitHub: a real X-Hub-Signature-256 over a pretty-printed body is accepted; a tampered body is not", async () => {
    const context = await createTestContext();
    const secretValue = "gh-webhook-secret";
    const secretRef = await context.secretService.createSecret({ name: "gh", provider: "github", value: secretValue });
    await saveWorkflow(context, triggerWorkflow("wf-gh", "github_webhook_trigger", { secretRef }));
    const signature = `sha256=${crypto.createHmac("sha256", secretValue).update(PRETTY_BODY).digest("hex")}`;

    const good = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/github/wf-gh",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-delivery": "d-1" },
      payload: PRETTY_BODY
    });
    expect(good.statusCode, good.body).toBe(200);
    expect(good.json()).toMatchObject({ ok: true, status: "success" });

    const tampered = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/github/wf-gh",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-delivery": "d-2" },
      payload: PRETTY_BODY.replace("two words", "three words")
    });
    expect(tampered.statusCode).toBe(401);
  });

  it("GitHub: the same X-GitHub-Delivery within the window starts no second run", async () => {
    const context = await createTestContext();
    const secretValue = "gh-webhook-secret";
    const secretRef = await context.secretService.createSecret({ name: "gh", provider: "github", value: secretValue });
    await saveWorkflow(context, triggerWorkflow("wf-gh-dup", "github_webhook_trigger", { secretRef }));
    const signature = `sha256=${crypto.createHmac("sha256", secretValue).update(PRETTY_BODY).digest("hex")}`;
    const send = async (delivery: string) =>
      await context.app.inject({
        method: "POST",
        url: "/api/webhooks/github/wf-gh-dup",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-delivery": delivery },
        payload: PRETTY_BODY
      });

    expect((await send("delivery-1")).json()).toMatchObject({ ok: true, status: "success" });
    const again = await send("delivery-1");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    expect((await send("delivery-2")).json()).toMatchObject({ ok: true, status: "success" });
    expect(await runsOf(context, "wf-gh-dup")).toBe(2);
  });

  it("GitHub: a redelivery after a failed run runs again", async () => {
    const context = await createTestContext();
    const secretValue = "gh-webhook-secret";
    const secretRef = await context.secretService.createSecret({ name: "gh", provider: "github", value: secretValue });
    const workflow = triggerWorkflow("wf-gh-fail", "github_webhook_trigger", { secretRef });
    workflow.nodes.push({ id: "boom", type: "code_node", name: "Boom", position: { x: 100, y: 0 }, config: { timeout: 1500, code: "throw new Error('boom');" } } as Workflow["nodes"][number]);
    workflow.edges = [
      { id: "e1", source: "trigger", target: "boom" },
      { id: "e2", source: "boom", target: "out" }
    ];
    await saveWorkflow(context, workflow);
    const signature = `sha256=${crypto.createHmac("sha256", secretValue).update(PRETTY_BODY).digest("hex")}`;
    const send = async () =>
      await context.app.inject({
        method: "POST",
        url: "/api/webhooks/github/wf-gh-fail",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-delivery": "delivery-f" },
        payload: PRETTY_BODY
      });
    expect((await send()).json()).toMatchObject({ ok: true, status: "error" });
    expect((await send()).json()).toMatchObject({ ok: true, status: "error" });
    expect(await runsOf(context, "wf-gh-fail")).toBe(2);
  });

  it("Slack: a real v0 signature over a pretty-printed body is accepted, answered at once and run in the background", async () => {
    const context = await createTestContext();
    const secretValue = "slack-signing-secret";
    const signingSecretRef = await context.secretService.createSecret({ name: "slack", provider: "slack", value: secretValue });
    await saveWorkflow(context, triggerWorkflow("wf-slack", "slack_trigger", { signingSecretRef }));
    const body = '{ "type": "event_callback",  "event_id": "Ev1", "event": {"type": "app_mention", "text": "hi"} }';
    const sign = (timestamp: string, raw: string) =>
      `v0=${crypto.createHmac("sha256", secretValue).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
    const ts = `${Math.floor(Date.now() / 1000)}`;

    const good = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/slack/wf-slack",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sign(ts, body) },
      payload: body
    });
    expect(good.statusCode, good.body).toBe(200);
    expect(good.json()).toMatchObject({ ok: true, accepted: true });
    await waitForRuns(context, "wf-slack", 1);

    const tampered = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/slack/wf-slack",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sign(ts, body) },
      payload: body.replace("hi", "bye")
    });
    expect(tampered.statusCode).toBe(401);
  });

  it("Slack: a URL verification challenge over a pretty-printed body is answered", async () => {
    const context = await createTestContext();
    const secretValue = "slack-signing-secret";
    const signingSecretRef = await context.secretService.createSecret({ name: "slack", provider: "slack", value: secretValue });
    await saveWorkflow(context, triggerWorkflow("wf-slack-challenge", "slack_trigger", { signingSecretRef }));
    const body = '{"token": "x", "challenge": "abc123",  "type": "url_verification"}';
    const ts = `${Math.floor(Date.now() / 1000)}`;
    const signature = `v0=${crypto.createHmac("sha256", secretValue).update(`v0:${ts}:${body}`).digest("hex")}`;
    const response = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/slack/wf-slack-challenge",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": signature },
      payload: body
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toBe("abc123");
  });

  it("Slack: a retried event (same event_id, X-Slack-Retry-Num) starts no second run", async () => {
    const context = await createTestContext();
    const secretValue = "slack-signing-secret";
    const signingSecretRef = await context.secretService.createSecret({ name: "slack", provider: "slack", value: secretValue });
    await saveWorkflow(context, triggerWorkflow("wf-slack-retry", "slack_trigger", { signingSecretRef }));
    const send = async (eventId: string, retry?: string) => {
      const body = JSON.stringify({ type: "event_callback", event_id: eventId, event: { type: "message", text: "hi" } });
      const ts = `${Math.floor(Date.now() / 1000)}`;
      const signature = `v0=${crypto.createHmac("sha256", secretValue).update(`v0:${ts}:${body}`).digest("hex")}`;
      return await context.app.inject({
        method: "POST",
        url: "/api/webhooks/slack/wf-slack-retry",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": signature,
          ...(retry ? { "x-slack-retry-num": retry, "x-slack-retry-reason": "http_timeout" } : {})
        },
        payload: body
      });
    };

    expect((await send("EvA")).json()).toMatchObject({ ok: true, accepted: true });
    const retried = await send("EvA", "1");
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ok: true, duplicate: true });
    expect((await send("EvB")).json()).toMatchObject({ ok: true, accepted: true });
    await waitForRuns(context, "wf-slack-retry", 2);
    expect(await runsOf(context, "wf-slack-retry")).toBe(2);
  });

  it("Stripe: a signature over a pretty-printed body is accepted; a re-serialised body is refused", async () => {
    const context = await createTestContext();
    const secretValue = "whsec_signing";
    const signingSecretRef = await context.secretService.createSecret({ name: "stripe", provider: "stripe", value: secretValue });
    await saveWorkflow(context, triggerWorkflow("wf-stripe-raw", "stripe_webhook_trigger", { signingSecretRef }));
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac("sha256", secretValue).update(`${t}.${PRETTY_BODY}`).digest("hex");

    const good = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/stripe/wf-stripe-raw",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
      payload: PRETTY_BODY
    });
    expect(good.statusCode, good.body).toBe(200);

    // The same JSON value sent compactly: the signature was over other bytes.
    const compact = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/stripe/wf-stripe-raw",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
      payload: JSON.stringify(JSON.parse(PRETTY_BODY))
    });
    expect(compact.statusCode).toBe(401);
  });

  it("generic webhook HMAC mode: a signature over a pretty-printed body is accepted; a re-serialised body is refused", async () => {
    const context = await createTestContext();
    const hmacSecret = "generic-hmac-key";
    const secretRef = await context.secretService.createSecret({ name: "hmac", provider: "webhook", value: hmacSecret });
    const workflow: Workflow = {
      id: "wf-generic-raw",
      name: "Generic HMAC",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        {
          id: "webhook-node",
          type: "webhook_input",
          name: "Webhook",
          position: { x: 0, y: 0 },
          config: {
            path: "generic-raw",
            method: "POST",
            authMode: "hmac_sha256",
            signatureHeaderName: "x-webhook-signature",
            timestampHeaderName: "x-webhook-timestamp",
            replayToleranceSeconds: 300,
            secretRef,
            passThroughFields: ["user_prompt"]
          }
        },
        { id: "out", type: "output", name: "Output", position: { x: 200, y: 0 }, config: { outputKey: "result", responseTemplate: "{{user_prompt}}" } }
      ],
      edges: [{ id: "e1", source: "webhook-node", target: "out" }]
    } as Workflow;
    await saveWorkflow(context, workflow);
    const body = '{\n  "user_prompt" :  "hello raw"\n}';
    const ts = `${Math.floor(Date.now() / 1000)}`;
    const signature = crypto.createHmac("sha256", hmacSecret).update(`${ts}.${body}`).digest("hex");

    const good = await context.app.inject({
      method: "POST",
      url: "/webhook/generic-raw",
      headers: { "content-type": "application/json", "x-webhook-timestamp": ts, "x-webhook-signature": signature },
      payload: body
    });
    expect(good.statusCode, good.body).toBe(200);

    const ts2 = `${Number(ts) + 1}`;
    const signature2 = crypto.createHmac("sha256", hmacSecret).update(`${ts2}.${body}`).digest("hex");
    const compact = await context.app.inject({
      method: "POST",
      url: "/webhook/generic-raw",
      headers: { "content-type": "application/json", "x-webhook-timestamp": ts2, "x-webhook-signature": signature2 },
      payload: JSON.stringify(JSON.parse(body))
    });
    expect(compact.statusCode).toBe(403);
  });
});
