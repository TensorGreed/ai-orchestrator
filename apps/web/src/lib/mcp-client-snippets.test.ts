import { describe, expect, it } from "vitest";
import { buildMcpClientSnippets, snippetServerName, toolsetEndpointUrl } from "./mcp-client-snippets";

describe("MCP client snippets", () => {
  const input = {
    serverName: snippetServerName("support"),
    url: "https://l2m.example.com/mcp/support",
    token: "l2m_mcp_abc.def-ghi"
  };

  it("builds the endpoint URL from the public base URL or the page origin", () => {
    expect(toolsetEndpointUrl("/mcp/support", "https://l2m.example.com/", "http://localhost:5173")).toBe(
      "https://l2m.example.com/mcp/support"
    );
    expect(toolsetEndpointUrl("/mcp/support", null, "http://localhost:5173")).toBe("http://localhost:5173/mcp/support");
  });

  it("emits an mcpServers entry with url and headers", () => {
    const [servers] = buildMcpClientSnippets(input);
    expect(JSON.parse(servers!.text)).toEqual({
      mcpServers: { "l2m-support": { url: input.url, headers: { Authorization: "Bearer l2m_mcp_abc.def-ghi" } } }
    });
  });

  it("emits a .vscode/mcp.json entry with an http transport type", () => {
    const vscode = buildMcpClientSnippets(input)[1]!;
    expect(vscode.title).toBe(".vscode/mcp.json");
    expect(JSON.parse(vscode.text)).toEqual({
      servers: { "l2m-support": { type: "http", url: input.url, headers: { Authorization: "Bearer l2m_mcp_abc.def-ghi" } } }
    });
  });

  it("emits a quoted CLI add command", () => {
    const cli = buildMcpClientSnippets(input)[2]!;
    expect(cli.text).toBe(
      "<agent-cli> mcp add --transport http l2m-support https://l2m.example.com/mcp/support --header 'Authorization: Bearer l2m_mcp_abc.def-ghi'"
    );
  });
});
