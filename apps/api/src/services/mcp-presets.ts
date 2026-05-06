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
}

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
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      timeoutMs: 60000
    },
    notes: "Replace '/tmp' with the directories you want to expose. You can pass multiple paths."
  },
  {
    id: "git",
    name: "Git",
    category: "Dev tools",
    description: "Read git history, branches, diffs, and file contents from a local repository.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-git", "--repository", "/path/to/repo"],
      timeoutMs: 60000
    },
    notes: "Replace '/path/to/repo' with the absolute path to a git repository on the host."
  },
  {
    id: "github",
    name: "GitHub",
    category: "Dev tools",
    description:
      "Search code, list issues and pull requests, read repos, comment, and create issues against the GitHub API.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
      timeoutMs: 60000
    },
    credentialHint: {
      envVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
      secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
      description:
        "Create a fine-grained or classic Personal Access Token at github.com/settings/tokens with the scopes you need (e.g. repo, issues, pull_requests)."
    }
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "Databases",
    description: "Read-only SQL access to a PostgreSQL database. Inspects schema and runs SELECT queries.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@host:5432/db"],
      timeoutMs: 60000
    },
    notes:
      "Replace the DSN with your database connection string. The server is read-only by design — it cannot mutate data."
  },
  {
    id: "sqlite",
    name: "SQLite",
    category: "Databases",
    description: "Query and inspect a local SQLite database file. Useful for exploring local data with an agent.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "/path/to/database.db"],
      timeoutMs: 60000
    },
    notes: "Replace '/path/to/database.db' with the absolute path to a SQLite file."
  },
  {
    id: "brave-search",
    name: "Brave Search",
    category: "Search",
    description: "Run web and local search queries via the Brave Search API.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
      secretEnvVar: "BRAVE_API_KEY",
      timeoutMs: 60000
    },
    credentialHint: {
      envVar: "BRAVE_API_KEY",
      secretEnvVar: "BRAVE_API_KEY",
      description: "Get an API key from api.search.brave.com. The free tier is sufficient for casual use."
    }
  },
  {
    id: "fetch",
    name: "Fetch",
    category: "Search",
    description: "Fetch arbitrary URLs and return Markdown-converted content. Good general-purpose web tool.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-fetch"],
      timeoutMs: 60000
    }
  },
  {
    id: "time",
    name: "Time",
    category: "AI utilities",
    description: "Time and timezone conversion utilities. Lightweight, no credentials required.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-time"],
      timeoutMs: 30000
    }
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
      args: ["-y", "@modelcontextprotocol/server-memory"],
      timeoutMs: 60000
    }
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
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      timeoutMs: 60000
    }
  },
  {
    id: "puppeteer",
    name: "Puppeteer (Browser)",
    category: "Productivity",
    description:
      "Drive a headless Chrome browser. Navigate URLs, take screenshots, fill forms, and scrape JavaScript-heavy pages.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-puppeteer"],
      timeoutMs: 120000
    },
    notes: "First run downloads Chromium (~150 MB). Subsequent runs reuse the cached browser."
  },
  {
    id: "slack",
    name: "Slack",
    category: "Productivity",
    description:
      "Read channels and messages, post messages, and search Slack via a bot token. Great for ops and notification workflows.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    serverAdapter: "stdio_mcp",
    connection: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_TEAM_ID: "T01234567" },
      secretEnvVar: "SLACK_BOT_TOKEN",
      timeoutMs: 60000
    },
    credentialHint: {
      envVar: "SLACK_BOT_TOKEN",
      secretEnvVar: "SLACK_BOT_TOKEN",
      description:
        "Create a Slack app at api.slack.com/apps, add bot scopes (channels:read, chat:write, etc.), install to your workspace, and copy the Bot User OAuth Token (xoxb-...). Replace the placeholder SLACK_TEAM_ID in env."
    }
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
      args: ["-y", "@modelcontextprotocol/server-everything"],
      timeoutMs: 60000
    }
  }
];
