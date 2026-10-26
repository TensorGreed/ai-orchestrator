/**
 * Records the fixtures the static demo (`vite build --mode demo`) serves.
 *
 * Boots the real API in-process against a temporary SQLite database, seeds a
 * curated set of the sample workflows plus a few demo workflows, and runs them
 * with no network and no keys: the built-in echo provider and a scripted
 * OpenAI-style model on 127.0.0.1 stand in for a model, the in-process mock MCP
 * adapter for tools. The API answers and run event streams are scrubbed
 * (loopback hosts, temp paths, anything shaped like a credential) and written
 * to `apps/web/src/demo/fixtures/`.
 *
 * Re-record from the repo root:
 *   pnpm --filter @ai-orchestrator/web demo:record
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../api/src/app.js";
import { parseConfig } from "../../api/src/config.js";
import { SqliteStore } from "../../api/src/db/database.js";
import { AuthService } from "../../api/src/services/auth-service.js";
import { SecretService } from "../../api/src/services/secret-service.js";
import { seedTemplatesIfEmpty } from "../../api/src/services/seed-service.js";
import { WorkflowVersionService } from "../../api/src/services/workflow-version-service.js";
import { findLeaks, literalPattern } from "../src/demo/leak-patterns.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const outDir = path.resolve(here, "..", "src", "demo", "fixtures");

/** The sample workflows the demo ships; the rest need cloud accounts or name other products. */
const SAMPLE_FILES = [
  "basic-flow.json",
  "mcp-agent-quickstart-flow.json",
  "agentic-mcp-flow.json",
  "supervisor-worker-swarm-flow.json",
  "conditional-flow.json",
  "structured-output-flow.json",
  "rag-knowledge-base-flow.json",
  "rag-with-citations-flow.json",
  "workflow-as-mcp-tool-flow.json"
];

export const DEMO_USER = { email: "demo@example.com", password: "Demo-Only-Pass-123!", role: "admin" as const };
const REQUESTER = { email: "alex.requester@example.com", password: "Demo-Only-Pass-456!" };
/** What the studio's editor and chat send as `system_prompt` when no System Prompt node sets one (apps/web/src/App.tsx). */
const STUDIO_DEFAULT_SYSTEM_PROMPT = "You are a precise tool-using AI assistant.";
const MODEL_HOST_PLACEHOLDER = "https://models.example.com/v1";

type Json = Record<string, unknown>;
type ScriptedCall = { name: string; args: Record<string, unknown> };
type AgentScript = { match: string; calls: ScriptedCall[]; answer: string; usage: [number, number] };

/**
 * A stateless OpenAI-style model: it picks the script whose `match` appears in
 * the system prompt, makes the next scripted tool call while fewer tool results
 * than calls are in the conversation, then answers.
 */
async function startScriptedModel(scripts: AgentScript[]) {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };
      const messages = body.messages ?? [];
      const system = messages.filter((message) => message.role === "system").map((message) => String(message.content ?? "")).join("\n");
      const script = scripts.find((entry) => system.includes(entry.match)) ?? scripts[scripts.length - 1]!;
      const done = messages.filter((message) => message.role === "tool").length;
      const toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
      const next = script.calls[done];
      const resolved = next ? toolNames.find((name) => name === next.name || name.endsWith(`__${next.name}`) || name.includes(next.name)) : undefined;
      const message = resolved
        ? { role: "assistant", content: "", tool_calls: [{ id: `call_${done + 1}`, type: "function", function: { name: resolved, arguments: JSON.stringify(next!.args) } }] }
        : { role: "assistant", content: script.answer };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message, finish_reason: resolved ? "tool_calls" : "stop" }], usage: { prompt_tokens: script.usage[0] + done * 90, completion_tokens: resolved ? 24 : script.usage[1] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind the scripted model");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const SCRIPTS: AgentScript[] = [
  {
    match: "[support-agent]",
    calls: [
      { name: "lookup_kb", args: { topic: "plans" } },
      { name: "calculator", args: { expression: "49*12*12" } }
    ],
    answer:
      "The Team plan is $12 per seat per month, billed yearly, and includes MCP tool access. For 49 seats that is $7,056 a year. I've kept the seat count in this session for follow-up questions.",
    usage: [620, 64]
  },
  {
    match: "[supervisor]",
    calls: [
      { name: "researcher", args: { task_prompt: "Look up what RAG is in the knowledge base." } },
      { name: "analyst", args: { task_prompt: "Compute 1250 * 0.18 for the daily uncached retrievals." } }
    ],
    answer:
      "Summary for the team: RAG grounds model prompts with retrieved context, so answers can cite internal documents. At 1,250 queries a day with an 18% cache miss rate, plan for about 225 uncached retrievals a day.",
    usage: [880, 72]
  },
  {
    match: "[researcher]",
    calls: [{ name: "lookup_kb", args: { topic: "rag" } }],
    answer: "RAG combines retrieval and generation by grounding prompts with external context.",
    usage: [410, 28]
  },
  {
    match: "[analyst]",
    calls: [{ name: "calculator", args: { expression: "1250*0.18" } }],
    answer: "1250 × 0.18 = 225.",
    usage: [380, 16]
  },
  {
    match: "[faq]",
    calls: [],
    answer: "You can reset your password from Settings → Security. Links expire after 30 minutes.",
    usage: [240, 26]
  }
];

/** Knowledge-base entries the demo's mock MCP lookups answer with. */
const DEMO_KB = {
  plans: "Team plan: $12 per seat per month, billed yearly. Includes MCP tool access and session memory.",
  rag: "Retrieval-augmented generation grounds a prompt with passages retrieved from your own documents, so answers can cite them."
};

function modelProvider(baseUrl: string) {
  return { providerId: "openai_compatible", model: "demo-model", baseUrl, temperature: 0.2, extra: { maxRetries: 0 } };
}

function node(id: string, type: string, name: string, x: number, y: number, config: Json = {}) {
  return { id, type, name, position: { x, y }, config };
}

function supportAgentWorkflow(baseUrl: string): Json {
  return {
    id: "wf-demo-support-agent",
    name: "Support agent with MCP tools and memory",
    description: "An agent that answers customer questions with MCP tools (knowledge base lookup, calculator) and remembers the conversation.",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("trigger", "manual_trigger", "Ask a question", 0, 120, { label: "Ask a question" }),
      node("agent", "agent_orchestrator", "Support agent", 280, 120, {
        systemPromptTemplate: "[support-agent] You answer customer questions. Use lookup_kb for product facts and calculator for prices. Keep answers short.",
        userPromptTemplate: "{{user_prompt}}",
        sessionIdTemplate: "demo-support",
        maxIterations: 4,
        toolCallingEnabled: true
      }),
      node("model", "llm_call", "Chat model", 140, 340, { provider: modelProvider(baseUrl), promptKey: "prompt", systemPromptKey: "system_prompt" }),
      node("memory", "local_memory", "Session memory", 300, 340, { namespace: "demo", sessionIdTemplate: "demo-support", maxMessages: 20, persistToolMessages: false }),
      node("kb", "mcp_tool", "Knowledge base", 460, 340, { serverId: "mock-mcp", toolName: "lookup_kb", argsTemplate: "{\"topic\":\"plans\"}", connection: { transport: "mock", kbOverrides: DEMO_KB } }),
      node("calc", "mcp_tool", "Calculator", 620, 340, { serverId: "mock-mcp", toolName: "calculator", argsTemplate: "{\"expression\":\"1+1\"}", connection: { transport: "mock" } }),
      node("output", "output", "Answer", 600, 120, { responseTemplate: "{{answer}}", outputKey: "result" })
    ],
    edges: [
      { id: "e1", source: "trigger", target: "agent" },
      { id: "e2", source: "agent", target: "output" },
      { id: "a1", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "a2", source: "agent", sourceHandle: "memory", target: "memory" },
      { id: "a3", source: "agent", sourceHandle: "tool", target: "kb" },
      { id: "a4", source: "agent", sourceHandle: "tool", target: "calc" }
    ]
  };
}

function swarmWorkflow(baseUrl: string): Json {
  return {
    id: "wf-demo-research-swarm",
    name: "Research supervisor with two workers",
    description: "A supervisor delegates to a researcher (knowledge base tool) and an analyst (calculator tool), then writes the summary.",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("trigger", "manual_trigger", "Start", 0, 140, { label: "Brief the team" }),
      node("supervisor", "supervisor_node", "Supervisor", 260, 140, {
        systemPromptTemplate: "[supervisor] Split the request, delegate to the researcher and the analyst, then summarise for the team.",
        userPromptTemplate: "{{user_prompt}}",
        sessionIdTemplate: "demo-swarm",
        maxIterations: 6
      }),
      node("supervisor_model", "llm_call", "Supervisor model", 120, 360, { provider: modelProvider(baseUrl), promptKey: "prompt", systemPromptKey: "system_prompt" }),
      node("researcher", "agent_orchestrator", "researcher", 340, 360, {
        systemPromptTemplate: "[researcher] Answer factual questions with the lookup_kb tool.",
        userPromptTemplate: "{{user_prompt}}",
        maxIterations: 3,
        toolCallingEnabled: true
      }),
      node("researcher_model", "llm_call", "Researcher model", 260, 560, { provider: modelProvider(baseUrl), promptKey: "prompt", systemPromptKey: "system_prompt" }),
      node("researcher_kb", "mcp_tool", "Knowledge base", 420, 560, { serverId: "mock-mcp", toolName: "lookup_kb", argsTemplate: "{\"topic\":\"rag\"}", connection: { transport: "mock", kbOverrides: DEMO_KB } }),
      node("analyst", "agent_orchestrator", "analyst", 620, 360, {
        systemPromptTemplate: "[analyst] Answer arithmetic with the calculator tool.",
        userPromptTemplate: "{{user_prompt}}",
        maxIterations: 3,
        toolCallingEnabled: true
      }),
      node("analyst_model", "llm_call", "Analyst model", 580, 560, { provider: modelProvider(baseUrl), promptKey: "prompt", systemPromptKey: "system_prompt" }),
      node("analyst_calc", "mcp_tool", "Calculator", 740, 560, { serverId: "mock-mcp", toolName: "calculator", argsTemplate: "{\"expression\":\"1+1\"}", connection: { transport: "mock" } }),
      node("output", "output", "Team summary", 620, 140, { responseTemplate: "{{answer}}", outputKey: "result" })
    ],
    edges: [
      { id: "e1", source: "trigger", target: "supervisor" },
      { id: "e2", source: "supervisor", target: "output" },
      { id: "a1", source: "supervisor", sourceHandle: "chat_model", target: "supervisor_model" },
      { id: "a2", source: "supervisor", sourceHandle: "worker", target: "researcher" },
      { id: "a3", source: "supervisor", sourceHandle: "worker", target: "analyst" },
      { id: "a4", source: "researcher", sourceHandle: "chat_model", target: "researcher_model" },
      { id: "a5", source: "researcher", sourceHandle: "tool", target: "researcher_kb" },
      { id: "a6", source: "analyst", sourceHandle: "chat_model", target: "analyst_model" },
      { id: "a7", source: "analyst", sourceHandle: "tool", target: "analyst_calc" }
    ]
  };
}

const GUARD_PROFILE = {
  id: "demo-strict-intake",
  name: "Strict intake",
  version: "1",
  description: "Blocks email addresses and redacts other sensitive data in prompts.",
  channels: {
    prompt: {
      detectors: [{ id: "dlp.patterns", threshold: 0.5 }],
      actions: { email: { action: "block" }, sensitive_data: { action: "redact" } },
      defaultAction: { action: "allow" }
    }
  }
};

function guardedWorkflow(): Json {
  return {
    id: "wf-demo-guarded-intake",
    name: "Guarded intake",
    description: "A prompt guard in front of the intake step: prompts with an email address are blocked before any model sees them.",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("trigger", "manual_trigger", "New request", 0, 120, { label: "New request" }),
      node("guard", "guard", "Prompt guard", 260, 120, { profileId: GUARD_PROFILE.id }),
      node("pass", "output", "Accepted", 520, 40, { responseTemplate: "Accepted: {{results.guard.user_prompt}}" }),
      node("blocked", "output", "Blocked", 520, 220, { responseTemplate: "Blocked by the prompt guard." })
    ],
    edges: [
      { id: "e1", source: "trigger", target: "guard" },
      { id: "e2", source: "guard", sourceHandle: "pass", target: "pass" },
      { id: "e3", source: "guard", sourceHandle: "blocked", target: "blocked" }
    ]
  };
}

function approvalWorkflow(): Json {
  return {
    id: "wf-demo-refund-approval",
    name: "Refund with human approval",
    description: "Drafts a refund reply and pauses for an approver, who can edit the reply before it is sent.",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("trigger", "manual_trigger", "Refund request", 0, 140, { label: "Refund request" }),
      node("draft", "set_node", "Draft reply", 240, 140, { assignments: [{ key: "reply", valueTemplate: "Hi, we've refunded your order: {{user_prompt}}" }] }),
      node("gate", "approval_gate", "Approve refund", 480, 140, {
        message: "Send this refund reply? {{reply}}",
        approverRoles: ["builder", "admin"],
        timeoutMinutes: 1440,
        timeoutOutcome: "fallback",
        editableFields: [{ key: "reply", label: "Reply", type: "text", valueTemplate: "{{reply}}", required: true, maxLength: 400 }]
      }),
      node("sent", "output", "Sent", 740, 40, { responseTemplate: "sent: {{reply}}" }),
      node("stopped", "output", "Rejected", 740, 140, { responseTemplate: "rejected" }),
      node("late", "output", "Timed out", 740, 240, { responseTemplate: "timed out" })
    ],
    edges: [
      { id: "e1", source: "trigger", target: "draft" },
      { id: "e2", source: "draft", target: "gate" },
      { id: "e3", source: "gate", sourceHandle: "approved", target: "sent" },
      { id: "e4", source: "gate", sourceHandle: "rejected", target: "stopped" },
      { id: "e5", source: "gate", sourceHandle: "timed_out", target: "late" }
    ]
  };
}

function faqWorkflow(baseUrl: string, answerTemplate: string): Json {
  return {
    id: "wf-demo-faq-release",
    name: "FAQ answerer (release gated)",
    description: "Published behind a release gate: a new version reaches production only when its replay job against the golden set passes.",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("trigger", "manual_trigger", "Question", 0, 120, { label: "Question" }),
      node("agent", "agent_orchestrator", "FAQ agent", 260, 120, {
        systemPromptTemplate: "[faq] Answer account questions from the help centre in one or two sentences.",
        userPromptTemplate: "{{user_prompt}}",
        maxIterations: 2,
        toolCallingEnabled: false
      }),
      node("model", "llm_call", "Chat model", 260, 320, { provider: modelProvider(baseUrl), promptKey: "prompt", systemPromptKey: "system_prompt" }),
      node("output", "output", "Answer", 520, 120, { responseTemplate: answerTemplate, outputKey: "result" })
    ],
    edges: [
      { id: "e1", source: "trigger", target: "agent" },
      { id: "e2", source: "agent", target: "output" },
      { id: "a1", source: "agent", sourceHandle: "chat_model", target: "model" }
    ]
  };
}

/** Parses a recorded SSE body into frames with a millisecond offset taken from the event's own timestamps. */
function parseSse(body: string): Array<{ event: string; data: unknown; t: number }> {
  const frames: Array<{ event: string; data: unknown; t: number }> = [];
  let origin: number | null = null;
  let last = 0;
  for (const raw of body.split("\n\n")) {
    const lines = raw.split("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!event || !dataText) continue;
    let data: unknown = null;
    try {
      data = JSON.parse(dataText);
    } catch {
      continue;
    }
    const record = (data ?? {}) as Json;
    const stamp = [record.at, record.startedAt, record.completedAt].find((value) => typeof value === "string") as string | undefined;
    const ms = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(ms)) {
      origin ??= ms;
      last = Math.max(last, ms - origin);
    }
    frames.push({ event, data, t: last });
  }
  return frames;
}

/** Replaces the scripted model's loopback address, temp paths and credential-shaped strings everywhere in a recorded value. */
function scrub<T>(value: T, baseUrls: string[]): T {
  let text = JSON.stringify(value);
  for (const url of baseUrls) text = text.split(url).join(MODEL_HOST_PLACEHOLDER);
  text = text
    .replace(new RegExp(os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^\"\\\\]*", "g"), "/data")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}|\bgithub_pat_[A-Za-z0-9_]{12,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [redacted]")
    .replace(/-----BEGIN [A-Z ]+-----[^"]*-----END [A-Z ]+-----/g, "[redacted]");
  return JSON.parse(text) as T;
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-demo-record-"));
  const model = await startScriptedModel(SCRIPTS);
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "error",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    CODE_NODES_ENABLED: "false",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    LLM_PRICING_OVERRIDES_JSON: JSON.stringify({ openai_compatible: { "demo-model": { inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 } } })
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();

  const user = authService.register({ email: DEMO_USER.email, password: DEMO_USER.password, role: DEMO_USER.role });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: DEMO_USER.email, password: DEMO_USER.password } });
  const cookie = [login.headers["set-cookie"]].flat().map(String).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))?.split(";")[0];
  if (!cookie) throw new Error(`Login failed: ${login.body}`);

  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Json } : {}) });
    return { status: response.statusCode, body: response.body, json: () => JSON.parse(response.body) as Json };
  };
  const must = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const response = await call(method, url, payload);
    if (response.status >= 400) throw new Error(`${method} ${url} answered ${response.status}: ${response.body.slice(0, 400)}`);
    return response.json();
  };

  // Seed: the curated samples, the templates made from them, and the demo workflows.
  const sampleDir = path.join(repoRoot, "samples", "workflows");
  for (const file of SAMPLE_FILES) {
    const parsed = JSON.parse(fs.readFileSync(path.join(sampleDir, file), "utf8")) as { schemaVersion: string; workflowVersion: number; workflow: Json };
    // The same path the API's own seed takes: samples are stored as written.
    store.upsertWorkflow({ ...parsed.workflow, schemaVersion: parsed.schemaVersion, workflowVersion: parsed.workflowVersion, projectId: "default" } as never);
    const check = await call("POST", `/api/workflows/${String(parsed.workflow.id)}/validate`);
    if (check.status !== 200 || (check.json() as { valid?: boolean }).valid === false) console.warn(`  sample ${file} does not validate: ${check.body.slice(0, 200)}`);
  }
  seedTemplatesIfEmpty(store, repoRoot);
  const sampleNames = new Set(
    SAMPLE_FILES.map((file) => String((JSON.parse(fs.readFileSync(path.join(sampleDir, file), "utf8")) as { workflow: Json }).workflow.name))
  );
  for (const template of store.listTemplates()) {
    if (!sampleNames.has(template.name)) store.deleteTemplate(template.id);
  }
  for (const workflow of [supportAgentWorkflow(model.baseUrl), swarmWorkflow(model.baseUrl), guardedWorkflow(), approvalWorkflow()]) {
    await must("POST", "/api/workflows", workflow);
  }
  await must("POST", "/api/guard/profiles", { document: GUARD_PROFILE });
  const mcpServer = (await must("POST", "/api/mcp/servers", { name: "Demo tools", adapterId: "mock-mcp", probeEnabled: false })) as { server: { id: string } };
  await call("POST", `/api/mcp/servers/${mcpServer.server.id}/probe`);
  for (const destination of [
    { name: "Help centre API", kind: "http", host: "help.example.com", tier: "public", region: "eu-west", holdsDataClasses: [] },
    { name: "CRM (private)", kind: "http", host: "*.crm.example.org", tier: "private", region: "eu-west", holdsDataClasses: ["email", "phone"] },
    { name: "Model gateway", kind: "http", host: "models.example.com", tier: "vendor", region: "us-east", holdsDataClasses: [] }
  ]) {
    await call("POST", "/api/data-destinations", destination);
  }

  // Runs, recorded as event streams. One recording per workflow; the last one wins.
  const runs: Record<string, { prompt: string; systemPrompt: string | null; executionId: string; frames: ReturnType<typeof parseSse> }> = {};
  const runStream = async (workflowId: string, prompt: string, as = cookie) => {
    // The studio sends its default system prompt unless the workflow has a System Prompt node with text.
    const stored = (await must("GET", `/api/workflows/${workflowId}`)) as { nodes: Array<{ type: string; config?: { text?: unknown } }> };
    const fromNodes = stored.nodes.some((entry) => entry.type === "system_prompt" && typeof entry.config?.text === "string" && entry.config.text.trim() !== "");
    const systemPrompt = fromNodes ? null : STUDIO_DEFAULT_SYSTEM_PROMPT;
    const response = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execute/stream`,
      headers: { cookie: as },
      payload: { user_prompt: prompt, ...(systemPrompt ? { system_prompt: systemPrompt } : {}) }
    });
    if (response.statusCode !== 200) throw new Error(`stream ${workflowId} answered ${response.statusCode}: ${response.body.slice(0, 300)}`);
    const frames = parseSse(response.body);
    const started = frames.find((frame) => frame.event === "execution_started")?.data as { executionId?: string } | undefined;
    const result = frames.find((frame) => frame.event === "result")?.data as { status?: string } | undefined;
    if (!started?.executionId || !result) throw new Error(`stream ${workflowId} had no start or result frame`);
    runs[workflowId] = { prompt, systemPrompt, executionId: started.executionId, frames };
    console.log(`  run ${workflowId}: ${result.status} (${frames.length} frames)`);
    return started.executionId;
  };

  console.log("Recording runs");
  await runStream("wf-basic-llm", "Summarise what L2M does in one line.");
  await runStream("wf-mcp-agent-quickstart", "What time is it in UTC?");
  const supportRun = await runStream("wf-demo-support-agent", "A customer on the Team plan has 49 seats. What is MCP, and what is the yearly cost at $12 per seat per month?");
  await runStream("wf-demo-research-swarm", "Brief the team: what is RAG, and how many uncached retrievals a day at 1,250 queries and an 18% miss rate?");
  await runStream("wf-demo-guarded-intake", "Please update the billing contact to jordan.lee@example.org and confirm.");
  // A teammate starts the refund runs, so the demo user is an eligible approver (nobody approves their own run).
  authService.register({ email: REQUESTER.email, password: REQUESTER.password, role: "builder" });
  const requesterLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: REQUESTER.email, password: REQUESTER.password } });
  const requesterCookie = [requesterLogin.headers["set-cookie"]].flat().map(String).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))?.split(";")[0];
  if (!requesterCookie) throw new Error(`Requester login failed: ${requesterLogin.body}`);
  const firstApproval = await runStream("wf-demo-refund-approval", "order 1042, $38.50", requesterCookie);
  await runStream("wf-demo-refund-approval", "order 1043, $112.00", requesterCookie);
  await runStream("wf-demo-refund-approval", "order 1044, $64.20", requesterCookie);
  await must("POST", `/api/approvals/${firstApproval}/approve`, { reason: "Within the refund policy." });

  // A golden run of the support agent, listed on its golden-run panel.
  const golden = (await must("POST", "/api/replay/recordings", { executionId: supportRun, name: "Team plan pricing question" })) as { recording: { id: string } };

  // The release gate: v1 published, a golden set of three runs, a regressing v2 blocked by its replay job.
  console.log("Recording the release gate");
  await must("POST", "/api/workflows", faqWorkflow(model.baseUrl, "{{answer}}"));
  const versions = new WorkflowVersionService(store);
  const faqV1 = versions.snapshot({ workflow: store.getWorkflow("wf-demo-faq-release")!, changeNote: "First version" }).version;
  await must("POST", "/api/workflows/wf-demo-faq-release/publish", { version: faqV1 });
  const faqRecordings: string[] = [];
  for (const [index, question] of ["How do I reset my password?", "Where do I change my password?", "My reset link expired, what now?"].entries()) {
    const run = (await must("POST", "/api/workflows/wf-demo-faq-release/execute", { user_prompt: question })) as { executionId: string };
    const saved = (await must("POST", "/api/replay/recordings", { executionId: run.executionId, name: `Password question ${index + 1}` })) as { recording: { id: string } };
    faqRecordings.push(saved.recording.id);
  }
  const set = (await must("POST", "/api/eval/datasets", { name: "FAQ golden set", workflowId: "wf-demo-faq-release" })) as { dataset: { id: string } };
  for (const recordingId of faqRecordings) await must("POST", `/api/eval/datasets/${set.dataset.id}/recordings`, { recordingId });
  await must("PUT", "/api/workflows/wf-demo-faq-release/release-gate", { enabled: true, datasetIds: [set.dataset.id] });
  const faqDraft = faqWorkflow(model.baseUrl, "FAQ: {{answer}}");
  await must("PUT", "/api/workflows/wf-demo-faq-release", faqDraft);
  const faqV2 = versions.snapshot({ workflow: store.getWorkflow("wf-demo-faq-release")!, changeNote: "Prefix answers" }).version;
  const job = (await must("POST", "/api/replay/runs", { datasetIds: [set.dataset.id] })) as { run: { id: string } };
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const current = (await must("GET", `/api/replay/runs/${job.run.id}`)) as { run: { status: string } };
    if (!["queued", "running"].includes(current.run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const publishRequest = { version: faqV2 };
  const blockedPublish = await call("POST", "/api/workflows/wf-demo-faq-release/publish", publishRequest);
  console.log(`  publish v${faqV2}: ${blockedPublish.status}`);
  // The regressing draft replayed against a golden run of v1: a real diff, on the graph the demo stores.
  console.log("Recording the replay diff");
  const replayRequest = { draft: true, mcpMode: "strict" };
  const replayDiff = await must("POST", `/api/replay/recordings/${faqRecordings[0]}/replay`, replayRequest);
  const faqStored = (await must("GET", "/api/workflows/wf-demo-faq-release")) as { nodes: unknown[]; edges: unknown[] };
  await runStream("wf-demo-faq-release", "How do I reset my password?");

  // Everything the UI reads, as the API answers it.
  console.log("Recording API answers");
  const responses: Record<string, { status: number; body: unknown }> = {};
  const record = async (url: string) => {
    const response = await call("GET", url);
    if (response.status >= 400) {
      console.warn(`  skip GET ${url}: ${response.status}`);
      return null;
    }
    responses[`GET ${url}`] = { status: response.status, body: response.json() };
    return response.json();
  };
  const workflowList = ((await call("GET", "/api/workflows")).json() as unknown) as Array<{ id: string }>;
  const executions = (await record("/api/executions?page=1&pageSize=40")) as { items: Array<{ id: string }> } | null;
  for (const url of [
    "/api/definitions",
    "/api/projects",
    "/api/folders",
    "/api/folders?projectId=default",
    "/api/templates",
    "/api/approvals",
    "/api/approvals?status=pending",
    "/api/approvals?status=decided",
    "/api/approvals?status=all",
    "/api/guard/events",
    "/api/guard/stats",
    "/api/guard/profiles",
    "/api/guard/detectors",
    "/api/guard/destination-rules",
    "/api/data-destinations",
    "/api/data-destinations/unclassified",
    "/api/mcp/servers",
    "/api/mcp/tools",
    "/api/mcp/catalog",
    "/api/mcp/presets",
    "/api/mcp/overview?window=24h",
    "/api/mcp/telemetry?window=24h",
    "/api/mcp/policies",
    "/api/mcp/toolsets",
    "/api/mcp/changes",
    "/api/mcp/elicitations?status=pending",
    "/api/mcp/toolsets/candidates",
    "/api/replay/recordings",
    "/api/replay/runs",
    "/api/eval/datasets",
    "/api/eval/runs",
    "/api/variables",
    "/api/usage/totals",
    "/api/usage/recent",
    "/api/observability",
    "/api/community-nodes",
    "/api/knowledge-bases",
    "/api/notifications"
  ]) {
    await record(url);
  }
  for (const template of store.listTemplates()) await record(`/api/templates/${template.id}`);
  for (const execution of executions?.items ?? []) {
    await record(`/api/executions/${execution.id}`);
    await record(`/api/executions/${execution.id}/guard-events`);
  }
  for (const workflow of workflowList) {
    for (const suffix of ["versions", "releases", "release-state", "release-gate", "variables", "pins", "replay-capture", "replay-captures?limit=100"]) {
      await record(`/api/workflows/${workflow.id}/${suffix}`);
    }
    await record(`/api/replay/recordings?workflowId=${workflow.id}`);
    await record(`/api/replay/runs?workflowId=${workflow.id}`);
    await record(`/api/eval/datasets?workflowId=${workflow.id}`);
    await record(`/api/guard/events?workflowId=${workflow.id}`);
  }
  await record(`/api/workflows/wf-demo-faq-release/publish-preview?version=${faqV2}`);
  const jobDetail = (await record(`/api/replay/runs/${job.run.id}`)) as { run: { results?: Array<{ id: string }> } } | null;
  await record(`/api/eval/runs/${job.run.id}`);
  for (const result of jobDetail?.run.results ?? []) await record(`/api/replay/runs/${job.run.id}/results/${result.id}`);
  await record(`/api/replay/recordings/${golden.recording.id}`);
  for (const recordingId of faqRecordings) await record(`/api/replay/recordings/${recordingId}`);
  await record(`/api/eval/datasets/${set.dataset.id}/fixtures`);
  const servers = (responses["GET /api/mcp/servers"]?.body ?? {}) as { servers?: Array<{ id: string }> };
  for (const server of servers.servers ?? []) {
    await record(`/api/mcp/servers/${server.id}`);
    await record(`/api/mcp/servers/${server.id}/tools`);
    await record(`/api/mcp/servers/${server.id}/telemetry?window=24h`);
  }

  // Recorded answers to a few writes, with what they were made against: the demo replays one only
  // when the request and the workflow's graph are the same again.
  const faqGraph = { nodes: faqStored.nodes, edges: faqStored.edges };
  const posts: Record<string, { status: number; body: unknown; match: { workflowId: string; graph: unknown; request: Json } }> = {
    [`POST /api/replay/recordings/${faqRecordings[0]}/replay`]: {
      status: 200,
      body: replayDiff,
      match: { workflowId: "wf-demo-faq-release", graph: faqGraph, request: replayRequest }
    },
    [`POST /api/workflows/wf-demo-faq-release/publish`]: {
      status: blockedPublish.status,
      body: blockedPublish.json(),
      // An override or an approval request gets another answer than the recorded one.
      match: { workflowId: "wf-demo-faq-release", graph: faqGraph, request: { ...publishRequest, override: null, requestApproval: null } }
    }
  };

  const workflows: Json[] = [];
  for (const entry of workflowList) workflows.push((await must("GET", `/api/workflows/${entry.id}`)) as Json);

  const baseUrls = [model.baseUrl];
  const fixture = scrub(
    {
      meta: {
        recordedAt: new Date().toISOString(),
        user: { id: user.id, email: DEMO_USER.email, role: DEMO_USER.role },
        // Stored as seeded and never saved through the API: no versions, releases, sets or captures.
        blankWorkflowId: "wf-basic-llm",
        note: "Recorded by apps/web/demo/record-fixtures.mts from the real API with a scripted local model and the mock MCP adapter."
      },
      workflows,
      workflowList: workflowList as unknown,
      runs,
      responses,
      posts
    },
    baseUrls
  );

  // Refuse to write anything credential-shaped or anything that identifies this machine or this recording.
  // The node definitions are compiled from source (their placeholders, such as a database user "root",
  // are product defaults), so machine names are scrubbed from and checked in everything else.
  const definitionsKey = "GET /api/definitions";
  const definitions = fixture.responses[definitionsKey];
  delete fixture.responses[definitionsKey];
  const hostName = os.hostname();
  const userName = os.userInfo().username;
  const scrubbedRest = JSON.parse(
    JSON.stringify(fixture)
      .split(JSON.stringify(hostName)).join(JSON.stringify("demo-host"))
      .split(JSON.stringify(userName)).join(JSON.stringify("demo-user"))
  ) as typeof fixture;
  Object.assign(fixture, scrubbedRest);
  const sessionToken = cookie.slice(cookie.indexOf("=") + 1);
  // Whole JSON-string tokens: "bob", /bob/, \bob\ (any length; ordinary words inside text do not count).
  const token = (value: string) => new RegExp(`["/\\\\]${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["/\\\\]`);
  // A path counts when it is followed by a separator or the end of a string, so "</root>" is not "/root".
  const pathPattern = (value: string) => new RegExp(`${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/"\\\\])`);
  const machine: Array<{ name: string; pattern: RegExp | null; value: string }> = [
    { name: "scripted model address", value: new URL(model.baseUrl).host, pattern: literalPattern(new URL(model.baseUrl).host) },
    // "/" and "/tmp" are on every machine and in ordinary paths; temp paths are scrubbed above.
    { name: "temp directory", value: os.tmpdir(), pattern: ["/", "/tmp"].includes(os.tmpdir()) ? null : pathPattern(os.tmpdir()) },
    { name: "home directory", value: os.homedir(), pattern: os.homedir() === "/" ? null : pathPattern(os.homedir()) },
    { name: "repository path", value: repoRoot, pattern: pathPattern(repoRoot) },
    { name: "user name", value: userName, pattern: token(userName) },
    { name: "host name", value: hostName, pattern: token(hostName) },
    { name: "master key", value: config.SECRET_MASTER_KEY_BASE64, pattern: literalPattern(config.SECRET_MASTER_KEY_BASE64) },
    { name: "session cookie", value: sessionToken, pattern: literalPattern(sessionToken) }
  ];
  for (const entry of machine) if (!entry.pattern) console.log(`  not checking the ${entry.name} "${entry.value}": on every machine`);
  const leaks = [
    ...findLeaks(
      JSON.stringify(fixture),
      machine.filter((entry) => entry.pattern).map((entry) => ({ name: entry.name, pattern: entry.pattern! }))
    ),
    ...findLeaks(JSON.stringify(definitions ?? {}))
  ];
  if (leaks.length) throw new Error(`Refusing to write fixtures; found ${leaks.map((leak) => `${leak.name} (${leak.match})`).join(", ")}`);
  if (definitions) fixture.responses[definitionsKey] = definitions;

  fs.mkdirSync(outDir, { recursive: true });
  const { workflows: wf, workflowList: list, runs: recordedRuns, responses: recorded, posts: recordedPosts, meta } = fixture;
  const files: Record<string, unknown> = {
    "meta.json": meta,
    "workflows.json": { workflows: wf, workflowList: list },
    "runs.json": recordedRuns,
    "responses.json": { get: recorded, post: recordedPosts }
  };
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    const text = `${JSON.stringify(content)}\n`;
    fs.writeFileSync(path.join(outDir, name), text);
    total += Buffer.byteLength(text);
    console.log(`  wrote ${name} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KiB)`);
  }
  console.log(`Fixtures: ${(total / 1024).toFixed(1)} KiB in ${outDir}`);

  await app.close();
  await model.close();
  try {
    store.close();
  } catch {
    // Already closed by the app shutdown hooks.
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

await main();
