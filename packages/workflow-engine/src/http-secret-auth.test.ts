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
import { DEFAULT_OUTBOUND_GUARD } from "./outbound-url-guard";
import { validateWorkflowGraph as validateWorkflow } from "./validation";

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config });

function deps(): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async ({ secretId }) => (secretId === "sec_key" ? "s3cr3t:pw" : undefined),
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    outboundGuard: DEFAULT_OUTBOUND_GUARD
  };
}

let server: Server;
let base = "";
const seen: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function workflow(config: Record<string, unknown>): Workflow {
  return {
    id: "wf-auth",
    name: "Secret auth",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("in", "webhook_input"), node("http", "http_request", { method: "GET", urlTemplate: `${base}/items?page=2`, secretRef: { secretId: "sec_key" }, ...config }), node("out", "output")],
    edges: [
      { id: "e1", source: "in", target: "http" },
      { id: "e2", source: "http", target: "out" }
    ]
  };
}

async function send(config: Record<string, unknown>) {
  const before = seen.length;
  const result = await executeWorkflow({ workflow: workflow(config), executionId: `auth-${before}`, webhookPayload: {} }, deps());
  expect(result.status).toBe("success");
  return seen.slice(before)[0]!;
}

describe("HTTP Request secret auth", () => {
  it("sends the secret as a bearer token when secretAuth is unset (saved nodes keep their behaviour)", async () => {
    const request = await send({});
    expect(request.headers.authorization).toBe("Bearer s3cr3t:pw");
    expect(request.url).toBe("/items?page=2");
  });

  it("sends basic auth from user:password", async () => {
    const request = await send({ secretAuth: { type: "basic" } });
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from("s3cr3t:pw").toString("base64")}`);
  });

  it("sends the secret in a named header, with no Authorization header", async () => {
    const request = await send({ secretAuth: { type: "header", name: "X-API-Key" } });
    expect(request.headers["x-api-key"]).toBe("s3cr3t:pw");
    expect(request.headers.authorization).toBeUndefined();
  });

  it("sends the secret as a query parameter and keeps it out of the node's activity URL", async () => {
    const events: unknown[] = [];
    const before = seen.length;
    const result = await executeWorkflow(
      { workflow: workflow({ secretAuth: { type: "query", name: "api_key" } }), executionId: "auth-query", webhookPayload: {} },
      { ...deps(), onNodeActivity: (event: unknown) => void events.push(event) } as WorkflowExecutionDependencies
    );
    expect(result.status).toBe("success");
    const request = seen.slice(before)[0]!;
    expect(request.url).toBe("/items?page=2&api_key=s3cr3t%3Apw");
    expect(request.headers.authorization).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("s3cr3t");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  it("flags a malformed secretAuth in validation", () => {
    const issues = validateWorkflow(workflow({ secretAuth: { type: "header", name: "bad name" } })).issues;
    expect(issues.map((issue) => issue.code)).toContain("invalid_http_secret_auth");
    expect(validateWorkflow(workflow({ secretAuth: { type: "query", name: "k" } })).issues.map((issue) => issue.code)).not.toContain("invalid_http_secret_auth");
  });
});

describe("HTTP Request secret auth and redirects", () => {
  let redirector: Server;
  let redirectBase = "";
  beforeAll(async () => {
    redirector = createServer((request, response) => {
      if (request.url?.startsWith("/same")) {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      if (request.url?.startsWith("/final")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ key: request.headers["x-api-key"] ?? null }));
        return;
      }
      // Another origin: the target server on a different port.
      response.writeHead(302, { location: `${base}/elsewhere` });
      response.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    redirectBase = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => redirector.close(() => resolve())));

  it("follows a same-origin redirect with the header secret", async () => {
    const wf = workflow({ urlTemplate: `${redirectBase}/same`, secretAuth: { type: "header", name: "X-API-Key" } });
    const result = await executeWorkflow({ workflow: wf, executionId: "redir-same", webhookPayload: {} }, deps());
    expect(result.status).toBe("success");
  });

  it("refuses a redirect to another origin when the secret is in a custom header or the query", async () => {
    for (const secretAuth of [{ type: "header", name: "X-Token" }, { type: "query", name: "k" }]) {
      const before = seen.length;
      const wf = workflow({ urlTemplate: `${redirectBase}/away`, secretAuth });
      const result = await executeWorkflow({ workflow: wf, executionId: `redir-${secretAuth.type}`, webhookPayload: {} }, deps());
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).toMatch(/redirected to another site/);
      expect(JSON.stringify(result)).not.toContain("s3cr3t");
      expect(seen.length).toBe(before);
    }
  });
});
