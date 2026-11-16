/**
 * 12.7 — content rule events reach log stream destinations that opted in (`rule_events`), with masked evidence only;
 * existing destinations (no categories) keep receiving audit events only; a destination that is down does not affect
 * runs; a run started from a sensitive run's content sends evidence digests only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
const EMAIL = "maria.gonzalez@example.org";

interface Received {
  path: string;
  body: { category: string; eventType: string; level: string; metadata: Record<string, any> | null };
  raw: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function receiver(options: { hang?: boolean } = {}) {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      received.push({ path: request.url ?? "", body: JSON.parse(raw), raw });
      if (options.hang) return;
      response.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(close);
  return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-rule-events-"));
  const store: Store = await openTestStore(path.join(dir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config: AppConfig = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    LOG_STREAM_FLUSH_INTERVAL_MS: "50",
    LOG_STREAM_RETRY_MAX_ATTEMPTS: "1",
    GIT_SYNC_WORKDIR: path.join(dir, "sync")
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app: FastifyInstance = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
  await app.ready();
  cleanups.unshift(async () => {
    await app.close();
    try {
      await store.close();
    } catch {
      // Already closed by the app.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = async (role: "admin" | "builder") => {
    await authService.register({ email: `${role}@example.com`, password: `${role}-Pass-123!`, role });
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${role}@example.com`, password: `${role}-Pass-123!` } });
    const raw = response.headers["set-cookie"];
    const values = Array.isArray(raw) ? raw : [raw ?? ""];
    return values.find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
  };
  return { app, store, login };
}

function guardWorkflow(id: string): Workflow {
  return {
    id,
    name: `Guarded ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "guard", type: "guard", name: "Prompt check", position: { x: 200, y: 0 }, config: {} },
      { id: "pass", type: "output", name: "Pass", position: { x: 400, y: 0 }, config: { responseTemplate: "{{results.guard.user_prompt}}" } },
      { id: "blocked", type: "output", name: "Blocked", position: { x: 400, y: 200 }, config: { responseTemplate: "blocked" } }
    ],
    edges: [
      { id: "e1", source: "hook", target: "guard" },
      { id: "e2", source: "guard", sourceHandle: "pass", target: "pass" },
      { id: "e3", source: "guard", sourceHandle: "blocked", target: "blocked" }
    ]
  } as Workflow;
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const ruleEvents = (received: Received[]) => received.filter((entry) => entry.body.category === "rule_events");

describe("content rule events on log streams", () => {
  it("reach opted-in destinations with masked evidence only; destinations without the category get none", async () => {
    const sink = await receiver();
    const { app, store, login } = await boot();
    const admin = await login("admin");
    const builder = await login("builder");
    const create = async (name: string, categories: string[]) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/log-streams",
        headers: { cookie: admin },
        payload: { name, type: "webhook", categories, config: { url: `${sink.url}/${name}` } }
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ destination: { id: string; categories: string[] } }>().destination;
    };
    await create("existing", []);
    await create("rules", ["rule_events"]);
    const both = await create("both", ["*", "rule_events"]);
    expect(both.categories).toEqual(["*", "rule_events"]);

    await store.upsertWorkflow(guardWorkflow("wf-siem"));
    const run = (
      await app.inject({ method: "POST", url: "/api/workflows/wf-siem/execute", headers: { cookie: builder }, payload: { user_prompt: `Use ${SECRET} to reach ${EMAIL}` } })
    ).json<{ status: string; executionId: string }>();
    expect(run.status).toBe("success");
    // An audit event after every destination exists.
    await app.inject({ method: "PUT", url: `/api/log-streams/${both.id}`, headers: { cookie: admin }, payload: { name: "both" } });

    const at = (name: string) => sink.received.filter((entry) => entry.path === `/${name}`);
    await until(() => ruleEvents(at("rules")).length > 0 && ruleEvents(at("both")).length > 0 && at("existing").some((entry) => entry.body.eventType === "log_stream.destination.update"));

    expect(ruleEvents(at("existing"))).toEqual([]);
    expect(at("rules").every((entry) => entry.body.category === "rule_events")).toBe(true);
    expect(at("both").some((entry) => entry.body.eventType === "log_stream.destination.update")).toBe(true);

    const credential = ruleEvents(at("rules")).find((entry) => entry.body.metadata?.detector?.dataClass === "credential")!;
    expect(credential.body).toMatchObject({
      eventType: "content_rules.event",
      level: "info",
      metadata: {
        schema: "l2m.rule_event",
        schemaVersion: 1,
        source: "workflow",
        executionId: run.executionId,
        workflowId: "wf-siem",
        projectId: "default",
        nodeId: "guard",
        channel: "prompt",
        ruleSet: { id: "default", version: 1 },
        action: { requested: "redact", effective: "redact" },
        evidenceWithheld: false
      }
    });
    expect(credential.body.metadata!.evidence[0].masked).toBeTruthy();
    for (const entry of sink.received) {
      expect(entry.raw).not.toContain(SECRET);
      expect(entry.raw).not.toContain(EMAIL);
    }
  });

  it("a destination that is down or never answers does not affect runs", async () => {
    const stuck = await receiver({ hang: true });
    const { app, store, login } = await boot();
    const admin = await login("admin");
    const builder = await login("builder");
    for (const [name, url] of [
      ["stuck", stuck.url],
      ["refused", "http://127.0.0.1:9"]
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/log-streams", headers: { cookie: admin }, payload: { name, type: "webhook", categories: ["rule_events"], config: { url } } });
      expect(response.statusCode, response.body).toBe(200);
    }
    await store.upsertWorkflow(guardWorkflow("wf-down"));
    const started = Date.now();
    for (let index = 0; index < 3; index += 1) {
      const run = (
        await app.inject({ method: "POST", url: "/api/workflows/wf-down/execute", headers: { cookie: builder }, payload: { user_prompt: `Write to ${EMAIL}` } })
      ).json<{ status: string }>();
      expect(run.status).toBe("success");
    }
    expect(Date.now() - started).toBeLessThan(5000);
    await until(() => stuck.received.length > 0);
    expect((await store.listGuardEvents({ workflowId: "wf-down" })).total).toBeGreaterThanOrEqual(3);
    // The stuck destination is released (its connection dropped) so the drain finishes before shutdown.
    await stuck.close();
  });

  it("a run started from a sensitive run's content sends evidence digests only", async () => {
    const sink = await receiver();
    const { app, store, login } = await boot();
    const admin = await login("admin");
    const builder = await login("builder");
    const created = await app.inject({ method: "POST", url: "/api/log-streams", headers: { cookie: admin }, payload: { name: "rules", type: "webhook", categories: ["rule_events"], config: { url: sink.url } } });
    expect(created.statusCode, created.body).toBe(200);
    await store.upsertWorkflow(guardWorkflow("wf-marked"));
    const finished = { workflowId: "wf-marked", status: "success", startedAt: "2026-11-13T00:00:00.000Z", completedAt: "2026-11-13T00:00:01.000Z", inputJson: { input: {} }, nodeResultsJson: [] };
    await store.saveExecutionHistory({ id: "run-marked", ...finished, sensitive: true });

    const run = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-marked/execute",
      headers: { cookie: builder },
      payload: { user_prompt: `Use ${SECRET} to reach ${EMAIL}`, sourceExecutionId: "run-marked" }
    });
    expect(run.statusCode, run.body).toBe(200);
    await until(() => ruleEvents(sink.received).length > 0);
    expect(ruleEvents(sink.received).some((entry) => entry.body.metadata!.evidence.length > 0)).toBe(true);
    for (const entry of ruleEvents(sink.received)) {
      expect(entry.body.metadata!.evidenceWithheld).toBe(true);
      for (const piece of entry.body.metadata!.evidence) {
        expect(piece.masked).toBeUndefined();
        expect(piece.digest).toMatch(/^sha256:/);
      }
    }
    // The stored rows keep their masked evidence for the Security page, as before.
    const stored = await store.listGuardEvents({ workflowId: "wf-marked" });
    expect(stored.events.some((event) => event.evidence.some((piece) => piece.evidence))).toBe(true);
    for (const entry of sink.received) {
      expect(entry.raw).not.toContain(SECRET);
      expect(entry.raw).not.toContain(EMAIL);
    }
  });

  it("the resumed part of a run started from a sensitive run's content still sends digests only", async () => {
    const sink = await receiver();
    const { app, store, login } = await boot();
    const admin = await login("admin");
    const builder = await login("builder");
    const created = await app.inject({ method: "POST", url: "/api/log-streams", headers: { cookie: admin }, payload: { name: "rules", type: "webhook", categories: ["rule_events"], config: { url: sink.url } } });
    expect(created.statusCode, created.body).toBe(200);
    const document = {
      id: "approve-email",
      name: "Approve email",
      version: "1",
      channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "require_approval" } }, defaultAction: { action: "allow" } } }
    };
    expect((await app.inject({ method: "POST", url: "/api/guard/profiles", headers: { cookie: builder }, payload: { document } })).statusCode).toBe(201);
    const workflow = guardWorkflow("wf-resume");
    workflow.nodes[1]!.config = { profileId: "approve-email" };
    workflow.nodes.push({ id: "after", type: "guard", name: "After approval", position: { x: 600, y: 0 }, config: { profileId: "default" } } as Workflow["nodes"][number]);
    workflow.edges.push({ id: "e4", source: "pass", target: "after" } as Workflow["edges"][number]);
    await store.upsertWorkflow(workflow);
    const finished = { workflowId: "wf-resume", status: "success", startedAt: "2026-11-13T00:00:00.000Z", completedAt: "2026-11-13T00:00:01.000Z", inputJson: { input: {} }, nodeResultsJson: [] };
    await store.saveExecutionHistory({ id: "run-marked", ...finished, sensitive: true });

    const run = (
      await app.inject({
        method: "POST",
        url: "/api/workflows/wf-resume/execute",
        headers: { cookie: builder },
        payload: { user_prompt: `Write to ${EMAIL}`, sourceExecutionId: "run-marked" }
      })
    ).json<{ status: string; executionId: string }>();
    expect(run.status).toBe("waiting_approval");
    const approved = (await app.inject({ method: "POST", url: `/api/approvals/${run.executionId}/approve`, headers: { cookie: admin }, payload: {} })).json<{ status: string }>();
    expect(approved.status).toBe("success");
    await until(() => ruleEvents(sink.received).some((entry) => entry.body.metadata!.nodeId === "after"));
    for (const entry of ruleEvents(sink.received)) {
      expect(entry.body.metadata!.evidenceWithheld).toBe(true);
      expect(entry.raw).not.toContain(EMAIL);
    }
  });
});
