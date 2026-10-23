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
import { nodeDefinitions, workflowNodeSchema, type AgentRunRequest, type AgentRunState, type WorkflowEdge, type WorkflowNode } from "@ai-orchestrator/shared";
import { executeCodeNodeSandbox, executeWorkflow } from "../executor";
import { IN_PROCESS_CODE_SANDBOX } from "../code-sandbox";
import { validateWorkflowGraph } from "../validation";
import { renderExternalImportCoverageMarkdown } from "./coverage-markdown";
import {
  EXTERNAL_IMPORT_COVERAGE,
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
  "unsupported-and-odd-expressions",
  "apps-chat",
  "apps-dev",
  "apps-data",
  "apps-crm-payments"
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
    }, IN_PROCESS_CODE_SANDBOX);
    expect(result.result).toEqual({ since: "2026-01-01T00:00:00.000Z", items: [{ id: 7, results: { schedule_trigger: { timestamp: "2026-01-01T00:00:00.000Z" } } }], total: 1 });
  });
});

describe("external workflow import — unsupported nodes and odd expressions", () => {
  const conversion = convertFixture("unsupported-and-odd-expressions");

  it("turns unsupported nodes into disabled noop placeholders carrying the original config", () => {
    const calculator = nodeById(conversion, "calculator");
    expect(calculator.type).toBe("noop_node");
    expect(calculator.disabled).toBe(true);
    expect(calculator.config.label).toBe("Unsupported: toolCalculator");
    expect(calculator.config.importedFrom).toMatchObject({ type: "@n8n/n8n-nodes-langchain.toolCalculator" });
    expect(reportFor(conversion, "Calculator")).toMatchObject({ status: "unsupported", targetType: "noop_node" });
    expect(reportFor(conversion, "Embeddings OpenAI").status).toBe("unsupported");
    expect(conversion.report.summary).toEqual({ total: 13, mapped: 6, approximated: 5, unsupported: 2 });
  });

  it("maps the chat and sheet app nodes in the mixed flow without echoing credential ids", () => {
    const slack = nodeById(conversion, "slack");
    expect(slack.type).toBe("slack_send_message");
    expect(slack.config).toEqual({
      authType: "bot",
      channel: "C123",
      text: "New feedback from {{results.feedback_form.Name}}",
      secretRef: { secretId: "import-slack_bot_token-slack_bot" }
    });
    expect(JSON.stringify(conversion.workflow)).not.toContain("cred_3");
    expect(reportFor(conversion, "Slack").status).toBe("mapped");
    expect(nodeById(conversion, "google_sheets").type).toBe("google_sheets_append");
    expect(reportFor(conversion, "Google Sheets")).toMatchObject({ status: "approximated", reason: expect.stringContaining("No columns were defined") });
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
    const directEntries = EXTERNAL_IMPORT_COVERAGE.filter((entry) => !entry.sourceType.endsWith("*"));
    expect(directEntries.map((entry) => entry.sourceType.toLowerCase()).sort()).toEqual([...EXTERNAL_IMPORT_SUPPORTED_TYPES].sort());
    expect(EXTERNAL_IMPORT_COVERAGE.find((entry) => entry.sourceType === "n8n-nodes-base.httpRequest")).toMatchObject({
      targetType: "http_request",
      category: "core"
    });
  });

  it("keeps the checked-in docs coverage table in sync with the converter", () => {
    const docsPath = join(FIXTURE_DIR, "..", "..", "apps", "docs", "docs", "product", "external-import-coverage.md");
    const checkedIn = readFileSync(docsPath, "utf8");
    const rendered = renderExternalImportCoverageMarkdown();
    expect(rendered).toContain("| `n8n-nodes-base.httpRequest` | `http_request` |");
    expect(checkedIn).toBe(rendered);
  });
});


describe("external workflow import — chat apps (Slack, Telegram, Discord)", () => {
  const conversion = convertFixture("apps-chat");

  it("maps a channel post to a bot-token send with translated text", () => {
    expect(nodeById(conversion, "post_to_channel").config).toEqual({
      authType: "bot",
      channel: "C0INCIDENTS",
      text: ":rotating_light: New incident: {{results.slack_trigger.event.text}}",
      secretRef: { secretId: "import-slack_bot_token-ops_slack" }
    });
    expect(reportFor(conversion, "Post to channel").status).toBe("mapped");
  });

  it("derives the channel id from an archive URL, keeps blocks and thread_ts, and reports dropped options", () => {
    const reply = nodeById(conversion, "reply_in_thread");
    expect(reply.config).toMatchObject({ channel: "C0INCIDENTS", threadTs: "{{results.post_to_channel.ts}}" });
    expect(JSON.parse(String(reply.config.blocks))).toEqual([{ type: "section", text: { type: "mrkdwn", text: "Acknowledged by {{results.post_to_channel.user}}" } }]);
    expect(reportFor(conversion, "Reply in thread")).toMatchObject({ status: "approximated", reason: "Message options (link_names, unfurl_links) are not supported and were dropped." });
  });

  it("maps triggers onto the L2M trigger nodes and flags event filters", () => {
    expect(nodeById(conversion, "slack_trigger").config).toEqual({ path: "slack_trigger", signingSecretRef: { secretId: "import-slack_signing_secret-ops_slack" }, replayToleranceSeconds: 300 });
    expect(reportFor(conversion, "Slack Trigger").reason).toContain("Event filters (app_mention)");
    expect(nodeById(conversion, "telegram_trigger").config).toEqual({ path: "telegram_trigger", signingSecretRef: { secretId: "import-telegram_webhook_secret_token-alerts_bot" } });
  });

  it("maps Telegram and Discord sends and keeps unsupported operations as placeholders", () => {
    expect(nodeById(conversion, "telegram_alert").config).toEqual({
      chatId: "-1001234567890",
      text: "<b>Incident</b> {{results.post_to_channel.ts}}",
      secretRef: { secretId: "import-telegram_bot_token-alerts_bot" },
      parseMode: "HTML"
    });
    const discord = nodeById(conversion, "discord_webhook");
    expect(discord.config).toMatchObject({ webhookUrl: "", content: "Incident in {{results.telegram_trigger.message.chat.title}}", username: "L2M bot" });
    expect(JSON.parse(String(discord.config.embedsJson))).toEqual([{ title: "Incident", description: "{{results.telegram_trigger.message.text}}", color: 15158332 }]);
    expect(reportFor(conversion, "Discord webhook")).toMatchObject({ status: "approximated", reason: expect.stringContaining("webhook URL lives in the source credential") });
    expect(reportFor(conversion, "Discord bot DM")).toMatchObject({ status: "unsupported", reason: expect.stringContaining("'botToken'") });
    expect(reportFor(conversion, "Add reaction")).toMatchObject({ status: "unsupported", reason: "Slack resource 'reaction' operation 'add' has no L2M equivalent; imported as a disabled placeholder." });
    expect(reportFor(conversion, "Telegram photo").reason).toContain("operation 'sendPhoto'");
  });

  it("keeps a trigger's signing secret apart from the send token even when the export shares one credential", () => {
    expect(conversion.report.secretsToResolve).toEqual([
      { secretId: "import-slack_signing_secret-ops_slack", credentialType: "slackApi", credentialName: "Slack signing secret (Ops Slack)", nodeIds: ["slack_trigger"] },
      { secretId: "import-slack_bot_token-ops_slack", credentialType: "slackApi", credentialName: "Slack bot token (Ops Slack)", nodeIds: ["post_to_channel", "reply_in_thread"] },
      { secretId: "import-telegram_bot_token-alerts_bot", credentialType: "telegramApi", credentialName: "Telegram bot token (Alerts bot)", nodeIds: ["telegram_alert"] },
      { secretId: "import-telegram_webhook_secret_token-alerts_bot", credentialType: "telegramApi", credentialName: "Telegram webhook secret token (Alerts bot)", nodeIds: ["telegram_trigger"] },
      { secretId: "import-discord_webhook_url-ops_discord_hook", credentialType: "discordWebhookApi", credentialName: "Discord webhook URL (Ops Discord hook)", nodeIds: ["discord_webhook"] }
    ]);
    expect(JSON.stringify(conversion)).not.toMatch(/cred_[a-z]+\d/);
  });
});

describe("external workflow import — developer apps (GitHub, Jira, Notion)", () => {
  const conversion = convertFixture("apps-dev");

  it("maps issue comment, close and file get to github_action operations", () => {
    expect(nodeById(conversion, "comment_on_issue").config).toEqual({
      secretRef: { secretId: "import-github_personal_access_token-github_bot" },
      owner: "tensorgreed",
      repo: "ai-orchestrator",
      operation: "commentIssue",
      issueNumber: "{{results.github_trigger.body.issue.number}}",
      body: "Thanks {{results.github_trigger.body.issue.user.login}}, we're on it."
    });
    expect(nodeById(conversion, "close_issue").config).toMatchObject({ operation: "closeIssue", issueNumber: 42 });
    expect(nodeById(conversion, "read_changelog").config).toMatchObject({ operation: "getFile", path: "CHANGELOG.md" });
    expect(["Comment on issue", "Close issue", "Read changelog"].map((name) => reportFor(conversion, name).status)).toEqual(["mapped", "mapped", "mapped"]);
  });

  it("derives owner and repository from URLs and reports dropped labels", () => {
    expect(nodeById(conversion, "create_issue").config).toMatchObject({ owner: "tensorgreed", repo: "ai-orchestrator", operation: "createIssue", title: "[triage] {{results.comment_on_issue.body.issue.title}}" });
    expect(reportFor(conversion, "Create issue")).toMatchObject({ status: "approximated", reason: "Issue labels are not supported and were dropped." });
    expect(reportFor(conversion, "Create release").reason).toBe("GitHub resource 'release' operation 'create' has no L2M equivalent; imported as a disabled placeholder.");
  });

  it("maps the GitHub trigger with its own webhook secret placeholder", () => {
    expect(nodeById(conversion, "github_trigger").config).toEqual({ path: "github_trigger", secretRef: { secretId: "import-github_webhook_secret-github_bot" } });
    expect(reportFor(conversion, "GitHub Trigger").reason).toContain("tensorgreed/ai-orchestrator");
  });

  it("maps Jira issue creation and JQL search, flagging ids and credential-held settings", () => {
    const ticket = nodeById(conversion, "jira_ticket");
    expect(ticket.config).toEqual({
      baseUrl: "",
      email: "",
      secretRef: { secretId: "import-jira_api_token-jira_cloud" },
      projectKey: "10001",
      issueType: "Bug",
      summary: "{{results.create_issue.title}}",
      description: "See {{results.create_issue.html_url}}",
      fieldsJson: JSON.stringify({ labels: ["imported"], priority: { id: "3" } })
    });
    const reason = reportFor(conversion, "Jira ticket").reason;
    expect(reason).toContain("set baseUrl and email after import");
    expect(reason).toContain("referenced by id (10001, 'Platform')");
    expect(reason).toContain("(componentIds)");
    expect(nodeById(conversion, "find_open_bugs").config).toMatchObject({ jql: "project = PLAT AND status != Done", maxResults: 20 });
  });

  it("maps Notion database pages with translated property types and JSON filters", () => {
    const page = nodeById(conversion, "notion_page");
    expect(page.config).toMatchObject({ databaseId: "8f3c5c1a2b3d4e5f8a9b0c1d2e3f4a5b", titleProperty: "Name", title: "{{results.create_issue.title}}" });
    expect(JSON.parse(String(page.config.propertiesJson))).toEqual({
      Status: { select: { name: "Triage" } },
      Priority: { number: 2 },
      Tags: { multi_select: [{ name: "bug" }, { name: "import" }] }
    });
    expect(reportFor(conversion, "Notion page").reason).toBe("Properties of unsupported types (Owner|people) were dropped. Page content blocks are not supported; add contentMarkdown after import.");
    const query = nodeById(conversion, "notion_query");
    expect(query.config).toMatchObject({ pageSize: 25, filterJson: '{"property":"Status","select":{"equals":"{{results.find_open_bugs.status}}"}}' });
    expect(JSON.parse(String(query.config.sortsJson))).toEqual([{ timestamp: "created_time", direction: "descending" }, { property: "Priority", direction: "ascending" }]);
    expect(reportFor(conversion, "Notion query").status).toBe("mapped");
  });
});

describe("external workflow import — data apps (Sheets, Postgres, Airtable, S3)", () => {
  const conversion = convertFixture("apps-data");

  it("derives the spreadsheet id from the URL and builds A1 ranges from sheet names", () => {
    expect(nodeById(conversion, "read_orders").config).toEqual({
      spreadsheetId: "1AbCdEfGhIjKlMnOp",
      range: "Orders!A:F",
      authType: "accessToken",
      secretRef: { secretId: "import-google_sheets_access_token-sheets_account" }
    });
    expect(reportFor(conversion, "Read orders").status).toBe("mapped");
    expect(nodeById(conversion, "sheets_trigger").config).toMatchObject({ range: "Orders!A:Z", pollIntervalSeconds: 900 });
    expect(reportFor(conversion, "Sheets Trigger").status).toBe("mapped");
  });

  it("turns defined columns into a row of translated cells and flags append-or-update", () => {
    expect(nodeById(conversion, "append_summary").config).toMatchObject({
      range: "Summary",
      values: [["{{ $now.toISOString() }}", "{{results.read_orders.values.length}}"]],
      valueInputOption: "RAW"
    });
    expect(reportFor(conversion, "Append summary").reason).toContain("listed column order (Date, Count)");
    expect(nodeById(conversion, "upsert_customer").type).toBe("google_sheets_append");
    expect(reportFor(conversion, "Upsert customer").reason).toContain("Append-or-update became a plain append");
    expect(reportFor(conversion, "Clear sheet").status).toBe("unsupported");
  });

  it("maps Postgres queries with parameters and rewrites selects as SQL", () => {
    expect(nodeById(conversion, "load_orders").config).toMatchObject({ host: "", port: 5432, query: "SELECT * FROM orders WHERE created_at > $1", params: ["{{results.read_orders.since}}"] });
    expect(nodeById(conversion, "recent_customers").config).toMatchObject({
      query: 'SELECT * FROM "public"."customers" WHERE "status" = $1 AND "deleted_at" IS NULL ORDER BY "created_at" DESC LIMIT 100',
      params: ["active"]
    });
    expect(nodeById(conversion, "postgres_trigger").config).toMatchObject({ query: 'SELECT * FROM "public"."orders"', pollIntervalSeconds: 60 });
    expect(reportFor(conversion, "Insert rows").reason).toBe("Postgres resource 'database' operation 'insert' has no L2M equivalent; imported as a disabled placeholder.");
  });

  it("derives Airtable base, table and view ids from URLs and maps record operations", () => {
    expect(nodeById(conversion, "list_leads").config).toEqual({
      secretRef: { secretId: "import-airtable_personal_access_token-airtable_pat" },
      baseId: "appAbCdEf12345678",
      table: "tblAbCdEf12345678",
      filterByFormula: "{Status} = 'New'",
      maxRecords: 50,
      view: "viwAbCdEf12345678"
    });
    expect(nodeById(conversion, "create_lead").config).toMatchObject({ fieldsJson: '{"Name":"{{results.list_leads.fields.Name}}","Status":"Contacted"}', typecast: true });
    expect(nodeById(conversion, "update_lead").config).toMatchObject({ recordId: "{{results.create_lead.id}}", fieldsJson: '{"Status":"Done"}' });
    expect(["List leads", "Create lead", "Update lead"].map((name) => reportFor(conversion, name).status)).toEqual(["mapped", "mapped", "mapped"]);
  });

  it("maps S3 file operations with a default region", () => {
    expect(nodeById(conversion, "download_report").config).toMatchObject({ region: "us-east-1", bucket: "acme-reports", key: "reports/{{results.recent_customers.date}}.csv" });
    expect(nodeById(conversion, "upload_digest").config).toMatchObject({ key: "digests/digest-{{ $now.toISOString() }}.txt", body: "{{results.download_report.summary}}", contentType: "text/plain" });
    expect(nodeById(conversion, "list_reports").config).toMatchObject({ prefix: "reports/", maxKeys: 20 });
    expect(reportFor(conversion, "Upload digest").reason).toContain("(acl)");
    expect(reportFor(conversion, "Create bucket").status).toBe("unsupported");
  });
});

describe("external workflow import — CRM and payment apps (HubSpot, Salesforce, Stripe)", () => {
  const conversion = convertFixture("apps-crm-payments");

  it("maps HubSpot contact upsert to a create with renamed properties and get by id", () => {
    const contact = nodeById(conversion, "create_hubspot_contact");
    expect(JSON.parse(String(contact.config.propertiesJson))).toMatchObject({ email: "{{results.stripe_trigger.data.object.customer_details.email}}", company: "Acme" });
    expect(reportFor(conversion, "Create HubSpot contact").reason).toContain("(associatedCompanyId)");
    expect(nodeById(conversion, "get_contact").config).toEqual({ secretRef: { secretId: "import-hubspot_private_app_token-hubspot_app" }, identifier: "{{results.create_hubspot_contact.id}}", idProperty: "id" });
    expect(reportFor(conversion, "Get contact").status).toBe("mapped");
    expect(reportFor(conversion, "Create deal").status).toBe("unsupported");
  });

  it("maps Salesforce creates and queries, rewriting list operations as SOQL", () => {
    const lead = nodeById(conversion, "create_lead");
    expect(lead.config).toMatchObject({ instanceUrl: "", apiVersion: "v58.0", sobject: "Lead" });
    expect(JSON.parse(String(lead.config.fieldsJson))).toEqual({
      company: "{{results.get_contact.properties.company}}",
      lastname: "{{results.get_contact.properties.lastname}}",
      email: "{{results.get_contact.properties.email}}",
      leadSource: "Web",
      phone: "{{results.get_contact.properties.phone}}",
      Imported__c: "true"
    });
    expect(nodeById(conversion, "find_accounts").config.soql).toBe("SELECT Id, Name FROM Account WHERE Name = '{{results.create_lead.Company}}'");
    expect(nodeById(conversion, "list_opportunities").config.soql).toBe("SELECT Id, Name, Amount FROM Opportunity LIMIT 10");
    expect(reportFor(conversion, "Add note").status).toBe("unsupported");
  });

  it("maps Stripe customers and charges with metadata and the webhook trigger", () => {
    expect(nodeById(conversion, "stripe_customer").config).toEqual({
      secretRef: { secretId: "import-stripe_secret_key-stripe_live" },
      name: "{{results.find_accounts.Name}}",
      email: "{{results.find_accounts.Email}}",
      description: "Imported from CRM",
      metadataJson: '{"source":"l2m","lead":"{{results.find_accounts.Id}}"}'
    });
    expect(reportFor(conversion, "Stripe customer").status).toBe("mapped");
    expect(nodeById(conversion, "charge_card").config).toMatchObject({ amount: 4999, currency: "usd", customerId: "{{results.stripe_customer.id}}" });
    expect(reportFor(conversion, "Charge card").reason).toBe("Charge fields (receipt_email) are not supported and were dropped.");
    expect(nodeById(conversion, "stripe_trigger").config).toEqual({ path: "stripe_trigger", signingSecretRef: { secretId: "import-stripe_webhook_signing_secret-stripe_live" }, replayToleranceSeconds: 300 });
    expect(reportFor(conversion, "Stripe Trigger").reason).toContain("Event filters (checkout.session.completed)");
  });
});

describe("external workflow import — app handler behaviour", () => {
  it("dispatches on the source defaults when resource and operation are omitted", () => {
    const conversion = convertExternalWorkflow(
      exportWith([
        { name: "Slack", type: "n8n-nodes-base.slack", parameters: { channelId: { __rl: true, value: "C1", mode: "id" }, text: "hi" } },
        { name: "Telegram", type: "n8n-nodes-base.telegram", parameters: { chatId: "1", text: "hi" } },
        { name: "Postgres", type: "n8n-nodes-base.postgres", parameters: { table: { __rl: true, value: "t", mode: "list" } } },
        { name: "Stripe", type: "n8n-nodes-base.stripe", parameters: {} }
      ])
    );
    expect(nodeById(conversion, "slack").type).toBe("slack_send_message");
    expect(nodeById(conversion, "telegram").type).toBe("telegram_send_message");
    expect(reportFor(conversion, "Postgres").reason).toBe("Postgres resource 'database' operation 'insert' has no L2M equivalent; imported as a disabled placeholder.");
    expect(reportFor(conversion, "Stripe").reason).toBe("Stripe resource 'balance' operation 'get' has no L2M equivalent; imported as a disabled placeholder.");
  });

  it("keeps the original parameters on a placeholder for an unknown resource/operation pair", () => {
    const conversion = convertExternalWorkflow(
      exportWith([{ name: "Sheets", type: "n8n-nodes-base.googleSheets", parameters: { resource: "spreadsheet", operation: "create", title: "New" }, credentials: { googleSheetsOAuth2Api: { id: "c1", name: "Sheets" } } }])
    );
    const node = nodeById(conversion, "sheets");
    expect(node.type).toBe("noop_node");
    expect(node.disabled).toBe(true);
    expect(node.config.importedFrom).toMatchObject({ parameters: { resource: "spreadsheet", operation: "create", title: "New" }, credentials: { googleSheetsOAuth2Api: "Sheets" } });
    expect(reportFor(conversion, "Sheets").reason).toBe("Google Sheets resource 'spreadsheet' operation 'create' has no L2M equivalent; imported as a disabled placeholder.");
  });

  it("unwraps resource locators: ids are kept, URLs are parsed, names and unparseable URLs are flagged", () => {
    const conversion = convertExternalWorkflow(
      exportWith([
        { name: "By id", type: "n8n-nodes-base.airtable", parameters: { operation: "search", base: { __rl: true, value: "appAAAAAAAAAAAAAA", mode: "list", cachedResultName: "CRM" }, table: { __rl: true, value: "tblBBBBBBBBBBBBBB", mode: "id" } } },
        { name: "By url", type: "n8n-nodes-base.notion", parameters: { resource: "databasePage", operation: "getAll", databaseId: { __rl: true, value: "https://www.notion.so/acme/Tasks-0123456789abcdef0123456789abcdef", mode: "url" } } },
        { name: "By name", type: "n8n-nodes-base.slack", parameters: { channelId: { __rl: true, value: "#general", mode: "name" }, text: "hi" } },
        { name: "Odd url", type: "n8n-nodes-base.googleSheets", parameters: { documentId: { __rl: true, value: "https://example.com/not-a-sheet", mode: "url" }, sheetName: { __rl: true, value: "Sheet1", mode: "name" } } },
        { name: "By expression", type: "n8n-nodes-base.slack", parameters: { channelId: { __rl: true, value: "={{ $json.channel }}", mode: "id" }, text: "hi" } }
      ], { "By id": { main: [[{ node: "By expression" }]] } })
    );
    expect(nodeById(conversion, "by_id").config).toMatchObject({ baseId: "appAAAAAAAAAAAAAA", table: "tblBBBBBBBBBBBBBB" });
    expect(reportFor(conversion, "By id").status).toBe("mapped");
    expect(nodeById(conversion, "by_url").config.databaseId).toBe("0123456789abcdef0123456789abcdef");
    expect(reportFor(conversion, "By url").status).toBe("mapped");
    expect(nodeById(conversion, "by_name").config.channel).toBe("#general");
    expect(reportFor(conversion, "By name")).toMatchObject({ status: "approximated", reason: "The Slack channel is referenced by name ('#general'); replace it with the id after import." });
    expect(nodeById(conversion, "odd_url").config.spreadsheetId).toBe("https://example.com/not-a-sheet");
    expect(reportFor(conversion, "Odd url").reason).toContain("referenced by URL");
    expect(nodeById(conversion, "by_expression").config.channel).toBe("{{results.by_id.channel}}");
  });

  it("flags sheets picked by gid without a cached title", () => {
    const conversion = convertExternalWorkflow(
      exportWith([{ name: "Sheet", type: "n8n-nodes-base.googleSheets", parameters: { documentId: { __rl: true, value: "1X", mode: "id" }, sheetName: { __rl: true, value: "123456", mode: "id" } } }])
    );
    expect(nodeById(conversion, "sheet").config.range).toBe("A:Z");
    expect(reportFor(conversion, "Sheet").reason).toContain("referenced by its gid (123456)");
  });

  it("creates a per-node placeholder when the export lists no credential and shares one per credential otherwise", () => {
    const conversion = convertExternalWorkflow(
      exportWith([
        { name: "No cred", type: "n8n-nodes-base.telegram", parameters: { chatId: "1", text: "a" } },
        { name: "Cred A", type: "n8n-nodes-base.telegram", parameters: { chatId: "1", text: "b" }, credentials: { telegramApi: { id: "c1", name: "Bot one" } } },
        { name: "Cred A again", type: "n8n-nodes-base.telegram", parameters: { chatId: "1", text: "c" }, credentials: { telegramApi: { id: "c1", name: "Bot one" } } },
        { name: "Cred B", type: "n8n-nodes-base.telegram", parameters: { chatId: "1", text: "d" }, credentials: { telegramApi: { id: "c2", name: "Bot two" } } }
      ])
    );
    expect(nodeById(conversion, "no_cred").config.secretRef).toEqual({ secretId: "import-telegramapi-no_cred" });
    expect(nodeById(conversion, "cred_a").config.secretRef).toEqual(nodeById(conversion, "cred_a_again").config.secretRef);
    expect(conversion.report.secretsToResolve).toEqual([
      { secretId: "import-telegramapi-no_cred", credentialType: "telegramApi", credentialName: "Telegram bot token", nodeIds: ["no_cred"] },
      { secretId: "import-telegram_bot_token-bot_one", credentialType: "telegramApi", credentialName: "Telegram bot token (Bot one)", nodeIds: ["cred_a", "cred_a_again"] },
      { secretId: "import-telegram_bot_token-bot_two", credentialType: "telegramApi", credentialName: "Telegram bot token (Bot two)", nodeIds: ["cred_b"] }
    ]);
    expect(JSON.stringify(conversion)).not.toContain('"c1"');
  });

  it("translates and flags expressions inside app parameters exactly like core nodes", () => {
    const conversion = convertExternalWorkflow(
      exportWith(
        [
          { name: "Start", type: "n8n-nodes-base.manualTrigger" },
          {
            name: "Ticket",
            type: "n8n-nodes-base.jira",
            parameters: {
              project: { __rl: true, value: "PLAT", mode: "id" },
              issueType: { __rl: true, value: "Bug", mode: "name" },
              summary: "={{ $json.title }} ({{ $('Start').item.json.id }})",
              additionalFields: { description: "={{ $binary.data.fileName }}", labels: ["x"] }
            }
          },
          {
            name: "Row",
            type: "n8n-nodes-base.airtable",
            parameters: {
              operation: "create",
              base: { __rl: true, value: "appAAAAAAAAAAAAAA", mode: "id" },
              table: { __rl: true, value: "tblBBBBBBBBBBBBBB", mode: "id" },
              columns: { mappingMode: "defineBelow", value: { Key: "={{ $json.key }}", Env: "={{ $env.REGION }}" } }
            }
          }
        ],
        { Start: { main: [[{ node: "Ticket" }]] }, Ticket: { main: [[{ node: "Row" }]] } }
      )
    );
    expect(nodeById(conversion, "ticket").config).toMatchObject({
      projectKey: "PLAT",
      issueType: "Bug",
      summary: "{{results.start.title}} ({{results.start.id}})",
      description: "{{ $binary.data.fileName }}"
    });
    expect(nodeById(conversion, "row").config.fieldsJson).toBe('{"Key":"{{results.ticket.key}}","Env":"{{vars.REGION}}"}');
    expect(conversion.report.unresolvedExpressions).toEqual([
      { nodeId: "ticket", sourceName: "Ticket", path: "additionalFields.description", expression: "$binary.data.fileName", reason: "unsupported runtime reference '$binary'" }
    ]);
    expect(conversion.report.variablesToSet).toEqual(["REGION"]);
    expect(conversion.workflow.variables).toEqual({ REGION: "" });
  });

  it("maps older Discord nodes that only knew webhook sends", () => {
    const conversion = convertExternalWorkflow(
      exportWith([{ name: "Discord", type: "n8n-nodes-base.discord", parameters: { webhookUri: "https://discord.com/api/webhooks/1/abc", text: "=Hi {{ $json.name }}" } }])
    );
    expect(nodeById(conversion, "discord").config).toMatchObject({ webhookUrl: "https://discord.com/api/webhooks/1/abc", content: "Hi {{ $json.name }}" });
    expect(reportFor(conversion, "Discord").status).toBe("mapped");
  });
});

describe("external workflow import — converted app nodes against the shared node contract", () => {
  const APP_FIXTURES = ["apps-chat", "apps-dev", "apps-data", "apps-crm-payments"] as const;
  const JSON_SCHEMA_TYPES: Record<string, (value: unknown) => boolean> = {
    string: (value) => typeof value === "string",
    number: (value) => typeof value === "number" && Number.isFinite(value),
    boolean: (value) => typeof value === "boolean",
    object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    array: (value) => Array.isArray(value)
  };

  it("maps every app source type in the registration table onto a node that exists in the shared definitions", () => {
    const definedTypes = new Set(nodeDefinitions.map((definition) => definition.type));
    const appEntries = EXTERNAL_IMPORT_COVERAGE.filter((entry) => entry.category === "app");
    expect(appEntries.length).toBe(20);
    for (const entry of appEntries) expect(definedTypes.has(entry.targetType)).toBe(true);
  });

  for (const fixture of APP_FIXTURES) {
    it(`${fixture}: every converted app node passes validation and its config matches the node's config schema`, () => {
      const conversion = convertFixture(fixture);
      const validation = validateWorkflowGraph(conversion.workflow);
      expect(validation.issues).toEqual([]);

      const appNodes = conversion.workflow.nodes.filter((node) => !["noop_node", "output"].includes(node.type));
      expect(appNodes.length).toBeGreaterThan(0);
      for (const node of appNodes) {
        expect(() => workflowNodeSchema.parse(node)).not.toThrow();
        const definition = nodeDefinitions.find((entry) => entry.type === node.type);
        expect(definition, `definition for ${node.type}`).toBeDefined();
        const schema = definition!.configSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
        const status = conversion.report.nodes.find((entry) => entry.targetNodeId === node.id)!.status;
        const unknownKeys = Object.keys(node.config).filter((key) => !(key in (schema.properties ?? {})));
        expect(unknownKeys, `${node.id} config keys`).toEqual([]);
        for (const key of schema.required ?? []) {
          expect(node.config, `${node.id} requires ${key}`).toHaveProperty(key);
          // Mapped nodes are runnable as imported; approximated nodes may leave credential-held values empty.
          if (status === "mapped") expect(node.config[key], `${node.id}.${key}`).not.toBe("");
        }
        for (const [key, value] of Object.entries(node.config)) {
          const property = schema.properties?.[key];
          const check = property?.type ? JSON_SCHEMA_TYPES[property.type] : undefined;
          if (check && !(typeof value === "string" && property?.type === "number" && value.includes("{{"))) {
            expect(check(value), `${node.id}.${key} should be ${property?.type}`).toBe(true);
          }
          if (property?.enum && typeof value === "string" && !value.includes("{{")) expect(property.enum, `${node.id}.${key}`).toContain(value);
        }
      }
    });
  }
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
