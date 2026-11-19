import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import { legacyBehaviours, type LLMProviderConfig, type ToolCall } from "@ai-orchestrator/shared";
import {
  BUILDER_BRANCH_OUTPUTS,
  builderNodeCatalog,
  builderNodeDetails,
  builderPreview,
  checkBuilderDraft,
  runWorkflowBuilder,
  workflowBuilderSystemPrompt
} from "./workflow-builder";

const NODE_MODEL: LLMProviderConfig = { providerId: "openai_compatible", model: "local-model", baseUrl: "http://127.0.0.1:9/v1" };

const webhookToHttp = {
  name: "Forward orders",
  description: "Posts each incoming order to the shop API",
  nodes: [
    { id: "incoming", type: "webhook_input", label: "Incoming order", config: { path: "orders", method: "POST" } },
    {
      id: "post_order",
      type: "http_request",
      label: "Post order",
      config: { method: "POST", urlTemplate: "https://shop.example.com/orders", bodyTemplate: "{\"id\": \"{{webhook.id}}\"}" }
    }
  ],
  edges: [{ source: "incoming", target: "post_order" }]
};

describe("builder catalog", () => {
  it("lists every available node type with outputs and attachment ports", () => {
    const catalog = builderNodeCatalog();
    const byType = new Map(catalog.map((entry) => [entry.type as string, entry]));
    expect(byType.get("webhook_input")).toMatchObject({ category: "Input", trigger: true });
    expect(byType.get("if_node")).toMatchObject({ outputs: ["true", "false"] });
    expect(byType.get("agent_orchestrator")).toMatchObject({ attachmentPorts: ["chat_model", "memory", "tool", "guard"] });
    expect(byType.get("supervisor_node")?.attachmentPorts).toContain("worker");
    expect(byType.get("local_memory")).toMatchObject({ attaches: "only as memory of agent_orchestrator" });
    expect(byType.get("llm_call")).toMatchObject({ attaches: "also as chat_model of agent_orchestrator" });
  });

  it("narrows the list by query words", () => {
    const types = builderNodeCatalog("slack").map((entry) => entry.type);
    expect(types).toContain("slack_send_message");
    expect(types).not.toContain("if_node");
  });

  it("describes node types in full, without credential examples", () => {
    const details = builderNodeDetails(["http_request", "slack_send_message", "no_such_type"]);
    expect(details.unknown).toEqual(["no_such_type"]);
    const http = details.nodeTypes.find((entry) => entry.type === "http_request")!;
    expect(http.configSchema).toMatchObject({ properties: { urlTemplate: { type: "string" } } });
    expect(JSON.stringify(http)).not.toContain("secretRef");
    expect(http.exampleConfig).toMatchObject({ method: "GET" });
  });

  it("describes the settings the editor's forms edit (Switch cases, form fields, sub-workflow mappings) in their saved shape", () => {
    const { nodeTypes } = builderNodeDetails(["switch_node", "form_trigger", "execute_workflow", "rag_retrieve"]);
    const schemaOf = (type: string) => (nodeTypes.find((entry) => entry.type === type)!.configSchema as { properties: Record<string, any> }).properties;
    expect(schemaOf("switch_node").cases.items.properties).toMatchObject({ value: { type: "string" }, label: { type: "string" } });
    expect(schemaOf("form_trigger").fields.items.properties.type.enum).toEqual(["text", "textarea", "email", "number", "select", "checkbox"]); // the Form Trigger editor's types
    expect(schemaOf("execute_workflow").inputMapping).toMatchObject({ type: "object", additionalProperties: { type: "string" } });
    expect(schemaOf("execute_workflow").outputMapping).toMatchObject({ type: "object", additionalProperties: { type: "string" } });
    expect(schemaOf("rag_retrieve").vectorStoreConfig).toMatchObject({ type: "object" });
  });

  it("keeps the system prompt under the runtime's system message cap", () => {
    expect(workflowBuilderSystemPrompt(3).length).toBeLessThan(8000);
  });
});

describe("checkBuilderDraft", () => {
  it("reads a valid draft into a new workflow, starting each node from its example settings", () => {
    const check = checkBuilderDraft(webhookToHttp, { workflowId: "wf-new", projectId: "p1", nodeModel: NODE_MODEL });
    expect(check.issues).toEqual([]);
    const workflow = check.workflow!;
    expect(workflow).toMatchObject({ id: "wf-new", projectId: "p1", name: "Forward orders", schemaVersion: "1.0.0", workflowVersion: 1 });
    expect(workflow.nodes.map((node) => node.id)).toEqual(["incoming", "post_order"]);
    const http = workflow.nodes[1]!;
    expect(http.name).toBe("Post order");
    // The model's settings win; the rest come from the type's example, as for a node added in the editor.
    expect(http.config).toMatchObject({ method: "POST", urlTemplate: "https://shop.example.com/orders", responseType: "json" });
    expect(workflow.nodes[1]!.position.x).toBeGreaterThan(workflow.nodes[0]!.position.x);
    expect(workflow.edges).toEqual([expect.objectContaining({ source: "incoming", target: "post_order" })]);
  });

  it("reports unknown types, bad ids, missing nodes and wrong outputs for the model to fix", () => {
    const check = checkBuilderDraft(
      {
        name: "x",
        nodes: [
          { id: "start", type: "manual_trigger", config: {} },
          { id: "check", type: "if_node", config: { condition: "{{ok}}" } },
          { id: "9bad", type: "set_node", config: {} },
          { id: "magic", type: "teleport_node", config: {} }
        ],
        edges: [
          { source: "start", target: "check" },
          { source: "check", target: "start" },
          { source: "check", target: "ghost" }
        ]
      },
      { workflowId: "wf" }
    );
    const messages = check.issues.map((issue) => issue.message).join("\n");
    expect(messages).toMatch(/9bad/);
    expect(messages).toMatch(/unknown node type 'teleport_node'/);
    expect(messages).toMatch(/needs sourceHandle, one of true, false/);
    expect(messages).toMatch(/target 'ghost' is not a node id/);
    expect(check.workflow).toBeUndefined();
  });

  it("reports graph errors from the shared validation (a cycle)", () => {
    const check = checkBuilderDraft(
      {
        name: "loop",
        nodes: [
          { id: "start", type: "manual_trigger", config: {} },
          { id: "a", type: "noop_node", config: {} },
          { id: "b", type: "noop_node", config: {} }
        ],
        edges: [
          { source: "start", target: "a" },
          { source: "a", target: "b" },
          { source: "b", target: "a" }
        ]
      },
      { workflowId: "wf" }
    );
    expect(check.issues.map((issue) => issue.message).join("\n")).toMatch(/cycle/i);
  });

  it("wires agent ports: infers the port, turns an attached node's edge around, and refuses a wrong attachment", () => {
    const check = checkBuilderDraft(
      {
        name: "agent",
        nodes: [
          { id: "start", type: "webhook_input", config: {} },
          { id: "agent", type: "agent_orchestrator", config: {} },
          { id: "model", type: "llm_call", config: { provider: { providerId: "openai", model: "gpt-x", baseUrl: "https://evil.example/v1" } } },
          { id: "memory", type: "local_memory", config: {} }
        ],
        edges: [
          { source: "start", target: "agent" },
          { source: "agent", target: "model" },
          { source: "memory", target: "agent" }
        ]
      },
      { workflowId: "wf", nodeModel: NODE_MODEL }
    );
    expect(check.issues).toEqual([]);
    expect(check.workflow!.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "agent", target: "model", sourceHandle: "chat_model" }),
        expect.objectContaining({ source: "agent", target: "memory", sourceHandle: "memory" })
      ])
    );
    // A model node uses the builder's model, never a provider or base URL the model wrote.
    expect(check.workflow!.nodes.find((node) => node.id === "model")!.config.provider).toEqual(NODE_MODEL);
    expect(check.notes.join(" ")).toMatch(/model the builder used/);

    const wrong = checkBuilderDraft(
      {
        name: "agent",
        nodes: [
          { id: "agent", type: "agent_orchestrator", config: {} },
          { id: "fetch", type: "http_request", config: {} }
        ],
        edges: [{ source: "agent", target: "fetch", sourceHandle: "tool" }]
      },
      { workflowId: "wf" }
    );
    expect(wrong.issues[0]!.message).toMatch(/'tool' port of 'agent' takes mcp_tool, workflow_tool, not http_request/);
  });

  it("never keeps credentials or admin-only settings from the model's answer", () => {
    const check = checkBuilderDraft(
      {
        name: "creds",
        nodes: [
          { id: "hook", type: "webhook_input", config: { path: "x", inputTrust: "user", authMode: "bearer_token", secretRef: { secretId: "someone-elses" } } },
          {
            id: "fetch",
            type: "http_request",
            config: { method: "GET", urlTemplate: "https://api.example.com", secretRef: { secretId: "s-1" }, headersTemplate: "{}", apiKey: "sk-live-123", sensitiveOutput: true }
          }
        ],
        edges: [{ source: "hook", target: "fetch" }]
      },
      { workflowId: "wf" }
    );
    const json = JSON.stringify(check.workflow);
    expect(json).not.toContain("someone-elses");
    expect(json).not.toContain("s-1");
    expect(json).not.toContain("sk-live-123");
    expect(json).not.toContain("inputTrust");
    expect(json).not.toContain("sensitiveOutput");
    expect(check.notes.join(" ")).toMatch(/credential values/);
    expect(check.notes.join(" ")).toMatch(/only an admin sets/);
  });

  it("lets a draft with unfinished settings through and lists them", () => {
    const check = checkBuilderDraft(
      {
        name: "unfinished",
        nodes: [
          { id: "start", type: "manual_trigger", config: {} },
          { id: "fetch", type: "http_request", config: { method: "GET", urlTemplate: "" } }
        ],
        edges: [{ source: "start", target: "fetch" }]
      },
      { workflowId: "wf" }
    );
    expect(check.issues).toEqual([]);
    expect(check.unfinished.map((issue) => issue.nodeId)).toContain("fetch");
  });

  it("gives every Switch case the label the engine routes on and the canvas draws, and refuses other handles", () => {
    const draft = (cases: unknown, handle: string) => ({
      name: "switch",
      nodes: [
        { id: "start", type: "manual_trigger", config: {} },
        { id: "route", type: "switch_node", config: { switchValue: "{{kind}}", cases } },
        { id: "alpha", type: "noop_node", config: {} }
      ],
      edges: [
        { source: "start", target: "route" },
        { source: "route", target: "alpha", sourceHandle: handle }
      ]
    });
    // No label: the value becomes the label, so the engine routes on it.
    const byValue = checkBuilderDraft(draft([{ value: "a" }], "a"), { workflowId: "wf" });
    expect(byValue.issues).toEqual([]);
    expect(byValue.workflow!.nodes.find((node) => node.id === "route")!.config.cases).toEqual([{ value: "a", label: "a" }]);
    // The canvas draws no case_0 handle for a labelled case.
    expect(checkBuilderDraft(draft([{ value: "a", label: " Alpha " }], "case_0"), { workflowId: "wf" }).issues.map((issue) => issue.message).join()).toMatch(/case_0/);
    expect(checkBuilderDraft(draft([{ value: "a", label: "Alpha" }, { value: "b", label: "Alpha" }], "Alpha"), { workflowId: "wf" }).issues.map((issue) => issue.message).join()).toMatch(/two cases/);
    expect(checkBuilderDraft(draft([{ value: "" }], "default"), { workflowId: "wf" }).issues.map((issue) => issue.message).join()).toMatch(/needs a value/);
  });

  it("gives an LLM Call the builder's model, leaves a chain node on the upstream model, and keeps chat model addresses at their placeholder", () => {
    const check = checkBuilderDraft(
      {
        name: "models",
        nodes: [
          { id: "start", type: "manual_trigger", config: {} },
          { id: "ask", type: "llm_call", config: { provider: { providerId: "openai", model: "gpt-x", baseUrl: "https://elsewhere.example/v1" } } },
          { id: "sum", type: "summarization_chain", config: {} },
          { id: "agent", type: "agent_orchestrator", config: {} },
          { id: "chat", type: "openai_compatible_chat_model", config: { baseUrl: "https://elsewhere.example/v1", model: "m" } }
        ],
        edges: [
          { source: "start", target: "ask" },
          { source: "ask", target: "sum" },
          { source: "sum", target: "agent" },
          { source: "agent", target: "chat", sourceHandle: "chat_model" }
        ]
      },
      { workflowId: "wf", nodeModel: NODE_MODEL }
    );
    expect(check.issues).toEqual([]);
    const config = (id: string) => check.workflow!.nodes.find((node) => node.id === id)!.config as Record<string, unknown>;
    expect(config("ask").provider).toEqual(NODE_MODEL);
    expect(config("sum").provider).toBeUndefined();
    expect(config("chat").baseUrl).toBe("http://localhost:1234/v1");
    expect(JSON.stringify(check.workflow)).not.toContain("elsewhere.example");
    expect(check.notes.join(" ")).toMatch(/chat\.baseUrl/);
  });

  it("puts new nodes on the newer behaviours, as the editor does, and keeps a behaviour the model chose", () => {
    const check = checkBuilderDraft(
      {
        name: "Loop and set",
        nodes: [
          { id: "incoming", type: "webhook_input", label: "Incoming", config: { path: "items" } },
          { id: "each_item", type: "loop_node", label: "Each item", config: { inputKey: "items" } },
          { id: "tag_item", type: "set_node", label: "Tag item", config: { assignments: [{ key: "tag", valueTemplate: "new" }] } },
          { id: "keep_open", type: "filter_node", label: "Keep open", config: { mode: "gate", conditions: [] } },
          { id: "post_item", type: "http_request", label: "Post item", config: { urlTemplate: "https://example.com" } }
        ],
        edges: [
          { source: "incoming", target: "each_item" },
          { source: "each_item", target: "tag_item" },
          { source: "tag_item", target: "keep_open" },
          { source: "keep_open", target: "post_item", sourceHandle: "pass" }
        ]
      },
      { workflowId: "wf" }
    );
    const byId = new Map(check.workflow!.nodes.map((node) => [node.id, node]));
    for (const node of check.workflow!.nodes) {
      expect(legacyBehaviours(node.type, node.config as Record<string, unknown>), node.id).toEqual([]);
    }
    expect(byId.get("each_item")!.config).toMatchObject({ collectResults: true, routeBranches: true });
    expect(byId.get("tag_item")!.config).toMatchObject({ assignments: [{ key: "tag", valueTemplate: "new", type: "auto" }] });
    expect(byId.get("post_item")!.config).toMatchObject({ failOnHttpError: true });
    // Chosen on purpose: kept (the editor shows its switch without the "earlier behaviour" notice).
    expect(byId.get("keep_open")!.config).toMatchObject({ mode: "gate" });
  });

  it("refuses node ids that templates already read (readable ids)", () => {
    const check = checkBuilderDraft(
      {
        name: "Reserved",
        nodes: [
          { id: "webhook", type: "webhook_input", label: "Incoming", config: { path: "x" } },
          { id: "results", type: "set_node", label: "Results", config: {} }
        ],
        edges: [{ source: "webhook", target: "results" }]
      },
      { workflowId: "wf" }
    );
    const messages = check.issues.map((issue) => issue.message).join("\n");
    expect(messages).toMatch(/'webhook' is a name templates already read/);
    expect(messages).toMatch(/'results' is a name templates already read/);
  });

  it("refuses a submission too large to be a workflow", () => {
    const huge = { ...webhookToHttp, nodes: [{ ...webhookToHttp.nodes[0]!, config: { path: "x".repeat(250_000) } }, webhookToHttp.nodes[1]!] };
    expect(checkBuilderDraft(huge, { workflowId: "wf" }).issues[0]!.message).toMatch(/too large/);
  });

  it("knows the outputs of every branching node the canvas draws", () => {
    expect(Object.keys(BUILDER_BRANCH_OUTPUTS).sort()).toEqual(["approval_gate", "chat_intent_router", "filter_node", "guard", "if_node", "try_catch"]);
    const check = checkBuilderDraft(
      {
        name: "switch",
        nodes: [
          { id: "start", type: "manual_trigger", config: {} },
          { id: "route", type: "switch_node", config: { switchValue: "{{kind}}", cases: [{ value: "a", label: "Alpha" }] } },
          { id: "alpha", type: "noop_node", config: {} },
          { id: "other", type: "noop_node", config: {} }
        ],
        edges: [
          { source: "start", target: "route" },
          { source: "route", target: "alpha", sourceHandle: "Alpha" },
          { source: "route", target: "other", sourceHandle: "default" }
        ]
      },
      { workflowId: "wf" }
    );
    expect(check.issues).toEqual([]);
  });
});

describe("builderPreview", () => {
  it("lists nodes, the credentials to pick and the addresses the workflow calls", () => {
    const check = checkBuilderDraft(
      {
        name: "slack",
        nodes: [
          { id: "start", type: "manual_trigger", config: {} },
          { id: "notify", type: "slack_send_message", config: { authType: "bot_token", channel: "#ops", text: "hi" } },
          { id: "fetch", type: "http_request", config: { method: "GET", urlTemplate: "https://status.example.com/api" } }
        ],
        edges: [
          { source: "start", target: "fetch" },
          { source: "fetch", target: "notify" }
        ]
      },
      { workflowId: "wf" }
    );
    const preview = builderPreview(check.workflow!, check);
    expect(preview.nodes.map((node) => node.typeLabel)).toEqual(["Manual Trigger", "Slack: Send Message", "HTTP Request"]);
    expect(preview.credentials.some((entry) => entry.nodeId === "notify")).toBe(true);
    expect(preview.addresses).toEqual(expect.arrayContaining([{ nodeId: "fetch", nodeLabel: "HTTP Request", url: "https://status.example.com/api" }]));
  });
});

/** A model that answers with the next scripted turn; it records what it was sent. */
class ScriptedModel implements LLMProviderAdapter {
  readonly definition = { id: "openai_compatible", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly calls: ProviderCallRequest[] = [];
  constructor(private readonly turns: Array<{ content?: string; toolCalls?: ToolCall[]; error?: string }>) {}
  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    const turn = this.turns[this.calls.length - 1] ?? { content: "done" };
    if (turn.error) throw new Error(turn.error);
    return { content: turn.content ?? "", toolCalls: turn.toolCalls ?? [] };
  }
}

function registryWith(model: LLMProviderAdapter): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(model);
  return registry;
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });

describe("runWorkflowBuilder", () => {
  const base = { workflowId: "wf-built", projectId: "p1", resolveSecret: async () => undefined, provider: NODE_MODEL };

  it("reads the catalog, repairs a rejected workflow and stops at the first accepted one", async () => {
    const model = new ScriptedModel([
      { toolCalls: [call("t1", "list_node_types", { query: "webhook http" })] },
      { toolCalls: [call("t2", "get_node_types", { types: ["webhook_input", "http_request"] })] },
      { toolCalls: [call("t3", "submit_workflow", { ...webhookToHttp, edges: [{ source: "incoming", target: "nowhere" }] })] },
      { toolCalls: [call("t4", "submit_workflow", webhookToHttp)] },
      { content: "this turn must never be asked for" }
    ]);
    const result = await runWorkflowBuilder({ ...base, prompt: "When an order arrives, post it to the shop API", providerRegistry: registryWith(model) });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.attempts).toBe(2);
    expect(result.workflow.id).toBe("wf-built");
    expect(result.model).toEqual({ providerId: "openai_compatible", model: "local-model" });
    expect(result.preview.addresses.map((entry) => entry.url)).toContain("https://shop.example.com/orders");
    expect(model.calls).toHaveLength(4);
    // The rejection went back to the model as a tool result naming the problem.
    const toolMessages = model.calls[3]!.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    expect(toolMessages.at(-1)).toMatch(/nowhere/);
    expect(toolMessages.at(-1)).toMatch(/submissionsLeft/);
    expect(model.calls[0]!.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["list_node_types", "get_node_types", "submit_workflow"]));
  });

  it("gives up after the last allowed submission and returns the problems", async () => {
    const bad = { name: "bad", nodes: [{ id: "x", type: "nope", config: {} }], edges: [] };
    const model = new ScriptedModel([1, 2, 3, 4].map((n) => ({ toolCalls: [call(`t${n}`, "submit_workflow", bad)] })));
    const result = await runWorkflowBuilder({ ...base, prompt: "something", providerRegistry: registryWith(model), maxAttempts: 3 });
    expect(result).toMatchObject({ status: "failed", attempts: 3 });
    if (result.status === "failed") expect(result.issues[0]!.message).toMatch(/unknown node type 'nope'/);
    expect(model.calls).toHaveLength(3);
  });

  it("reports a model call that fails, with the problems of the last rejected workflow", async () => {
    const bad = { name: "bad", nodes: [{ id: "x", type: "nope", config: {} }], edges: [] };
    const model = new ScriptedModel([{ toolCalls: [call("t1", "submit_workflow", bad)] }, ...Array.from({ length: 8 }, () => ({ error: "upstream said 500" }))]);
    const result = await runWorkflowBuilder({ ...base, prompt: "something", providerRegistry: registryWith(model) });
    expect(result).toMatchObject({ status: "failed" });
    if (result.status === "failed") {
      expect(result.message).toMatch(/^The model call failed/);
      expect(result.issues[0]!.message).toMatch(/unknown node type 'nope'/);
    }
  }, 30_000);

  it("returns the model's question when it asks one", async () => {
    const model = new ScriptedModel([{ toolCalls: [call("c1", "agent_clarify", { question: "Which channel should it post to?" })] }]);
    const result = await runWorkflowBuilder({ ...base, prompt: "notify", providerRegistry: registryWith(model) });
    expect(result).toMatchObject({ status: "question", question: "Which channel should it post to?" });
  });

  it("treats a plain answer without a workflow as a question back", async () => {
    const model = new ScriptedModel([{ content: "What should start it: a schedule or a webhook?" }]);
    const result = await runWorkflowBuilder({ ...base, prompt: "sync stuff", providerRegistry: registryWith(model) });
    expect(result).toMatchObject({ status: "question", question: "What should start it: a schedule or a webhook?" });
  });

  it("never calls a model on Echo", async () => {
    const model = new ScriptedModel([]);
    const result = await runWorkflowBuilder({ ...base, provider: { providerId: "echo", model: "echo" }, prompt: "x", providerRegistry: registryWith(model) });
    expect(result).toEqual({ status: "needs_model" });
    expect(model.calls).toHaveLength(0);
  });

  it("runs nothing the model submits: a code node's script is data only", async () => {
    const draft = {
      name: "code",
      nodes: [
        { id: "start", type: "manual_trigger", config: {} },
        { id: "script", type: "code_node", config: { language: "javascript", code: "globalThis.__builderRan = true; return {};" } }
      ],
      edges: [{ source: "start", target: "script" }]
    };
    const model = new ScriptedModel([{ toolCalls: [call("t1", "submit_workflow", draft)] }]);
    const result = await runWorkflowBuilder({ ...base, prompt: "run code", providerRegistry: registryWith(model) });
    expect(result.status).toBe("ready");
    expect((globalThis as Record<string, unknown>).__builderRan).toBeUndefined();
  });
});

/**
 * The end-user validation's Describe-it build (2026-11-19): "When a webhook receives a JSON body with a customer message
 * in the field 'message', use an LLM to classify it ... and reply to the webhook caller with JSON". The model wired a
 * Webhook Response body of {{response}}, a field the LLM Call never outputs, and the webhook answered 200 with an empty
 * body.
 */
const classifyWebhook = (body: string) => ({
  name: "Classify customer messages",
  nodes: [
    { id: "incoming", type: "webhook_input", label: "Incoming message", config: { path: "classify", method: "POST" } },
    {
      id: "build_prompt",
      type: "prompt_template",
      label: "Build prompt",
      config: { template: "Classify as billing, shipping or other and summarise in one sentence. Answer JSON {\"category\", \"summary\"}: {{webhook.message}}" }
    },
    { id: "classify", type: "llm_call", label: "Classify", config: {} },
    { id: "reply", type: "webhook_response", label: "Reply", config: { statusCode: 200, bodyTemplate: body } }
  ],
  edges: [
    { source: "incoming", target: "build_prompt" },
    { source: "build_prompt", target: "classify" },
    { source: "classify", target: "reply" }
  ]
});

describe("template paths in a draft", () => {
  it("sends back a {{ }} path the step before does not output, naming the fields it does output", () => {
    const check = checkBuilderDraft(classifyWebhook("{{response}}"), { workflowId: "wf", nodeModel: NODE_MODEL });
    expect(check.issues).toHaveLength(1);
    expect(check.issues[0]).toMatchObject({ nodeId: "reply" });
    expect(check.issues[0]!.message).toMatch(/\{\{response\}\}/);
    expect(check.issues[0]!.message).toMatch(/'classify' \(llm_call\) outputs answer/);
    // The older alias is not offered.
    expect(check.issues[0]!.message).not.toMatch(/\btext\b/);
  });

  it("accepts the fields the steps output, earlier steps through results, and run-wide names", () => {
    for (const body of ["{{answer}}", "{{text}}", "{{results.classify.answer}}", "{{results.build_prompt.prompt}}", "{\"from\": \"{{webhook.email}}\", \"q\": \"{{user_prompt}}\"}"]) {
      expect(checkBuilderDraft(classifyWebhook(body), { workflowId: "wf", nodeModel: NODE_MODEL }).issues).toEqual([]);
    }
  });

  it("sends back a results path to a node that does not exist or a field it does not output", () => {
    const missingNode = checkBuilderDraft(classifyWebhook("{{results.classifier.answer}}"), { workflowId: "wf", nodeModel: NODE_MODEL });
    expect(missingNode.issues[0]!.message).toMatch(/no node with that id/);
    const missingField = checkBuilderDraft(classifyWebhook("{{results.classify.summary}}"), { workflowId: "wf", nodeModel: NODE_MODEL });
    expect(missingField.issues[0]!.message).toMatch(/'classify' \(llm_call\) outputs answer, toolCalls, raw, not 'summary'/);
  });

  it("does not check what an open step passes on (a webhook's payload, a branch's item, code)", () => {
    const draft = {
      name: "open",
      nodes: [
        { id: "incoming", type: "webhook_input", config: { path: "x", method: "POST" } },
        { id: "check", type: "if_node", config: { condition: "{{amount}} > 10" } },
        { id: "reply", type: "webhook_response", config: { bodyTemplate: "{{customer.name}}" } }
      ],
      edges: [
        { source: "incoming", target: "check" },
        { source: "check", target: "reply", sourceHandle: "true" }
      ]
    };
    expect(checkBuilderDraft(draft, { workflowId: "wf", nodeModel: NODE_MODEL }).issues).toEqual([]);
  });

  it("lists each node's output fields in the catalog and the details", () => {
    const catalog = new Map(builderNodeCatalog().map((entry) => [entry.type as string, entry]));
    expect(catalog.get("llm_call")).toMatchObject({ outputFields: ["answer", "toolCalls", "raw"] });
    expect(catalog.get("http_request")).toMatchObject({ outputFields: ["status", "ok", "headers", "body"] });
    const { nodeTypes } = builderNodeDetails(["llm_call", "webhook_input"]);
    const llm = nodeTypes.find((entry) => entry.type === "llm_call")!;
    expect(llm.outputFields).toEqual(expect.arrayContaining([expect.objectContaining({ name: "answer" })]));
    expect(JSON.stringify(llm.outputFields)).not.toMatch(/"text"/);
    expect(nodeTypes.find((entry) => entry.type === "webhook_input")!.outputNote).toMatch(/body/);
  });

  it("repairs the validation's classify webhook: {{response}} goes back to the model, which answers {{answer}}", async () => {
    const model = new ScriptedModel([
      { toolCalls: [call("t1", "submit_workflow", classifyWebhook("{{response}}"))] },
      { toolCalls: [call("t2", "submit_workflow", classifyWebhook("{{answer}}"))] }
    ]);
    const result = await runWorkflowBuilder({
      workflowId: "wf-built",
      resolveSecret: async () => undefined,
      provider: NODE_MODEL,
      prompt: "When a webhook receives a JSON body with a customer message in the field 'message', classify it and reply with JSON",
      providerRegistry: registryWith(model)
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.attempts).toBe(2);
    expect(result.workflow.nodes.find((node) => node.id === "reply")!.config).toMatchObject({ bodyTemplate: "{{answer}}" });
    const feedback = model.calls[1]!.messages.filter((message) => message.role === "tool").map((message) => String(message.content)).at(-1);
    expect(feedback).toMatch(/\{\{response\}\}/);
    expect(feedback).toMatch(/outputs answer/);
  });

  it("lets a draft whose only problems are template paths through on the last submission, listing them as unfinished", async () => {
    const model = new ScriptedModel([1, 2, 3].map((n) => ({ toolCalls: [call(`t${n}`, "submit_workflow", classifyWebhook("{{response}}"))] })));
    const result = await runWorkflowBuilder({
      workflowId: "wf-built",
      resolveSecret: async () => undefined,
      provider: NODE_MODEL,
      prompt: "classify webhook messages",
      providerRegistry: registryWith(model),
      maxAttempts: 3
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.attempts).toBe(3);
    expect(result.preview.unfinished.map((issue) => issue.message).join("\n")).toMatch(/\{\{response\}\}/);
  });
});
