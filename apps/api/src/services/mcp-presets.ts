import type { McpSandboxSettings } from "@ai-orchestrator/shared";

export interface McpPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  source: string;
  serverAdapter: "stdio_mcp" | "http_mcp";
  connection: Record<string, unknown>;
  credentialHint?: {
    envVar: string;
    secretEnvVar?: string;
    description: string;
  };
  notes?: string;
  /** Phase 10.7 — sandbox the registration form starts with (catalog entries may carry one). */
  sandbox?: McpSandboxSettings;
}

/**
 * Built-in presets for the registration form. Every package and image is
 * pinned to an exact published version, so a preset starts the same server
 * build every time and satisfies a catalog that enforces pinning. Bump the
 * versions deliberately; `mcp-presets.test.ts` checks the shape.
 *
 * Python reference servers run through `uvx` (from uv), and the GitHub server
 * through Docker; their notes say so.
 */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    category: "Files",
    description:
      "Read, write, and explore files within an allowed directory tree. Sandboxed to the directories you pass as arguments.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@2.3.0", "/tmp"],
      timeoutMs: 60000
    },
    notes: "Needs Node.js (npx) on the L2M host. Replace '/tmp' with the directories you want to expose. You can pass multiple paths."
  },
  {
    id: "git",
    name: "Git",
    category: "Dev tools",
    description: "Read git history, branches, diffs, and file contents from a local repository.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "uvx",
      args: ["mcp-server-git==2026.11.11", "--repository", "/path/to/repo"],
      timeoutMs: 60000
    },
    notes:
      "A Python server: needs uv (uvx) on the L2M host. Replace '/path/to/repo' with the absolute path to a git repository on the host."
  },
  {
    id: "github",
    name: "GitHub",
    category: "Dev tools",
    description:
      "GitHub's own MCP server: search code, read repos, and work with issues and pull requests through the GitHub API.",
    source: "https://github.com/github/github-mcp-server",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server:v2.1.0"],
      secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
      timeoutMs: 60000
    },
    credentialHint: {
      envVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
      secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
      description:
        "Create a fine-grained Personal Access Token at github.com/settings/tokens with only the repositories and permissions the agent needs (read-only where possible)."
    },
    notes:
      "Runs in Docker: needs Docker on the L2M host. The token is passed into the container by name (-e), never on the command line. The project also publishes a standalone binary; to use it, set the command to the binary with the argument 'stdio'."
  },
  {
    id: "brave-search",
    name: "Brave Search",
    category: "Search",
    description: "Run web, news, image and local search queries via the Brave Search API.",
    source: "https://github.com/brave/brave-search-mcp-server",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server@2.1.4", "--transport", "stdio"],
      secretEnvVar: "BRAVE_API_KEY",
      timeoutMs: 60000
    },
    credentialHint: {
      envVar: "BRAVE_API_KEY",
      secretEnvVar: "BRAVE_API_KEY",
      description: "Get an API key from api.search.brave.com."
    },
    notes: "Needs Node.js (npx) on the L2M host."
  },
  {
    id: "fetch",
    name: "Fetch",
    category: "Search",
    description: "Fetch arbitrary URLs and return Markdown-converted content. Good general-purpose web tool.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "uvx",
      args: ["mcp-server-fetch==2026.11.11"],
      timeoutMs: 60000
    },
    notes:
      "A Python server: needs uv (uvx) on the L2M host. It refuses private and loopback addresses by default and obeys robots.txt for model-initiated fetches."
  },
  {
    id: "time",
    name: "Time",
    category: "AI utilities",
    description: "Time and timezone conversion utilities. Lightweight, no credentials required.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "uvx",
      args: ["mcp-server-time==2026.11.11"],
      timeoutMs: 30000
    },
    notes: "A Python server: needs uv (uvx) on the L2M host."
  },
  {
    id: "memory",
    name: "Knowledge Graph Memory",
    category: "AI utilities",
    description:
      "A persistent knowledge graph the agent can read from and write to across sessions. Useful for long-term memory.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory@2.1.1"],
      timeoutMs: 60000
    },
    notes: "Needs Node.js (npx) on the L2M host. Set MEMORY_FILE_PATH in env to choose where the graph is stored."
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    category: "AI utilities",
    description:
      "Lets the agent break down a problem into a chain of explicit reasoning steps. Often improves multi-step reasoning quality.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2.1.1"],
      timeoutMs: 60000
    },
    notes: "Needs Node.js (npx) on the L2M host."
  },
  {
    id: "playwright",
    name: "Playwright (Browser)",
    category: "Productivity",
    description:
      "Drive a headless browser through its accessibility tree: navigate URLs, click, fill forms, and read JavaScript-heavy pages.",
    source: "https://github.com/microsoft/playwright-mcp",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.85", "--headless", "--isolated"],
      timeoutMs: 120000
    },
    notes:
      "Needs Node.js (npx) and Google Chrome on the L2M host. '--isolated' keeps each session's profile in memory."
  },
  {
    id: "everything",
    name: "Everything (test server)",
    category: "AI utilities",
    description:
      "The official MCP test server. Exposes every primitive (tools, prompts, resources, completion) so you can sanity-check your wiring without depending on external services.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything@2.3.0"],
      timeoutMs: 60000
    },
    notes: "Needs Node.js (npx) on the L2M host."
  }
];
