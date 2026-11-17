/**
 * Sensitive values in MCP tool results: a result whose `_meta` lists sensitive values (L2M's gateway restore) is kept
 * out of what a run stores and streams, as a Reveal node's values are. The run's own nodes still get the values; a
 * marker this deployment signed puts the listed tokens back, any other marker only masks more.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  SENSITIVE_VALUES_META_KEY,
  UNVERIFIED_SENSITIVE_PLACEHOLDER,
  type ChatMessage,
  type MCPToolResult,
  type Workflow,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { buildToolCallResult } from "@ai-orchestrator/mcp-sdk";
import { executeWorkflow, runRevealedValues, type WorkflowExecutionDependencies } from "./executor";
import { RevealRedactor } from "./reveal-redaction";
import { observeSensitiveResults, protectSensitiveResult } from "./sensitive-results";

const EMAIL = "ana.lopez@example.org";
const TOKEN = "[EMAIL_1.R6CTZH]";
const SIG = "v1:signed";
const verify = (marker: { sig?: string }) => marker.sig === SIG;

function marker(values: Array<{ token: string; value: string }>, sig: string | undefined = SIG) {
  return { v: 1, values, ...(sig ? { sig } : {}) };
}

function restored(text: string, sensitiveValues?: unknown): MCPToolResult {
  return { ok: true, output: { restored: text }, structured: { restored: text }, ...(sensitiveValues !== undefined ? { sensitiveValues } : {}) };
}

describe("protectSensitiveResult", () => {
  it("puts back the tokens a verified marker lists, for values the result holds", () => {
    const redactor = new RevealRedactor();
    const result = restored(`Mail ${EMAIL}`, marker([{ token: TOKEN, value: EMAIL }, { token: "[PHONE_1]", value: "+1 415 555 0134" }]));
    expect(protectSensitiveResult(result, redactor, verify)).toBe(true);
    expect(redactor.redact(result.output)).toEqual({ restored: `Mail ${TOKEN}` });
    // A value the result does not hold is not taken from the marker.
    expect(redactor.redactText("call +1 415 555 0134")).toBe("call +1 415 555 0134");
  });

  it("masks with a fixed placeholder when the marker does not verify, is unsigned, or the check throws", () => {
    for (const [sensitive, check] of [
      [marker([{ token: "attacker text", value: EMAIL }], "v1:forged"), verify],
      [{ v: 1, values: [{ token: "attacker text", value: EMAIL }] }, verify],
      [marker([{ token: "attacker text", value: EMAIL }]), undefined],
      [
        marker([{ token: "attacker text", value: EMAIL }]),
        () => {
          throw new Error("boom");
        }
      ]
    ] as const) {
      const redactor = new RevealRedactor();
      expect(protectSensitiveResult(restored(`Mail ${EMAIL}`, sensitive), redactor, check as never)).toBe(true);
      expect(redactor.redactText(`Mail ${EMAIL}`)).toBe(`Mail ${UNVERIFIED_SENSITIVE_PLACEHOLDER}`);
    }
  });

  it("does not trust a signed marker with entries it had to drop", () => {
    const redactor = new RevealRedactor();
    const sensitive = { v: 1, sig: SIG, values: [{ token: TOKEN, value: EMAIL }, { token: 3, value: "x" }] };
    protectSensitiveResult(restored(`Mail ${EMAIL}`, sensitive), redactor, verify);
    expect(redactor.redactText(EMAIL)).toBe(UNVERIFIED_SENSITIVE_PLACEHOLDER);
  });

  it("never lets an unverified value stop a revealed value from being found whole", () => {
    const redactor = new RevealRedactor();
    redactor.add(EMAIL, "tok_email_abc");
    // A hostile result lists text that overlaps the start of the revealed value.
    const listed = Array.from({ length: 26 }, (_, index) => ({ token: "x", value: `Mail ${String.fromCharCode(97 + index)}` }));
    protectSensitiveResult(restored(listed.map((entry) => entry.value).join(" "), { v: 1, values: listed }), redactor, verify);
    const text = redactor.redactText(`Mail ${EMAIL} today`);
    expect(text).not.toContain("na.lopez@example.org");
    expect(text).toMatch(/ok_email_abc today$/);
  });

  it("reports a malformed marker as present but registers nothing, and ignores results without one", () => {
    const redactor = new RevealRedactor();
    expect(protectSensitiveResult(restored(`Mail ${EMAIL}`, "not a marker"), redactor, verify)).toBe(true);
    expect(protectSensitiveResult(restored(`Mail ${EMAIL}`), redactor, verify)).toBe(false);
    expect(redactor.active).toBe(false);
  });

  it("finds values escaped inside JSON text and in error results", () => {
    const quoted = 'say "hi" to ana';
    const redactor = new RevealRedactor();
    const result: MCPToolResult = { ok: false, output: null, error: JSON.stringify({ text: quoted }), sensitiveValues: marker([{ token: "[NAME_1]", value: quoted }]) };
    protectSensitiveResult(result, redactor, verify);
    expect(redactor.redactText(result.error!)).toBe(JSON.stringify({ text: "[NAME_1]" }));
  });
});

describe("the MCP result `_meta` marker", () => {
  it("is carried from the raw tools/call result to the tool result, also on errors", () => {
    const meta = { _meta: { [SENSITIVE_VALUES_META_KEY]: marker([{ token: TOKEN, value: EMAIL }]) } };
    expect(buildToolCallResult("restore", { content: [{ type: "text", text: EMAIL }], ...meta }).sensitiveValues).toEqual(meta._meta[SENSITIVE_VALUES_META_KEY]);
    expect(buildToolCallResult("restore", { isError: true, content: [{ type: "text", text: EMAIL }], ...meta }).sensitiveValues).toBeDefined();
    expect(buildToolCallResult("plain", { content: [{ type: "text", text: "hi" }] })).not.toHaveProperty("sensitiveValues");
  });
});

/** The gateway's restore tool, and a sink that records what the run's nodes sent. */
function adapters(sent: Array<Record<string, unknown>>, sensitiveValues: unknown = marker([{ token: TOKEN, value: EMAIL }])): MCPServerAdapter[] {
  return [
    {
      definition: { id: "gateway-mcp", label: "Gateway", description: "Test", configSchema: {}, authSchema: {} },
      async discoverTools() {
        return [{ serverId: "gateway-mcp", serverLabel: "Gateway", name: "restore_sensitive_data", description: "Restore", inputSchema: { type: "object" } }];
      },
      async invokeTool(_name: string, args: Record<string, unknown>) {
        const text = String(args.text ?? "").replace(TOKEN, EMAIL);
        return restored(text, sensitiveValues);
      }
    } as unknown as MCPServerAdapter,
    {
      definition: { id: "sink-mcp", label: "Sink", description: "Test", configSchema: {}, authSchema: {} },
      async discoverTools() {
        return [{ serverId: "sink-mcp", serverLabel: "Sink", name: "send", description: "Send", inputSchema: { type: "object" } }];
      },
      async invokeTool(_name: string, args: Record<string, unknown>) {
        sent.push(args);
        return { ok: true, output: { sent: true } };
      }
    } as unknown as MCPServerAdapter
  ];
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function directWorkflow(): Workflow {
  return {
    id: "wf-restore",
    name: "Restore",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("in", "webhook_input"),
      node("restore", "mcp_tool", { serverId: "gateway-mcp", toolName: "restore_sensitive_data", argsTemplate: '{"text":"{{text}}"}', retry: { enabled: false } }),
      node("sink", "mcp_tool", { serverId: "sink-mcp", toolName: "send", argsTemplate: '{"text":"{{restore.structured.restored}}"}', retry: { enabled: false } }),
      node("out", "output")
    ],
    edges: [
      { id: "e1", source: "in", target: "restore" },
      { id: "e2", source: "restore", target: "sink" },
      { id: "e3", source: "sink", target: "out" }
    ]
  };
}

function deps(mcp: MCPServerAdapter[], extra: Partial<WorkflowExecutionDependencies> = {}, providers: LLMProviderAdapter[] = []): WorkflowExecutionDependencies {
  const mcpRegistry = createDefaultMCPRegistry();
  for (const adapter of mcp) mcpRegistry.register(adapter);
  const providerRegistry = new ProviderRegistry();
  for (const provider of providers) providerRegistry.register(provider);
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    ...extra
  };
}

describe("a run that calls a tool whose result lists sensitive values", () => {
  it("gives the values to its own nodes and keeps their tokens in its result and live events", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const events: unknown[] = [];
    const result = await executeWorkflow(
      { workflow: directWorkflow(), executionId: "exec-1", webhookPayload: { text: `Mail ${TOKEN}` } },
      deps(adapters(sent), {
        verifySensitiveValues: verify,
        onNodeStart: (event) => void events.push(event),
        onNodeComplete: (event) => void events.push(event),
        onNodeActivity: (event) => void events.push(event)
      })
    );
    expect(result.status, result.error).toBe("success");
    // The downstream node got the value.
    expect(sent).toEqual([{ text: `Mail ${EMAIL}` }]);
    // What the run keeps and streams holds the token.
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(JSON.stringify(result.nodeResults.find((entry) => entry.nodeId === "restore")?.output)).toContain(TOKEN);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(EMAIL);
    // Like a Reveal: kept out of replay capture and MCP cassettes.
    expect(runRevealedValues(result)).toBe(true);
  });

  it("masks with the fixed placeholder when the marker does not verify", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const result = await executeWorkflow(
      { workflow: directWorkflow(), executionId: "exec-2", webhookPayload: { text: `Mail ${TOKEN}` } },
      deps(adapters(sent, marker([{ token: "[OK]", value: EMAIL }], "v1:from-elsewhere")), { verifySensitiveValues: verify })
    );
    expect(result.status, result.error).toBe("success");
    expect(sent).toEqual([{ text: `Mail ${EMAIL}` }]);
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(JSON.stringify(result)).not.toContain("[OK]");
    expect(JSON.stringify(result)).toContain(UNVERIFIED_SENSITIVE_PLACEHOLDER);
  });

  it("tells the caller before the next live event, so what it already showed can be corrected", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const log: Array<{ kind: string; nodeId?: string; data?: unknown }> = [];
    const redactions: Array<<T>(value: T) => T> = [];
    // The run's input carries the value in clear: the events of the input node hold it until the restore lists it.
    const result = await executeWorkflow(
      { workflow: directWorkflow(), executionId: "exec-3", webhookPayload: { text: `Mail ${TOKEN}`, note: `from ${EMAIL}` } },
      deps(adapters(sent), {
        verifySensitiveValues: verify,
        onNodeComplete: (event) => void log.push({ kind: "complete", nodeId: event.nodeId, data: event }),
        onRunRedacted: (redact) => {
          redactions.push(redact);
          log.push({ kind: "redacted" });
        }
      })
    );
    expect(result.status, result.error).toBe("success");
    expect(redactions).toHaveLength(1);
    const kinds = log.map((entry) => (entry.kind === "complete" ? entry.nodeId : entry.kind));
    // The notice comes after the input node's event and before the restore node's.
    expect(kinds).toEqual(["in", "redacted", "restore", "sink", "out"]);
    const before = log[0]!.data;
    expect(JSON.stringify(before)).toContain(EMAIL);
    expect(JSON.stringify(redactions[0]!(before))).not.toContain(EMAIL);
    expect(JSON.stringify(log.slice(1))).not.toContain(EMAIL);
  });

  it("covers an agent's tool calls: the model gets the value, the agent's result keeps the token", async () => {
    const seen: string[] = [];
    class Scripted implements LLMProviderAdapter {
      readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
      async generate(request: ProviderCallRequest) {
        const tool = request.messages.find((message: ChatMessage) => message.role === "tool");
        if (!tool) return { content: "Restoring.", toolCalls: [{ id: "call-1", name: "gateway-mcp__restore_sensitive_data", arguments: { text: `Mail ${TOKEN}` } }] };
        seen.push(String(tool.content));
        return { content: "Done.", toolCalls: [] };
      }
    }
    const workflow: Workflow = {
      id: "wf-agent",
      name: "Agent",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        node("in", "webhook_input"),
        node("agent", "agent_orchestrator", { maxIterations: 3, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }),
        node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("tools", "mcp_tool", { serverId: "gateway-mcp", toolName: "__all__" }),
        node("out", "output")
      ],
      edges: [
        { id: "e1", source: "in", target: "agent" },
        { id: "e2", source: "agent", target: "out" },
        { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" },
        { id: "e4", source: "agent", sourceHandle: "tool", target: "tools" }
      ]
    };
    const events: unknown[] = [];
    const result = await executeWorkflow(
      { workflow, executionId: "exec-4", webhookPayload: { user_prompt: "Restore it" } },
      deps(adapters([]), { verifySensitiveValues: verify, onNodeComplete: (event) => void events.push(event), onNodeActivity: (event) => void events.push(event) }, [new Scripted()])
    );
    expect(result.status, result.error).toBe("success");
    expect(seen.join("")).toContain(EMAIL);
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(JSON.stringify(result)).toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(EMAIL);
  });
});

describe("observeSensitiveResults", () => {
  it("wraps each adapter once and passes other registry calls through", async () => {
    const registry = createDefaultMCPRegistry();
    for (const adapter of adapters([])) registry.register(adapter);
    const redactor = new RevealRedactor();
    const observed = observeSensitiveResults(registry, redactor, verify);
    expect(observeSensitiveResults(observed, redactor, verify)).toBe(observed);
    expect(observed.get("gateway-mcp")).toBe(observed.get("gateway-mcp"));
    expect(observed.tryGet("missing")).toBeUndefined();
    expect(observed.listDefinitions().map((definition) => definition.id)).toContain("gateway-mcp");
    await observed.get("gateway-mcp").invokeTool("restore_sensitive_data", { text: TOKEN }, { serverId: "gateway-mcp" } as never, {} as never);
    expect(redactor.redactText(EMAIL)).toBe(TOKEN);
  });
});
