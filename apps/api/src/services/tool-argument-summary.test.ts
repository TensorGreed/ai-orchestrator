/**
 * Phase 12.4 — argument summaries with the production-capture detectors, the
 * MCP_TOOL_ARGUMENT_SUMMARIES switch, and extraction from run traces.
 */
import { describe, expect, it } from "vitest";
import type { ToolArgumentSummary } from "@ai-orchestrator/shared";
import { parseConfig, toolArgumentSummariesEnabled } from "../config.js";
import { extractMcpToolCalls } from "./mcp-tool-telemetry.js";
import { captureDetector, createToolArgumentSummarizer } from "./tool-argument-summary.js";

const summarize = createToolArgumentSummarizer({ enabled: true })!;

const SECRETS = {
  card: "4111 1111 1111 1111",
  cardNumber: 4111111111111111,
  iban: "GB82WEST12345698765432",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  aws: "AKIAIOSFODNN7EXAMPLE",
  github: "ghp_1234567890abcdefghijklmnopqrstuvwxyz12",
  email: "jane.doe@example.com",
  encodedEmail: "jane.doe%40example.com",
  phone: "+1 415 555 0100",
  compactPhone: "+14155550100",
  basicAuth: "https://bob:hunter2@db.internal.example/x",
  ssn: "123-45-6789",
  privateKey: "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
  body: "Hi Jane, please charge 4111-1111-1111-1111 and mail jane.doe@example.com"
};

describe("tool argument summaries with the capture detectors", () => {
  it("keeps no secret or personal value, only classes, prefixes and length buckets", () => {
    const summary = summarize(SECRETS)!;
    const text = JSON.stringify(summary);
    for (const needle of [
      "4111",
      "GB82",
      "eyJhbGci",
      "AKIA",
      "ghp_",
      "jane.doe",
      "jane",
      "415",
      "hunter2",
      "bob",
      "6789",
      "MIIB",
      "charge"
    ]) {
      expect(text).not.toContain(needle);
    }
    expect(summary.fields.card?.classes).toEqual(["card_number"]);
    expect(summary.fields.cardNumber).toEqual({ type: "number", classes: ["card_number"] });
    expect(summary.fields.iban?.classes).toEqual(["iban"]);
    expect(summary.fields.jwt?.classes).toEqual(["jwt"]);
    expect(summary.fields.aws?.classes).toEqual(["credential"]);
    expect(summary.fields.github?.classes).toEqual(["credential"]);
    expect(summary.fields.email).toEqual({ type: "string", prefixes: ["@example.com"], classes: ["email"] });
    expect(summary.fields.encodedEmail?.classes).toEqual(["email"]);
    expect(summary.fields.phone?.classes).toEqual(["phone"]);
    expect(summary.fields.compactPhone?.classes).toEqual(["phone"]);
    expect(summary.fields.basicAuth?.classes).toContain("credential");
    expect(summary.fields.basicAuth?.prefixes).toBeUndefined();
    expect(summary.fields.ssn).toEqual({ type: "string", len: "9-32" });
    expect(summary.fields.privateKey?.classes).toEqual(["private_key"]);
    expect(summary.fields.body).toEqual({ type: "string", classes: ["card_number", "email"], len: "33-128" });
  });

  it("keeps what a policy needs from an ordinary call", () => {
    const summary = summarize(
      {
        owner: "octo-org",
        repo: "octo-org/hello-world",
        state: "open",
        per_page: 50,
        labels: ["bug", "ui"],
        url: "https://api.github.com/repos/octo-org/hello-world/issues?page=2",
        path: "/srv/data/reports/2026/q3.csv",
        title: "Crash when saving",
        assignee: "octocat",
        direction: "Oldest first"
      },
      { properties: { direction: { enum: ["Oldest first", "Newest first"] } } }
    )!;
    expect(summary.fields).toEqual({
      assignee: { type: "string", len: "1-8" },
      direction: { type: "string", values: ["Oldest first"] },
      labels: { type: "array", items: 2 },
      "labels[]": { type: "string", count: 2, values: ["bug", "ui"] },
      owner: { type: "string", values: ["octo-org"] },
      path: { type: "string", prefixes: ["/srv/data/"] },
      per_page: { type: "number", values: [50], min: 50, max: 50 },
      repo: { type: "string", prefixes: ["octo-org/"] },
      state: { type: "string", values: ["open"] },
      title: { type: "string", len: "9-32" },
      url: { type: "string", prefixes: ["https://api.github.com"] }
    });
  });

  it("finds escaped values the way production capture does", () => {
    expect(captureDetector("mail jane%40example.com")).toEqual(["email"]);
    expect(captureDetector("plain words")).toEqual([]);
  });

  it("returns undefined when switched off and null when the summariser throws", () => {
    expect(createToolArgumentSummarizer({ enabled: false })).toBeUndefined();
    const broken = createToolArgumentSummarizer({ enabled: true, detect: () => [] })!;
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("no keys"); } });
    expect(broken(hostile)).toBeNull();
  });
});

describe("MCP_TOOL_ARGUMENT_SUMMARIES", () => {
  it("is on unless set to false", () => {
    expect(toolArgumentSummariesEnabled(parseConfig({}))).toBe(true);
    expect(toolArgumentSummariesEnabled(parseConfig({ MCP_TOOL_ARGUMENT_SUMMARIES: "" }))).toBe(true);
    expect(toolArgumentSummariesEnabled(parseConfig({ MCP_TOOL_ARGUMENT_SUMMARIES: "true" }))).toBe(true);
    expect(toolArgumentSummariesEnabled(parseConfig({ MCP_TOOL_ARGUMENT_SUMMARIES: "false" }))).toBe(false);
    expect(toolArgumentSummariesEnabled(parseConfig({ MCP_TOOL_ARGUMENT_SUMMARIES: "0" }))).toBe(false);
    expect(() => parseConfig({ MCP_TOOL_ARGUMENT_SUMMARIES: "sometimes" })).toThrow();
  });
});

describe("extracting argument summaries from a run", () => {
  const workflow = {
    id: "wf",
    projectId: "proj-a",
    nodes: [
      { id: "agent", type: "agent_orchestrator" },
      { id: "direct", type: "mcp_tool", config: { serverId: "mock-mcp", toolName: "lookup" } },
      { id: "failed", type: "mcp_tool", config: { serverId: "mock-mcp", toolName: "lookup" } }
    ]
  };
  const priceTurn = () => null;
  const worker = {
    _toolPolicy: { subject: { role: "operator", source: "owner" }, noWriteTools: false, hidden: [] },
    _mcpTools: { "mock-mcp__lookup": { adapterId: "mock-mcp", toolName: "lookup" } },
    steps: [
      {
        iteration: 1,
        requestedTools: [{ id: "w1", name: "mock-mcp__lookup", arguments: { topic: "worker" } }],
        toolResults: [{ toolCallId: "w1", toolName: "mock-mcp__lookup", output: "ok" }]
      }
    ]
  };
  const nodeResults = [
    {
      nodeId: "agent",
      status: "success",
      startedAt: "2026-10-30T00:00:00.000Z",
      output: {
        _toolPolicy: { subject: { role: "builder", source: "user", userId: "u1", email: "b@example.com" }, noWriteTools: false, hidden: [] },
        _mcpTools: { "mock-mcp__lookup": { adapterId: "mock-mcp", toolName: "lookup" } },
        steps: [
          {
            iteration: 1,
            // Results come back in another order than requested: arguments follow the call id.
            requestedTools: [
              { id: "a", name: "mock-mcp__lookup", arguments: { topic: "alpha" } },
              { id: "b", name: "mock-mcp__lookup", arguments: { topic: "beta", note: "free text here" } },
              { id: "d", name: "delegate_to_Worker", arguments: { task: "x" } }
            ],
            toolResults: [
              { toolCallId: "b", toolName: "mock-mcp__lookup", output: "ok" },
              { toolCallId: "a", toolName: "mock-mcp__lookup", output: "ok" },
              { toolCallId: "d", toolName: "delegate_to_Worker", output: worker }
            ]
          }
        ]
      }
    },
    {
      nodeId: "direct",
      status: "success",
      startedAt: "2026-10-30T00:00:01.000Z",
      output: { invocation_request: { server_id: "mock-mcp", tool_name: "lookup", tool_args: { topic: "direct", limit: 3 } }, tool_output: "ok" }
    },
    { nodeId: "failed", status: "error", startedAt: "2026-10-30T00:00:02.000Z", error: "boom" }
  ];

  it("summarises each call's arguments with the run's subject and project", () => {
    const rows = extractMcpToolCalls({ executionId: "e1", workflow, nodeResults, priceTurn, summarizeArguments: summarize });
    const topics = rows.map((row) => (row.argsSummary as ToolArgumentSummary | null)?.fields.topic?.values?.[0] ?? null);
    expect(rows.map((row) => row.nodeId)).toEqual(["agent", "agent", "agent", "direct", "failed"]);
    expect(topics).toEqual(["beta", "alpha", "worker", "direct", null]);
    expect(rows[0]?.argsSummary?.fields.note).toEqual({ type: "string", len: "9-32" });
    expect(rows[3]?.argsSummary?.fields.limit).toEqual({ type: "number", values: [3], min: 3, max: 3 });
    // Agent calls use the agent's subject; the worker its own; a direct node the run's.
    expect(rows.map((row) => [row.subjectRole, row.subjectSource])).toEqual([
      ["builder", "user"],
      ["builder", "user"],
      ["operator", "owner"],
      ["builder", "user"],
      ["builder", "user"]
    ]);
    expect(rows.every((row) => row.projectId === "proj-a")).toBe(true);
    // A node that failed before calling reported no arguments.
    expect(rows[4]?.argsSummary).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("free text here");
  });

  it("falls back to the call's position when the result has no call id, and to null without a subject", () => {
    const rows = extractMcpToolCalls({
      executionId: "e2",
      workflow: { id: "wf", nodes: workflow.nodes },
      priceTurn,
      summarizeArguments: summarize,
      nodeResults: [
        {
          nodeId: "agent",
          status: "success",
          output: {
            _mcpTools: { "mock-mcp__lookup": { adapterId: "mock-mcp", toolName: "lookup" } },
            steps: [
              {
                iteration: 1,
                requestedTools: [{ name: "mock-mcp__lookup", arguments: { topic: "first" } }],
                toolResults: [{ toolName: "mock-mcp__lookup", output: "ok" }]
              }
            ]
          }
        }
      ]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.argsSummary?.fields.topic?.values).toEqual(["first"]);
    expect(rows[0]).toMatchObject({ subjectRole: null, subjectSource: null, projectId: null });
  });

  it("leaves the summary, subject and project out when switched off", () => {
    const rows = extractMcpToolCalls({ executionId: "e3", workflow, nodeResults, priceTurn });
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.argsSummary).toBeUndefined();
      expect(row.subjectRole).toBeUndefined();
      expect(row.subjectSource).toBeUndefined();
      expect(row.projectId).toBeUndefined();
    }
  });
});
