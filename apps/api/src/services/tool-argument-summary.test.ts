/**
 * Phase 12.4 — argument summaries with the production-capture detectors, the
 * MCP_TOOL_ARGUMENT_SUMMARIES switch, and extraction from run traces.
 */
import { describe, expect, it } from "vitest";
import type { ToolArgumentSummary } from "@ai-orchestrator/shared";
import { parseConfig, toolArgumentSummariesEnabled } from "../config.js";
import { extractMcpToolCalls } from "./mcp-tool-telemetry.js";
import { deriveCaptureSurrogateKey } from "./replay-capture-service.js";
import {
  captureDetector,
  createToolArgumentSummarizer,
  deriveToolArgumentHashKey,
  hashSummaryValue,
  toolArgumentHashKey
} from "./tool-argument-summary.js";

const masterKey = new Uint8Array(32).fill(3);
const hashKey = deriveToolArgumentHashKey(masterKey);
const h = (value: string | number | boolean) => hashSummaryValue(value, hashKey);
const summarize = createToolArgumentSummarizer({ enabled: true, hashKey })!;

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
  it("keeps no secret or personal value, only classes, prefixes, length buckets and hashes", () => {
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
    expect(summary.fields.cardNumber).toEqual({ type: "number", mag: 15, hashes: [h(SECRETS.cardNumber)], classes: ["card_number"] });
    expect(summary.fields.iban?.classes).toEqual(["iban"]);
    expect(summary.fields.jwt?.classes).toEqual(["jwt"]);
    expect(summary.fields.aws?.classes).toEqual(["credential"]);
    expect(summary.fields.github?.classes).toEqual(["credential"]);
    // `email` is a sensitive key: class and hash only, not even the domain.
    expect(summary.fields.email).toEqual({ type: "string", hashes: [h(SECRETS.email)], classes: ["email"], len: "9-32" });
    expect(summary.fields.encodedEmail?.classes).toEqual(["email"]);
    expect(summary.fields.phone?.classes).toEqual(["phone"]);
    expect(summary.fields.compactPhone?.classes).toEqual(["phone"]);
    expect(summary.fields.basicAuth?.classes).toContain("credential");
    expect(summary.fields.basicAuth?.prefixes).toBeUndefined();
    expect(summary.fields.ssn).toEqual({ type: "string", hashes: [h(SECRETS.ssn)], len: "9-32" });
    expect(summary.fields.privateKey?.classes).toEqual(["private_key"]);
    expect(summary.fields.body).toEqual({ type: "string", hashes: [h(SECRETS.body)], classes: ["card_number", "email"], len: "33-128" });
    for (const field of Object.values(summary.fields)) expect(field.values).toBeUndefined();
  });

  it("keeps no raw value for any reproduction from the review", () => {
    const probes: Array<[Record<string, unknown>, string[]]> = [
      [{ pass: "hunter2", pw: "hunter2", passphrase: "hunter2", pin: "hunter2", otp: "hunter2", sig: "hunter2", session: "hunter2" }, ["hunter2"]],
      [{ password: { value: "hunter2" }, auth: [{ v: "hunter2" }], message: { name: "Alice" } }, ["hunter2", "Alice"]],
      [{ customer: "Alice", recipient_name: "Alice", reviewer_login: "jsmith", owner: "jsmith", name: "Alice", ref: "john.smith" }, ["Alice", "jsmith", "john"]],
      [{ a: "/home/jdoe/secret.txt", b: "/Users/john.smith/x/y", c: "C:\\Users\\jsmith\\Docs\\a" }, ["jdoe", "john", "jsmith", "secret"]],
      [{ a: 4111111111111111.5, b: 123456789.25, acct: 12345678, phone7: 5551234, dob: 19850315 }, ["4111", "123456789", "12345678", "5551234", "19850315"]],
      [{ a: "４１１１１１１１１１１１１１１１", b: "٤١١١١١١١١١١١١١١١" }, ["４１", "٤١"]],
      [{ "550e8400-e29b-41d4-a716-446655440000": 1, "9fceb02d0ae598e95dc970b74767f19372d61af8": 2, "5551234567": 3, "123-45-6789": 4 }, ["550e8400", "9fceb02d", "5551234567", "6789"]],
      [{ a: "https://alice-smith.github.io/x", b: "http://10.1.2.3/x" }, ["alice", "10.1"]],
      [{ a: "deadbeefcafebabe", b: "aGVsbG8gd29ybGQ", c: "sk-abc123", d: "correcthorsebatterystaple", e: "03/1985" }, ["deadbeef", "aGVs", "abc123", "horse", "1985"]],
      [{ lat: 51.501364, lon: -0.14189 }, ["501364", "14189"]],
      // Re-review M-A: people's words inside joined or all-lower-case keys.
      [{ firstname: "alice", lastname: "smith", surname: "smith", fullname: "alice-smith", nickname: "bob", displayname: "bob", userid: "jsmith", emailaddress: "xq" }, ["alice", "smith", "\"bob\"", "jsmith", "\"xq\""]],
      // Re-review M-B: codes written as numbers or strings.
      [{ security_code: 123, verification_code: 482913, code: 482913, postal_code: 90210, verificationCode: "abc123" }, [":123", "482913", "90210", "abc123"]],
      // Re-review M-C: random ids and digests as object keys.
      [{ a1b2c3d4e5f6g7h8: 1, Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv: 2, a3f2b9c1e7d4f8a2b6c3e9d1f7a4b8c2: 3 }, ["a1b2", "Ab1Cd2", "a3f2b9"]],
      // Re-review L-A: first.last with trailing digits or a one-letter tail.
      [{ tag: "john.smith1", x: "john.s" }, ["john"]]
    ];
    for (const [args, needles] of probes) {
      const text = JSON.stringify(summarize(args));
      for (const needle of needles) expect(text, needle).not.toContain(needle);
    }
    // The token-budget exception keeps numbers only, and only without a sensitive ancestor.
    const budget = summarize({ max_tokens: 1024, token: 1024, auth: { max_tokens: 1 }, strings: { max_tokens: "1024" } })!;
    expect(budget.fields.max_tokens?.values).toEqual([1024]);
    for (const path of ["token", "auth.max_tokens", "strings.max_tokens"]) expect(budget.fields[path]?.values, path).toBeUndefined();
    // A schema enum does not reopen a credential key.
    expect(summarize({ password: "hunter2" }, { properties: { password: { enum: ["hunter2"] } } })?.fields.password?.values).toBeUndefined();
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
      assignee: { type: "string", hashes: [h("octocat")], len: "1-8" },
      direction: { type: "string", values: ["Oldest first"] },
      labels: { type: "array", items: 2 },
      "labels[]": { type: "string", count: 2, values: ["bug", "ui"] },
      // `owner` is a sensitive key (often a person's handle); the repository still keeps `owner/` as its prefix.
      owner: { type: "string", hashes: [h("octo-org")], len: "1-8" },
      path: { type: "string", hashes: [h("/srv/data/reports/2026/q3.csv")], prefixes: ["/srv/"], len: "9-32" },
      per_page: { type: "number", values: [50], min: 50, max: 50 },
      repo: { type: "string", hashes: [h("octo-org/hello-world")], prefixes: ["octo-org/"], len: "9-32" },
      state: { type: "string", values: ["open"] },
      title: { type: "string", hashes: [h("Crash when saving")], len: "9-32" },
      url: { type: "string", hashes: [h("https://api.github.com/repos/octo-org/hello-world/issues?page=2")], prefixes: ["https://api.github.com"], len: "33-128" }
    });
  });

  it("finds escaped values the way production capture does", () => {
    expect(captureDetector("mail jane%40example.com")).toEqual(["email"]);
    expect(captureDetector("plain words")).toEqual([]);
  });

  it("returns undefined when switched off and null when the summariser throws", () => {
    expect(createToolArgumentSummarizer({ enabled: false, hashKey })).toBeUndefined();
    const broken = createToolArgumentSummarizer({ enabled: true, hashKey, detect: () => [] })!;
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("no keys"); } });
    expect(broken(hostile)).toBeNull();
  });
});

describe("the summary hash key", () => {
  it("is derived from the master key with its own label", () => {
    expect(deriveToolArgumentHashKey(masterKey)).toEqual(hashKey);
    expect(deriveToolArgumentHashKey(new Uint8Array(32).fill(4))).not.toEqual(hashKey);
    expect(Buffer.from(hashKey).equals(Buffer.from(deriveCaptureSurrogateKey(masterKey)))).toBe(false);
    expect(() => deriveToolArgumentHashKey(new Uint8Array(16))).toThrow();
    expect(toolArgumentHashKey(Buffer.from(masterKey).toString("base64"))).toEqual(hashKey);
  });

  it("falls back to one random key per process without a master key, and refuses an invalid one", () => {
    const fallback = toolArgumentHashKey(undefined);
    expect(fallback).toHaveLength(32);
    expect(toolArgumentHashKey("")).toBe(fallback);
    expect(() => toolArgumentHashKey(Buffer.from("short").toString("base64"))).toThrow(/32-byte master key/);
    expect(Buffer.from(fallback).equals(Buffer.from(hashKey))).toBe(false);
  });

  it("hashes a rule's comparison value the way the summary stores it", () => {
    const summary = summarize({ account: "ACME-Corp", amount: 12_500_000, flag: "Ｙes" })!;
    expect(summary.fields.account?.hashes).toEqual([hashSummaryValue("ACME-Corp", hashKey)]);
    expect(summary.fields.amount?.hashes).toEqual([hashSummaryValue(12_500_000, hashKey)]);
    // NFKC: the full-width form hashes like the ASCII one.
    expect(summary.fields.flag?.hashes).toEqual([hashSummaryValue("Yes", hashKey)]);
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
    expect(rows[0]?.argsSummary?.fields.note).toEqual({ type: "string", hashes: [h("free text here")], len: "9-32" });
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
