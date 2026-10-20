#!/usr/bin/env node
// A dependency-free stdio MCP server for demos and tests of the MCP registry,
// config import and playground. Speaks newline-delimited JSON-RPC 2.0.
//
//   node samples/mcp-echo-server/server.mjs
//
// Tools:
//   echo           read-only; returns the message (optionally repeated)
//   create_ticket  write; nested-object arguments, returns structured content
//   credentials    read-only; reports which of ECHO_API_KEY / ECHO_API_SECRET are set (never their values)

import process from "node:process";

const tools = [
  {
    name: "echo",
    description: "Echo a message back, optionally repeated.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Text to echo" },
        times: { type: "integer", minimum: 1, maximum: 5, default: 1 },
        shout: { type: "boolean", description: "Upper-case the reply" }
      },
      required: ["message"]
    },
    annotations: { readOnlyHint: true, title: "Echo" }
  },
  {
    name: "create_ticket",
    description: "Pretend to open a ticket; returns what it would create.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        labels: { type: "array", items: { type: "string" } },
        estimate: { type: "number", description: "Hours" },
        reporter: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            notify: { type: "boolean" }
          },
          required: ["name"]
        }
      },
      required: ["title", "reporter"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  {
    name: "credentials",
    description: "Report which credential env vars the server received (names only).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true }
  }
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function callTool(name, args) {
  if (name === "echo") {
    const times = Math.min(5, Math.max(1, Number(args.times) || 1));
    let text = Array.from({ length: times }, () => String(args.message ?? "")).join(" ");
    if (args.shout === true) text = text.toUpperCase();
    return { content: [{ type: "text", text }] };
  }
  if (name === "create_ticket") {
    const ticket = {
      id: `T-${Math.floor(Math.random() * 9000) + 1000}`,
      title: String(args.title ?? ""),
      priority: args.priority ?? "normal",
      labels: Array.isArray(args.labels) ? args.labels : [],
      estimate: typeof args.estimate === "number" ? args.estimate : null,
      reporter: args.reporter ?? null
    };
    return {
      content: [{ type: "text", text: `Created ${ticket.id}: ${ticket.title}` }],
      structuredContent: ticket
    };
  }
  if (name === "credentials") {
    const present = ["ECHO_API_KEY", "ECHO_API_SECRET"].filter((key) => Boolean(process.env[key]));
    return { content: [{ type: "text", text: present.length ? `Received: ${present.join(", ")}` : "No credentials received" }] };
  }
  return null;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "l2m-echo", version: "1.0.0" }
      });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools });
    } else if (message.method === "tools/call") {
      const result = callTool(message.params?.name, message.params?.arguments ?? {});
      if (result) reply(message.id, result);
      else fail(message.id, -32602, `Unknown tool: ${message.params?.name}`);
    } else if (message.method === "ping") {
      reply(message.id, {});
    } else {
      fail(message.id, -32601, `Method not found: ${message.method}`);
    }
  }
});
