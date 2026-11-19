import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { buildOperationRequest, type OpenApiOperation, type Workflow, type WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { DEFAULT_OUTBOUND_GUARD } from "./outbound-url-guard";

/** Requests built from an OpenAPI operation's form render values safely: a value cannot break the JSON or the URL. */

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config });

function deps(): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async (reference) => (reference?.secretId === "sec_key" ? "k&y=1" : undefined),
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    outboundGuard: DEFAULT_OUTBOUND_GUARD
  };
}

let server: Server;
let base = "";
const seen: Array<{ url: string; body: string; trace: string | undefined }> = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ url: request.url ?? "", body, trace: request.headers["x-trace"] as string | undefined });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const operation: OpenApiOperation = {
  id: "updateTicket",
  method: "POST",
  path: "/tickets/{ticketId}",
  summary: "Update",
  description: "",
  tags: [],
  parameters: [
    { name: "ticketId", in: "path", required: true, description: "", schema: { type: "string" } },
    { name: "q", in: "query", required: false, description: "", schema: { type: "string" } },
    { name: "X-Trace", in: "header", required: false, description: "", schema: { type: "string" } }
  ],
  requestBody: { required: true, contentType: "application/json", json: true, schema: { type: "object", properties: { title: { type: "string" } } } },
  security: null,
  deprecated: false
} as unknown as OpenApiOperation;

async function run(config: Record<string, unknown>, payload: Record<string, unknown>) {
  const workflow: Workflow = {
    id: "wf-openapi",
    name: "OpenAPI request",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("in", "webhook_input"), node("http", "http_request", { responseType: "json", ...config }), node("out", "output")],
    edges: [
      { id: "e1", source: "in", target: "http" },
      { id: "e2", source: "http", target: "out" }
    ]
  };
  const before = seen.length;
  const result = await executeWorkflow({ workflow, executionId: `oas-${before}`, webhookPayload: payload }, deps());
  expect(result.status, JSON.stringify(result.nodeResults?.find?.((entry) => entry.nodeId === "http") ?? result)).toBe("success");
  return seen.slice(before)[0]!;
}

describe("requests built from an OpenAPI operation", () => {
  it("encodes path and query values and escapes JSON values when they render", async () => {
    const built = buildOperationRequest(operation, base, {
      "path.ticketId": "{{ webhook.id }}",
      "query.q": "{{ webhook.q }}",
      "header.X-Trace": "t-{{ webhook.trace }}",
      "body.title": "Re: {{ webhook.title }}"
    });
    expect(built.errors).toEqual({});
    const sent = await run(
      { method: built.method, urlTemplate: built.urlTemplate, headersTemplate: built.headersTemplate, bodyTemplate: built.bodyTemplate },
      { id: "../admin?x=", q: "a&role=admin#", trace: 'say "hi"', title: 'Printer "jam"\n2nd line","isAdmin":true,"x":"' }
    );
    expect(sent.url).toBe("/tickets/..%2Fadmin%3Fx%3D?q=a%26role%3Dadmin%23");
    expect(sent.trace).toBe('t-say "hi"');
    expect(JSON.parse(sent.body)).toEqual({ title: 'Re: Printer "jam"\n2nd line","isAdmin":true,"x":"' });
  });

  it("adds a query secret without re-encoding the URL's other parameters", async () => {
    const sent = await run(
      { method: "GET", urlTemplate: `${base}/items?q=a%20b&f=a,b&t=x~y#frag`, secretRef: { secretId: "sec_key" }, secretAuth: { type: "query", name: "api_key" } },
      {}
    );
    expect(sent.url).toBe("/items?q=a%20b&f=a,b&t=x~y&api_key=k%26y%3D1");
  });
});
