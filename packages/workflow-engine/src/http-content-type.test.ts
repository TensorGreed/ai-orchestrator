import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { applyJsonContentType } from "./http-content-type";
import { DEFAULT_OUTBOUND_GUARD } from "./outbound-url-guard";

describe("applyJsonContentType", () => {
  it("marks a JSON object or array body as application/json", () => {
    for (const body of ['{"a":1}', "  [1, 2]\n"]) {
      const headers = new Headers();
      applyJsonContentType(headers, body);
      expect(headers.get("content-type")).toBe("application/json");
    }
  });

  it("leaves a Content-Type the headers set, whatever its case", () => {
    const headers = new Headers({ "content-type": "text/csv" });
    applyJsonContentType(headers, '{"a":1}');
    expect(headers.get("content-type")).toBe("text/csv");
  });

  it("leaves bodies that are not a JSON object or array alone", () => {
    for (const body of ["", "   ", "hello", "{not json", "42", '"text"', "a=1&b=2"]) {
      const headers = new Headers();
      applyJsonContentType(headers, body);
      expect(headers.has("content-type")).toBe(false);
    }
  });
});

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config });

function deps(): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    outboundGuard: DEFAULT_OUTBOUND_GUARD
  };
}

let server: Server;
let base = "";
const seen: Array<{ contentType: string | undefined; body: string }> = [];
beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ contentType: request.headers["content-type"], body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function send(config: Record<string, unknown>) {
  const workflow: Workflow = {
    id: "wf-json",
    name: "JSON body",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("in", "webhook_input"), node("http", "http_request", { method: "POST", urlTemplate: `${base}/items`, ...config }), node("out", "output")],
    edges: [
      { id: "e1", source: "in", target: "http" },
      { id: "e2", source: "http", target: "out" }
    ]
  };
  const before = seen.length;
  const result = await executeWorkflow({ workflow, executionId: `json-${before}`, webhookPayload: { name: "Ada" } }, deps());
  expect(result.status).toBe("success");
  return seen.slice(before);
}

describe("HTTP Request content type", () => {
  it("sends a JSON body as application/json when the headers name no Content-Type", async () => {
    expect(await send({ bodyTemplate: '{"name":"{{name}}"}', headersTemplate: '{"Accept":"application/json"}' })).toEqual([
      { contentType: "application/json", body: '{"name":"Ada"}' }
    ]);
  });

  it("keeps the Content-Type the headers set", async () => {
    const [request] = await send({ bodyTemplate: '{"name":"{{name}}"}', headersTemplate: '{"Content-Type":"application/vnd.api+json"}' });
    expect(request?.contentType).toBe("application/vnd.api+json");
  });

  it("keeps sending a text body as text", async () => {
    const [request] = await send({ bodyTemplate: "name={{name}}" });
    expect(request?.contentType).toBe("text/plain;charset=UTF-8");
  });
});
