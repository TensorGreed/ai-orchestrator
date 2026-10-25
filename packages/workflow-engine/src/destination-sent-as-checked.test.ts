import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultGuardRegistry, hashGuardProfile, InMemoryTokenVaultStorage, parseGuardProfile, type GuardProfileInput } from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { DataDestinationRow, McpSamplingRequest, Workflow, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import type { GuardRunResolution, GuardVerdictEvent, ResolvedGuardProfile } from "./guard-runtime";
import { createMcpSamplingHandler } from "./mcp-client-features";
import { DEFAULT_OUTBOUND_GUARD, playwrightOutboundGuard, playwrightWebSocketGuard, type PlaywrightRouteLike } from "./outbound-url-guard";

/**
 * Phase 16 — what leaves is exactly what the outbound check judged: a
 * template is rendered once (by the check) and the handler sends that
 * rendering, so an expression that renders differently each time (time,
 * randomness) cannot show the check one thing and send another. Also the
 * browser route guard under destination rules, and MCP sampling requests.
 */

const CARD = "4111 1111 1111 1111";

// `{{flip}}` renders "nothing" the first time and the card every later time: a stand-in for `Math.random()` or `new Date()`.
const flips = vi.hoisted(() => ({ count: 0 }));
vi.mock("./template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./template")>();
  const flip = (template: string) => template.split("{{flip}}").join(flips.count++ === 0 ? "nothing" : "4111 1111 1111 1111");
  return {
    ...actual,
    renderTemplate: (template: string, values: Record<string, unknown>) =>
      template.includes("{{flip}}") ? flip(template) : actual.renderTemplate(template, values),
    // A connector's fresh rendering (a miss) flips too; a checked one is served as it was judged.
    renderCheckedTemplate: (template: string, values: Record<string, unknown>) => {
      const checked = actual.renderCheckedTemplate(template, values);
      return template.includes("{{flip}}") && checked === template ? flip(template) : checked;
    }
  };
});

function resolved(id: string, document: Omit<GuardProfileInput, "id" | "name" | "version">): ResolvedGuardProfile {
  const profile = parseGuardProfile({ id, name: id, version: "1", ...document });
  return { profileId: id, version: 1, hash: hashGuardProfile(profile), name: profile.name, profile };
}
const BLOCK = resolved("block", { destinations: { rules: [{ name: "In-house", when: { dataClasses: ["card_number"] }, allow: { maxTier: "private" }, action: "block" }] } } as never);
const PUBLIC_LOCALHOST = [
  { id: "dst_pub", name: "Test server", kind: "http", targetId: null, host: "127.0.0.1", tier: "public", region: "unknown", holdsDataClasses: [], createdAt: "", updatedAt: "", createdBy: null, updatedBy: null },
  { id: "dst_con", name: "Test connector", kind: "connector", targetId: null, host: "127.0.0.1", tier: "public", region: "unknown", holdsDataClasses: [], createdAt: "", updatedAt: "", createdBy: null, updatedBy: null }
] as unknown as DataDestinationRow[];

function guard() {
  const events: GuardVerdictEvent[] = [];
  const resolution: GuardRunResolution = { source: "project", stack: [BLOCK], chain: [] };
  return {
    events,
    guard: {
      registry: createDefaultGuardRegistry({ resolver: async () => ["93.184.215.14"] }),
      resolveRun: () => resolution,
      loadProfile: () => BLOCK,
      vault: new InMemoryTokenVaultStorage(),
      onVerdict: (event: GuardVerdictEvent) => void events.push(event),
      destinationRows: () => PUBLIC_LOCALHOST,
      issuedSurrogates: new Set<string>()
    } satisfies WorkflowExecutionDependencies["guard"]
  };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config });
const workflow = (nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>): Workflow => ({
  id: "wf-sent",
  name: "Sent as checked",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  nodes,
  edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge }))
});

function deps(input: { guard: WorkflowExecutionDependencies["guard"]; mcpSeen?: unknown[] }): WorkflowExecutionDependencies {
  const mcpRegistry = createDefaultMCPRegistry();
  mcpRegistry.register({
    definition: { id: "docs-mcp", label: "Docs", description: "Test", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [{ serverId: "docs-mcp", serverLabel: "Docs", name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } }];
    },
    async invokeTool(_name: string, args: unknown) {
      input.mcpSeen?.push(args);
      return { ok: true, output: { text: "ok" } };
    }
  } as unknown as MCPServerAdapter);
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
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
      received.push(`${request.url ?? ""} ${body}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("the handler sends the rendering the check judged", () => {
  it("HTTP Request: a template that renders differently the second time is not rendered again", async () => {
    flips.count = 0;
    const harness = guard();
    const before = received.length;
    const wf = workflow(
      [node("in", "webhook_input"), node("http", "http_request", { method: "POST", urlTemplate: `${base}/hook`, bodyTemplate: '{"note":"{{flip}}"}' }), node("out", "output")],
      [{ source: "in", target: "http" }, { source: "http", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "m1-http", webhookPayload: {} }, deps({ guard: harness.guard }));
    expect(result.status).toBe("success");
    expect(received.slice(before)).toEqual(['/hook {"note":"nothing"}']);
  });

  it("a connector (Slack webhook): the checked rendering is what the handler posts", async () => {
    flips.count = 0;
    const harness = guard();
    const before = received.length;
    const wf = workflow(
      [node("in", "webhook_input"), node("slack", "slack_send_message", { webhookUrl: `${base}/slack`, text: "Note: {{flip}}" }), node("out", "output")],
      [{ source: "in", target: "slack" }, { source: "slack", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "m1-slack", webhookPayload: {} }, deps({ guard: harness.guard }));
    expect(result.status).toBe("success");
    const sent = received.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Note: nothing");
    expect(sent[0]).not.toContain("4111");
  });

  it("Teams: a templated webhook URL with spaces around it posts to the checked rendering, never a second one", async () => {
    flips.count = 0;
    const harness = guard();
    const before = received.length;
    const wf = workflow(
      [node("in", "webhook_input"), node("teams", "teams_send_message", { webhookUrl: ` ${base}/teams/{{flip}} `, text: "hello" }), node("out", "output")],
      [{ source: "in", target: "teams" }, { source: "teams", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "la-teams", webhookPayload: {} }, deps({ guard: harness.guard }));
    expect(result.status).toBe("success");
    const sent = received.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\/teams\/nothing /);
    expect(sent[0]).not.toContain("4111");
  });

  it("an MCP Tool node: the checked arguments are the ones sent", async () => {
    flips.count = 0;
    const harness = guard();
    const seen: unknown[] = [];
    const wf = workflow(
      [node("in", "webhook_input"), node("tool", "mcp_tool", { serverId: "docs-mcp", toolName: "lookup", argsTemplate: '{"q":"{{flip}}"}' }), node("out", "output")],
      [{ source: "in", target: "tool" }, { source: "tool", target: "out" }]
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "m1-mcp", webhookPayload: {} }, deps({ guard: harness.guard, mcpSeen: seen }));
    expect(result.status).toBe("success");
    expect(seen).toEqual([{ q: "nothing" }]);
  });
});

/** A fake Playwright route: records what happened to it. */
function route(url: string, response?: { status: number; location?: string }, redirectedFrom?: string) {
  const done: string[] = [];
  const target: PlaywrightRouteLike = {
    request: () => ({ url: () => url, redirectedFrom: () => (redirectedFrom ? { url: () => redirectedFrom } : null) }),
    continue: async () => void done.push("continue"),
    abort: async () => void done.push("abort"),
    ...(response
      ? {
          fetch: async () => ({ status: () => response.status, headers: (): Record<string, string> => (response.location ? { location: response.location } : {}) }),
          fulfill: async () => void done.push("fulfill")
        }
      : {})
  };
  return { target, done };
}

describe("browser loads under destination rules", () => {
  const open = { ...DEFAULT_OUTBOUND_GUARD, allowPrivateNetworks: true } as typeof DEFAULT_OUTBOUND_GUARD;
  const resolver = async () => ["93.184.215.14"];

  it("each load is judged with the chain that led to it; a redirect's target is judged before the browser follows it", async () => {
    const judged: Array<{ url: string; chain: string[] }> = [];
    const judge = async (url: string, chain: string[]) => {
      judged.push({ url, chain });
      if (url.includes("evil")) throw new Error("stopped");
    };
    const handler = playwrightOutboundGuard(open, resolver, judge);

    const clean = route("https://example.com/page", { status: 200 });
    await handler(clean.target);
    expect(clean.done).toEqual(["fulfill"]);

    const redirected = route("https://example.com/go", { status: 302, location: "https://evil.example/?ssn=1" });
    await handler(redirected.target);
    expect(redirected.done).toEqual(["abort"]);
    expect(judged.at(-1)).toEqual({ url: "https://evil.example/?ssn=1", chain: ["https://example.com/go"] });

    const later = route("https://evil.example/next", { status: 200 }, "https://example.com/start");
    await handler(later.target);
    expect(later.done).toEqual(["abort"]);
    expect(judged.at(-1)!.chain).toEqual(["https://example.com/start"]);

    // A route that cannot be made here (no fetch) cannot be checked for redirects: stopped.
    const unchecked = route("https://example.com/other");
    await handler(unchecked.target);
    expect(unchecked.done).toEqual(["abort"]);

    // Without rules the guard is as before.
    const plain = route("https://example.com/page");
    await playwrightOutboundGuard(open, resolver)(plain.target);
    expect(plain.done).toEqual(["continue"]);
  });

  it("WebSockets are not opened while rules are on, and the node is told why", async () => {
    const refused: string[] = [];
    const judge = Object.assign(async () => undefined, { refuse: (message: string) => void refused.push(message) });
    const closed: string[] = [];
    await playwrightWebSocketGuard(open, resolver, judge)({ url: () => "wss://example.com/socket?x=1", connectToServer: () => closed.push("connected"), close: async () => void closed.push("closed") });
    expect(closed).toEqual(["closed"]);
    expect(refused[0]).toContain("WebSocket traffic cannot be checked");
    expect(refused[0]).not.toContain("x=1");
  });
});

describe("MCP sampling requests", () => {
  it("are judged before the model is called; a stop refuses the request", async () => {
    const calls: ProviderCallRequest[] = [];
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register({
      definition: { id: "scripted", label: "Scripted", supportsTools: false, configSchema: {} },
      async generate(request: ProviderCallRequest) {
        calls.push(request);
        return { content: "ok", toolCalls: [] };
      }
    } as unknown as LLMProviderAdapter);
    const request: McpSamplingRequest = { messages: [{ role: "user", content: { type: "text", text: `card ${CARD}` } }], maxTokens: 50 };
    const handler = (check: (provider: unknown, messages: Array<{ content: string }>) => Promise<never> | Promise<Array<{ role: "user"; content: string }>>) =>
      createMcpSamplingHandler({
        providerRegistry,
        resolveSecret: async () => undefined,
        provider: { providerId: "scripted" as never, model: "m" },
        serverConfigs: [{ serverId: "docs-mcp", registryServerId: "docs", sampling: { allow: true, maxTokens: 100, allowedModels: [], maxRequestsPerCall: 3, defaultModel: null } } as never],
        trace: [],
        checkModelCall: check as never
      });
    const blocked = handler(async () => {
      throw new Error("Data of class card_number may go no further than private network");
    });
    await expect(blocked.onSampling(request, { serverId: "docs-mcp", registryServerId: "docs", toolName: "t" })).rejects.toThrow(/was not sent: Data of class card_number/);
    expect(calls).toHaveLength(0);

    const rewritten = handler(async (_provider, messages) => messages.map(() => ({ role: "user" as const, content: "card [REDACTED:card_number]" })));
    await rewritten.onSampling(request, { serverId: "docs-mcp", registryServerId: "docs", toolName: "t" });
    expect(calls[0]!.messages.map((message) => message.content)).toEqual(["card [REDACTED:card_number]"]);
  });
});
