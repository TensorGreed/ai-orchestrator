import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import {
  createDefaultGuardRegistry,
  hashGuardProfile,
  InMemoryTokenVaultStorage,
  parseGuardProfile,
  surrogateFor,
  type GuardProfileInput
} from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { DataDestinationRow, DataLabels, Workflow, WorkflowEdge, WorkflowExecutionResult, WorkflowExecutionState, WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { builtInGuardProfile, type GuardRunResolution, type GuardVerdictEvent, type ResolvedGuardProfile } from "./guard-runtime";
import { describeEgressRequest, isEgressNodeType } from "./destination-guard";

/**
 * Phase 16 — destination rules and the egress checkpoint wired into the
 * engine: model calls (LLM nodes and agents), MCP calls, HTTP Request and
 * connector senders, redirects, replays, approvals and runtime surrogates;
 * and the zero-config path, where none of it runs.
 */

const CARD = "4111 1111 1111 1111";
const KEY = new Uint8Array(32).fill(7);
const L = (provenance: DataLabels["provenance"], dataClasses: string[] = []): DataLabels => ({ provenance, dataClasses, source: "propagated" });

function resolved(id: string, document: Omit<GuardProfileInput, "id" | "name" | "version">, version = 1): ResolvedGuardProfile {
  const profile = parseGuardProfile({ id, name: id, version: "1", ...document });
  return { profileId: id, version, hash: hashGuardProfile(profile), name: profile.name, profile };
}

const IN_HOUSE = { dataClasses: ["card_number", "iban", "us_ssn", "credential"] };
const rule = (action: string, extra: Record<string, unknown> = {}) => ({ name: "Keep sensitive data in-house", when: IN_HOUSE, allow: { maxTier: "private" }, action, ...extra });

const PROFILES = {
  default: builtInGuardProfile(),
  block: resolved("block", { destinations: { rules: [rule("block")] } } as never),
  shadow: resolved("shadow", { destinations: { rules: [rule("block", { shadow: true })] } } as never),
  approval: resolved("approval", { destinations: { rules: [rule("require_approval")] } } as never),
  redact: resolved("redact", { destinations: { rules: [rule("redact")] } } as never),
  surrogate: resolved("surrogate", {
    destinations: { rules: [rule("protect")] },
    protection: { dataClasses: { card_number: { providerId: "surrogate", options: {} } }, fallback: "block" }
  } as never),
  egress: resolved("egress", {
    channels: { egress: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { card_number: { action: "block" } }, defaultAction: { action: "allow" } } }
  } as never)
} satisfies Record<string, ResolvedGuardProfile>;

function guardDeps(stack: Array<keyof typeof PROFILES>, options: { rows?: DataDestinationRow[]; surrogateKey?: Uint8Array; mayUseLabels?: () => boolean } = {}) {
  const events: GuardVerdictEvent[] = [];
  const calls = { resolveRun: 0, rows: 0 };
  const profiles = stack.map((id) => PROFILES[id]);
  const resolution: GuardRunResolution = { source: profiles.length ? "project" : "none", stack: profiles, chain: [] };
  const issued = new Set<string>();
  return {
    events,
    calls,
    issued,
    guard: {
      registry: createDefaultGuardRegistry({ resolver: async () => ["93.184.215.14"] }),
      resolveRun: () => {
        calls.resolveRun += 1;
        return resolution;
      },
      loadProfile: (id: string) => (PROFILES as Record<string, ResolvedGuardProfile>)[id],
      vault: new InMemoryTokenVaultStorage(),
      onVerdict: (event: GuardVerdictEvent) => {
        events.push(event);
      },
      destinationRows: () => {
        calls.rows += 1;
        return options.rows ?? [];
      },
      issuedSurrogates: issued,
      ...(options.surrogateKey ? { surrogateKey: options.surrogateKey } : {}),
      ...(options.mayUseLabels ? { mayUseLabels: options.mayUseLabels } : {})
    } satisfies WorkflowExecutionDependencies["guard"]
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

function workflow(nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>): Workflow {
  return { id: "wf-dest", name: "Destinations", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })) };
}

/** A model that records what it was sent, and calls the tool once when it has one. */
class RecordingModel implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly prompts: string[] = [];
  constructor(private readonly reply = "All done.", private readonly toolCall?: { name: string; args: Record<string, unknown> }) {}
  async generate(request: ProviderCallRequest) {
    this.prompts.push(request.messages.map((message) => message.content).join("\n"));
    const sawTool = request.messages.some((message) => message.role === "tool");
    if (this.toolCall && !sawTool && request.tools?.some((tool) => tool.name === this.toolCall!.name)) {
      return { content: "Calling a tool.", toolCalls: [{ id: "call-1", name: this.toolCall.name, arguments: this.toolCall.args }] };
    }
    return { content: this.reply, toolCalls: [] };
  }
}

function pageAdapter(page: () => unknown, seen: unknown[] = []): MCPServerAdapter {
  return {
    definition: { id: "docs-mcp", label: "Docs", description: "Test pages", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [{ serverId: "docs-mcp", serverLabel: "Docs", name: "fetch_page", description: "Fetch a page", inputSchema: { type: "object", properties: { url: { type: "string" } } } }];
    },
    async invokeTool(_config: unknown, _name: string, args: unknown) {
      seen.push(args);
      return { ok: true, output: page() };
    }
  } as unknown as MCPServerAdapter;
}

function deps(input: { model?: LLMProviderAdapter; guard?: WorkflowExecutionDependencies["guard"]; page?: () => unknown; mcpSeen?: unknown[]; paused?: WorkflowExecutionState[] } = {}): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  if (input.model) providerRegistry.register(input.model);
  const mcpRegistry = createDefaultMCPRegistry();
  mcpRegistry.register(pageAdapter(input.page ?? (() => ({ text: "A quiet page." })), input.mcpSeen));
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    ...(input.guard ? { guard: input.guard } : {}),
    persistPausedExecution: async (paused) => {
      input.paused?.push(paused.state);
    }
  };
}

const resultOf = (result: WorkflowExecutionResult, id: string) => result.nodeResults.filter((entry) => entry.nodeId === id).at(-1);

// A local HTTP server: requests that reach it are recorded.
let server: Server;
let base = "";
const received: Array<{ url: string; body: string }> = [];
beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ url: request.url ?? "", body });
      if (request.url?.startsWith("/redirect")) {
        response.writeHead(302, { location: "http://127.0.0.2:9/next" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** in (webhook) → http (POST the prompt) → out */
function httpWorkflow(url: string) {
  return workflow(
    [node("in", "webhook_input"), node("http", "http_request", { method: "POST", urlTemplate: url, bodyTemplate: '{"note":"{{user_prompt}}"}', headersTemplate: '{"x-note":"{{user_prompt}}"}' }), node("out", "output")],
    [{ source: "in", target: "http" }, { source: "http", target: "out" }]
  );
}

/** Rows that make the local test server a public destination (its loopback address is local by default). */
const PUBLIC_LOCALHOST: DataDestinationRow[] = [
  { id: "dst_pub", name: "Test server", kind: "http", targetId: null, host: "127.0.0.1", tier: "public", region: "unknown", holdsDataClasses: [], createdAt: "", updatedAt: "", createdBy: null, updatedBy: null } as unknown as DataDestinationRow
];
const PUBLIC_SECOND_HOP: DataDestinationRow[] = [{ ...PUBLIC_LOCALHOST[0]!, id: "dst_hop", host: "127.0.0.2" } as DataDestinationRow];

describe("zero config", () => {
  it("the built-in default profile checks no outbound call: no destination read, no verdict, the request goes out", async () => {
    const harness = guardDeps(["default"]);
    const before = received.length;
    const result = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "z1", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard }));
    expect(result.status).toBe("success");
    expect(received.length).toBe(before + 1);
    expect(harness.events).toEqual([]);
    expect(harness.calls.rows).toBe(0);
  });

  it("when no stored profile can opt in, the run does not even resolve its guard stack", async () => {
    const harness = guardDeps(["block"], { mayUseLabels: () => false, rows: PUBLIC_LOCALHOST });
    const result = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "z2", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard }));
    expect(result.status).toBe("success");
    expect(harness.calls.resolveRun).toBe(0);
    expect(harness.calls.rows).toBe(0);
  });
});

describe("egress checkpoint", () => {
  it("blocks a card number leaving for a public host and says why in plain words", async () => {
    const harness = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const before = received.length;
    const result = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "e1", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard }));
    expect(result.status).toBe("error");
    expect(received.length).toBe(before);
    const error = resultOf(result, "http")?.error ?? "";
    expect(error).toContain("was blocked by the guard");
    expect(error).toContain("Data of class card_number may go no further than private network");
    expect(error).toContain("Test server (public)");
    expect(error).not.toContain("4111");
    const event = harness.events.find((entry) => entry.channel === "egress")!;
    expect(event.verdict.destination).toMatchObject({ kind: "http", host: "127.0.0.1", tier: "public", name: "Test server" });
    expect(event.verdict.actions[0]).toMatchObject({ detectorId: "<destinations>", effective: "block", dataClass: "card_number" });
  });

  it("lets the same request go to a local host, and data without a listed class anywhere", async () => {
    const local = guardDeps(["block"]);
    const toLocal = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "e2", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: local.guard }));
    expect(toLocal.status).toBe("success");
    const plain = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const clean = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "e3", webhookPayload: { user_prompt: "hello" } }, deps({ guard: plain.guard }));
    expect(clean.status).toBe("success");
  });

  it("a class only the labels carry blocks, with the label-only reason", async () => {
    const harness = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const wf = workflow(
      [node("in", "webhook_input"), node("http", "http_request", { method: "POST", urlTemplate: `${base}/plain`, bodyTemplate: "ping" }), node("out", "output")],
      [{ source: "in", target: "http" }, { source: "http", target: "out" }]
    );
    // The input held a card; the request body does not, but the node read the input (a root node reads the run input).
    const result = await executeWorkflow(
      { workflow: wf, executionId: "e4", webhookPayload: { user_prompt: "x" }, inputLabels: L(["user"], ["card_number"]) },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("error");
    expect(resultOf(result, "http")?.error).toContain("matched by where the data came from, not found in the text");
  });

  it("redact rewrites the body and header values that leave", async () => {
    const harness = guardDeps(["redact"], { rows: PUBLIC_LOCALHOST });
    const before = received.length;
    const result = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain?card=${encodeURIComponent(CARD)}`), executionId: "e5", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard }));
    expect(result.status).toBe("success");
    const sent = received.slice(before)[0]!;
    expect(sent.body).toContain("[REDACTED:card_number]");
    expect(sent.body).not.toContain("4111");
    expect(decodeURIComponent(sent.url)).not.toContain("4111");
  });

  it("shadow mode records the verdict and lets the request through", async () => {
    const harness = guardDeps(["shadow"], { rows: PUBLIC_LOCALHOST });
    const before = received.length;
    const result = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "e6", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard }));
    expect(result.status).toBe("success");
    expect(received.length).toBe(before + 1);
    const action = harness.events.flatMap((event) => event.verdict.actions).find((entry) => entry.detectorId === "<destinations>")!;
    expect(action).toMatchObject({ effective: "block", shadow: true });
  });

  it("a profile's egress channel detectors check what leaves too", async () => {
    const harness = guardDeps(["egress"]);
    const result = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "e7", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard }));
    expect(result.status).toBe("error");
    expect(harness.events[0]?.channel).toBe("egress");
  });

  it("judges a redirect by the strictest hop and stops before following it", async () => {
    const harness = guardDeps(["block"], { rows: PUBLIC_SECOND_HOP });
    const before = received.length;
    const result = await executeWorkflow({ workflow: httpWorkflow(`${base}/redirect`), executionId: "e8", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard }));
    expect(result.status).toBe("error");
    expect(received.length).toBe(before + 1);
    expect(resultOf(result, "http")?.error).toContain("redirected to 127.0.0.2");
    const redirect = harness.events.at(-1)!;
    expect(redirect.verdict.destination).toMatchObject({ host: "127.0.0.2", tier: "public" });
  });

  it("require_approval pauses through the approval inbox and runs the request once approved", async () => {
    const paused: WorkflowExecutionState[] = [];
    const harness = guardDeps(["approval"], { rows: PUBLIC_LOCALHOST });
    const before = received.length;
    const first = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "e9", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard, paused }));
    expect(first.status).toBe("waiting_approval");
    expect(received.length).toBe(before);
    expect(paused[0]!.approvalHandoff).toMatchObject({ kind: "rerun", source: "egress_guard" });
    const again = guardDeps(["approval"], { rows: PUBLIC_LOCALHOST });
    const resumed = await resumeWorkflowExecution({ executionId: "e9", state: paused[0]!, decision: "approve", actedBy: "admin" }, deps({ guard: again.guard }));
    expect(resumed.status).toBe("success");
    expect(received.length).toBe(before + 1);
  });

  it("in a replay the check runs before the stub: nothing is sent, nothing pauses", async () => {
    const stubHook = (target: { type: string }) => (target.type === "http_request" ? { kind: "output" as const, output: { status: 200, body: "recorded" } } : null);
    for (const [profile, words] of [["block", "was blocked by the guard"], ["approval", "would wait for approval"]] as const) {
      const harness = guardDeps([profile], { rows: PUBLIC_LOCALHOST });
      const before = received.length;
      const result = await executeWorkflow(
        { workflow: httpWorkflow(`${base}/plain`), executionId: `r-${profile}`, webhookPayload: { user_prompt: `card ${CARD}` } },
        { ...deps({ guard: harness.guard }), replayNodeHook: stubHook }
      );
      expect(result.status).toBe("error");
      expect(resultOf(result, "http")?.error).toContain(words);
      expect(received.length).toBe(before);
    }
    const clean = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const ok = await executeWorkflow(
      { workflow: httpWorkflow(`${base}/plain`), executionId: "r-clean", webhookPayload: { user_prompt: "hello" } },
      { ...deps({ guard: clean.guard }), replayNodeHook: stubHook }
    );
    expect(ok.status).toBe("success");
    expect((resultOf(ok, "http")?.output as Record<string, unknown>).body).toBe("recorded");
  });

  it("describes connector senders by their rendered settings, without secret values or references", () => {
    expect(isEgressNodeType("slack_send_message")).toBe(true);
    expect(isEgressNodeType("smtp_send_email")).toBe(true);
    expect(isEgressNodeType("slack_trigger")).toBe(false);
    expect(isEgressNodeType("set_node")).toBe(false);
    const slack = describeEgressRequest(
      node("s", "slack_send_message"),
      { webhookUrl: "https://hooks.slack.com/services/T/B/x", text: "Card {{user_prompt}} via {{vars.relay}}", secretRef: { secretId: "slack-hook" }, max_tokens: "{{user_prompt}}" },
      { user_prompt: CARD, vars: { relay: "xoxb-secret-value-1" } },
      { secretValues: ["xoxb-secret-value-1"] }
    )!;
    expect(slack.refs[0]).toEqual({ kind: "connector", id: "slack_send_message", host: "hooks.slack.com" });
    expect(JSON.stringify(slack.content)).toContain(CARD);
    // Secret references never enter the check; other values are checked whatever their key is called.
    expect(JSON.stringify(slack.content)).not.toContain("slack-hook");
    expect(JSON.stringify((slack.content as { settings: Record<string, unknown> }).settings.max_tokens)).toContain(CARD);
    // A secret value stays in place for the scan (so it cannot split a finding) and is named as ignored:
    // a finding entirely inside it is not counted.
    expect(slack.ignoredValues).toEqual(["xoxb-secret-value-1"]);
    // Content holding a secret value cannot be rewritten: blocked instead.
    expect(slack.apply({ connector: "slack_send_message", settings: { text: "x" } })).toBeNull();
    const smtp = describeEgressRequest(node("m", "smtp_send_email"), { host: "smtp.example.com", to: "a@b.c" }, {})!;
    expect(smtp.refs[0]).toEqual({ kind: "connector", id: "smtp_send_email", host: "smtp.example.com" });

    // The handler gets the checked renderings: a rewrite maps onto the template text it came from.
    const plain = describeEgressRequest(node("s", "slack_send_message"), { webhookUrl: "https://hooks.slack.com/services/T/B/x", text: "Card {{user_prompt}}", channel: "#ops" }, { user_prompt: CARD })!;
    expect(plain.sent).toEqual({ kind: "renderings", renderings: new Map([["Card {{user_prompt}}", `Card ${CARD}`]]) });
    const rewritten = plain.apply({ connector: "slack_send_message", settings: { webhookUrl: "https://hooks.slack.com/services/T/B/x", text: "Card [REDACTED:card_number]", channel: "#ops" } });
    expect(rewritten).toEqual({ kind: "renderings", renderings: new Map([["Card {{user_prompt}}", "Card [REDACTED:card_number]"]]) });
    // A changed literal (the handler may send it as it is) or a dropped key cannot be applied: blocked.
    expect(plain.apply({ connector: "slack_send_message", settings: { webhookUrl: "https://hooks.slack.com/services/T/B/x", text: `Card ${CARD}`, channel: "#[x]" } })).toBeNull();
    expect(plain.apply({ connector: "slack_send_message", settings: { text: "Card [REDACTED:card_number]" } })).toBeNull();
  });
});

describe("model and MCP calls", () => {
  it("an LLM node's prompt is judged against its provider (an unknown host is public)", async () => {
    const harness = guardDeps(["block"]);
    const model = new RecordingModel();
    const wf = workflow(
      [node("in", "webhook_input"), node("llm", "llm_call", { provider: { providerId: "scripted", model: "m" } }), node("out", "output")],
      [{ source: "in", target: "llm" }, { source: "llm", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "m1", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard, model }));
    expect(result.status).toBe("error");
    expect(model.prompts).toEqual([]);
    expect(harness.events[0]).toMatchObject({ channel: "prompt", verdict: { destination: { kind: "model_provider", id: "scripted", tier: "public" } } });
  });

  it("an MCP Tool node's arguments are judged against its server", async () => {
    const harness = guardDeps(["block"]);
    const seen: unknown[] = [];
    const wf = workflow(
      [node("in", "webhook_input"), node("tool", "mcp_tool", { serverId: "docs-mcp", toolName: "fetch_page", argsTemplate: '{"url":"{{user_prompt}}"}' }), node("out", "output")],
      [{ source: "in", target: "tool" }, { source: "tool", target: "out" }]
    );
    const blocked = await executeWorkflow({ workflow: wf, executionId: "m2", webhookPayload: { user_prompt: CARD } }, deps({ guard: harness.guard, mcpSeen: seen }));
    expect(blocked.status).toBe("error");
    expect(seen).toEqual([]);
    expect(harness.events[0]).toMatchObject({ channel: "tool_arguments", verdict: { destination: { kind: "mcp_server", tier: "public" } } });
    const clean = await executeWorkflow({ workflow: wf, executionId: "m3", webhookPayload: { user_prompt: "https://example.com" } }, deps({ guard: guardDeps(["block"]).guard, mcpSeen: seen }));
    expect(clean.status).toBe("success");
    expect(seen).toHaveLength(1);
  });

  it("an agent: a tool result with a card stops the next model call to a public provider", async () => {
    const harness = guardDeps(["block"]);
    const model = new RecordingModel("Done.", { name: "docs-mcp__fetch_page", args: { url: "https://example.com" } });
    const wf = workflow(
      [
        node("in", "webhook_input"),
        node("agent", "agent_orchestrator", { maxIterations: 4, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }),
        node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("tool", "mcp_tool", { serverId: "docs-mcp", toolName: "fetch_page" }),
        node("out", "output")
      ],
      [
        { source: "in", target: "agent" },
        { source: "agent", target: "out" },
        { source: "agent", sourceHandle: "chat_model", target: "model" },
        { source: "agent", sourceHandle: "tool", target: "tool" }
      ]
    );
    const result = await executeWorkflow(
      { workflow: wf, executionId: "m4", webhookPayload: { user_prompt: "Read the page" } },
      deps({ guard: harness.guard, model, page: () => ({ text: `Billing card ${CARD}` }) })
    );
    expect(result.status).toBe("error");
    // The first call went out; the second (with the card from the tool result) did not.
    expect(model.prompts).toHaveLength(1);
    const blocked = harness.events.find((event) => event.verdict.action === "block")!;
    expect(blocked.channel).toBe("prompt");
    expect(blocked.verdict.destination?.kind).toBe("model_provider");
  });
});

describe("runtime surrogates", () => {
  it("protect issues a surrogate with the deployment key; later checks ignore it and the class leaves the labels", async () => {
    const harness = guardDeps(["surrogate"], { surrogateKey: KEY, rows: PUBLIC_LOCALHOST });
    const model = new RecordingModel();
    const echo: LLMProviderAdapter = {
      definition: { id: "scripted", label: "Echo", supportsTools: false, configSchema: {} },
      async generate(request: ProviderCallRequest) {
        model.prompts.push(request.messages.map((message) => message.content).join("\n"));
        return { content: request.messages.at(-1)!.content, toolCalls: [] };
      }
    } as unknown as LLMProviderAdapter;
    const wf = workflow(
      [
        node("in", "webhook_input"),
        node("llm", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("http", "http_request", { method: "POST", urlTemplate: `${base}/plain`, bodyTemplate: "{{results.llm.text}}" }),
        node("out", "output")
      ],
      [{ source: "in", target: "llm" }, { source: "llm", target: "http" }, { source: "http", target: "out" }]
    );
    const before = received.length;
    const result = await executeWorkflow({ workflow: wf, executionId: "s1", webhookPayload: { user_prompt: `card ${CARD}` }, inputLabels: L(["user"]) }, deps({ guard: harness.guard, model: echo }));
    const surrogate = surrogateFor(CARD, "card_number", KEY);
    expect(model.prompts[0]).toContain(surrogate);
    expect(model.prompts[0]).not.toContain(CARD);
    expect(harness.issued.has(surrogate)).toBe(true);
    // The HTTP request carries the surrogate to a public host: not counted as a card.
    expect(result.status).toBe("success");
    expect(received.slice(before)[0]?.body).toContain(surrogate);
    expect(resultOf(result, "llm")?.labels?.dataClasses ?? []).not.toContain("card_number");
  });

  it("without the deployment key, a surrogate rule falls back to the profile fallback (block)", async () => {
    const harness = guardDeps(["surrogate"]);
    const model = new RecordingModel();
    const wf = workflow(
      [node("in", "webhook_input"), node("llm", "llm_call", { provider: { providerId: "scripted", model: "m" } }), node("out", "output")],
      [{ source: "in", target: "llm" }, { source: "llm", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "s2", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard, model }));
    expect(result.status).toBe("error");
    expect(model.prompts).toEqual([]);
  });
});

describe("RAG senders", () => {
  /** in → rag node → out */
  const ragWorkflow = (type: string, config: Record<string, unknown>) =>
    workflow([node("in", "webhook_input"), node("rag", type, config), node("out", "output")], [{ source: "in", target: "rag" }, { source: "rag", target: "out" }]);
  const documents = [{ id: "d1", text: `Customer card ${CARD}` }, { id: "d2", text: "Opening hours" }];

  it("rag_retrieve: the documents and the query are judged against the embedder before any embedding call", async () => {
    for (const [embedder, settings] of [
      ["openai-embedder", { baseUrl: `${base}/v1` }],
      ["openai-embedder", {}],
      ["cohere-embedder", {}]
    ] as const) {
      const harness = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
      const before = received.length;
      const result = await executeWorkflow(
        { workflow: ragWorkflow("rag_retrieve", { embedderId: embedder, vectorStoreConfig: settings }), executionId: `rag-${embedder}`, webhookPayload: { user_prompt: "hours?", documents } },
        deps({ guard: harness.guard })
      );
      expect(result.status, embedder).toBe("error");
      expect(resultOf(result, "rag")?.error, embedder).toContain("was blocked by the guard");
      expect(received.length).toBe(before);
      expect(harness.events.find((event) => event.channel === "egress")?.verdict.destination?.kind).toBe("connector");
    }
  });

  it("rag_retrieve: a vector store that is a network service is judged too (upserts carry the documents)", async () => {
    const harness = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const before = received.length;
    const result = await executeWorkflow(
      {
        workflow: ragWorkflow("rag_retrieve", { embedderId: "token-embedder", vectorStoreId: "qdrant-vector-store", vectorStoreConfig: { endpoint: base, collectionName: "c" } }),
        executionId: "rag-qdrant",
        webhookPayload: { user_prompt: "hours?", documents }
      },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("error");
    expect(received.length).toBe(before);
    expect(harness.events.find((event) => event.channel === "egress")?.verdict.destination).toMatchObject({ host: "127.0.0.1", tier: "public" });
  });

  it("rag_retrieve with the in-process embedder and store sends nothing: not checked, runs as before", async () => {
    const harness = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const result = await executeWorkflow(
      { workflow: ragWorkflow("rag_retrieve", {}), executionId: "rag-local", webhookPayload: { user_prompt: "hours?", documents } },
      deps({ guard: harness.guard })
    );
    expect(result.status).toBe("success");
    expect(harness.events).toEqual([]);
  });

  it("embeddings and rerank are judged against their service", async () => {
    const embed = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const before = received.length;
    const embedded = await executeWorkflow(
      { workflow: ragWorkflow("embeddings_azure_openai", { endpoint: base, deployment: "e", secretRef: { secretId: "emb" } }), executionId: "emb", webhookPayload: { user_prompt: `card ${CARD}` } },
      deps({ guard: embed.guard })
    );
    expect(embedded.status).toBe("error");
    expect(resultOf(embedded, "rag")?.error).toContain("was blocked by the guard");
    expect(received.length).toBe(before);

    const rerank = guardDeps(["block"]);
    const reranked = await executeWorkflow(
      { workflow: ragWorkflow("rerank", { providerId: "cohere" }), executionId: "rerank", webhookPayload: { user_prompt: "hours?", documents } },
      deps({ guard: rerank.guard })
    );
    expect(reranked.status).toBe("error");
    expect(resultOf(reranked, "rag")?.error).toContain("api.cohere.com");
  });
});

describe("what leaves, as it reads", () => {
  it("a percent-encoded card in the path and a form-encoded card in the body are seen", async () => {
    const path = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const before = received.length;
    const encoded = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain/4111%201111%201111%201111`), executionId: "enc-1", webhookPayload: { user_prompt: "hi" } }, deps({ guard: path.guard }));
    expect(encoded.status).toBe("error");
    const form = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const formWorkflow = workflow(
      [
        node("in", "webhook_input"),
        node("http", "http_request", { method: "POST", urlTemplate: `${base}/plain`, bodyTemplate: "card=4111+1111+1111+1111", headersTemplate: '{"content-type":"application/x-www-form-urlencoded"}' }),
        node("out", "output")
      ],
      [{ source: "in", target: "http" }, { source: "http", target: "out" }]
    );
    const posted = await executeWorkflow({ workflow: formWorkflow, executionId: "enc-2", webhookPayload: {} }, deps({ guard: form.guard }));
    expect(posted.status).toBe("error");
    expect(received.length).toBe(before);
  });

  it("a redirect hop that would need an approval is stopped, not paused (the first request already went out)", async () => {
    const paused: WorkflowExecutionState[] = [];
    const harness = guardDeps(["approval"], { rows: PUBLIC_SECOND_HOP });
    const result = await executeWorkflow({ workflow: httpWorkflow(`${base}/redirect`), executionId: "hop-approval", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: harness.guard, paused }));
    expect(result.status).toBe("error");
    expect(paused).toEqual([]);
    expect(resultOf(result, "http")?.error).toContain("would wait for approval");
  });

  it("an MCP resource read sends its URI: judged against the server", async () => {
    const harness = guardDeps(["block"]);
    const wf = workflow(
      [node("in", "webhook_input"), node("tool", "mcp_tool", { serverId: "docs-mcp", operation: "read_resource", resourceUri: "docs://cards/{{user_prompt}}" }), node("out", "output")],
      [{ source: "in", target: "tool" }, { source: "tool", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "res-1", webhookPayload: { user_prompt: CARD } }, deps({ guard: harness.guard }));
    expect(result.status).toBe("error");
    expect(resultOf(result, "tool")?.error).toContain("was blocked by the guard");
  });
});

describe("model calls outside LLM nodes and agents", () => {
  /** A model whose answer carries the card: the retry would send it back out. */
  class CardAnswer extends RecordingModel {
    override async generate(request: ProviderCallRequest) {
      this.prompts.push(request.messages.map((message) => message.content).join("\n"));
      return { content: `not json, card ${CARD}`, toolCalls: [] };
    }
  }
  // The scripted provider has no known host (public): the clean first call goes out, the retry carries the card.

  it("an Output Parser retry is judged before it sends the upstream text", async () => {
    const model = new CardAnswer();
    const harness = guardDeps(["block"]);
    const wf = workflow(
      [
        node("in", "webhook_input"),
        node("llm", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("parse", "output_parser", { mode: "auto_fix", maxRetries: 1, inputKey: "answer" }),
        node("out", "output")
      ],
      [{ source: "in", target: "llm" }, { source: "llm", target: "parse" }, { source: "parse", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "parser", webhookPayload: { user_prompt: "hello" } }, deps({ guard: harness.guard, model }));
    expect(model.prompts).toHaveLength(1);
    expect(resultOf(result, "parse")?.error).toContain("parser retry model call");
  });

  it("an Output Guardrail retry is judged before it sends the output", async () => {
    const model = new CardAnswer();
    const harness = guardDeps(["block"]);
    const wf = workflow(
      [
        node("in", "webhook_input"),
        node("llm", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("rail", "output_guardrail", { checks: ["must_contain_json"], onFail: "retry" }),
        node("out", "output")
      ],
      [{ source: "in", target: "llm" }, { source: "llm", target: "rail" }, { source: "rail", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "rail", webhookPayload: { user_prompt: "hello" } }, deps({ guard: harness.guard, model }));
    expect(model.prompts).toHaveLength(1);
    expect(resultOf(result, "rail")?.error).toContain("guardrail retry model call");
  });
});

describe("outbound verdict rows", () => {
  it("a clean outbound check writes no row; a finding (shadow included) does", async () => {
    const clean = guardDeps(["default", "block"], { rows: PUBLIC_LOCALHOST });
    const ok = await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "rows-1", webhookPayload: { user_prompt: "hello" } }, deps({ guard: clean.guard }));
    expect(ok.status).toBe("success");
    expect(clean.events.filter((event) => event.channel === "egress")).toEqual([]);

    const shadow = guardDeps(["default", "shadow"], { rows: PUBLIC_LOCALHOST });
    await executeWorkflow({ workflow: httpWorkflow(`${base}/plain`), executionId: "rows-2", webhookPayload: { user_prompt: `card ${CARD}` } }, deps({ guard: shadow.guard }));
    const egress = shadow.events.filter((event) => event.channel === "egress");
    // Only the rules profile found something: the built-in default writes no row for this call.
    expect(egress.map((event) => event.profile.profileId)).toEqual(["shadow"]);
  });

  it("an agent's later model calls record no extra row for the built-in default profile", async () => {
    const harness = guardDeps(["default", "shadow"]);
    const model = new RecordingModel("Done.", { name: "docs-mcp__fetch_page", args: { url: "https://example.com" } });
    const wf = workflow(
      [
        node("in", "webhook_input"),
        node("agent", "agent_orchestrator", { maxIterations: 4, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }),
        node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("tool", "mcp_tool", { serverId: "docs-mcp", toolName: "fetch_page" }),
        node("out", "output")
      ],
      [
        { source: "in", target: "agent" },
        { source: "agent", target: "out" },
        { source: "agent", sourceHandle: "chat_model", target: "model" },
        { source: "agent", sourceHandle: "tool", target: "tool" }
      ]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "rows-3", webhookPayload: { user_prompt: "Read the page" } }, deps({ guard: harness.guard, model }));
    expect(result.status).toBe("success");
    // The default profile's prompt rows: only the user prompt check (iteration 1), none for later model calls.
    const defaultPrompt = harness.events.filter((event) => event.profile.profileId === "default" && event.channel === "prompt");
    expect(defaultPrompt.map((event) => event.iteration)).toEqual([1]);
  });
});

describe("loads made while rendering or browsing", () => {
  it("a chart's data URL is judged as egress before it is fetched", async () => {
    const harness = guardDeps(["block"], { rows: PUBLIC_LOCALHOST });
    const before = received.length;
    const spec = { mark: "bar", data: { url: `${base}/data.json?ssn=${encodeURIComponent(CARD)}` }, encoding: { x: { field: "a", type: "nominal" } } };
    const wf = workflow([node("in", "webhook_input"), node("chart", "chart", { spec }), node("out", "output")], [{ source: "in", target: "chart" }, { source: "chart", target: "out" }]);
    const result = await executeWorkflow({ workflow: wf, executionId: "chart-1", webhookPayload: {} }, deps({ guard: harness.guard }));
    expect(result.status).toBe("error");
    expect(received.length).toBe(before);
    expect(harness.events.find((event) => event.channel === "egress")?.verdict.destination).toMatchObject({ host: "127.0.0.1", tier: "public" });
  });
});
