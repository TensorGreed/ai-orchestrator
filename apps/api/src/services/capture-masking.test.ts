import { describe, expect, it } from "vitest";
import { canonicalJson, type McpCassette, type ModelMemorySeed, type ModelTape, type RunFacts } from "@ai-orchestrator/shared";
import { MaskIdentifierError, surrogateFor } from "@ai-orchestrator/guard-sdk";
import { canonicalJson as cassetteCanonical, hashCassetteArgs } from "@ai-orchestrator/mcp-sdk";
import { canonicalTapeJson, hashModelRequest } from "@ai-orchestrator/provider-sdk";
import { sha256Hex } from "./audit-bundle-service.js";
import { cassetteIdentifiers, inputProvenance, maskCapturedRun, maskCapturedRunAsync, provenanceFor, withNodeLabels, type CapturedRunParts } from "./capture-masking.js";

const key = Buffer.from("0123456789abcdef0123456789abcdef");
const EMAIL = "jane.doe@example.com";

/** A captured workflow whose supervisor has these workers attached: the runtime names their delegate tools `delegate_to_<name>`. */
function withWorkers(...names: string[]) {
  return {
    nodes: [{ id: "sup", type: "supervisor_node", name: "Sup", config: {} }, ...names.map((name, index) => ({ id: `w${index}`, type: "agent_orchestrator", name, config: {} }))],
    edges: names.map((_, index) => ({ id: `e${index}`, source: "sup", target: `w${index}`, sourceHandle: "worker" }))
  };
}

function run() {
  const facts: RunFacts = {
    status: "success",
    error: null,
    output: { answer: `Mailed ${EMAIL}` },
    nodes: [
      { nodeId: "hook", nodeType: "webhook_input", status: "success", durationMs: 1, errorCategory: null },
      { nodeId: "lookup", nodeType: "mcp_tool", status: "success", durationMs: 2, errorCategory: null },
      { nodeId: "out", nodeType: "output", status: "success", durationMs: 1, errorCategory: null }
    ],
    toolCalls: [{ nodeId: "lookup", iteration: 1, server: "crm", tool: "find", args: { email: EMAIL }, argsHash: "stale" } as RunFacts["toolCalls"][number]],
    modelCalls: [],
    guard: [],
    totals: {} as RunFacts["totals"]
  };
  const cassette = {
    format: "l2m.mcp-cassette",
    version: 1,
    recordedAt: "2026-10-24T00:00:00.000Z",
    servers: [],
    entries: [{ seq: 1, server: "crm", method: "tools/call", name: "find", args: { email: EMAIL }, argsHash: "stale", result: { owner: EMAIL }, at: 0 }]
  } as unknown as McpCassette;
  const request: ModelTape["entries"][number]["request"] = { messages: [{ role: "user", content: `Who is ${EMAIL}?` }], tools: null, params: { model: "m" } };
  const modelTape = {
    format: "l2m.model-tape",
    version: 1,
    recordedAt: "2026-10-24T00:00:00.000Z",
    entries: [{ seq: 1, nodeId: "lookup", iteration: 0, providerId: "openai", model: "m", requestHash: "stale", request, response: { content: `It is ${EMAIL}` }, at: 0 }]
  } as unknown as ModelTape;
  const memorySeed: ModelMemorySeed = { sessions: [{ namespace: "ns", sessionId: EMAIL, messages: [{ role: "user", content: EMAIL }] }], truncated: false };
  return {
    input: { user_prompt: `I am ${EMAIL}`, from: "Support <support@acme.test>" },
    nodes: {
      hook: { nodeId: "hook", nodeType: "webhook_input", status: "success", output: { email: EMAIL } },
      lookup: { nodeId: "lookup", nodeType: "mcp_tool", status: "success", output: { owner: EMAIL } },
      out: { nodeId: "out", nodeType: "output", status: "success", output: { answer: "done" } }
    },
    facts,
    cassette,
    modelTape,
    memorySeed
  };
}

describe("maskCapturedRun", () => {
  it("replaces the value with one surrogate in every part and takes the match keys again over the masked content", () => {
    const masked = maskCapturedRun(run(), { key, dictionaries: [], keepLiteralsFrom: { nodes: [{ config: { note: "Mail support@acme.test" } }] } });
    const surrogate = surrogateFor(EMAIL, "email", key);
    const text = JSON.stringify(masked);
    expect(text).not.toContain(EMAIL);
    expect(text).toContain(surrogate);
    // A value the workflow itself holds stays.
    expect(text).toContain("support@acme.test");
    expect(masked.memorySeed!.sessions[0]!.sessionId).toBe(surrogate);

    const tool = masked.facts.toolCalls[0]!;
    expect(tool.args).toEqual({ email: surrogate });
    expect(tool.argsHash).toBe(sha256Hex(canonicalJson({ email: surrogate })));
    const entry = masked.cassette!.entries[0]!;
    expect(entry.argsHash).toBe(hashCassetteArgs(cassetteCanonical({ email: surrogate })));
    expect(entry.result).toEqual({ owner: surrogate });
    const tape = masked.modelTape!.entries[0]!;
    expect(tape.requestHash).toBe(hashModelRequest(canonicalTapeJson({ messages: [{ role: "user", content: `Who is ${surrogate}?` }], tools: null, params: { model: "m" } }) as ModelTape["entries"][number]["request"]));
    expect(masked.report.values).toEqual({ email: 1 });
    expect(masked.report.keptFromWorkflow).toBe(1);
  });

  it("keeps a configured tool's name as written in the tape, so a dictionary term inside one does not change a request hash the replay recomputes", () => {
    const base = run();
    // A worker delegate tool: replay rebuilds it from the workflow, so it is held back as written.
    const tools = [{ name: "delegate_to_atlas-search", description: "Delegate task to atlas-search. Hint: be brief", inputSchema: { type: "object", properties: { task_prompt: { type: "string" } } } }];
    const call = { id: "c1", name: "delegate_to_atlas-search", arguments: { task_prompt: "x" } };
    const request = {
      messages: [
        { role: "user", content: `Who is ${EMAIL}?` },
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", content: "found", name: "delegate_to_atlas-search", toolCallId: "c1" }
      ],
      tools,
      params: { model: "m" }
    };
    base.modelTape = { ...base.modelTape, entries: [{ ...base.modelTape.entries[0]!, request, response: { content: "", toolCalls: [call] } }] } as unknown as ModelTape;
    const masked = maskCapturedRun(base, { key, dictionaries: [{ dataClass: "project", terms: ["atlas"], patterns: [], score: 0.9 }], keepLiteralsFrom: withWorkers("atlas-search") });
    const surrogate = surrogateFor(EMAIL, "email", key);
    const entry = masked.modelTape!.entries[0]!;
    // What the replay recomputes: the live request has the configured tool definitions and tool names, with the content masked.
    const live = canonicalTapeJson({ ...request, messages: [{ ...request.messages[0]!, content: `Who is ${surrogate}?` }, request.messages[1]!, request.messages[2]!] }) as ModelTape["entries"][number]["request"];
    expect(entry.request).toEqual(live);
    expect(entry.requestHash).toBe(hashModelRequest(live));
    expect((entry.response as { toolCalls: Array<{ name: string }> }).toolCalls[0]!.name).toBe("delegate_to_atlas-search");
    expect(JSON.stringify(masked)).not.toContain(EMAIL);
  });

  // Re-review H1: a held-back definition is never stored with a collected value in it.
  it("drops the capture when a configured tool's name, description or schema holds a collected value", () => {
    const dictionaries = [{ dataClass: "project", terms: ["atlas"], patterns: [], score: 0.9 }];
    const withTool = (tool: Record<string, unknown>, content = `Who is ${EMAIL}?`) => {
      const base = run();
      const request = { messages: [{ role: "user", content }], tools: [tool], params: { model: "m" } };
      base.modelTape = { ...base.modelTape, entries: [{ ...base.modelTape.entries[0]!, request }] } as unknown as ModelTape;
      return base;
    };
    const schema = { type: "object", properties: { q: { type: "string" } } };
    expect(() => maskCapturedRun(withTool({ name: "delegate_to_Helper", description: `Delegate task to Helper. Hint: mail ${EMAIL}`, inputSchema: schema }), { key, dictionaries, keepLiteralsFrom: withWorkers("Helper") })).toThrow(MaskIdentifierError);
    expect(() => maskCapturedRun(withTool({ name: "delegate_to_Helper", description: "Delegate", inputSchema: { type: "object", properties: { q: { type: "string", default: EMAIL } } } }), { key, dictionaries, keepLiteralsFrom: withWorkers("Helper") })).toThrow(MaskIdentifierError);
    expect(() => maskCapturedRun(withTool({ name: "delegate_to_Helper", description: "Delegate", inputSchema: { type: "object", properties: { [EMAIL]: { type: "string" } } } }), { key, dictionaries, keepLiteralsFrom: withWorkers("Helper") })).toThrow(MaskIdentifierError);
    // A dictionary term the content holds (so it was collected) as a word in a held-back definition.
    expect(() => maskCapturedRun(withTool({ name: "agent_clarify", description: "Ask the atlas user", inputSchema: schema }, "Ask atlas."), { key, dictionaries, keepLiteralsFrom: withWorkers("Helper") })).toThrow(MaskIdentifierError);
    expect(() => maskCapturedRun(withTool({ name: "delegate_to_Helper", description: "Delegate to the atlas team", inputSchema: schema }, "Ask atlas."), { key, dictionaries, keepLiteralsFrom: withWorkers("Helper") })).toThrow(MaskIdentifierError);
    // The error never repeats the value.
    let message = "";
    try {
      maskCapturedRun(withTool({ name: "delegate_to_Helper", description: `owner ${EMAIL}`, inputSchema: schema }), { key, dictionaries, keepLiteralsFrom: withWorkers("Helper") });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("model tape entry 1 tool 1");
    expect(message).not.toContain(EMAIL);
    expect(message).not.toContain("Helper");
  });

  // Re-review H1/M1: an MCP tool's definition in the tape is masked exactly as the cassette's tools/list copy.
  it("masks an MCP-listed tool in the tape with the same surrogates as the cassette, so replay's live request hashes alike", () => {
    const dictionaries = [{ dataClass: "project", terms: ["atlas"], patterns: [], score: 0.9 }];
    const listed = [
      { name: "lookup", description: `Look up contacts; owner ${EMAIL}`, inputSchema: { type: "object", properties: { q: { type: "string", default: EMAIL } } } },
      { name: "atlas-search", description: "Search the atlas catalog", inputSchema: { type: "object", properties: { q: { type: "string" } } } }
    ];
    // How the agent exposes them: `<adapterId>__<name>`, `[<adapterId>] <description>`.
    const expose = (tool: (typeof listed)[number]) => ({ name: `http_mcp__${tool.name}`, description: `[http_mcp] ${tool.description}`, inputSchema: tool.inputSchema });
    const base = run();
    base.cassette = {
      ...base.cassette!,
      servers: [{ key: "registry:crm", registryServerId: "crm", adapterId: "http_mcp", label: "CRM" }],
      entries: [{ seq: 1, server: "registry:crm", method: "tools/list", result: listed, at: 0, durationMs: 1 }]
    } as McpCassette;
    const request = { messages: [{ role: "user", content: `Who is ${EMAIL}?` }], tools: listed.map(expose), params: { model: "m" } };
    base.modelTape = { ...base.modelTape, entries: [{ ...base.modelTape.entries[0]!, request }] } as unknown as ModelTape;
    const masked = maskCapturedRun(base, { key, dictionaries });
    expect(JSON.stringify(masked)).not.toContain(EMAIL);
    const cassetteTools = masked.cassette!.entries[0]!.result as typeof listed;
    const tapeTools = (masked.modelTape!.entries[0]!.request as { tools: ReturnType<typeof expose>[] }).tools;
    const surrogate = surrogateFor(EMAIL, "email", key);
    expect(cassetteTools[0]!.description).toBe(`Look up contacts; owner ${surrogate}`);
    expect(cassetteTools[1]!.name).not.toBe("atlas-search");
    // Identical to what the agent builds from the masked cassette at replay.
    expect(tapeTools).toEqual(cassetteTools.map(expose));
    const live = canonicalTapeJson({ ...request, messages: [{ role: "user", content: `Who is ${surrogate}?` }], tools: cassetteTools.map(expose) }) as ModelTape["entries"][number]["request"];
    expect(masked.modelTape!.entries[0]!.requestHash).toBe(hashModelRequest(live));
  });

  // Re-review round 2 N1: only names the runtime itself builds are held back; any other tool is content.
  it("masks an MCP tool whose tools/list answer is missing from a truncated cassette, and a tool with no runtime-built name", () => {
    const OTHER = "bob.smith@corp-example.com";
    const tools = [
      { name: "http_mcp__lookup", description: `[http_mcp] Look up contacts; owner ${OTHER}`, inputSchema: { type: "object" } },
      { name: "manual_lookup", description: "Find a contact", inputSchema: { type: "object", properties: { q: { type: "string", default: OTHER } } } },
      // Named like a delegate tool, but no attached worker has that name: content too.
      { name: "delegate_to_Ghost", description: `Delegate task to Ghost. Hint: ${OTHER}`, inputSchema: { type: "object" } }
    ];
    const base = run();
    base.cassette = { ...base.cassette!, truncated: true, servers: [{ key: "registry:crm", registryServerId: "crm", adapterId: "http_mcp" }], entries: [] } as unknown as McpCassette;
    const request = { messages: [{ role: "user", content: "Who owns the contacts?" }], tools, params: { model: "m" } };
    base.modelTape = { ...base.modelTape, entries: [{ ...base.modelTape.entries[0]!, request }] } as unknown as ModelTape;
    const masked = maskCapturedRun(base, { key, dictionaries: [], keepLiteralsFrom: withWorkers("Helper") });
    expect(JSON.stringify(masked)).not.toContain(OTHER);
    const surrogate = surrogateFor(OTHER, "email", key);
    const taped = (masked.modelTape!.entries[0]!.request as unknown as { tools: typeof tools }).tools;
    expect(taped[0]!.description).toBe(`[http_mcp] Look up contacts; owner ${surrogate}`);
    expect(JSON.stringify(taped[1])).toContain(surrogate);
    expect(taped[2]!.description).toContain(surrogate);
  });

  it("holds back only the runtime's own tool names: agent_clarify, session_cache_*, and delegate tools of attached workers", () => {
    const dictionaries = [{ dataClass: "project", terms: ["atlas"], patterns: [], score: 0.9 }];
    const tools = [
      { name: "agent_clarify", description: "Ask the atlas user", inputSchema: { type: "object" } },
      { name: "session_cache_get", description: "Get an atlas record", inputSchema: { type: "object" } },
      { name: "delegate_to_atlas_Helper", description: "Delegate task to atlas-Helper.", inputSchema: { type: "object" } }
    ];
    const base = run();
    const request = { messages: [{ role: "user", content: `Who is ${EMAIL}?` }], tools, params: { model: "m" } };
    base.modelTape = { ...base.modelTape, entries: [{ ...base.modelTape.entries[0]!, request }] } as unknown as ModelTape;
    // The worker's name is sanitised the way the engine builds the delegate tool name.
    const masked = maskCapturedRun(base, { key, dictionaries, keepLiteralsFrom: withWorkers("atlas Helper") });
    expect((masked.modelTape!.entries[0]!.request as unknown as { tools: typeof tools }).tools).toEqual(tools);
  });

  // Re-review 2 L1: worker `a..b` is delegated as `delegate_to_a__b`, which is also how a server `delegate_to_a` exposes its tool `b`.
  it("never holds back a tool named `<configured MCP serverId>__…`, even when a worker's delegate tool has the same name", () => {
    const OTHER = "bob.smith@corp-example.com";
    const tool = { name: "delegate_to_a__b", description: `[delegate_to_a] owner ${OTHER}`, inputSchema: { type: "object" } };
    const workflow = withWorkers("a..b");
    const capture = (servers: unknown[], keepLiteralsFrom: unknown) => {
      const base = run();
      base.cassette = { ...base.cassette!, truncated: true, servers, entries: [] } as unknown as McpCassette;
      const request = { messages: [{ role: "user", content: "Who owns it?" }], tools: [tool], params: { model: "m" } };
      base.modelTape = { ...base.modelTape, entries: [{ ...base.modelTape.entries[0]!, request }] } as unknown as ModelTape;
      return maskCapturedRun(base, { key, dictionaries: [], keepLiteralsFrom });
    };
    const surrogate = surrogateFor(OTHER, "email", key);
    const mcpNode = { id: "m", type: "mcp_tool", name: "Lookup", config: { serverId: "delegate_to_a" } };
    const inline = { id: "sup", type: "supervisor_node", name: "Sup", config: { mcpServers: [{ serverId: "delegate_to_a", connection: {} }] } };
    const cases = [
      // The server is named by the cassette (a registry server's adapter), by an MCP Tool node, or inline on an agent node.
      capture([{ key: "registry:crm", registryServerId: "crm", adapterId: "delegate_to_a" }], workflow),
      capture([], { ...workflow, nodes: [...workflow.nodes, mcpNode] }),
      capture([], { ...workflow, nodes: [inline, ...workflow.nodes.slice(1)] })
    ];
    for (const masked of cases) {
      expect(JSON.stringify(masked)).not.toContain(OTHER);
      expect((masked.modelTape!.entries[0]!.request as unknown as { tools: Array<typeof tool> }).tools[0]!.description).toBe(`[delegate_to_a] owner ${surrogate}`);
    }
    // With no such server, the worker's delegate tool stays as written.
    const kept = { ...tool, description: "Delegate task to a..b." };
    const plain = run();
    plain.modelTape = { ...plain.modelTape, entries: [{ ...plain.modelTape.entries[0]!, request: { messages: [], tools: [kept], params: { model: "m" } } }] } as unknown as ModelTape;
    expect((maskCapturedRun(plain, { key, dictionaries: [], keepLiteralsFrom: workflow }).modelTape!.entries[0]!.request as unknown as { tools: unknown[] }).tools).toEqual([kept]);
  });

  // Re-review round 2 N2: every scalar in a held-back definition is checked, numbers as their decimal text.
  it("drops the capture when a held-back schema holds a collected value as a number (default, enum, examples, const at any depth)", () => {
    const CARD = "4111111111111111";
    const withSchema = (inputSchema: Record<string, unknown>) => {
      const base = run();
      base.input = { user_prompt: `card ${CARD}`, from: "x" };
      const request = { messages: [{ role: "user", content: `Pay with ${CARD}` }], tools: [{ name: "delegate_to_Helper", description: "Delegate", inputSchema }], params: { model: "m" } };
      base.modelTape = { ...base.modelTape, entries: [{ ...base.modelTape.entries[0]!, request }] } as unknown as ModelTape;
      return base;
    };
    const options = { key, dictionaries: [], keepLiteralsFrom: withWorkers("Helper") };
    const card = Number(CARD);
    for (const field of [{ default: card }, { enum: [card] }, { examples: [card] }, { const: card }]) {
      expect(() => maskCapturedRun(withSchema({ type: "object", properties: { n: { type: "number", ...field } } }), options)).toThrow(MaskIdentifierError);
      expect(() => maskCapturedRun(withSchema({ type: "object", properties: { a: { type: "object", properties: { b: { type: "array", items: { type: "number", ...field } } } } } }), options)).toThrow(MaskIdentifierError);
    }
    // A number nobody collected stays as written.
    expect(() => maskCapturedRun(withSchema({ type: "object", properties: { n: { type: "number", default: 3 } } }), options)).not.toThrow();
  });

  it("restores held-back tool-call names by position, never by a name the model made up", () => {
    const base = run();
    const tools = [{ name: "session_cache_list", description: "List cached tool outputs", inputSchema: { type: "object" } }];
    const request = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "l2m_held_tool_0", arguments: {} }, { id: "c2", name: "session_cache_list", arguments: {} }] }
      ],
      tools,
      params: { model: "m" }
    };
    base.modelTape = { ...base.modelTape, entries: [{ ...base.modelTape.entries[0]!, request }] } as unknown as ModelTape;
    const masked = maskCapturedRun(base, { key, dictionaries: [] });
    const calls = (masked.modelTape!.entries[0]!.request as unknown as { messages: Array<{ toolCalls: Array<{ name: string }> }> }).messages[1]!.toolCalls;
    expect(calls.map((entry) => entry.name)).toEqual(["l2m_held_tool_0", "session_cache_list"]);
  });

  it("labels each node with the classes found in it and where its content came from", () => {
    const masked = maskCapturedRun(run(), { key, dictionaries: [] });
    const facts = withNodeLabels(masked.facts, masked.report, "untrusted_external");
    const byId = Object.fromEntries(facts.nodes.map((node) => [node.nodeId, node.labels]));
    // Provenance is origin only: finding a data class adds nothing to it.
    expect(byId.hook).toEqual({ provenance: ["untrusted_external"], dataClasses: ["email"], source: "scan" });
    expect(byId.lookup).toMatchObject({ provenance: ["untrusted_external"], dataClasses: ["email"] });
    expect(byId.out).toEqual({ provenance: [], dataClasses: [], source: "scan" });
    // Unscanned (masking off): unchanged.
    expect(withNodeLabels(masked.facts, null, "untrusted_external")).toBe(masked.facts);
  });

  it("derives provenance from where the run started, never from a caller-chosen trigger name", () => {
    expect(inputProvenance("cron", "scheduler")).toBe("trusted");
    // A caller naming its queued run "cron" is a user, not the scheduler.
    expect(inputProvenance("cron", "user")).toBe("user");
    expect(inputProvenance("cron", undefined)).toBe("untrusted_external");
    expect(inputProvenance("schedule", undefined)).toBe("untrusted_external");
    expect(inputProvenance("chat", undefined)).toBe("user");
    // An API-key run of the execute routes keeps its `manual` trigger; the server passes its origin.
    expect(inputProvenance("manual", "user")).toBe("user");
    expect(inputProvenance("webhook", undefined)).toBe("untrusted_external");
    expect(provenanceFor("webhook_input", "trusted")).toEqual(["trusted"]);
    expect(provenanceFor("http_request", "user")).toEqual(["untrusted_external"]);
    expect(provenanceFor("output", "untrusted_external")).toEqual([]);
  });

  it("masks the same way in chunks as in one go", async () => {
    const options = { key, dictionaries: [] };
    expect(JSON.stringify(await maskCapturedRunAsync(run(), options))).toBe(JSON.stringify(maskCapturedRun(run(), options)));
  });

  // Re-review N1: a resource URI (the cassette entry's `name`) held the raw email.
  it("masks a resource URI and a server label; a replay of the masked input asks for the masked URI on the unmasked server", () => {
    const base: CapturedRunParts = run();
    const uri = `crm://customers/${EMAIL}/profile`;
    base.cassette = {
      ...base.cassette!,
      servers: [{ key: "registry:crm", registryServerId: "crm", adapterId: "http-mcp", label: `CRM for ${EMAIL}` }],
      entries: [
        {
          seq: 1,
          server: "registry:crm",
          method: "resources/read",
          name: uri,
          argsHash: "stale",
          result: { contents: [{ uri, text: "profile" }] },
          at: 0,
          durationMs: 1
        }
      ]
    } as McpCassette;
    const masked = maskCapturedRun(base, { key, dictionaries: [] });
    const surrogate = surrogateFor(EMAIL, "email", key);
    expect(JSON.stringify(masked)).not.toContain(EMAIL);
    const entry = masked.cassette!.entries[0]!;
    // The workflow resolves the URI from the (masked) input, so a replay asks for exactly this name.
    expect(entry.name).toBe(`crm://customers/${surrogate}/profile`);
    // Routing identifiers stay as written: replay rebuilds the server key from the live configuration.
    expect(entry.server).toBe("registry:crm");
    expect(masked.cassette!.servers[0]).toMatchObject({ key: "registry:crm", registryServerId: "crm", adapterId: "http-mcp", label: `CRM for ${surrogate}` });
    expect(entry).toMatchObject({ seq: 1, method: "resources/read", at: 0, durationMs: 1 });
  });

  it("round 3 A3: keeps server keys and tool names as written, and drops the capture when one holds a collected value", () => {
    const dictionaries = [{ dataClass: "codename", terms: ["atlas"], patterns: [], score: 0.9 }];
    const clean: CapturedRunParts = run();
    clean.cassette = {
      ...clean.cassette!,
      servers: [{ key: "registry:crm-main", registryServerId: "crm-main", adapterId: "http-mcp", label: "CRM" }],
      entries: [{ seq: 1, server: "registry:crm-main", method: "tools/call", name: "crm_search", args: { email: EMAIL }, argsHash: "stale", at: 0, durationMs: 1 }]
    } as McpCassette;
    const masked = maskCapturedRun(clean, { key, dictionaries });
    expect(masked.cassette!.entries[0]).toMatchObject({ server: "registry:crm-main", name: "crm_search" });
    expect(masked.cassette!.servers[0]).toMatchObject({ key: "registry:crm-main", registryServerId: "crm-main" });
    expect(JSON.stringify(masked)).not.toContain(EMAIL);

    // A dictionary term the input holds also names the server and the tool: kept identifiers would show it, so the capture is dropped.
    const leaky: CapturedRunParts = run();
    leaky.input = { user_prompt: "ask atlas about it" };
    leaky.cassette = {
      ...leaky.cassette!,
      servers: [{ key: "registry:atlas", registryServerId: "atlas", adapterId: "http-mcp" }],
      entries: [{ seq: 1, server: "registry:atlas", method: "tools/call", name: "atlas_search", args: { q: "x" }, argsHash: "stale", at: 0, durationMs: 1 }]
    } as McpCassette;
    expect(() => maskCapturedRun(leaky, { key, dictionaries })).toThrow(MaskIdentifierError);
  });

  it("round 4 B2: a registry id with a card-shaped digit run and a catalog tool name holding a dictionary term never drop the capture", () => {
    const dictionaries = [{ dataClass: "codename", terms: ["atlas"], patterns: [], score: 0.9 }];
    // The capture scan reads `77585956-5432-4` in this id as a Luhn-valid card number.
    const registryId = "mcp_77585956-5432-4c3f-b145-534cb79b36c8";
    const base: CapturedRunParts = run();
    base.input = { user_prompt: `ask atlas about ${EMAIL}, card 4111 1111 1111 1111` };
    base.cassette = {
      ...base.cassette!,
      servers: [{ key: `registry:${registryId}`, registryServerId: registryId, adapterId: "http-mcp", label: "Atlas" }],
      entries: [
        { seq: 1, server: `registry:${registryId}`, method: "tools/list", argsHash: "x", result: [{ name: "atlas_search" }], at: 0, durationMs: 1 },
        { seq: 2, server: `registry:${registryId}`, method: "tools/call", name: "atlas_search", args: { q: "atlas" }, argsHash: "stale", at: 1, durationMs: 1 },
        { seq: 3, server: `registry:${registryId}`, method: "tools/call", name: "atlas_lookup", args: { q: "atlas" }, argsHash: "stale", at: 2, durationMs: 1 }
      ]
    } as McpCassette;
    const kinds = (catalog?: (id: string) => readonly string[]) => cassetteIdentifiers(base.cassette!, catalog).map((entry) => [entry.text, entry.kind]);
    expect(kinds()).toEqual([
      [`registry:${registryId}`, "generated"],
      [registryId, "generated"],
      ["http-mcp", "generated"],
      [`registry:${registryId}`, "generated"],
      [`registry:${registryId}`, "generated"],
      ["atlas_search", "catalog"],
      [`registry:${registryId}`, "generated"],
      ["atlas_lookup", "free"]
    ]);
    // The registry's current tool snapshot lists the second tool.
    expect(kinds((id) => (id === registryId ? ["atlas_lookup"] : [])).at(-1)).toEqual(["atlas_lookup", "catalog"]);
    const masked = maskCapturedRun(base, { key, dictionaries });
    expect(masked.cassette!.servers[0]!.key).toBe(`registry:${registryId}`);
    expect(masked.cassette!.entries.map((entry) => entry.name)).toEqual([undefined, "atlas_search", "atlas_lookup"]);
    expect(JSON.stringify(masked)).not.toContain(EMAIL);

    // A raw email in a tool name the catalog does not list still drops the capture, even when the content never holds it.
    const leaky: CapturedRunParts = run();
    leaky.input = { user_prompt: "hello" };
    leaky.cassette = {
      ...leaky.cassette!,
      servers: [{ key: `registry:${registryId}`, registryServerId: registryId, adapterId: "http-mcp" }],
      entries: [{ seq: 1, server: `registry:${registryId}`, method: "tools/call", name: "lookup_john.roe@example.org", args: { q: "x" }, argsHash: "stale", at: 0, durationMs: 1 }]
    } as McpCassette;
    expect(() => maskCapturedRun(leaky, { key, dictionaries: [] })).toThrow(MaskIdentifierError);
  });

  it("finds the value only in a resource URI and masks it there and everywhere else", () => {
    const base: CapturedRunParts = run();
    base.input = { user_prompt: "show the profile" };
    base.nodes = {};
    base.facts = { ...base.facts, output: null, toolCalls: [] };
    base.modelTape = null;
    base.memorySeed = null;
    base.cassette = {
      ...base.cassette!,
      entries: [{ seq: 1, server: "crm", method: "resources/read", name: "crm://customers/jane.doe@example.com/profile", argsHash: "stale", at: 0, durationMs: 1 }]
    } as McpCassette;
    const masked = maskCapturedRun(base, { key, dictionaries: [] });
    expect(masked.cassette!.entries[0]!.name).toBe(`crm://customers/${surrogateFor(EMAIL, "email", key)}/profile`);
    expect(masked.report.values).toEqual({ email: 1 });
  });

  it("property: no detected value survives in any field of any cassette entry", () => {
    const values = [EMAIL, "+44 20 7946 0958", "4111 1111 1111 1111", "GB82 WEST 1234 5698 7654 32", "536-90-4399"];
    const fields = ["server", "name", "args", "result", "error", "exchanges", "futureField"] as const;
    for (const value of values) {
      for (const field of fields) {
        const base: CapturedRunParts = run();
        const entry: Record<string, unknown> = { seq: 1, server: "crm", method: "tools/call", name: "find", argsHash: "stale", at: 0, durationMs: 1 };
        entry[field] =
          field === "args" || field === "result"
            ? { nested: [{ text: `see ${value}` }] }
            : field === "exchanges"
              ? [{ kind: "sampling", at: 0, request: { text: value }, response: { text: `ok ${value}` } }]
              : `x ${value} y`;
        base.input = { user_prompt: "nothing here" };
        base.cassette = { ...base.cassette!, servers: [{ key: "crm", adapterId: "mock-mcp", label: field === "server" ? `crm ${value}` : "crm" }], entries: [entry] } as unknown as McpCassette;
        // The entry's server and a tool name are kept as written: a value in one drops the capture instead.
        if (field === "server" || field === "name") {
          expect(() => maskCapturedRun(base, { key, dictionaries: [] }), `${field}: ${value}`).toThrow(MaskIdentifierError);
          continue;
        }
        const masked = maskCapturedRun(base, { key, dictionaries: [] });
        const stored = JSON.stringify(masked.cassette);
        expect(stored, `${field}: ${value}`).not.toContain(value);
        expect(stored.replace(/\D/g, ""), `${field}: ${value}`).not.toContain(value.replace(/\D/g, "").length >= 9 ? value.replace(/\D/g, "").slice(-8) : "@@");
      }
    }
  });
});
