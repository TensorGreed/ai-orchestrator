/**
 * Phase 10.5 — the engine side of MCP structured output, progress and
 * cancellation, against a real stdio MCP server process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimeAdapter, AgentToolRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type {
  AgentRunRequest,
  AgentRunState,
  McpToolPolicyRule,
  McpToolProgressEvent,
  Workflow,
  WorkflowEdge,
  WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";

const SERVER_SCRIPT = `
const fs = require('fs');
const log = (entry) => fs.appendFileSync(process.env.EVENT_LOG, JSON.stringify(entry) + '\\n');
process.stdin.setEncoding('utf-8');
process.stdin.on('end', () => { log({ event: 'stdin_closed' }); process.exit(0); });
let buf = '';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const OUTPUT = { type: 'object', properties: { temperature: { type: 'number' }, unit: { type: 'string' } }, required: ['temperature', 'unit'] };
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === 'notifications/cancelled') { log({ event: 'cancelled', params: req.params }); continue; }
    if (req.id === undefined) continue;
    if (req.method === 'initialize') send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
    else if (req.method === 'tools/list') send({ jsonrpc: '2.0', id: req.id, result: { tools: [
      { name: 'weather', description: 'weather', inputSchema: { type: 'object' }, outputSchema: OUTPUT, annotations: { readOnlyHint: true } },
      { name: 'slow', description: 'reports progress', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'hang', description: 'never answers', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'wipe', description: 'destroys data', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } }
    ] } });
    else if (req.method === 'tools/call') {
      const name = req.params.name;
      const token = req.params._meta && req.params._meta.progressToken;
      log({ event: 'call', id: req.id, name });
      if (name === 'weather') send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'Mild, 21.5 C' }], structuredContent: { temperature: 21.5, unit: 'C' } } });
      else if (name === 'slow') {
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 40, total: 100, message: 'indexing' } });
        setTimeout(() => send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'done' }] } }), 20);
      } else if (name === 'hang') { /* never answers */ }
      else send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'wiped' }] } });
    }
  }
});
`;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function eventLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-engine-mcp-"));
  tempDirs.push(dir);
  const file = path.join(dir, "events.log");
  fs.writeFileSync(file, "");
  return file;
}

function readLog(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class FakeProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };
  async generate() {
    return { content: "unused", toolCalls: [] };
  }
}

type AgentScript = (request: AgentRunRequest, tools: AgentToolRuntime) => Promise<Partial<AgentRunState> | void>;

class ScriptedAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "scripted-agent";
  constructor(private readonly script: AgentScript) {}
  async run(request: AgentRunRequest, tools: AgentToolRuntime): Promise<AgentRunState> {
    const overrides = (await this.script(request, tools)) ?? {};
    return { finalAnswer: "done", stopReason: "final_answer", iterations: 1, messages: [], steps: [], ...overrides };
  }
}

function makeDeps(agentRuntime: AgentRuntimeAdapter, extra?: Partial<WorkflowExecutionDependencies>): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new FakeProvider());
  return {
    providerRegistry,
    mcpRegistry: createDefaultMCPRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime,
    resolveSecret: async () => undefined,
    ...extra
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `${source}-${sourceHandle ?? "main"}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function toolConfig(log: string, toolName: string) {
  return {
    serverId: "stdio_mcp",
    toolName,
    argsTemplate: "{}",
    connection: { command: process.execPath, args: ["-e", SERVER_SCRIPT], env: { EVENT_LOG: log }, timeoutMs: 10_000 }
  };
}

function directWorkflow(
  log: string,
  toolName: string,
  extraNodes: WorkflowNode[] = [node("output", "output")],
  extraEdges: WorkflowEdge[] = [edge("tool", "output")]
): Workflow {
  return {
    id: `wf-direct-${toolName}`,
    name: "Direct MCP tool",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("trigger", "webhook_input"), node("tool", "mcp_tool", toolConfig(log, toolName)), ...extraNodes],
    edges: [edge("trigger", "tool"), ...extraEdges]
  };
}

function agentWorkflow(log: string): Workflow {
  return {
    id: "wf-agent-mcp",
    name: "Agent MCP",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("trigger", "webhook_input"),
      node("agent", "agent_orchestrator", { systemPromptTemplate: "S", userPromptTemplate: "{{user_prompt}}", maxIterations: 4 }),
      node("model", "llm_call", { provider: { providerId: "fake", model: "fake-model" } }),
      node("tool", "mcp_tool", { ...toolConfig(log, "__all__") }),
      node("output", "output")
    ],
    edges: [edge("trigger", "agent"), edge("agent", "output"), edge("agent", "model", "chat_model"), edge("agent", "tool", "tool")]
  };
}

const runtimeNoop = new ScriptedAgentRuntime(async () => undefined);

describe("MCP Tool node structured output", () => {
  it("exposes the validated structuredContent as `structured` for downstream templates", async () => {
    const log = eventLog();
    const workflow = directWorkflow(
      log,
      "weather",
      [
        node("set", "set_node", {
          assignments: [
            { key: "temp", valueTemplate: "{{results.tool.structured.temperature}}" },
            { key: "unit", valueTemplate: "{{results.tool.structured.unit}}" }
          ]
        }),
        node("output", "output", { responseTemplate: "{{temp}} {{unit}}" })
      ],
      [edge("tool", "set"), edge("set", "output")]
    );
    const result = await executeWorkflow({ workflow, webhookPayload: {} }, makeDeps(runtimeNoop));
    expect(result.status).toBe("success");
    const toolOutput = result.nodeResults.find((entry) => entry.nodeId === "tool")?.output as Record<string, unknown>;
    expect(toolOutput.structured).toEqual({ temperature: 21.5, unit: "C" });
    expect(toolOutput.content).toBe("Mild, 21.5 C");
    // tool_output keeps its old shape: the structured result when there is one.
    expect(toolOutput.tool_output).toEqual({ temperature: 21.5, unit: "C" });
    const setOutput = result.nodeResults.find((entry) => entry.nodeId === "set")?.output as Record<string, unknown>;
    expect(setOutput.temp).toBe("21.5");
    expect(setOutput.unit).toBe("C");
  });
});

describe("agents and structured content", () => {
  it("hands the model the structured result together with text that says more", async () => {
    const log = eventLog();
    let seen: unknown;
    const runtime = new ScriptedAgentRuntime(async (_request, tools) => {
      seen = await tools.invokeTool("stdio_mcp__weather", {});
    });
    const result = await executeWorkflow({ workflow: agentWorkflow(log), webhookPayload: { user_prompt: "weather?" } }, makeDeps(runtime));
    expect(result.status).toBe("success");
    expect(seen).toEqual({ content: "Mild, 21.5 C", structuredContent: { temperature: 21.5, unit: "C" } });
  });
});

describe("MCP progress", () => {
  it("streams progress of a direct MCP Tool node and keeps it on the output", async () => {
    const log = eventLog();
    const events: Array<McpToolProgressEvent & { nodeId: string }> = [];
    const result = await executeWorkflow(
      { workflow: directWorkflow(log, "slow"), webhookPayload: {} },
      makeDeps(runtimeNoop, { onMcpProgress: (event) => void events.push(event) })
    );
    expect(result.status).toBe("success");
    expect(events).toEqual([
      expect.objectContaining({ nodeId: "tool", toolName: "slow", serverId: "stdio_mcp", progress: 40, total: 100, message: "indexing" })
    ]);
    const output = result.nodeResults.find((entry) => entry.nodeId === "tool")?.output as Record<string, unknown>;
    expect(output._mcpProgress).toEqual([expect.objectContaining({ progress: 40, total: 100 })]);
  });

  it("streams progress of an agent's tool calls under the agent node", async () => {
    const log = eventLog();
    const events: Array<McpToolProgressEvent & { nodeId: string }> = [];
    const runtime = new ScriptedAgentRuntime(async (_request, tools) => {
      await tools.invokeTool("stdio_mcp__slow", {});
    });
    const result = await executeWorkflow(
      { workflow: agentWorkflow(log), webhookPayload: { user_prompt: "go" } },
      makeDeps(runtime, { onMcpProgress: (event) => void events.push(event) })
    );
    expect(result.status).toBe("success");
    expect(events).toEqual([expect.objectContaining({ nodeId: "agent", toolName: "slow", progress: 40, message: "indexing" })]);
  });
});

describe("MCP cancellation", () => {
  it("sends notifications/cancelled for the in-flight call, then closes the server, when the run is aborted", async () => {
    const log = eventLog();
    const controller = new AbortController();
    const pending = executeWorkflow(
      { workflow: directWorkflow(log, "hang"), webhookPayload: {} },
      makeDeps(runtimeNoop, { abortSignal: controller.signal })
    );
    const started = Date.now();
    while (!readLog(log).some((entry) => entry.event === "call") && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort(new Error("Run canceled by user"));
    const result = await pending;
    expect(result.status).not.toBe("success");
    const deadline = Date.now() + 5000;
    while (!readLog(log).some((entry) => entry.event === "stdin_closed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const entries = readLog(log);
    const call = entries.find((entry) => entry.event === "call" && entry.name === "hang")!;
    const cancelIndex = entries.findIndex((entry) => entry.event === "cancelled");
    const closeIndex = entries.findIndex((entry) => entry.event === "stdin_closed");
    expect(entries[cancelIndex]).toEqual({ event: "cancelled", params: { requestId: call.id, reason: "Run canceled by user" } });
    expect(closeIndex).toBeGreaterThan(cancelIndex);
  });
});

describe("MCP Tool node and annotation policy", () => {
  it("looks up annotations before running a direct tool when a rule targets destructive tools", async () => {
    const log = eventLog();
    const rule: McpToolPolicyRule = {
      id: "no-destructive",
      name: "No destructive tools for operators",
      description: null,
      effect: "deny",
      projectId: null,
      roles: ["operator"],
      serverId: null,
      toolPattern: "*",
      annotationHint: "destructive",
      enabled: true
    };
    const deps = makeDeps(runtimeNoop, { loadMcpToolPolicy: () => ({ rules: [rule], classifications: [] }) });
    const operator = { role: "operator" as const, source: "user" as const };
    const denied = await executeWorkflow({ workflow: directWorkflow(log, "wipe"), webhookPayload: {}, toolPolicySubject: operator }, deps);
    expect(denied.status).toBe("error");
    expect(denied.nodeResults.find((entry) => entry.nodeId === "tool")?.error).toMatch(/No destructive tools for operators/);
    expect(readLog(log).some((entry) => entry.event === "call")).toBe(false);

    const allowed = await executeWorkflow({ workflow: directWorkflow(log, "weather"), webhookPayload: {}, toolPolicySubject: operator }, deps);
    expect(allowed.status).toBe("success");
  });
});
