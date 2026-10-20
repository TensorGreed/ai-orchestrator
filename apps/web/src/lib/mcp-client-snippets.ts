/**
 * Phase 10.4 — copy-paste configuration for MCP clients that connect to a
 * toolset endpoint. Three common shapes: an `mcpServers` JSON entry with
 * `url` and `headers`, a workspace `.vscode/mcp.json` entry, and a CLI
 * `mcp add` command line.
 */

export interface McpClientSnippetInput {
  /** Key the client lists the server under. */
  serverName: string;
  url: string;
  token: string;
}

export interface McpClientSnippet {
  id: "mcp-servers-json" | "vscode-mcp-json" | "cli-add";
  title: string;
  hint: string;
  language: "json" | "shell";
  text: string;
}

/** Endpoint URL of a toolset: the configured public base URL, else the page's origin. */
export function toolsetEndpointUrl(endpointPath: string, gatewayBaseUrl: string | null, origin: string): string {
  const base = (gatewayBaseUrl ?? "").replace(/\/+$/, "") || origin.replace(/\/+$/, "");
  return `${base}${endpointPath}`;
}

/** `l2m-<slug>`: a stable key for the server entry in a client's config. */
export function snippetServerName(slug: string): string {
  return `l2m-${slug}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildMcpClientSnippets(input: McpClientSnippetInput): McpClientSnippet[] {
  const authorization = `Bearer ${input.token}`;
  return [
    {
      id: "mcp-servers-json",
      title: "mcpServers JSON",
      hint: "For clients configured with an mcpServers object (desktop assistants and many IDE agents). Merge the entry into the existing object.",
      language: "json",
      text: JSON.stringify(
        { mcpServers: { [input.serverName]: { url: input.url, headers: { Authorization: authorization } } } },
        null,
        2
      )
    },
    {
      id: "vscode-mcp-json",
      title: ".vscode/mcp.json",
      hint: "Workspace file read by editors that keep MCP servers under a servers key with a transport type.",
      language: "json",
      text: JSON.stringify(
        { servers: { [input.serverName]: { type: "http", url: input.url, headers: { Authorization: authorization } } } },
        null,
        2
      )
    },
    {
      id: "cli-add",
      title: "CLI add command",
      hint: "Command-line agents register a remote server with a command of this shape; replace <agent-cli> with the agent's command.",
      language: "shell",
      text: `<agent-cli> mcp add --transport http ${shellQuote(input.serverName)} ${shellQuote(input.url)} --header ${shellQuote(`Authorization: ${authorization}`)}`
    }
  ];
}
