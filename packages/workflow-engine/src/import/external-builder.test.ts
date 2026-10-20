/**
 * External workflow import — golden-file and behaviour tests.
 *
 * Fixtures live under samples/external-imports. Each `<name>.json` is a source
 * export and `<name>.expected.json` is the converter's golden output. Set
 * UPDATE_EXTERNAL_IMPORT_GOLDENS=1 to rewrite the goldens after an intentional
 * converter change.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { AgentRuntimeAdapter } from "@ai-orchestrator/agent-runtime";
import type { AgentRunRequest, AgentRunState, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";
import { executeCodeNodeSandbox, executeWorkflow } from "../executor";
import { validateWorkflowGraph } from "../validation";
import {
  EXTERNAL_IMPORT_SUPPORTED_TYPES,
  ExternalWorkflowImportError,
  convertExternalWorkflow,
  slugifyNodeId,
  translateExternalExpression,
  type ExternalWorkflowConversion
} from "./external-builder";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "samples", "external-imports");
const FIXTURES = [
  "webhook-http-set",
  "if-two-branches",
  "switch-three-outputs",
  "ai-agent-tools",
  "schedule-code-execute",
  "unsupported-and-odd-expressions"
] as const;

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

function convertFixture(name: string): ExternalWorkflowConversion {
  return convertExternalWorkflow(loadFixture(name));
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nodeById(conversion: ExternalWorkflowConversion, id: string): WorkflowNode {
  const node = conversion.workflow.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error(`node '${id}' not found`);
  return node;
}

function edgesFrom(conversion: ExternalWorkflowConversion, source: string): WorkflowEdge[] {
  return conversion.workflow.edges.filter((edge) => edge.source === source);
}

function reportFor(conversion: ExternalWorkflowConversion, sourceName: string) {
  const entry = conversion.report.nodes.find((node) => node.sourceName === sourceName);
  if (!entry) throw new Error(`report entry for '${sourceName}' not found`);
  return entry;
}

class EchoAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "echo-agent";

  async run(request: AgentRunRequest): Promise<AgentRunState> {
    return {
      finalAnswer: `agent:${request.userPrompt}`,
      stopReason: "final_answer",
      iterations: 1,
      messages: [],
      steps: []
    };
  }
}

function executionDependencies() {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new EchoAgentRuntime(),
    resolveSecret: async () => undefined
  };
}

/** Minimal export builder for focused tests. */
function exportWith(
  nodes: Array<{ name: string; type: string; parameters?: Record<string, unknown>; credentials?: Record<string, unknown>; position?: [number, number]; disabled?: boolean }>,
  connections: Record<string, Record<string, Array<Array<{ node: string; type?: string; index?: number }>>>> = {},
  extra: Record<string, unknown> = {}
) {
  return {
    name: "Focused export",
    nodes: nodes.map((node, index) => ({
      id: `node-${index}`,
      typeVersion: 1,
      position: node.position ?? [index * 200, 0],
      parameters: node.parameters ?? {},
      ...(node.credentials ? { credentials: node.credentials } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      name: node.name,
      type: node.type
    })),
    connections: Object.fromEntries(
      Object.entries(connections).map(([source, byType]) => [
        source,
        Object.fromEntries(
          Object.entries(byType).map(([type, outputs]) => [
            type,
            outputs.map((targets) => targets.map((target) => ({ node: target.node, type: target.type ?? type, index: target.index ?? 0 })))
          ])
        )
      ])
    ),
    settings: { executionOrder: "v1" },
    pinData: {},
    ...extra
  };
}

describe("external workflow import — golden files", () => {
  for (const name of FIXTURES) {
    it(`converts ${name} to its golden output and passes validation`, () => {
      const conversion = roundTrip(convertFixture(name));
      const goldenPath = join(FIXTURE_DIR, `${name}.expected.json`);

      if (process.env.UPDATE_EXTERNAL_IMPORT_GOLDENS === "1" || !existsSync(goldenPath)) {
        writeFileSync(goldenPath, `${JSON.stringify(conversion, null, 2)}\n`, "utf8");
      }

      const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
      expect(conversion).toEqual(golden);

      const validation = validateWorkflowGraph(conversion.workflow);
      expect(validation.issues).toEqual([]);
      expect(validation.valid).toBe(true);
    });
  }

  it("reports every source node exactly once", () => {
    for (const name of FIXTURES) {
      const source = loadFixture(name) as { nodes: Array<{ name: string }> };
      const { report } = convertFixture(name);
      expect(report.nodes.map((entry) => entry.sourceName).sort()).toEqual(source.nodes.map((node) => node.name).sort());
      expect(report.summary.total).toBe(source.nodes.length);
      expect(report.summary.mapped + report.summary.approximated + report.summary.unsupported).toBe(source.nodes.length);
      for (const entry of report.nodes) {
        expect(["mapped", "approximated", "unsupported"]).toContain(entry.status);
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("external workflow import — webhook, HTTP request and field assignments", () => {
  const conversion = convertFixture("webhook-http-set");

  it("maps the webhook trigger with its route and response settings", () => {
    const webhook = nodeById(conversion, "webhook");
    expect(webhook.type).toBe("webhook_input");
    expect(webhook.config).toMatchObject({ path: "lead-enrich", method: "POST", authMode: "none", responseMode: "lastNode", responseCode: 200 });
    expect(webhook.position).toEqual({ x: -200, y: 300 });
    expect(reportFor(conversion, "Webhook").status).toBe("mapped");
  });

  it("maps the HTTP request with translated URL, query, headers, timeout and a secretRef placeholder", () => {
    const http = nodeById(conversion, "http_request");
    expect(http.type).toBe("http_request");
    expect(http.config.method).toBe("GET");
    expect(http.config.urlTemplate).toBe("https://api.example.com/v1/people/{{results.webhook.body.userId}}?include=company");
    expect(JSON.parse(String(http.config.headersTemplate))).toEqual({ Accept: "application/json", "X-Request-Id": "{{execution.id}}" });
    expect(http.config.timeoutMs).toBe(10000);
    expect(http.config.secretRef).toEqual({ secretId: "import-httpheaderauth-enrichment_api_key" });
    expect(JSON.stringify(http.config)).not.toContain("cred_41");
    expect(reportFor(conversion, "HTTP Request").status).toBe("approximated");
  });

  it("lists credentials to resolve without raw values", () => {
    expect(conversion.report.secretsToResolve).toEqual([
      { secretId: "import-httpheaderauth-enrichment_api_key", credentialType: "httpHeaderAuth", credentialName: "Enrichment API key", nodeIds: ["http_request"] }
    ]);
  });

  it("maps Edit Fields to set_node assignments with translated expressions", () => {
    const set = nodeById(conversion, "edit_fields");
    expect(set.type).toBe("set_node");
    expect(set.config.assignments).toEqual([
      { key: "email", valueTemplate: "{{results.webhook.body.email}}" },
      { key: "company", valueTemplate: "{{results.http_request.company.name}}" },
      { key: "enrichedAt", valueTemplate: "{{ $now.toISOString() }}" },
      { key: "score", valueTemplate: "42" },
      { key: "source", valueTemplate: "webhook" }
    ]);
  });

  it("carries pinned data, tags and the edge chain into a single output node", () => {
    expect(conversion.workflow.pinnedData).toEqual({
      webhook: { headers: { "content-type": "application/json" }, body: { userId: "u_123", email: "ada@example.com" } }
    });
    expect(conversion.workflow.tags).toEqual(["leads"]);
    expect(conversion.workflow.schemaVersion).toBe("1.0.0");
    expect(conversion.workflow.id).toBe("wf-import-lead_enrichment_webhook");
    expect(conversion.workflow.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["webhook", "http_request"],
      ["http_request", "edit_fields"],
      ["edit_fields", "import_output"]
    ]);
    expect(nodeById(conversion, "import_output").type).toBe("output");
  });
});

describe("external workflow import — IF with two branches", () => {
  const conversion = convertFixture("if-two-branches");

  it("maps the manual trigger, sticky note and no-op", () => {
    expect(nodeById(conversion, "when_clicking_test_workflow").type).toBe("manual_trigger");
    expect(nodeById(conversion, "auto_approve").type).toBe("noop_node");
    const sticky = nodeById(conversion, "sticky_note");
    expect(sticky.type).toBe("sticky_note");
    expect(sticky.config).toMatchObject({ content: "## Approval rule\nOrders above 100 go to a human.", color: "green", width: 260, height: 120 });
    expect(sticky.position).toEqual({ x: 380, y: -220 });
  });

  it("compiles the structured conditions into one condition expression", () => {
    const ifNode = nodeById(conversion, "needs_approval");
    expect(ifNode.type).toBe("if_node");
    expect(ifNode.config.condition).toBe(
      '{{ (String(results.sample_order.status ?? "") === "active") && (Number(results.sample_order.amount) > Number(100)) }}'
    );
    expect(reportFor(conversion, "Needs approval?").status).toBe("mapped");
  });

  it("maps output indexes 0 and 1 to the true and false handles", () => {
    const branches = edgesFrom(conversion, "needs_approval");
    expect(branches).toEqual([
      expect.objectContaining({ target: "request_approval", sourceHandle: "true" }),
      expect.objectContaining({ target: "auto_approve", sourceHandle: "false" })
    ]);
  });

  it("translates a JSON body with named-node and current-item references", () => {
    const http = nodeById(conversion, "request_approval");
    expect(http.config.bodyTemplate).toBe('{\n  "amount": {{results.needs_approval.amount}},\n  "requestedBy": "{{results.sample_order.status}}"\n}');
  });
});

describe("external workflow import — Switch with three outputs", () => {
  const conversion = convertFixture("switch-three-outputs");

  it("maps same-field equality rules to switchValue plus cases with renamed labels", () => {
    const switchNode = nodeById(conversion, "route_by_type");
    expect(switchNode.type).toBe("switch_node");
    expect(switchNode.config).toEqual({
      switchValue: "{{results.event_webhook.body.type}}",
      cases: [
        { value: "order.created", label: "order" },
        { value: "refund.requested", label: "refund" },
        { value: "ticket.opened", label: "ticket" }
      ],
      defaultLabel: "default"
    });
    expect(reportFor(conversion, "Route by type").status).toBe("mapped");
  });

  it("routes output indexes to case labels and the extra fallback output to default", () => {
    expect(edgesFrom(conversion, "route_by_type")).toEqual([
      expect.objectContaining({ target: "tag_order", sourceHandle: "order" }),
      expect.objectContaining({ target: "tag_refund", sourceHandle: "refund" }),
      expect.objectContaining({ target: "tag_ticket", sourceHandle: "ticket" }),
      expect.objectContaining({ target: "unknown_event", sourceHandle: "default" })
    ]);
  });

  it("maps merge-by-field to combine_by_key and labels merge inputs", () => {
    const merge = nodeById(conversion, "merge");
    expect(merge.config).toEqual({ mode: "combine_by_key", combineKey: "queue" });
    const incoming = conversion.workflow.edges.filter((edge) => edge.target === "merge");
    expect(incoming.map((edge) => edge.label)).toEqual(["input 1", "input 2"]);
  });

  it("maps Stop and Error and keeps it out of the output wiring", () => {
    const stop = nodeById(conversion, "unknown_event");
    expect(stop.type).toBe("stop_and_error");
    expect(stop.config).toEqual({ errorCode: "WORKFLOW_STOPPED", message: "Unknown event type: {{results.route_by_type.body.type}}" });
    expect(edgesFrom(conversion, "unknown_event")).toEqual([]);
    expect(conversion.workflow.edges.filter((edge) => edge.target === "import_output").map((edge) => edge.source).sort()).toEqual(["merge", "tag_ticket"]);
  });
});

describe("external workflow import — AI agent with model, memory, tools and parser", () => {
  const conversion = convertFixture("ai-agent-tools");

  it("maps the chat trigger and the agent", () => {
    expect(nodeById(conversion, "chat").config).toMatchObject({ authMode: "public", welcomeMessage: "Hi! How can I help with your order?", persistMessages: true });
    const agent = nodeById(conversion, "ai_agent");
    expect(agent.type).toBe("agent_orchestrator");
    expect(agent.config).toEqual({
      agentType: "tools",
      systemPromptTemplate: "You are a support agent for Example Shop. Use the tools to look up orders.",
      userPromptTemplate: "{{results.chat.chatInput}}",
      sessionIdTemplate: "{{session_id}}",
      maxIterations: 8,
      toolCallingEnabled: true
    });
  });

  it("turns sub-node connections into chat_model, memory and tool attachment edges from the agent", () => {
    const attachments = conversion.workflow.edges.filter((edge) => ["chat_model", "memory", "tool"].includes(edge.sourceHandle ?? ""));
    expect(attachments).toEqual([
      expect.objectContaining({ source: "ai_agent", target: "openai_chat_model", sourceHandle: "chat_model" }),
      expect.objectContaining({ source: "ai_agent", target: "simple_memory", sourceHandle: "memory" }),
      expect.objectContaining({ source: "ai_agent", target: "orders_mcp", sourceHandle: "tool" }),
      expect.objectContaining({ source: "ai_agent", target: "shipping_mcp", sourceHandle: "tool" })
    ]);
  });

  it("maps the chat model by provider with options and a secretRef placeholder", () => {
    const model = nodeById(conversion, "openai_chat_model");
    expect(model.type).toBe("openai_chat_model");
    expect(model.config).toEqual({
      model: "gpt-4o-mini",
      promptKey: "prompt",
      systemPromptKey: "system_prompt",
      temperature: 0.3,
      maxTokens: 2048,
      secretRef: { secretId: "import-openaiapi-openai_account" }
    });
  });

  it("maps Simple Memory to local_memory with the custom session key and window length", () => {
    const memory = nodeById(conversion, "simple_memory");
    expect(memory.type).toBe("local_memory");
    expect(memory.config).toEqual({ namespace: "support_agent", sessionIdTemplate: "{{ $json.sessionId }}", maxMessages: 12, persistToolMessages: false });
  });

  it("maps MCP client tools to mcp_tool nodes", () => {
    const orders = nodeById(conversion, "orders_mcp");
    expect(orders.type).toBe("mcp_tool");
    expect(orders.config).toEqual({
      serverId: "orders_mcp",
      toolName: "lookup_order",
      argsTemplate: "{}",
      connection: { endpoint: "https://mcp.example.com/orders/mcp", transport: "http_streamable", authType: "bearer" },
      allowedTools: ["lookup_order"],
      secretRef: { secretId: "import-httpbearerauth-orders_mcp_token" }
    });
    const shipping = nodeById(conversion, "shipping_mcp");
    expect(shipping.config).toMatchObject({ toolName: "__all__", connection: { transport: "http_streamable" } });
    expect(reportFor(conversion, "Shipping MCP")).toMatchObject({ status: "approximated", reason: expect.stringContaining("SSE") });
  });

  it("maps the structured output parser and inserts it between the agent and its downstream nodes", () => {
    const parser = nodeById(conversion, "structured_output_parser");
    expect(parser.type).toBe("output_parser");
    expect(parser.config.mode).toBe("json_schema");
    expect(JSON.parse(String(parser.config.jsonSchema))).toEqual({
      type: "object",
      properties: { answer: { type: "string" }, orderId: { type: "string" }, escalate: { type: "boolean" } },
      required: ["answer", "orderId", "escalate"]
    });
    const mainEdges = conversion.workflow.edges.filter((edge) => !edge.sourceHandle).map((edge) => [edge.source, edge.target]);
    expect(mainEdges).toEqual([
      ["chat", "ai_agent"],
      ["structured_output_parser", "format_reply"],
      ["ai_agent", "structured_output_parser"],
      ["format_reply", "import_output"]
    ]);
  });

  it("does not wire attachment nodes into the output", () => {
    const outputSources = conversion.workflow.edges.filter((edge) => edge.target === "import_output").map((edge) => edge.source);
    expect(outputSources).toEqual(["format_reply"]);
  });
});

describe("external workflow import — schedule, code and execute workflow", () => {
  const conversion = convertFixture("schedule-code-execute");

  it("maps a daily interval to cron with the workflow timezone", () => {
    expect(nodeById(conversion, "schedule_trigger").config).toEqual({ cronExpression: "30 2 * * *", timezone: "Asia/Kolkata", active: true });
  });

  it("wraps JavaScript code in a compatibility shim and keeps the user code", () => {
    const code = nodeById(conversion, "collect");
    expect(code.type).toBe("code_node");
    expect(code.config.language).toBe("javascript");
    const body = String(code.config.code);
    expect(body).toContain("const runs = $input.all();");
    expect(body).toContain('"Schedule Trigger":"schedule_trigger"');
    expect(body).toContain("const $json = input;");
    expect(reportFor(conversion, "Collect").status).toBe("approximated");
  });

  it("maps wait, execute workflow, split out, sort, limit and aggregate", () => {
    expect(nodeById(conversion, "wait").config).toEqual({ resumeMode: "timer", delayMs: 5000, maxDelayMs: 30000 });
    expect(nodeById(conversion, "build_digest").config).toEqual({ workflowId: "wf_child_digest", mode: "sync", inputMapping: { since: "since" } });
    expect(nodeById(conversion, "split_out").config).toEqual({ field: "items" });
    expect(nodeById(conversion, "sort").config).toEqual({ inputKey: "items", order: "desc", field: "createdAt" });
    expect(nodeById(conversion, "limit").config).toEqual({ maxItems: 10, keep: "first", inputKey: "items" });
    expect(nodeById(conversion, "aggregate").config).toEqual({ operation: "concatenate", inputKey: "items", field: "title", separator: "," });
    expect(reportFor(conversion, "Build digest").status).toBe("approximated");
    expect(reportFor(conversion, "Aggregate").status).toBe("approximated");
  });

  it("warns about the source error workflow setting", () => {
    expect(conversion.report.warnings).toEqual([expect.stringContaining("error workflow")]);
  });

  it("executes the shimmed code node against results of earlier nodes", async () => {
    const code = String(nodeById(conversion, "collect").config.code);
    const result = await executeCodeNodeSandbox({
      code,
      input: { id: 7, results: { schedule_trigger: { timestamp: "2026-01-01T00:00:00.000Z" } } },
      timeoutMs: 2000
    });
    expect(result.result).toEqual({ since: "2026-01-01T00:00:00.000Z", items: [{ id: 7, results: { schedule_trigger: { timestamp: "2026-01-01T00:00:00.000Z" } } }], total: 1 });
  });
});

describe("external workflow import — unsupported nodes and odd expressions", () => {
  const conversion = convertFixture("unsupported-and-odd-expressions");

  it("turns unsupported nodes into disabled noop placeholders carrying the original config", () => {
    const slack = nodeById(conversion, "slack");
    expect(slack.type).toBe("noop_node");
    expect(slack.disabled).toBe(true);
    expect(slack.config.label).toBe("Unsupported: slack");
    expect(slack.config.importedFrom).toMatchObject({
      type: "n8n-nodes-base.slack",
      parameters: { text: "=New feedback from {{ $json.Name }}" },
      credentials: { slackApi: "Slack bot" }
    });
    expect(JSON.stringify(slack.config)).not.toContain("cred_3");
    expect(reportFor(conversion, "Slack")).toMatchObject({ status: "unsupported", targetType: "noop_node" });
    expect(reportFor(conversion, "Google Sheets").status).toBe("unsupported");
    expect(conversion.report.summary).toEqual({ total: 13, mapped: 5, approximated: 4, unsupported: 4 });
  });

  it("keeps the main chain through placeholders so the flow still loads", () => {
    const chain = conversion.workflow.edges.filter((edge) => !edge.sourceHandle).map((edge) => [edge.source, edge.target]);
    expect(chain).toContainEqual(["feedback_form", "slack"]);
    expect(chain).toContainEqual(["slack", "google_sheets"]);
    expect(chain).toContainEqual(["google_sheets", "odd_fields"]);
  });

  it("translates the known expression subset and flags the rest verbatim", () => {
    const assignments = nodeById(conversion, "odd_fields").config.assignments as Array<{ key: string; valueTemplate: string }>;
    const byKey = Object.fromEntries(assignments.map((entry) => [entry.key, entry.valueTemplate]));
    expect(byKey).toEqual({
      attachment: "{{ $binary.data.fileName }}",
      year: "{{ $now.toFormat('yyyy') }}",
      missing: "{{ $('Nope').item.json.value }}",
      apiBase: "{{vars.API_BASE}}",
      region: "{{vars.region}}",
      meta: "{{workflow.name}} / {{execution.id}}",
      day: "{{ $today.toISOString().slice(0, 10) }}",
      stamp: "{{ $now.toISOString() }}",
      fallback: "{{ $ifEmpty(results.google_sheets.Rating, 'n/a') }}",
      runs: "{{ $runIndex }}"
    });
    expect(conversion.report.unresolvedExpressions).toEqual([
      { nodeId: "odd_fields", sourceName: "Odd fields", path: "assignments[0].value", expression: "$binary.data.fileName", reason: "unsupported runtime reference '$binary'" },
      { nodeId: "odd_fields", sourceName: "Odd fields", path: "assignments[1].value", expression: "$now.toFormat('yyyy')", reason: "date helper .toFormat() has no direct equivalent" },
      { nodeId: "odd_fields", sourceName: "Odd fields", path: "assignments[2].value", expression: "$('Nope').item.json.value", reason: "unknown node reference 'Nope'" },
      { nodeId: "odd_fields", sourceName: "Odd fields", path: "assignments[9].value", expression: "$runIndex", reason: "unsupported runtime reference '$runIndex'" }
    ]);
  });

  it("creates placeholder workflow variables for $env and $vars references", () => {
    expect(conversion.workflow.variables).toEqual({ API_BASE: "", region: "" });
    expect(conversion.report.variablesToSet).toEqual(["API_BASE", "region"]);
  });

  it("maps the remaining triggers", () => {
    const form = nodeById(conversion, "feedback_form");
    expect(form.type).toBe("form_trigger");
    expect(form.config).toMatchObject({
      path: "feedback",
      title: "Feedback",
      description: "Tell us what you think",
      submitLabel: "Send",
      successMessage: "Thanks!",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "rating", label: "Rating", type: "select", required: false, options: ["1", "2", "3"] },
        { name: "attachment", label: "Attachment", type: "text", required: false }
      ]
    });
    expect(reportFor(conversion, "Feedback form")).toMatchObject({ status: "approximated", reason: expect.stringContaining("'file'") });
    expect(nodeById(conversion, "error_trigger").type).toBe("error_trigger");
    expect(nodeById(conversion, "rss_feed_trigger").config).toEqual({ feedUrl: "https://example.com/feed.xml", pollIntervalSeconds: 900, active: true });
    const imap = nodeById(conversion, "email_trigger_imap");
    expect(imap.type).toBe("imap_email_trigger");
    expect(imap.config).toMatchObject({ mailbox: "INBOX", secretRef: { secretId: "import-imap-support_inbox" } });
    expect(reportFor(conversion, "Email Trigger (IMAP)").status).toBe("approximated");
  });

  it("keeps Python code verbatim and maps the filter", () => {
    const python = nodeById(conversion, "python");
    expect(python.config).toMatchObject({ language: "python", code: "for item in _input.all():\n    item.json['seen'] = True\nreturn _input.all()" });
    expect(nodeById(conversion, "top_ratings").config).toEqual({
      conditions: [{ field: "results.summarise.Rating", operator: "eq", value: "3" }],
      combineWith: "AND",
      passMode: "pass"
    });
  });

  it("drops attachments that cannot be honoured and reports why", () => {
    expect(conversion.report.warnings).toEqual([
      expect.stringContaining("'Mars/Olympus'"),
      expect.stringContaining("'Ghost node'"),
      expect.stringContaining("'Calculator'"),
      expect.stringContaining("'ai_embedding'")
    ]);
    const agentEdges = edgesFrom(conversion, "summarise");
    expect(agentEdges).toEqual([
      expect.objectContaining({ target: "top_ratings" }),
      expect.objectContaining({ target: "anthropic_chat_model", sourceHandle: "chat_model" })
    ]);
    const outputSources = conversion.workflow.edges.filter((edge) => edge.target === "import_output").map((edge) => edge.source).sort();
    expect(outputSources).toEqual(["email_trigger_imap", "error_trigger", "rss_feed_trigger", "top_ratings"]);
  });

  it("falls back to UTC for an invalid workflow timezone", () => {
    const conversionWithSchedule = convertExternalWorkflow(
      exportWith([{ name: "Every hour", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "hours", hoursInterval: 1 }] } } }], {}, {
        settings: { timezone: "Mars/Olympus" }
      })
    );
    expect(nodeById(conversionWithSchedule, "every_hour").config.timezone).toBe("UTC");
  });
});

describe("external workflow import — expression translation", () => {
  const context = { nodeIdByName: { Webhook: "webhook", "HTTP Request": "http_request" }, previousNodeId: "http_request" };

  it("translates current-item references to the feeding node", () => {
    expect(translateExternalExpression("={{ $json.user.id }}", context).value).toBe("{{results.http_request.user.id}}");
    expect(translateExternalExpression("={{ $input.item.json.user.id }}", context).value).toBe("{{results.http_request.user.id}}");
    expect(translateExternalExpression("={{ $input.first().json.total }}", context).value).toBe("{{results.http_request.total}}");
  });

  it("translates named node references in every supported spelling", () => {
    expect(translateExternalExpression('={{ $node["Webhook"].json.body.id }}', context).value).toBe("{{results.webhook.body.id}}");
    expect(translateExternalExpression("={{ $node['Webhook'].json.body.id }}", context).value).toBe("{{results.webhook.body.id}}");
    expect(translateExternalExpression("={{ $node.Webhook.json.body.id }}", context).value).toBe("{{results.webhook.body.id}}");
    expect(translateExternalExpression("={{ $('Webhook').item.json.body.id }}", context).value).toBe("{{results.webhook.body.id}}");
    expect(translateExternalExpression('={{ $("HTTP Request").first().json.status }}', context).value).toBe("{{results.http_request.status}}");
    expect(translateExternalExpression("={{ $('HTTP Request').last().json.status }}", context).value).toBe("{{results.http_request.status}}");
    expect(translateExternalExpression('={{ $items("Webhook")[0].json.body.id }}', context).value).toBe("{{results.webhook.body.id}}");
  });

  it("keeps $json when there is no feeding node", () => {
    expect(translateExternalExpression("={{ $json.chatInput }}", { nodeIdByName: {} }).value).toBe("{{ $json.chatInput }}");
  });

  it("translates $now, $today, $env, $vars, $workflow and $execution", () => {
    expect(translateExternalExpression("={{ $now }}", context).value).toBe("{{ $now.toISOString() }}");
    expect(translateExternalExpression("={{ $now.toISO() }}", context).value).toBe("{{ $now.toISOString() }}");
    expect(translateExternalExpression("={{ $today.toISODate() }}", context).value).toBe("{{ $today.toISOString().slice(0, 10) }}");
    expect(translateExternalExpression("={{ $now.toMillis() }}", context).value).toBe("{{ $now.getTime() }}");
    const env = translateExternalExpression("={{ $env.API_KEY }}/{{ $env['BASE'] }}/{{ $vars.region }}", context);
    expect(env.value).toBe("{{vars.API_KEY}}/{{vars.BASE}}/{{vars.region}}");
    expect(env.variables).toEqual(["API_KEY", "BASE", "region"]);
    expect(translateExternalExpression("={{ $workflow.name }}-{{ $execution.id }}", context).value).toBe("{{workflow.name}}-{{execution.id}}");
  });

  it("keeps complex expressions as expressions and supported helpers untouched", () => {
    expect(translateExternalExpression("={{ $json.total * 2 }}", context).value).toBe("{{ results.http_request.total * 2 }}");
    expect(translateExternalExpression("={{ $if($json.ok, 'yes', 'no') }}", context).value).toBe("{{ $if(results.http_request.ok, 'yes', 'no') }}");
    expect(translateExternalExpression("={{ $jmespath($json, 'items[0].id') }}", context).value).toBe("{{ $jmespath(results.http_request, 'items[0].id') }}");
  });

  it("leaves literals and unknown expressions verbatim and flags the unknown ones", () => {
    expect(translateExternalExpression("plain text", context)).toEqual({ value: "plain text", unresolved: [], variables: [] });
    const unknown = translateExternalExpression("={{ $binary.data }} and {{ $('Missing').item.json.x }} and {{ $input.all().length }}", context);
    expect(unknown.value).toBe("{{ $binary.data }} and {{ $('Missing').item.json.x }} and {{ $input.all().length }}");
    expect(unknown.unresolved.map((entry) => entry.reason)).toEqual([
      "unsupported runtime reference '$binary'",
      "unknown node reference 'Missing'",
      "item list access ($input.all())"
    ]);
  });
});

describe("external workflow import — additional node variants", () => {
  it("maps schedule intervals and the legacy cron node", () => {
    const conversion = convertExternalWorkflow(
      exportWith(
        [
          { name: "Minutes", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 15 }] } } },
          { name: "Hours", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "hours", hoursInterval: 6, triggerAtMinute: 5 }] } } },
          { name: "Weekly", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "weeks", triggerAtDay: [1, 3], triggerAtHour: 9 }] } } },
          { name: "Custom", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 0 1 * *" }] } } },
          { name: "Legacy", type: "n8n-nodes-base.cron", parameters: { triggerTimes: { item: [{ mode: "everyDay", hour: 7, minute: 45 }] } } },
          { name: "Seconds", type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "seconds", secondsInterval: 30 }] } } }
        ],
        {},
        { settings: { timezone: "Europe/London" } }
      )
    );
    expect(nodeById(conversion, "minutes").config).toMatchObject({ cronExpression: "*/15 * * * *", timezone: "Europe/London" });
    expect(nodeById(conversion, "hours").config.cronExpression).toBe("5 */6 * * *");
    expect(nodeById(conversion, "weekly").config.cronExpression).toBe("0 9 * * 1,3");
    expect(nodeById(conversion, "custom").config.cronExpression).toBe("0 0 1 * *");
    expect(nodeById(conversion, "legacy").config.cronExpression).toBe("45 7 * * *");
    expect(nodeById(conversion, "seconds").config.cronExpression).toBe("* * * * *");
    expect(reportFor(conversion, "Seconds").status).toBe("approximated");
    expect(validateWorkflowGraph(conversion.workflow).valid).toBe(true);
  });

  it("maps chat models by provider and approximates unknown providers", () => {
    const conversion = convertExternalWorkflow(
      exportWith(
        [
          { name: "Agent", type: "@n8n/n8n-nodes-langchain.agent", parameters: { promptType: "define", text: "hello", options: {} } },
          { name: "Gemini", type: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini", parameters: { modelName: "models/gemini-2.5-pro", options: { temperature: 0.1 } }, credentials: { googlePalmApi: { id: "c1", name: "Gemini key" } } },
          { name: "Ollama", type: "@n8n/n8n-nodes-langchain.lmChatOllama", parameters: { model: "llama3.1:8b", options: {} } },
          { name: "Azure", type: "@n8n/n8n-nodes-langchain.lmChatAzureOpenAi", parameters: { model: "gpt-4o-deploy", options: {} }, credentials: { azureOpenAiApi: { id: "c2", name: "Azure key" } } },
          { name: "Groq", type: "@n8n/n8n-nodes-langchain.lmChatGroq", parameters: { model: "llama-3.1-70b", options: {} } },
          { name: "Anthropic", type: "@n8n/n8n-nodes-langchain.lmChatAnthropic", parameters: { model: { __rl: true, value: "claude-sonnet-4-5", mode: "list" }, options: { maxTokensToSample: 4096 } } },
          { name: "Mystery", type: "@n8n/n8n-nodes-langchain.lmChatSomethingNew", parameters: { model: "x-1", options: {} } }
        ],
        { Gemini: { ai_languageModel: [[{ node: "Agent" }]] } }
      )
    );
    expect(nodeById(conversion, "gemini").type).toBe("google_gemini_chat_model");
    expect(nodeById(conversion, "gemini").config).toMatchObject({ model: "models/gemini-2.5-pro", temperature: 0.1, secretRef: { secretId: "import-googlepalmapi-gemini_key" } });
    expect(nodeById(conversion, "ollama").type).toBe("ollama_chat_model");
    expect(nodeById(conversion, "ollama").config).toMatchObject({ model: "llama3.1:8b", baseUrl: "http://localhost:11434/v1" });
    expect(nodeById(conversion, "azure").type).toBe("azure_openai_chat_model");
    expect(nodeById(conversion, "azure").config).toMatchObject({ deployment: "gpt-4o-deploy", secretRef: { secretId: "import-azureopenaiapi-azure_key" } });
    expect(reportFor(conversion, "Azure").status).toBe("approximated");
    expect(nodeById(conversion, "groq").type).toBe("openai_compatible_chat_model");
    expect(nodeById(conversion, "groq").config).toMatchObject({ model: "llama-3.1-70b", baseUrl: "https://api.groq.com/openai/v1" });
    expect(nodeById(conversion, "anthropic").config).toMatchObject({ model: "claude-sonnet-4-5", maxTokens: 4096 });
    expect(nodeById(conversion, "mystery").type).toBe("openai_compatible_chat_model");
    expect(reportFor(conversion, "Mystery")).toMatchObject({ status: "approximated", reason: expect.stringContaining("lmChatSomethingNew") });
    expect(validateWorkflowGraph(conversion.workflow).valid).toBe(true);
  });

  it("compiles mixed switch rules into a routing expression and legacy switch rules into cases", () => {
    const conversion = convertExternalWorkflow(
      exportWith(
        [
          { name: "Start", type: "n8n-nodes-base.manualTrigger" },
          {
            name: "Mixed",
            type: "n8n-nodes-base.switch",
            parameters: {
              rules: {
                values: [
                  { conditions: { conditions: [{ leftValue: "={{ $json.amount }}", rightValue: 100, operator: { type: "number", operation: "gt" } }], combinator: "and" }, renameOutput: true, outputKey: "big" },
                  { conditions: { conditions: [{ leftValue: "={{ $json.tag }}", rightValue: "vip", operator: { type: "string", operation: "contains" } }], combinator: "and" } }
                ]
              },
              options: { fallbackOutput: 1 }
            }
          },
          { name: "Legacy", type: "n8n-nodes-base.switch", parameters: { mode: "rules", value1: "={{ $json.kind }}", rules: { rules: [{ value2: "a", outputKey: "alpha" }, { value2: "b" }] } } },
          { name: "A", type: "n8n-nodes-base.noOp" },
          { name: "B", type: "n8n-nodes-base.noOp" }
        ],
        {
          Start: { main: [[{ node: "Mixed" }]] },
          Mixed: { main: [[{ node: "A" }], [{ node: "B" }]] }
        }
      )
    );
    const mixed = nodeById(conversion, "mixed");
    expect(mixed.config.switchValue).toBe(
      '{{ ((Number(results.start.amount) > Number(100))) ? "big" : ((String(results.start.tag ?? "").includes("vip"))) ? "output_1" : "default" }}'
    );
    expect(mixed.config.cases).toEqual([
      { value: "big", label: "big" },
      { value: "output_1", label: "output_1" }
    ]);
    expect(reportFor(conversion, "Mixed").status).toBe("approximated");
    expect(edgesFrom(conversion, "mixed")).toEqual([
      expect.objectContaining({ target: "a", sourceHandle: "big" }),
      expect.objectContaining({ target: "b", sourceHandle: "default" }),
      expect.objectContaining({ target: "b", sourceHandle: "output_1" })
    ]);
    const legacy = nodeById(conversion, "legacy");
    expect(legacy.config).toEqual({
      switchValue: "{{ $json.kind }}",
      cases: [
        { value: "a", label: "alpha" },
        { value: "b", label: "output_1" }
      ],
      defaultLabel: "default"
    });
  });

  it("compiles legacy IF conditions and handles the remaining operators", () => {
    const conversion = convertExternalWorkflow(
      exportWith(
        [
          { name: "Start", type: "n8n-nodes-base.manualTrigger" },
          { name: "Legacy IF", type: "n8n-nodes-base.if", parameters: { conditions: { string: [{ value1: "={{ $json.name }}", operation: "contains", value2: "x" }], boolean: [{ value1: "={{ $json.ok }}", operation: "equal", value2: true }] } } },
          {
            name: "Modern IF",
            type: "n8n-nodes-base.if",
            parameters: {
              conditions: {
                combinator: "or",
                conditions: [
                  { leftValue: "={{ $json.tags }}", rightValue: "", operator: { type: "array", operation: "notEmpty" } },
                  { leftValue: "={{ $json.email }}", rightValue: "^.+@.+$", operator: { type: "string", operation: "regex" } },
                  { leftValue: "={{ $json.when }}", rightValue: "2026-01-01", operator: { type: "dateTime", operation: "after" } },
                  { leftValue: "={{ $json.flag }}", rightValue: "", operator: { type: "boolean", operation: "true" } },
                  { leftValue: "={{ $json.other }}", rightValue: "", operator: { type: "object", operation: "exists" } },
                  { leftValue: "=prefix-{{ $json.id }}", rightValue: "prefix-1", operator: { type: "string", operation: "startsWith" } }
                ]
              }
            }
          }
        ],
        { Start: { main: [[{ node: "Legacy IF" }, { node: "Modern IF" }]] } }
      )
    );
    expect(nodeById(conversion, "legacy_if").config.condition).toBe(
      '{{ (String(results.start.name ?? "").includes("x")) && (String(results.start.ok ?? "") === "true") }}'
    );
    expect(nodeById(conversion, "modern_if").config.condition).toBe(
      "{{ (!(results.start.tags === undefined || results.start.tags === null || results.start.tags === \"\" || (Array.isArray(results.start.tags) && results.start.tags.length === 0))) || " +
        '(new RegExp("^.+@.+$").test(String(results.start.email ?? ""))) || ' +
        '(new Date(results.start.when).getTime() > new Date("2026-01-01").getTime()) || ' +
        '((results.start.flag === true || String(results.start.flag ?? "") === "true")) || ' +
        "((results.start.other !== undefined && results.start.other !== null)) || " +
        '(String(`prefix-${results.start.id}` ?? "").startsWith("prefix-1")) }}'
    );
  });

  it("keeps an untranslatable condition verbatim and marks the node approximated", () => {
    const conversion = convertExternalWorkflow(
      exportWith(
        [
          { name: "Start", type: "n8n-nodes-base.manualTrigger" },
          { name: "Odd IF", type: "n8n-nodes-base.if", parameters: { conditions: { conditions: [{ leftValue: "={{ $binary.size }}", rightValue: 10, operator: { type: "number", operation: "gt" } }], combinator: "and" } } }
        ],
        { Start: { main: [[{ node: "Odd IF" }]] } }
      )
    );
    expect(nodeById(conversion, "odd_if").config.condition).toBe("{{ (Number(($binary.size)) > Number(10)) }}");
    expect(reportFor(conversion, "Odd IF")).toMatchObject({ status: "approximated", reason: expect.stringContaining("verbatim") });
    expect(conversion.report.unresolvedExpressions).toEqual([expect.objectContaining({ nodeId: "odd_if", path: "conditions[0].leftValue", expression: "$binary.size" })]);
  });

  it("maps the remaining core node variants", () => {
    const conversion = convertExternalWorkflow(
      exportWith(
        [
          { name: "Start", type: "n8n-nodes-base.webhook", parameters: { path: "in", httpMethod: "GET", authentication: "headerAuth" }, credentials: { httpHeaderAuth: { id: "c9", name: "Inbound key" } } },
          { name: "Raw set", type: "n8n-nodes-base.set", parameters: { mode: "raw", jsonOutput: '{"a": 1, "b": "two"}' } },
          { name: "Legacy set", type: "n8n-nodes-base.set", parameters: { values: { string: [{ name: "s", value: "={{ $json.a }}" }], number: [{ name: "n", value: 3 }] }, keepOnlySet: true } },
          { name: "Webhook wait", type: "n8n-nodes-base.wait", parameters: { resume: "webhook", options: { webhookSuffix: "resume-here" } } },
          { name: "Error object", type: "n8n-nodes-base.stopAndError", parameters: { errorType: "errorObject", errorObject: '{"message": "boom", "code": "E_BOOM"}' } },
          { name: "Append merge", type: "n8n-nodes-base.merge", parameters: { mode: "append" } },
          { name: "Random sort", type: "n8n-nodes-base.sort", parameters: { type: "random" } },
          { name: "Last limit", type: "n8n-nodes-base.limit", parameters: { maxItems: 3, keep: "lastItems" } },
          { name: "Split many", type: "n8n-nodes-base.splitOut", parameters: { fieldToSplitOut: "a, b", options: { destinationFieldName: "row" } } },
          { name: "Async child", type: "n8n-nodes-base.executeWorkflow", parameters: { workflowId: "child-1", options: { waitForSubWorkflow: false } } },
          { name: "Legacy HTTP", type: "n8n-nodes-base.httpRequest", parameters: { requestMethod: "POST", url: "https://example.com", bodyParametersJson: '={"id": {{ $json.a }}}', headerParametersJson: '{"X": "1"}' } },
          { name: "Form body", type: "n8n-nodes-base.httpRequest", parameters: { method: "PUT", url: "https://example.com/u", sendBody: true, specifyBody: "keypair", contentType: "form-urlencoded", bodyParameters: { parameters: [{ name: "k", value: "v" }] }, options: { response: { response: { responseFormat: "text" } } } } }
        ],
        {
          Start: { main: [[{ node: "Raw set" }]] },
          "Raw set": { main: [[{ node: "Legacy set" }, { node: "Append merge", index: 0 }]] },
          "Legacy set": { main: [[{ node: "Append merge", index: 1 }]] },
          "Append merge": { main: [[{ node: "Webhook wait" }]] }
        }
      )
    );
    expect(nodeById(conversion, "start").config).toMatchObject({ method: "GET", authMode: "bearer_token", authHeaderName: "authorization", secretRef: { secretId: "import-httpheaderauth-inbound_key" } });
    expect(nodeById(conversion, "raw_set").config.assignments).toEqual([
      { key: "a", valueTemplate: "1" },
      { key: "b", valueTemplate: "two" }
    ]);
    expect(nodeById(conversion, "legacy_set").config.assignments).toEqual([
      { key: "s", valueTemplate: "{{results.raw_set.a}}" },
      { key: "n", valueTemplate: "3" }
    ]);
    expect(reportFor(conversion, "Legacy set").reason).toContain("Keep only set fields");
    expect(nodeById(conversion, "webhook_wait").config).toMatchObject({ resumeMode: "webhook", resumeWebhookPath: "resume-here" });
    expect(nodeById(conversion, "error_object").config).toEqual({ errorCode: "E_BOOM", message: "boom" });
    expect(nodeById(conversion, "append_merge").config).toEqual({ mode: "append" });
    expect(nodeById(conversion, "random_sort").config).toMatchObject({ order: "random" });
    expect(nodeById(conversion, "last_limit").config).toEqual({ maxItems: 3, keep: "last", inputKey: "items" });
    expect(nodeById(conversion, "split_many").config).toEqual({ field: "a", destinationField: "row" });
    expect(reportFor(conversion, "Split many").reason).toContain("Only the first field");
    expect(nodeById(conversion, "async_child").config).toMatchObject({ workflowId: "child-1", mode: "async" });
    expect(nodeById(conversion, "legacy_http").config).toMatchObject({ method: "POST", bodyTemplate: '{"id": {{ $json.a }}}', headersTemplate: '{"X": "1"}' });
    const formBody = nodeById(conversion, "form_body").config;
    expect(formBody).toMatchObject({ method: "PUT", responseType: "text" });
    expect(JSON.parse(String(formBody.bodyTemplate))).toEqual({ k: "v" });
    expect(reportFor(conversion, "Form body").reason).toContain("form-urlencoded");
    expect(validateWorkflowGraph(conversion.workflow).valid).toBe(true);
  });

  it("derives unique node ids from names and keeps disabled nodes disabled", () => {
    const conversion = convertExternalWorkflow(
      exportWith([
        { name: "Set", type: "n8n-nodes-base.set", parameters: {} },
        { name: "set", type: "n8n-nodes-base.set", parameters: {}, disabled: true },
        { name: "123 go!", type: "n8n-nodes-base.noOp" },
        { name: "Output", type: "n8n-nodes-base.noOp" }
      ])
    );
    expect(conversion.workflow.nodes.map((node) => node.id)).toEqual(["set", "set_2", "n_123_go", "output", "import_output"]);
    expect(nodeById(conversion, "set_2").disabled).toBe(true);
    expect(slugifyNodeId("  Hello, World!  ")).toBe("hello_world");
    expect(slugifyNodeId("")).toBe("node");
  });

  it("rejects exports without a nodes array or with untyped nodes", () => {
    expect(() => convertExternalWorkflow({})).toThrow(ExternalWorkflowImportError);
    expect(() => convertExternalWorkflow(null)).toThrow(ExternalWorkflowImportError);
    expect(() => convertExternalWorkflow({ nodes: [{ name: "x" }] })).toThrow(/no 'type'/);
  });

  it("publishes the supported source types for coverage tables", () => {
    expect(EXTERNAL_IMPORT_SUPPORTED_TYPES).toContain("n8n-nodes-base.httprequest");
    expect(EXTERNAL_IMPORT_SUPPORTED_TYPES).toContain("@n8n/n8n-nodes-langchain.agent");
    expect(EXTERNAL_IMPORT_SUPPORTED_TYPES.length).toBeGreaterThan(40);
  });
});

describe("external workflow import — execution of a converted flow", () => {
  it("routes an IF branch using results.<id> references at run time", async () => {
    const conversion = convertExternalWorkflow(
      exportWith(
        [
          { name: "Start", type: "n8n-nodes-base.manualTrigger" },
          { name: "Order", type: "n8n-nodes-base.set", parameters: { assignments: { assignments: [{ name: "status", value: "active", type: "string" }, { name: "amount", value: 250, type: "number" }] } } },
          {
            name: "Check",
            type: "n8n-nodes-base.if",
            parameters: {
              conditions: {
                combinator: "and",
                conditions: [
                  { leftValue: "={{ $json.status }}", rightValue: "active", operator: { type: "string", operation: "equals" } },
                  { leftValue: "={{ $('Order').item.json.amount }}", rightValue: 100, operator: { type: "number", operation: "gt" } }
                ]
              }
            }
          },
          { name: "Approve", type: "n8n-nodes-base.noOp" },
          { name: "Reject", type: "n8n-nodes-base.noOp" },
          { name: "Stamp", type: "n8n-nodes-base.set", parameters: { assignments: { assignments: [{ name: "route", value: "={{ $node[\"Check\"].json.result }}-{{ $json.status }}", type: "string" }] } } }
        ],
        {
          Start: { main: [[{ node: "Order" }]] },
          Order: { main: [[{ node: "Check" }]] },
          Check: { main: [[{ node: "Approve" }], [{ node: "Reject" }]] },
          Approve: { main: [[{ node: "Stamp" }]] }
        }
      )
    );
    expect(validateWorkflowGraph(conversion.workflow).valid).toBe(true);

    const result = await executeWorkflow({ workflow: conversion.workflow }, executionDependencies());
    expect(result.status).toBe("success");
    const statusById = Object.fromEntries(result.nodeResults.map((entry) => [entry.nodeId, entry.status]));
    expect(statusById).toMatchObject({ check: "success", approve: "success", reject: "skipped", stamp: "success", import_output: "success" });
    const stamp = result.nodeResults.find((entry) => entry.nodeId === "stamp")?.output as Record<string, unknown>;
    expect(stamp.route).toBe("true-active");
  });
});
