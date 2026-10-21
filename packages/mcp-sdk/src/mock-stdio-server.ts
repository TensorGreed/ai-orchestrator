import { JSON_RPC_METHOD_NOT_FOUND } from "./client-features";
import { MCP_CLIENT_PROTOCOL_VERSION } from "./progress";
import { SnapshotMockError, type SnapshotMockServer } from "./snapshot-mock";

/**
 * Phase 10.8 — serve a `SnapshotMockServer` over the MCP stdio transport:
 * newline-delimited JSON-RPC on stdin/stdout. Only JSON-RPC goes to the
 * output stream; diagnostics go to `log` (stderr for the CLI).
 */

export const MOCK_SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface MockStdioServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Diagnostics; never written to `output`. */
  log?: (line: string) => void;
  version?: string;
}

/** Answer one JSON-RPC message; null for notifications. Exported for tests. */
export function handleMockRpc(server: SnapshotMockServer, message: unknown, version = "0.1.0"): JsonRpcResponse | null {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { jsonrpc: "2.0", id: isRecord(message) && "id" in message ? (message.id as JsonRpcId) : null, error: { code: JSON_RPC_INVALID_REQUEST, message: "Invalid request" } };
  }
  const isNotification = !("id" in message) || message.id === undefined;
  if (isNotification) return null;
  const id = message.id as JsonRpcId;
  const params = isRecord(message.params) ? message.params : {};
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  try {
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_CLIENT_PROTOCOL_VERSION;
        const protocolVersion = MOCK_SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MOCK_SUPPORTED_PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion,
          capabilities: server.capabilities(),
          serverInfo: { name: `l2m-mock-${server.snapshot.server.id}`, title: `${server.name} (mock)`, version },
          instructions: `Mock of ${server.name} generated from snapshot ${server.snapshot.snapshot.hash.slice(0, 12)}. Responses are recorded or synthesized; nothing reaches the real server.`
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: server.listTools() });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        if (!name) throw new SnapshotMockError("tools/call needs a tool name.");
        return ok(server.callTool(name, isRecord(params.arguments) ? params.arguments : {}));
      }
      case "resources/list":
        return ok({ resources: server.resources });
      case "resources/templates/list":
        return ok({ resourceTemplates: server.resourceTemplates });
      case "resources/read": {
        const uri = typeof params.uri === "string" ? params.uri : "";
        if (!uri) throw new SnapshotMockError("resources/read needs a uri.");
        return ok(server.readResource(uri));
      }
      case "prompts/list":
        return ok({ prompts: server.prompts });
      case "prompts/get": {
        const name = typeof params.name === "string" ? params.name : "";
        if (!name) throw new SnapshotMockError("prompts/get needs a prompt name.");
        const args: Record<string, string> = {};
        if (isRecord(params.arguments)) {
          for (const [key, value] of Object.entries(params.arguments)) args[key] = String(value);
        }
        return ok(server.getPrompt(name, args));
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Method not found: ${message.method}` } };
    }
  } catch (error) {
    if (error instanceof SnapshotMockError) return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message } };
    return {
      jsonrpc: "2.0",
      id,
      error: { code: JSON_RPC_INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) }
    };
  }
}

/**
 * Read JSON-RPC lines from `input` and answer on `output` until `input`
 * ends. The returned promise settles then.
 */
export function serveSnapshotMockOverStdio(server: SnapshotMockServer, options: MockStdioServerOptions): Promise<void> {
  const { input, output } = options;
  const write = (response: JsonRpcResponse | JsonRpcResponse[]) => {
    output.write(`${JSON.stringify(response)}\n`);
  };
  let buffer = "";
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error" } });
      return;
    }
    if (Array.isArray(message)) {
      const responses = message
        .map((entry) => handleMockRpc(server, entry, options.version))
        .filter((entry): entry is JsonRpcResponse => entry !== null);
      if (responses.length > 0) write(responses);
      return;
    }
    if (isRecord(message) && typeof message.method === "string") {
      options.log?.(`${message.method}${typeof message.id !== "undefined" ? ` #${String(message.id)}` : ""}`);
    }
    const response = handleMockRpc(server, message, options.version);
    if (response) write(response);
  };
  return new Promise<void>((resolve) => {
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    input.on("end", () => {
      if (buffer.trim()) handleLine(buffer);
      buffer = "";
      resolve();
    });
    input.on("close", () => resolve());
  });
}
