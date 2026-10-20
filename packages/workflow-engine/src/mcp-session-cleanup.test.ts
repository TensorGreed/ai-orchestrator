import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeAdapter, AgentToolRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type { AgentRunRequest, AgentRunState, Workflow, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";

// A minimal stdio MCP server. The `pid` tool reports the server's own process
// id so a test can check afterwards that the process is gone.
const PID_SERVER_SCRIPT = `
process.stdin.setEncoding('utf-8');
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.method === 'initialize') {
      reply(req.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'pid-test', version: '1.0' } });
    } else if (req.method === 'tools/list') {
      reply(req.id, { tools: [{ name: 'pid', description: 'returns the server pid', inputSchema: { type: 'object' } }] });
    } else if (req.method === 'tools/call') {
      reply(req.id, { structuredContent: { pid: process.pid } });
    }
  }
});
`;

const PID_TOOL = "stdio_mcp__pid";

class FakeProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };

  async generate() {
    return { content: "unused", toolCalls: [] };
  }
}

type AgentScript = (request: AgentRunRequest, tools: AgentToolRuntime) => Promise<Partial<AgentRunState> | void>;

/**
 * Agent runtime that runs a per-test script instead of a model loop. Scripts
 * call tools through the executor-provided tool runtime, which is what opens
 * stdio sessions in the node's MCP context.
 */
class ScriptedAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "scripted-agent";

  constructor(private readonly script: AgentScript) {}

  async run(request: AgentRunRequest, tools: AgentToolRuntime): Promise<AgentRunState> {
    const overrides = (await this.script(request, tools)) ?? {};
    return {
      finalAnswer: "done",
      stopReason: "final_answer",
      iterations: 1,
      messages: [],
      steps: [],
      ...overrides
    };
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

const stdioToolConfig = {
  serverId: "stdio_mcp",
  toolName: "pid",
  argsTemplate: "{}",
  connection: { command: process.execPath, args: ["-e", PID_SERVER_SCRIPT], timeoutMs: 10_000 }
};

const agentConfig = {
  systemPromptTemplate: "S",
  userPromptTemplate: "{{user_prompt}}",
  maxIterations: 4,
  toolCallingEnabled: true
};

function agentWorkflow(): Workflow {
  return {
    id: "wf-mcp-cleanup",
    name: "MCP cleanup",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("trigger", "webhook_input"),
      node("agent", "agent_orchestrator", agentConfig),
      node("model", "llm_call", { provider: { providerId: "fake", model: "fake-model" } }),
      node("tool", "mcp_tool", stdioToolConfig),
      node("output", "output")
    ],
    edges: [
      edge("trigger", "agent"),
      edge("agent", "output"),
      edge("agent", "model", "chat_model"),
      edge("agent", "tool", "tool")
    ]
  };
}

function supervisorWorkflow(): Workflow {
  return {
    id: "wf-mcp-cleanup-supervisor",
    name: "MCP cleanup supervisor",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("trigger", "webhook_input"),
      node("supervisor", "supervisor_node", agentConfig),
      node("worker", "agent_orchestrator", agentConfig),
      node("model", "llm_call", { provider: { providerId: "fake", model: "fake-model" } }),
      node("tool", "mcp_tool", stdioToolConfig),
      node("output", "output")
    ],
    edges: [
      edge("trigger", "supervisor"),
      edge("supervisor", "output"),
      edge("supervisor", "model", "chat_model"),
      edge("supervisor", "tool", "tool"),
      edge("supervisor", "worker", "worker"),
      edge("worker", "model", "chat_model"),
      edge("worker", "tool", "tool")
    ]
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function callPidTool(tools: AgentToolRuntime): Promise<number> {
  const output = (await tools.invokeTool(PID_TOOL, {})) as { pid: number };
  expect(typeof output.pid).toBe("number");
  return output.pid;
}

function countChildProcesses(): number {
  try {
    const out = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf-8" });
    return out.split("\n").filter((line) => line.trim()).length;
  } catch {
    // pgrep exits 1 when nothing matches.
    return 0;
  }
}

describe("MCP stdio session cleanup", () => {
  it("terminates the stdio server an agent node spawned once the node succeeds", async () => {
    const pids: number[] = [];
    const runtime = new ScriptedAgentRuntime(async (_request, tools) => {
      pids.push(await callPidTool(tools));
      pids.push(await callPidTool(tools));
    });

    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } },
      makeDeps(runtime)
    );

    expect(result.status).toBe("success");
    expect(pids).toHaveLength(2);
    // Both calls inside one node run share a single session.
    expect(pids[0]).toBe(pids[1]);
    expect(isAlive(pids[0])).toBe(false);
  });

  it("terminates the stdio server when the agent run throws", async () => {
    const pids: number[] = [];
    const runtime = new ScriptedAgentRuntime(async (_request, tools) => {
      const pid = await callPidTool(tools);
      pids.push(pid);
      expect(isAlive(pid)).toBe(true);
      throw new Error("agent exploded");
    });

    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } },
      makeDeps(runtime)
    );

    expect(result.status).toBe("error");
    // The node may be retried; every attempt's server must be gone.
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      expect(isAlive(pid)).toBe(false);
    }
  });

  it("terminates the stdio server when the agent pauses for clarification", async () => {
    let pid = 0;
    const runtime = new ScriptedAgentRuntime(async (_request, tools) => {
      pid = await callPidTool(tools);
      return {
        finalAnswer: "Which account?",
        stopReason: "clarification_requested",
        clarification: { question: "Which account?", toolCallId: "call-1" }
      };
    });

    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } },
      makeDeps(runtime)
    );

    expect(result.status).toBe("success");
    expect(isAlive(pid)).toBe(false);
  });

  it("terminates the stdio server as soon as the execution is aborted", async () => {
    const controller = new AbortController();
    let pid = 0;
    let aliveAfterAbort: boolean | undefined;
    const runtime = new ScriptedAgentRuntime(async (_request, tools) => {
      pid = await callPidTool(tools);
      controller.abort(new Error("execution timed out"));
      // The runtime does not watch the signal; the executor must still kill
      // the child without waiting for the run to return.
      const deadline = Date.now() + 5_000;
      while (isAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      aliveAfterAbort = isAlive(pid);
    });

    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "go" } },
      makeDeps(runtime, { abortSignal: controller.signal })
    );

    expect(result.status).not.toBe("success");
    expect(aliveAfterAbort).toBe(false);
    expect(isAlive(pid)).toBe(false);
  });

  it("lets a worker close its own session without touching the supervisor's", async () => {
    const seen: Record<string, number[]> = { supervisor: [], worker: [] };
    let workerPidAliveAfterDelegation: boolean | undefined;
    const runtime = new ScriptedAgentRuntime(async (_request, tools) => {
      // Only the supervisor is offered a delegation tool.
      const delegate = tools.tools.find((tool) => tool.name.startsWith("delegate_to_"));
      if (!delegate) {
        seen.worker.push(await callPidTool(tools));
        return { finalAnswer: "worker done" };
      }
      seen.supervisor.push(await callPidTool(tools));
      await tools.invokeTool(delegate.name, { task_prompt: "worker task" });
      workerPidAliveAfterDelegation = isAlive(seen.worker[0]);
      // The supervisor's own session must still answer after the worker ended.
      seen.supervisor.push(await callPidTool(tools));
      return { finalAnswer: "supervisor done" };
    });

    const result = await executeWorkflow(
      { workflow: supervisorWorkflow(), webhookPayload: { user_prompt: "supervise" } },
      makeDeps(runtime)
    );

    expect(result.status).toBe("success");
    expect(seen.worker).toHaveLength(1);
    expect(seen.supervisor).toHaveLength(2);
    expect(seen.supervisor[0]).toBe(seen.supervisor[1]);
    expect(seen.worker[0]).not.toBe(seen.supervisor[0]);
    expect(workerPidAliveAfterDelegation).toBe(false);
    expect(isAlive(seen.supervisor[0])).toBe(false);
  });

  it("terminates the stdio server a direct MCP Tool node spawned", async () => {
    const workflow: Workflow = {
      id: "wf-mcp-direct",
      name: "Direct MCP tool",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [node("trigger", "webhook_input"), node("tool", "mcp_tool", stdioToolConfig), node("output", "output")],
      edges: [edge("trigger", "tool"), edge("tool", "output")]
    };

    const result = await executeWorkflow(
      { workflow, webhookPayload: {} },
      makeDeps(new ScriptedAgentRuntime(async () => undefined))
    );

    expect(result.status).toBe("success");
    const toolOutput = result.nodeResults.find((entry) => entry.nodeId === "tool")?.output as
      | { tool_output?: { pid?: number } }
      | undefined;
    const pid = toolOutput?.tool_output?.pid;
    expect(typeof pid).toBe("number");
    expect(isAlive(pid as number)).toBe(false);
  });

  it("leaves no child processes behind across repeated agent runs", async () => {
    const before = countChildProcesses();
    const runtime = new ScriptedAgentRuntime(async (_request, tools) => {
      await callPidTool(tools);
    });
    const deps = makeDeps(runtime);

    for (let run = 0; run < 5; run += 1) {
      const result = await executeWorkflow(
        { workflow: agentWorkflow(), webhookPayload: { user_prompt: `run ${run}` } },
        deps
      );
      expect(result.status).toBe("success");
    }
    const after = countChildProcesses();
    console.info(`[mcp-session-cleanup] child processes before=${before} after=${after} (5 agent runs)`);

    expect(after).toBe(before);
  });
});
