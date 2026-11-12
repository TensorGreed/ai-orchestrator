// MCP 2026-07-28 test fixture: the official TypeScript SDK v2 server over
// stdio, as an independent peer for the stdio client's tests. The SDK picks
// the era from how the client opens; SDK_V2_LEGACY=reject makes it a
// modern-only server.
import { McpServer, fromJsonSchema, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

function buildServer() {
  const server = new McpServer({ name: "sdk-v2-stdio-fixture", version: "1.0.0" });
  server.registerTool(
    "sum",
    {
      description: "Add two numbers",
      inputSchema: fromJsonSchema({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }),
      annotations: { readOnlyHint: true }
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
  );
  server.registerTool(
    "deploy",
    {
      description: "Deploy after a confirmation",
      inputSchema: fromJsonSchema({ type: "object", properties: { env: { type: "string" } }, required: ["env"] })
    },
    async ({ env }, ctx) => {
      const answer = inputResponse(ctx.mcpReq.inputResponses, "confirm");
      if (answer.kind !== "elicit") {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Deploy to ${env}?`,
              requestedSchema: fromJsonSchema({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] })
            })
          },
          requestState: "state-1"
        });
      }
      return { content: [{ type: "text", text: answer.action === "accept" && answer.content?.ok === true ? `deployed to ${env}` : "not deployed" }] };
    }
  );
  return server;
}

serveStdio(buildServer, { legacy: process.env.SDK_V2_LEGACY === "reject" ? "reject" : "serve" });
