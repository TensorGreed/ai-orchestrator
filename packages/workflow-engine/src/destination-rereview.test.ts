import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { azureStorageEndpointFor, createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultGuardRegistry, hashGuardProfile, InMemoryTokenVaultStorage, parseGuardProfile, type GuardProfileInput } from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry, type MCPExecutionContext, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { DataDestinationRow, MCPServerConfig, Workflow, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { describeEgressRequest } from "./destination-guard";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import type { GuardRunResolution, GuardVerdictEvent, ResolvedGuardProfile } from "./guard-runtime";
import { bindCheckedRenderings, renderCheckedTemplate } from "./template";

/**
 * Phase 16 — outbound checks, second round: a rewritten query key, MCP
 * server-prompt arguments and the sampling of the session that fetches them,
 * a checked rendering that is missing, secret values that hide part of a
 * finding, RAG document ids and metadata, and Azure Storage addresses that
 * come from the secret.
 */

const CARD = "4111 1111 1111 1111";
const CARD_DIGITS = /4111.?1111.?1111.?1111/;

function resolved(id: string, document: Omit<GuardProfileInput, "id" | "name" | "version">): ResolvedGuardProfile {
  const profile = parseGuardProfile({ id, name: id, version: "1", ...document });
  return { profileId: id, version: 1, hash: hashGuardProfile(profile), name: profile.name, profile };
}
const rule = (action: string) => ({ name: "In-house", when: { dataClasses: ["card_number"] }, allow: { maxTier: "private" }, action });
const BLOCK = resolved("block", { destinations: { rules: [rule("block")] } } as never);
const REDACT = resolved("redact", { destinations: { rules: [rule("redact")] } } as never);

const row = (id: string, kind: string, host: string, tier = "public") =>
  ({ id, name: id, kind, targetId: null, host, tier, region: "unknown", holdsDataClasses: [], createdAt: "", updatedAt: "", createdBy: null, updatedBy: null }) as unknown as DataDestinationRow;
const PUBLIC_LOCALHOST = [row("h", "http", "127.0.0.1"), row("c", "connector", "127.0.0.1"), row("m", "mcp_server", "127.0.0.1")];

function guard(profile: ResolvedGuardProfile, rows: DataDestinationRow[] = PUBLIC_LOCALHOST) {
  const events: GuardVerdictEvent[] = [];
  const resolution: GuardRunResolution = { source: "project", stack: [profile], chain: [] };
  return {
    events,
    guard: {
      registry: createDefaultGuardRegistry({ resolver: async () => ["93.184.215.14"] }),
      resolveRun: () => resolution,
      loadProfile: () => profile,
      vault: new InMemoryTokenVaultStorage(),
      onVerdict: (event: GuardVerdictEvent) => void events.push(event),
      destinationRows: () => rows,
      issuedSurrogates: new Set<string>()
    } satisfies WorkflowExecutionDependencies["guard"]
  };
}

class RecordingProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };
  calls: ProviderCallRequest[] = [];
  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    return { content: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** A registry MCP server with prompts, at 127.0.0.1 (classified public above). */
const PROMPT_SERVER = "prompts-srv";
function promptAdapter(seen: Array<Record<string, string>>, sample?: string): MCPServerAdapter {
  return {
    definition: { id: "prompt-mcp", label: "Prompts", description: "Test", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [];
    },
    async invokeTool() {
      return { ok: true, output: {} };
    },
    async getPrompt(_name: string, args: Record<string, string>, _config: MCPServerConfig, context: MCPExecutionContext) {
      seen.push(args);
      if (sample !== undefined && context.onSampling) {
        await context.onSampling({ messages: [{ role: "user", content: { type: "text", text: sample } }], maxTokens: 50 }, { serverId: "prompt-mcp", registryServerId: PROMPT_SERVER });
      }
      return { messages: [{ role: "user", content: { type: "text", text: `Explain ${args.topic ?? ""}` } }] };
    }
  } as unknown as MCPServerAdapter;
}

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config });
const workflow = (nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>): Workflow => ({
  id: "wf-rereview",
  name: "Re-review",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  nodes,
  edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge }))
});

function deps(input: {
  guard: WorkflowExecutionDependencies["guard"];
  secrets?: Record<string, string>;
  adapter?: MCPServerAdapter;
  provider?: RecordingProvider;
}): WorkflowExecutionDependencies {
  const mcpRegistry = createDefaultMCPRegistry();
  if (input.adapter) mcpRegistry.register(input.adapter);
  const providerRegistry = new ProviderRegistry();
  if (input.provider) providerRegistry.register(input.provider);
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async (ref) => {
      const value = input.secrets?.[(ref as { secretId: string }).secretId];
      if (value === "<unreadable>") throw new Error("secret store unavailable");
      return value;
    },
    resolveRegisteredMcpServer: (id: string) => {
      if (id !== PROMPT_SERVER) throw new Error(`unknown server ${id}`);
      return {
        serverId: "prompt-mcp",
        registryServerId: PROMPT_SERVER,
        label: "Prompts",
        connection: { endpoint: "http://127.0.0.1:9/mcp" },
        sampling: { allow: true, maxTokens: 1024, allowedModels: [], maxRequestsPerCall: 3, defaultModel: { providerId: "fake", model: "m" } }
      } as MCPServerConfig;
    },
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    guard: input.guard
  };
}

let server: Server;
let base = "";
const received: string[] = [];
beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      let url = request.url ?? "";
      try {
        url = decodeURIComponent(url.replace(/\+/g, " "));
      } catch {
        // kept as sent
      }
      received.push(`${request.method} ${url} ${body}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: [], points: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const httpFlow = (config: Record<string, unknown>) =>
  workflow([node("in", "webhook_input"), node("http", "http_request", config), node("out", "output")], [{ source: "in", target: "http" }, { source: "http", target: "out" }]);

describe("HTTP Request: a rewrite of the query rebuilds it from the rewritten keys and values", () => {
  it("a card in a query key is redacted: the receiver never sees the card, the other values are kept", async () => {
    const harness = guard(REDACT);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: httpFlow({ method: "GET", urlTemplate: `${base}/q?4111%201111%201111%201111=1&x=2` }), executionId: "n1-key", webhookPayload: {} },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("success");
    const sent = received.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(CARD_DIGITS);
    expect(sent[0]).toContain("[REDACTED");
    expect(sent[0]).toContain("x=2");
  });

  it("a rewritten value of a key given twice cannot be split back: blocked, nothing sent", async () => {
    const harness = guard(REDACT);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: httpFlow({ method: "GET", urlTemplate: `${base}/q?c=4111%201111%201111%201111&c=hello` }), executionId: "n1-twice", webhookPayload: {} },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("error");
    expect(received.slice(before)).toEqual([]);
  });

  it("two keys rewritten into the same key cannot be mapped: blocked, nothing sent", async () => {
    const harness = guard(REDACT);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: httpFlow({ method: "GET", urlTemplate: `${base}/q?4111%201111%201111%201111=1&5500%200000%200000%200004=2` }), executionId: "n1-collide", webhookPayload: {} },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("error");
    expect(received.slice(before)).toEqual([]);
  });

  it("the request description: a rewritten key replaces the original one", () => {
    const request = describeEgressRequest({ type: "http_request", name: "h", id: "h" }, { method: "GET", urlTemplate: "https://api.example.com/q?secret=a&x=2" }, {});
    const override = request!.apply({ ...request!.content, query: { other: "b", x: "2" } });
    expect(override).toMatchObject({ kind: "http", url: "https://api.example.com/q?other=b&x=2" });
    expect(request!.apply({ ...request!.content, query: { x: "2" } })).toBeNull();
  });
});

describe("MCP server prompts: the arguments are judged against the server before they are sent", () => {
  const llmFlow = (topic: string) =>
    workflow(
      [node("in", "webhook_input"), node("llm", "llm_call", { provider: { providerId: "fake", model: "m" }, serverPrompt: { registryServerId: PROMPT_SERVER, name: "explain", arguments: { topic } } }), node("out", "output")],
      [{ source: "in", target: "llm" }, { source: "llm", target: "out" }]
    );

  it("an LLM node: a card in an argument for a public server is blocked before prompts/get", async () => {
    const harness = guard(BLOCK);
    const seen: Array<Record<string, string>> = [];
    const provider = new RecordingProvider();
    const result = await executeWorkflow({ workflow: llmFlow("{{card}}"), executionId: "n2-llm", webhookPayload: { card: CARD } }, deps({ guard: harness.guard, adapter: promptAdapter(seen), provider }));
    expect(result.status).toBe("error");
    expect(result.error).toContain("blocked by the guard");
    expect(seen).toEqual([]);
    expect(provider.calls).toEqual([]);
    expect(harness.events[0]).toMatchObject({ channel: "tool_arguments", verdict: { destination: { kind: "mcp_server", tier: "public" } } });
  });

  it("an LLM node: a redact rule sends the rewritten argument", async () => {
    const harness = guard(REDACT);
    const seen: Array<Record<string, string>> = [];
    const result = await executeWorkflow(
      { workflow: llmFlow(`card ${CARD}`), executionId: "n2-redact", webhookPayload: {} },
      deps({ guard: harness.guard, adapter: promptAdapter(seen), provider: new RecordingProvider() })
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.topic).not.toMatch(CARD_DIGITS);
    expect(seen[0]!.topic).toContain("[REDACTED");
    expect(result.status).toBe("success");
  });

  it("an LLM node: clean arguments go out as rendered", async () => {
    const harness = guard(BLOCK);
    const seen: Array<Record<string, string>> = [];
    const result = await executeWorkflow({ workflow: llmFlow("{{topic}}"), executionId: "n2-clean", webhookPayload: { topic: "billing" } }, deps({ guard: harness.guard, adapter: promptAdapter(seen), provider: new RecordingProvider() }));
    expect(result.status).toBe("success");
    expect(seen).toEqual([{ topic: "billing" }]);
  });

  it("an agent: a card in an argument for a public server is blocked before prompts/get", async () => {
    const harness = guard(BLOCK);
    const seen: Array<Record<string, string>> = [];
    const provider = new RecordingProvider();
    const wf = workflow(
      [
        node("in", "webhook_input"),
        node("agent", "agent_orchestrator", { systemPromptTemplate: "S", userPromptTemplate: "hello", maxIterations: 2, serverPrompt: { registryServerId: PROMPT_SERVER, name: "explain", arguments: { topic: "{{card}}" } } }),
        node("model", "llm_call", { provider: { providerId: "fake", model: "m" } }),
        node("out", "output")
      ],
      [{ source: "in", target: "agent" }, { source: "agent", target: "out" }, { source: "agent", target: "model", sourceHandle: "chat_model" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "n2-agent", webhookPayload: { card: CARD } }, deps({ guard: harness.guard, adapter: promptAdapter(seen), provider }));
    expect(result.status).toBe("error");
    expect(seen).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("an LLM node: sampling during the prompt fetch is judged as a model call", async () => {
    const harness = guard(BLOCK);
    const seen: Array<Record<string, string>> = [];
    const provider = new RecordingProvider();
    await executeWorkflow({ workflow: llmFlow("billing"), executionId: "n2-sampling", webhookPayload: {} }, deps({ guard: harness.guard, adapter: promptAdapter(seen, `card ${CARD}`), provider }));
    expect(seen.length).toBeGreaterThan(0);
    expect(provider.calls.some((call) => call.messages.some((message) => CARD_DIGITS.test(message.content)))).toBe(false);
    expect(harness.events.some((event) => event.channel === "prompt" && event.verdict.blocked)).toBe(true);
  });
});

describe("a checked rendering that is missing is never rendered again", () => {
  it("renderCheckedTemplate fails closed on a template the check did not render", () => {
    const data: Record<string, unknown> = { a: "x" };
    bindCheckedRenderings(data, new Map([["{{a}}", "checked"]]));
    expect(renderCheckedTemplate("{{a}}", data)).toBe("checked");
    expect(renderCheckedTemplate("plain text", data)).toBe("plain text");
    expect(() => renderCheckedTemplate(" {{a}} ", data)).toThrow(/not checked/);
    // Without a check, templates render as before.
    expect(renderCheckedTemplate(" {{a}} ", { a: "x" })).toBe(" x ");
  });
});

describe("secret values do not hide what is around them", () => {
  it("a secret value inside a card number does not hide the card", async () => {
    const harness = guard(BLOCK);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: httpFlow({ method: "POST", urlTemplate: `${base}/s`, bodyTemplate: `{"c":"${CARD}"}`, secretRef: { secretId: "short" } }), executionId: "lb-inside", webhookPayload: {} },
      deps({ guard: harness.guard, secrets: { short: "1111" } })
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("blocked by the guard");
    expect(received.slice(before)).toEqual([]);
    expect(JSON.stringify(harness.events)).not.toContain('"1111"');
  });

  it("a finding entirely inside a secret value is not counted", async () => {
    const harness = guard(BLOCK);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: httpFlow({ method: "POST", urlTemplate: `${base}/t`, bodyTemplate: `{"token":"${CARD}"}`, secretRef: { secretId: "tok" } }), executionId: "lb-whole", webhookPayload: {} },
      deps({ guard: harness.guard, secrets: { tok: CARD } })
    );
    expect(result.status).toBe("success");
    expect(received.slice(before)).toHaveLength(1);
    expect(JSON.stringify(harness.events)).not.toContain(CARD);
  });
});

describe("RAG uploads: document ids and metadata are checked content", () => {
  const ragFlow = (documents: unknown[]) =>
    workflow(
      [
        node("in", "webhook_input"),
        node("rag", "rag_retrieve", { embedderId: "token-embedder", vectorStoreId: "qdrant-vector-store", vectorStoreConfig: { endpoint: base, collectionName: "c" }, documents }),
        node("out", "output")
      ],
      [{ source: "in", target: "rag" }, { source: "rag", target: "out" }]
    );

  it("a card only in a document's metadata is blocked before the upsert", async () => {
    const harness = guard(BLOCK);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: ragFlow([{ id: "d1", text: "Opening hours", metadata: { owner: `card ${CARD}` } }]), executionId: "lc-meta", webhookPayload: { user_prompt: "hours?" } },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("error");
    expect(received.slice(before)).toEqual([]);
  });

  it("a card only in a document's id is blocked before the upsert", async () => {
    const harness = guard(BLOCK);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: ragFlow([{ id: `card ${CARD}`, text: "Opening hours" }]), executionId: "lc-id", webhookPayload: { user_prompt: "hours?" } },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("error");
    expect(received.slice(before)).toEqual([]);
  });
});

describe("Azure Storage: an address that comes from the secret", () => {
  it("the adapter's endpoint for its settings and secret", () => {
    const key = Buffer.from("key").toString("base64");
    expect(azureStorageEndpointFor({ accountName: "acct" }, JSON.stringify({ accountName: "acct", accountKey: key, endpoint: "https://store.example.com/" }))).toBe("https://store.example.com");
    expect(azureStorageEndpointFor({ accountName: "acct" }, undefined)).toBe("https://acct.blob.core.windows.net");
    expect(azureStorageEndpointFor({ accountName: "acct", endpoint: "https://e.example.com" }, "anything")).toBe("https://e.example.com");
  });

  it("is judged by the endpoint the adapter will use, not the account's default host", async () => {
    // An admin classified the account's default host as local; the secret points the adapter elsewhere.
    const harness = guard(BLOCK, [row("acct", "connector", "acct.blob.core.windows.net", "local"), ...PUBLIC_LOCALHOST]);
    const secret = JSON.stringify({ accountName: "acct", accountKey: Buffer.from("key").toString("base64"), endpoint: base });
    const wf = workflow(
      [node("in", "webhook_input"), node("az", "azure_storage", { accountName: "acct", operation: "list_blobs", containerName: `c ${CARD}`, secretRef: { secretId: "az" } }), node("out", "output")],
      [{ source: "in", target: "az" }, { source: "az", target: "out" }]
    );
    const before = received.length;
    const result = await executeWorkflow({ workflow: wf, executionId: "ld-secret", webhookPayload: {} }, deps({ guard: harness.guard, secrets: { az: secret } }));
    expect(result.status).toBe("error");
    expect(result.error).toContain("blocked by the guard");
    expect(harness.events[0]).toMatchObject({ verdict: { destination: { kind: "connector", host: "127.0.0.1", tier: "public" } } });
    expect(received.slice(before)).toEqual([]);
  });

  it("a secret that cannot be read leaves the endpoint unknown: public", async () => {
    const harness = guard(BLOCK, [row("acct", "connector", "acct.blob.core.windows.net", "local")]);
    const wf = workflow(
      [node("in", "webhook_input"), node("az", "azure_storage", { accountName: "acct", operation: "list_blobs", containerName: `c ${CARD}`, secretRef: { secretId: "broken" } }), node("out", "output")],
      [{ source: "in", target: "az" }, { source: "az", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "ld-unknown", webhookPayload: {} }, deps({ guard: harness.guard, secrets: { broken: "<unreadable>" } }));
    expect(result.status).toBe("error");
    expect(result.error).toContain("to an unknown host");
    expect(harness.events[0]?.verdict.destination).toEqual({ kind: "connector", id: "azure_storage", tier: "public", region: "unknown", matchedBy: "unmatched" });
  });
});

describe("round 3: query keys are checked and rewritten by name", () => {
  it("a query key named __proto__ is checked content: HTTP Request blocks a card in it", async () => {
    const harness = guard(BLOCK);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: httpFlow({ method: "GET", urlTemplate: `${base}/q?__proto__=4111%201111%201111%201111` }), executionId: "l-e-http", webhookPayload: {} },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("error");
    expect(received.slice(before)).toEqual([]);
  });

  it("under a redact rule the card in a __proto__ key never reaches the receiver", async () => {
    const harness = guard(REDACT);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: httpFlow({ method: "GET", urlTemplate: `${base}/q?__proto__=4111%201111%201111%201111&x=2` }), executionId: "l-e-redact", webhookPayload: {} },
      deps({ guard: harness.guard })
    );
    for (const line of received.slice(before)) expect(line).not.toMatch(CARD_DIGITS);
    if (result.status === "success") expect(received.slice(before)).toHaveLength(1);
  });

  it("Web Browse checks the same key (constructor and prototype too)", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const request = describeEgressRequest({ type: "web_browse", name: "b", id: "b" }, { url: `https://api.example.com/q?${key}=${encodeURIComponent(CARD)}` }, {});
      expect(JSON.stringify(request!.content)).toContain(CARD);
      expect(Object.entries(request!.content.query as Record<string, string>)).toEqual([[key, CARD]]);
    }
  });

  it("an integer-like key next to a repeated key is redacted, not blocked", async () => {
    const harness = guard(REDACT);
    const before = received.length;
    const result = await executeWorkflow(
      { workflow: httpFlow({ method: "GET", urlTemplate: `${base}/q?x=a&x=b&5=4111%201111%201111%201111` }), executionId: "l-f", webhookPayload: {} },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("success");
    const sent = received.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(CARD_DIGITS);
    expect(sent[0]).toContain("5=[REDACTED");
    expect(sent[0]).toContain("x=a");
    expect(sent[0]).toContain("x=b");
  });
});
