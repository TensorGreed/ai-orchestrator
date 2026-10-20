import { z } from "zod";
import type { McpToolAnnotations, McpToolClassification } from "./types";

// ---------------------------------------------------------------------------
// Phase 10.6 — MCP onboarding: config import, deployment catalog, playground.
// ---------------------------------------------------------------------------

/** Client config file shapes the importer understands. */
export type McpConfigImportFormat =
  /** `{ "mcpServers": { name: { command | url, … } } }`, also nested per project under `projects`. */
  | "mcp_servers"
  /** `{ "servers": { … }, "inputs": [ … ] }` (a workspace `mcp.json`). */
  | "servers_inputs"
  /** `{ "mcp": { "servers": { … } } }` inside an editor settings file. */
  | "settings_mcp_servers"
  /** `{ "context_servers": { … } }` editor settings. */
  | "context_servers"
  /** `{ "mcp": { name: { "type": "local" | "remote", … } } }`. */
  | "mcp_typed_map";

export type McpImportItemStatus = "mapped" | "approximated" | "skipped";
export type McpImportDecision = "create" | "update" | "copy" | "skip";

/** One field of one entry and what happened to it. */
export interface McpImportReportItem {
  field: string;
  status: McpImportItemStatus;
  message: string;
}

/**
 * A value the import needs: a credential stored through SecretService
 * (`kind: "secret"`) or a plain value the source file asked the user for
 * (`kind: "prompt"`, lands in the connection).
 */
export interface McpImportValueSlot {
  /** `env:NAME` or `header:Name`. */
  id: string;
  kind: "secret" | "prompt";
  target: "env" | "header";
  name: string;
  /** literal: the file holds the value. input: a `${input:id}` placeholder. env_ref: `${env:NAME}` / `${NAME}`. */
  origin: "literal" | "input" | "env_ref";
  inputId?: string;
  envRef?: string;
  /** What the file says about the value (an input's description). */
  description?: string;
  options?: string[];
  /** Default the file offers for a prompted, non-secret value. */
  defaultValue?: string;
  /** true when the value is not in the file and must be supplied to import. */
  needsValue: boolean;
  /** true when the request carried a value for it. */
  provided: boolean;
}

export interface McpImportDuplicate {
  serverId: string;
  serverName: string;
  match: "command" | "url";
}

export interface McpImportEntryView {
  key: string;
  name: string;
  adapterId: "stdio_mcp" | "http_mcp";
  transport: "stdio" | "http" | "sse";
  /** Connection as it will be stored: no secret values. */
  connection: Record<string, unknown>;
  /** none: no credential. single: one secret (secretEnvVar / bearer auth). bundle: a JSON secret of several values. */
  secretMode: "none" | "single" | "bundle";
  slots: McpImportValueSlot[];
  report: McpImportReportItem[];
  status: McpImportItemStatus;
  disabledInSource: boolean;
  duplicate: McpImportDuplicate | null;
  decision: McpImportDecision;
  /** Set when the entry cannot be imported as is (missing values, catalog enforcement, unusable source). */
  blockedReason: string | null;
  result?: {
    action: "created" | "updated" | "skipped";
    serverId?: string;
    secretId?: string;
    reason?: string;
  };
}

export interface McpConfigImportResponse {
  dryRun: boolean;
  format: McpConfigImportFormat;
  sourceName: string | null;
  entries: McpImportEntryView[];
  summary: {
    total: number;
    mapped: number;
    approximated: number;
    skipped: number;
    create: number;
    update: number;
    copy: number;
    skip: number;
    blocked: number;
  };
  warnings: string[];
}

export const mcpConfigImportEntryOptionsSchema = z.object({
  decision: z.enum(["create", "update", "copy", "skip"]).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  /** Values for slots, keyed by slot id. Never echoed back. */
  values: z.record(z.string(), z.string().max(16_384)).optional()
});

export const mcpConfigImportRequestSchema = z.object({
  /** The file as text (JSON, comments and trailing commas allowed) or already parsed. */
  content: z.union([z.string().min(1).max(1_000_000), z.record(z.string(), z.unknown())]),
  fileName: z.string().max(260).optional(),
  dryRun: z.boolean().optional(),
  projectId: z.string().trim().min(1).nullable().optional(),
  entries: z.record(z.string(), mcpConfigImportEntryOptionsSchema).optional(),
  /** Probe imported servers like a normal registration (default true). */
  probe: z.boolean().optional()
});
export type McpConfigImportRequest = z.infer<typeof mcpConfigImportRequestSchema>;

// --- Deployment-local catalog (MCP_CATALOG_FILE) ----------------------------

export const mcpCatalogRequiredSecretSchema = z.object({
  /** Env var (stdio) or header (http) the secret is injected as. */
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional()
});

export const mcpCatalogEntrySchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, "id must be lowercase letters, digits, '.', '_' or '-'"),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  adapter: z.enum(["stdio_mcp", "http_mcp"]),
  connection: z.record(z.string(), z.unknown()),
  requiredSecrets: z.array(mcpCatalogRequiredSecretSchema).max(20).default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  approved: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
  source: z.string().max(500).optional()
});
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;

export const mcpCatalogFileSchema = z.object({
  version: z.literal(1).optional(),
  servers: z.array(z.unknown()).max(500)
});

export interface McpCatalogIssue {
  /** Index of the entry in `servers`, or null for a file-level problem. */
  index: number | null;
  entryId?: string;
  path?: string;
  message: string;
}

export interface McpCatalogStatus {
  configured: boolean;
  /** File name only; the full path stays on the server. */
  fileName: string | null;
  mode: "merge" | "exclusive";
  enforce: boolean;
  /** ok: loaded cleanly. partial: some entries rejected. error: the file could not be used. */
  state: "off" | "ok" | "partial" | "error";
  loadedAt: string | null;
  entryCount: number;
  approvedCount: number;
  errors: McpCatalogIssue[];
}

// --- Playground -------------------------------------------------------------

export const mcpPlaygroundCallSchema = z.object({
  toolName: z.string().trim().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
  projectId: z.string().trim().min(1).nullable().optional(),
  /** Must be true to call a tool classified as write. */
  confirmWrite: z.boolean().optional()
});
export type McpPlaygroundCallRequest = z.infer<typeof mcpPlaygroundCallSchema>;

/** What a playground panel can show for a server; panels render per capability. */
export type McpPlaygroundCapability = "tools";

export interface McpPlaygroundExchange {
  transport:
    | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
    | { kind: "http"; endpoint: string; headers: Record<string, string> }
    | { kind: "other"; adapterId: string };
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  note: string;
}

export interface McpPlaygroundCallResponse {
  ok: boolean;
  durationMs: number;
  toolName: string;
  serverId: string;
  classification: McpToolClassification;
  annotations?: McpToolAnnotations;
  result: {
    content: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  exchange: McpPlaygroundExchange;
  policy: { role: string; projectId: string };
  telemetryId: string;
}
