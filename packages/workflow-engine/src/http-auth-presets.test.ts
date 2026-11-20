import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { validateWorkflowGraph as validateWorkflow } from "./validation";
import { DEFAULT_OUTBOUND_GUARD } from "./outbound-url-guard";
import { clearClientCredentialsTokenCache } from "./http-auth";
import { executeTier1Node } from "./connectors/tier1-dispatch";
import { describeEgressRequest } from "./destination-guard";
import { connectorAddressInSecret, connectorDestinationRef } from "@ai-orchestrator/shared";

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config });

let server: Server;
let base = "";
const seen: Array<{ url: string; method: string; headers: IncomingMessage["headers"]; body: string }> = [];
/** Access tokens the API accepts; anything else gets 401. */
const accepted = new Set<string>(["fresh-token"]);
let tokenRequests = 0;
let issuedExpiresIn = 3600;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ url: request.url ?? "", method: request.method ?? "", headers: request.headers, body });
      if (request.url === "/oauth/moved") {
        // A token endpoint that redirects: a 307 keeps the POST and its body (the client secret) on the next hop.
        response.writeHead(307, { location: "/oauth/token" });
        response.end();
        return;
      }
      if (request.url === "/oauth/token") {
        tokenRequests += 1;
        const form = new URLSearchParams(body);
        const basic = request.headers.authorization?.startsWith("Basic ")
          ? Buffer.from(request.headers.authorization.slice(6), "base64").toString()
          : `${form.get("client_id")}:${form.get("client_secret")}`;
        if (form.get("grant_type") !== "client_credentials" || basic !== "app-1:cs-secret") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_client" }));
          return;
        }
        const token = `cc-token-${tokenRequests}`;
        accepted.add(token);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: issuedExpiresIn, scope: form.get("scope") ?? undefined }));
        return;
      }
      const auth = request.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!accepted.has(token)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "invalid_auth" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  clearClientCredentialsTokenCache();
  tokenRequests = 0;
  issuedExpiresIn = 3600;
});

function deps(overrides: Partial<WorkflowExecutionDependencies> = {}): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async (reference) => (reference?.secretId === "sec_cs" ? "cs-secret" : reference?.secretId === "sec_conn" ? "stale-token" : undefined),
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    outboundGuard: DEFAULT_OUTBOUND_GUARD,
    ...overrides
  };
}

function workflow(config: Record<string, unknown>): Workflow {
  return {
    id: "wf-presets",
    name: "Auth presets",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("in", "webhook_input"), node("http", "http_request", { method: "GET", urlTemplate: `${base}/items`, ...config }), node("out", "output")],
    edges: [
      { id: "e1", source: "in", target: "http" },
      { id: "e2", source: "http", target: "out" }
    ]
  };
}

const ccAuth = (extra: Record<string, unknown> = {}) => ({
  secretRef: { secretId: "sec_cs" },
  secretAuth: { type: "oauth2_client_credentials", tokenUrl: `${base}/oauth/token`, clientId: "app-1", scope: "read", ...extra }
});

describe("HTTP Request OAuth2 client credentials", () => {
  it("gets a token with the client secret, sends it as a bearer token, and reuses it until it expires", async () => {
    const first = await executeWorkflow({ workflow: workflow(ccAuth()), executionId: "cc-1", webhookPayload: {} }, deps());
    expect(first.status).toBe("success");
    const second = await executeWorkflow({ workflow: workflow(ccAuth()), executionId: "cc-2", webhookPayload: {} }, deps());
    expect(second.status).toBe("success");
    expect(tokenRequests).toBe(1);
    const tokenCall = seen.filter((entry) => entry.url === "/oauth/token").at(-1)!;
    expect(Object.fromEntries(new URLSearchParams(tokenCall.body))).toEqual({ grant_type: "client_credentials", scope: "read", client_id: "app-1", client_secret: "cs-secret" });
    expect(seen.at(-1)!.headers.authorization).toBe("Bearer cc-token-1");
    // Neither the client secret nor the token reaches the run's record.
    expect(JSON.stringify(second)).not.toContain("cs-secret");
    expect(JSON.stringify(second)).not.toContain("cc-token-1");
  });

  it("sends the client credentials as basic auth when asked", async () => {
    const result = await executeWorkflow({ workflow: workflow(ccAuth({ clientAuth: "basic" })), executionId: "cc-basic", webhookPayload: {} }, deps());
    expect(result.status).toBe("success");
    const tokenCall = seen.filter((entry) => entry.url === "/oauth/token").at(-1)!;
    expect(tokenCall.headers.authorization).toBe(`Basic ${Buffer.from("app-1:cs-secret").toString("base64")}`);
    expect(new URLSearchParams(tokenCall.body).has("client_secret")).toBe(false);
  });

  it("asks again once the cached token is near its expiry, and once more after a 401", async () => {
    issuedExpiresIn = 10; // inside the refresh margin: never reused
    await executeWorkflow({ workflow: workflow(ccAuth()), executionId: "cc-exp-1", webhookPayload: {} }, deps());
    await executeWorkflow({ workflow: workflow(ccAuth()), executionId: "cc-exp-2", webhookPayload: {} }, deps());
    expect(tokenRequests).toBe(2);
    issuedExpiresIn = 3600;
    await executeWorkflow({ workflow: workflow(ccAuth()), executionId: "cc-401-a", webhookPayload: {} }, deps());
    accepted.delete("cc-token-3"); // the API stops accepting the cached token
    const result = await executeWorkflow({ workflow: workflow(ccAuth()), executionId: "cc-401-b", webhookPayload: {} }, deps());
    expect(result.status).toBe("success");
    expect(tokenRequests).toBe(4);
  });

  it("never follows a redirect from the token endpoint, so the client secret goes nowhere else", async () => {
    const result = await executeWorkflow(
      { workflow: workflow(ccAuth({ tokenUrl: `${base}/oauth/moved` })), executionId: "cc-moved", webhookPayload: {} },
      deps()
    );
    expect(result.status).toBe("error");
    expect(tokenRequests).toBe(0);
    expect(JSON.stringify(result)).not.toContain("cs-secret");
  });

  it("the token URL is a destination of the request, judged by the destination rules with the URL", () => {
    const request = describeEgressRequest({ type: "http_request", name: "h", id: "h" }, { method: "GET", urlTemplate: "https://api.example.com/items", ...ccAuth({ tokenUrl: "https://login.example.net/oauth/token" }) }, {});
    expect(request!.refs.map((ref) => ref.host)).toEqual(["api.example.com", "login.example.net"]);
    const plain = describeEgressRequest({ type: "http_request", name: "h", id: "h" }, { method: "GET", urlTemplate: "https://api.example.com/items" }, {});
    expect(plain!.refs.map((ref) => ref.host)).toEqual(["api.example.com"]);
  });

  it("fails with a plain message when the token endpoint refuses, without the secret", async () => {
    const result = await executeWorkflow(
      { workflow: workflow(ccAuth({ clientId: "wrong" })), executionId: "cc-refused", webhookPayload: {} },
      deps()
    );
    expect(result.status).toBe("error");
    const text = JSON.stringify(result);
    expect(text).toMatch(/token request to 127\.0\.0\.1:\d+ failed \(401\)/);
    expect(text).not.toContain("cs-secret");
  });
});

describe("connected account tokens refused with 401", () => {
  it("HTTP Request asks for a fresh token once and retries", async () => {
    const refreshed: string[] = [];
    const result = await executeWorkflow(
      { workflow: workflow({ secretRef: { secretId: "sec_conn" }, secretAuth: { type: "connected" } }), executionId: "conn-401", webhookPayload: {} },
      deps({
        refreshRejectedCredential: async (token) => {
          refreshed.push(token);
          return token === "stale-token" ? "fresh-token" : undefined;
        }
      })
    );
    expect(result.status).toBe("success");
    expect(refreshed).toEqual(["stale-token"]);
    expect(seen.at(-1)!.headers.authorization).toBe("Bearer fresh-token");
  });

  it("a plain bearer secret gets the same retry, and nothing changes without a fresh token", async () => {
    const result = await executeWorkflow(
      { workflow: workflow({ secretRef: { secretId: "sec_conn" }, failOnHttpError: true }), executionId: "conn-none", webhookPayload: {} },
      deps({ refreshRejectedCredential: async () => undefined })
    );
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).toMatch(/401/);
  });

  it("connector nodes retry once with a fresh token too", async () => {
    const calls: string[] = [];
    const output = await executeTier1Node(
      node("gh", "github_action", { operation: "listIssues", owner: "o", repo: "r", secretRef: { secretId: "sec_conn" } }),
      { operation: "listIssues", owner: "o", repo: "r", secretRef: { secretId: "sec_conn" } },
      {
        templateData: {},
        resolveSecret: async () => "stale-token",
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          const auth = new Headers(init?.headers).get("authorization") ?? "";
          calls.push(auth);
          return auth === "Bearer fresh-token"
            ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
            : new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        refreshRejectedCredential: async (token) => (token === "stale-token" ? "fresh-token" : undefined)
      }
    );
    expect(calls).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(output).toBeTruthy();
  });
});

describe("Teams with a Microsoft account", () => {
  it("posts to the channel through Graph with the account's token when Team ID and Channel ID are set", async () => {
    const { executeTier2Node } = await import("./connectors/tier2-dispatch");
    const calls: Array<{ url: string; auth: string; body: string }> = [];
    const config = { teamId: "team-1", channelId: "19:abc@thread.tacv2", title: "Build", text: "Done <ok>", secretRef: { secretId: "sec_ms" } };
    const output = await executeTier2Node(node("t", "teams_send_message", config), config, {
      templateData: {},
      resolveSecret: async () => "ms-token",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? "", body: String(init?.body) });
        return new Response(JSON.stringify({ id: "m1" }), { status: 201, headers: { "content-type": "application/json" } });
      }) as typeof fetch
    });
    expect(output).toEqual({ ok: true, status: 201, id: "m1" });
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/teams/team-1/channels/19%3Aabc%40thread.tacv2/messages");
    expect(calls[0]!.auth).toBe("Bearer ms-token");
    expect(JSON.parse(calls[0]!.body)).toEqual({ body: { contentType: "html", content: "<p><strong>Build</strong></p><p>Done &#60;ok&#62;</p>" } });
  });

  it("is addressed at Microsoft Graph for the destination rules, not at its secret", () => {
    const graph = { teamId: "team-1", channelId: "c", secretRef: { secretId: "sec_ms" } };
    expect(connectorAddressInSecret("teams_send_message", graph)).toBe(false);
    expect(connectorDestinationRef("teams_send_message", graph)?.host).toBe("graph.microsoft.com");
    expect(connectorAddressInSecret("teams_send_message", { secretRef: { secretId: "sec_hook" } })).toBe(true);
  });

  it("refuses a webhook secret that is not a URL without echoing it (a connected account needs Team ID and Channel ID)", async () => {
    const { executeTier2Node } = await import("./connectors/tier2-dispatch");
    const config = { text: "hi", secretRef: { secretId: "sec_ms" } };
    let fetched = false;
    const run = executeTier2Node(node("t", "teams_send_message", config), config, {
      templateData: {},
      resolveSecret: async () => "eyJ0eXAiOiJKV1QiLCJhbGciOiJub25lIn0.access-token",
      fetchImpl: (async () => {
        fetched = true;
        return new Response("1");
      }) as typeof fetch
    });
    await expect(run).rejects.toThrow(/Team ID and Channel ID/);
    await expect(run).rejects.not.toThrow(/access-token/);
    expect(fetched).toBe(false);
  });

  it("asks for both ids", async () => {
    const { executeTier2Node } = await import("./connectors/tier2-dispatch");
    const config = { teamId: "team-1", secretRef: { secretId: "sec_ms" } };
    await expect(executeTier2Node(node("t", "teams_send_message", config), config, { templateData: {}, resolveSecret: async () => "x" })).rejects.toThrow(/both Team ID and Channel ID/);
  });
});

describe("validation of the Auth choice", () => {
  it("warns when a choice that needs a secret has none picked; a bare bearer choice stays quiet", () => {
    const codes = (config: Record<string, unknown>) =>
      validateWorkflow(workflow(config)).issues.filter((issue) => issue.code === "http_auth_secret_missing").map((issue) => issue.severity);
    expect(codes({ secretAuth: { type: "connected" } })).toEqual(["warning"]);
    expect(codes({ secretAuth: { type: "basic" } })).toEqual(["warning"]);
    expect(codes({ secretAuth: { type: "bearer" } })).toEqual([]);
    expect(codes({ secretAuth: { type: "connected" }, secretRef: { secretId: "sec_conn" } })).toEqual([]);
    expect(codes({})).toEqual([]);
  });
});
