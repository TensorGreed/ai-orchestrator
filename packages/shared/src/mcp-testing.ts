import { z } from "zod";
import type { McpPrompt, McpResource, McpResourceTemplate, McpServerCapabilities, McpToolAnnotations } from "./types";
import { modelMemorySeedSchema, modelTapeSchema, type ModelMemorySeed, type ModelTape } from "./model-tape";

// ---------------------------------------------------------------------------
// Phase 10.8 — MCP testing and reliability: cassettes (record and replay),
// snapshot files for mock servers, and the CI check report.
// ---------------------------------------------------------------------------

export const MCP_CASSETTE_FORMAT = "l2m.mcp-cassette";
export const MCP_CASSETTE_VERSION = 1;
export const MCP_SNAPSHOT_FILE_FORMAT = "l2m.mcp-snapshot";
export const MCP_SNAPSHOT_FILE_VERSION = 1;

/** The MCP request an entry recorded. `server/describe` is the capabilities from `initialize`. */
export type McpCassetteMethod =
  | "server/describe"
  | "tools/list"
  | "tools/call"
  | "resources/list"
  | "resources/templates/list"
  | "resources/read"
  | "prompts/list"
  | "prompts/get";

export const MCP_CASSETTE_METHODS: readonly McpCassetteMethod[] = [
  "server/describe",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get"
];

/**
 * How replay treats a call the cassette has no answer for.
 *   - strict: the call fails with a message naming what was missing.
 *   - lenient: an exhausted call reuses its last recorded answer; a call the
 *     cassette never saw goes to the live server. Opt-in only.
 */
export type McpReplayMode = "strict" | "lenient";

/** A server the cassette talked to. No connection details are kept. */
export interface McpCassetteServer {
  /** `registry:<id>` for registry servers, `inline:<adapter>:<hash>` for inline configs. */
  key: string;
  adapterId: string;
  registryServerId?: string;
  label?: string;
  /** Hash of the server's accepted tool snapshot when the cassette was recorded. */
  snapshotHash?: string | null;
}

/** A server-initiated request made during a call: sampling or elicitation. */
export interface McpCassetteExchange {
  kind: "sampling" | "elicitation";
  /** Milliseconds since the cassette started. */
  at: number;
  request: unknown;
  response?: unknown;
  error?: string;
}

export interface McpCassetteEntry {
  /** 1-based position in recording order. */
  seq: number;
  /** `McpCassetteServer.key`. */
  server: string;
  method: McpCassetteMethod;
  /** Tool name, resource URI or prompt name. */
  name?: string;
  /** Canonical (sorted keys), scrubbed arguments. */
  args?: unknown;
  /** sha256 of the canonical scrubbed arguments; the replay match key. */
  argsHash: string;
  /** Scrubbed result, as the adapter returned it. */
  result?: unknown;
  /** Set when the adapter threw; the replay throws the same message. */
  error?: string;
  /** Milliseconds since the cassette started. */
  at: number;
  durationMs: number;
  exchanges?: McpCassetteExchange[];
}

export interface McpCassette {
  format: typeof MCP_CASSETTE_FORMAT;
  version: typeof MCP_CASSETTE_VERSION;
  recordedAt: string;
  servers: McpCassetteServer[];
  entries: McpCassetteEntry[];
  /** True when the size limit stopped the recording early. */
  truncated: boolean;
  /** Serialized size of `entries`, in bytes. */
  bytes: number;
  /**
   * `not_recorded`: the run's model calls were not recorded, so replays call
   * the model live. `tape` (Phase 15.3): `models` holds the run's model tape
   * and `memorySeed` the session memory it started from.
   */
  llm: "not_recorded" | "tape";
  /** Phase 15.3 — the run's model calls, recorded with its MCP calls. */
  models?: ModelTape;
  /** Phase 15.3 — session memory as the run first read it. */
  memorySeed?: ModelMemorySeed;
}

export type McpCassetteSource = "manual" | "eval" | "replay" | "import";

export interface McpCassetteSummary {
  id: string;
  executionId: string | null;
  workflowId: string | null;
  workflowName: string | null;
  projectId: string | null;
  source: McpCassetteSource;
  evalRunId: string | null;
  fixtureId: string | null;
  callCount: number;
  serverCount: number;
  bytes: number;
  truncated: boolean;
  createdAt: string;
  createdBy: string | null;
}

export interface McpCassetteRecord extends McpCassetteSummary {
  cassette: McpCassette;
}

/** What a replay did, attached to the run result as `mcpReplay`. */
export interface McpReplayReport {
  cassetteId: string;
  mode: McpReplayMode;
  /** Calls answered from the cassette. */
  matched: number;
  /** Calls answered by reusing an exhausted entry (lenient only). */
  reused: number;
  /** Calls sent to the live server (lenient only). */
  live: number;
  unmatched: Array<{ server: string; method: McpCassetteMethod; name?: string; reason: string }>;
}

/** Per-execution cassette badge for the Runs page. */
export interface McpCassetteBadge {
  id: string;
  callCount: number;
  truncated: boolean;
}

// --- zod schemas for files the CLI and the mock adapter read -----------------

const unknownRecord = z.record(z.string(), z.unknown());

export const mcpCassetteSchema = z.object({
  format: z.literal(MCP_CASSETTE_FORMAT),
  version: z.literal(MCP_CASSETTE_VERSION),
  recordedAt: z.string(),
  servers: z
    .array(
      z.object({
        key: z.string().min(1),
        adapterId: z.string().min(1),
        registryServerId: z.string().optional(),
        label: z.string().optional(),
        snapshotHash: z.string().nullable().optional()
      })
    )
    .max(500),
  entries: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        server: z.string().min(1),
        method: z.enum(MCP_CASSETTE_METHODS as unknown as [McpCassetteMethod, ...McpCassetteMethod[]]),
        name: z.string().optional(),
        args: z.unknown().optional(),
        argsHash: z.string(),
        result: z.unknown().optional(),
        error: z.string().optional(),
        at: z.number().nonnegative(),
        durationMs: z.number().nonnegative(),
        exchanges: z
          .array(
            z.object({
              kind: z.enum(["sampling", "elicitation"]),
              at: z.number().nonnegative(),
              request: z.unknown(),
              response: z.unknown().optional(),
              error: z.string().optional()
            })
          )
          .optional()
      })
    )
    .max(100_000),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
  llm: z.enum(["not_recorded", "tape"]),
  models: modelTapeSchema.optional(),
  memorySeed: modelMemorySeedSchema.optional()
});

export interface McpSnapshotFileTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  outputSchema?: Record<string, unknown>;
}

/** An exported accepted snapshot: what `l2m mcp check` and `l2m mcp mock` read offline. */
export interface McpSnapshotFile {
  format: typeof MCP_SNAPSHOT_FILE_FORMAT;
  version: typeof MCP_SNAPSHOT_FILE_VERSION;
  exportedAt: string;
  server: { id: string; name: string; adapterId: string };
  snapshot: { id?: string | null; hash: string; createdAt?: string | null; tools: McpSnapshotFileTool[] };
  catalog?: {
    capabilities: McpServerCapabilities;
    resources: McpResource[];
    resourceTemplates: McpResourceTemplate[];
    prompts: McpPrompt[];
  };
}

export const mcpSnapshotFileSchema = z.object({
  format: z.literal(MCP_SNAPSHOT_FILE_FORMAT),
  version: z.literal(MCP_SNAPSHOT_FILE_VERSION),
  exportedAt: z.string(),
  server: z.object({ id: z.string().min(1), name: z.string(), adapterId: z.string() }),
  snapshot: z.object({
    id: z.string().nullable().optional(),
    hash: z.string(),
    createdAt: z.string().nullable().optional(),
    tools: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          inputSchema: unknownRecord,
          annotations: unknownRecord.optional(),
          outputSchema: unknownRecord.optional()
        })
      )
      .max(5_000)
  }),
  catalog: z
    .object({
      capabilities: unknownRecord,
      resources: z.array(unknownRecord).max(5_000),
      resourceTemplates: z.array(unknownRecord).max(5_000),
      prompts: z.array(unknownRecord).max(5_000)
    })
    .optional()
});

// --- CI check ----------------------------------------------------------------

export const mcpCheckRequestSchema = z.object({
  /** Registry server ids; empty or absent = every server (or the toolset's servers). */
  serverIds: z.array(z.string().trim().min(1)).max(500).optional(),
  /** Check the registry servers a gateway toolset includes. */
  toolsetId: z.string().trim().min(1).optional(),
  /** Workflows whose MCP tools must not be blocked by policy; absent = every workflow using a checked server. */
  workflowIds: z.array(z.string().trim().min(1)).max(500).optional(),
  /** Fail when a server cannot be reached (default true). */
  failOnUnreachable: z.boolean().optional(),
  /** Fail when a workflow depends on a tool the policy blocks (default true). */
  failOnPolicyBlocked: z.boolean().optional()
});
export type McpCheckRequest = z.infer<typeof mcpCheckRequestSchema>;

export interface McpCheckChange {
  tool: string;
  kind: string;
  path?: string;
  schema?: "output";
  breaking: boolean;
  detail: string;
}

export interface McpCheckServerResult {
  serverId: string;
  name: string;
  adapterId: string;
  reachable: boolean;
  error: string | null;
  latencyMs: number | null;
  /** Hash of the accepted snapshot the probe was compared against; null when there is none yet. */
  acceptedHash: string | null;
  /** Hash of what the server serves now; null when it could not be reached. */
  currentHash: string | null;
  breaking: boolean;
  changes: McpCheckChange[];
}

export interface McpCheckBlockedTool {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  serverId: string;
  toolName: string;
  reason: string;
  message: string;
}

export type McpCheckFailureKind = "breaking" | "unreachable" | "policy_blocked";

export interface McpCheckFailure {
  kind: McpCheckFailureKind;
  serverId?: string;
  detail: string;
}

export interface McpCheckReport {
  ok: boolean;
  checkedAt: string;
  servers: McpCheckServerResult[];
  blockedTools: McpCheckBlockedTool[];
  failures: McpCheckFailure[];
}

/**
 * The failures of a check, given which problems fail it. Shared by the API's
 * check endpoint and the CLI's offline mode so both judge the same way.
 */
export function judgeMcpCheck(
  servers: McpCheckServerResult[],
  blockedTools: McpCheckBlockedTool[],
  options: { failOnUnreachable?: boolean; failOnPolicyBlocked?: boolean } = {}
): { ok: boolean; failures: McpCheckFailure[] } {
  const failOnUnreachable = options.failOnUnreachable ?? true;
  const failOnPolicyBlocked = options.failOnPolicyBlocked ?? true;
  const failures: McpCheckFailure[] = [];
  for (const server of servers) {
    if (!server.reachable) {
      if (failOnUnreachable) {
        failures.push({ kind: "unreachable", serverId: server.serverId, detail: `${server.name}: ${server.error ?? "unreachable"}` });
      }
      continue;
    }
    if (server.breaking) {
      const count = server.changes.filter((change) => change.breaking).length;
      failures.push({
        kind: "breaking",
        serverId: server.serverId,
        detail: `${server.name}: ${count} breaking change${count === 1 ? "" : "s"} against the accepted snapshot`
      });
    }
  }
  if (failOnPolicyBlocked) {
    for (const blocked of blockedTools) {
      failures.push({
        kind: "policy_blocked",
        serverId: blocked.serverId,
        detail: `${blocked.workflowName} (${blocked.nodeId}) uses '${blocked.toolName}', which is blocked: ${blocked.message}`
      });
    }
  }
  return { ok: failures.length === 0, failures };
}
