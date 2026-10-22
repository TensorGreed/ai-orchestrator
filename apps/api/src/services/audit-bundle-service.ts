/**
 * Phase 11.1 — signed run manifests and audit bundles.
 *
 * The manifest is built from what a run already recorded: the execution
 * history (node results, as stored and redacted), the run context captured
 * when the run finished (the workflow as it ran and the identity of the MCP
 * servers it could call), guard events, and the price table. It is
 * generated once, on first request after the run finished, signed and
 * cached in `execution_manifests`, so it never changes afterwards.
 *
 * Secrets: node configurations keep `secretRef.secretId` only, secret-looking
 * literals are replaced with `[REDACTED]`, and as a last line of defence every
 * secret value the deployment holds (see `SecretService.valuesForScrubbing`
 * and the provider keys from the environment) is scrubbed from the manifest,
 * every JSON and log file, and every text output; binary outputs that carry
 * one are left out and listed in `redactions.json`. Values are only held in
 * memory while scrubbing; they are never logged or returned.
 */

import crypto from "node:crypto";
import { promisify } from "node:util";
import { deflateRaw, deflateRawSync } from "node:zlib";
import {
  AUDIT_BUNDLE_MANIFEST_PATH,
  AUDIT_BUNDLE_README_PATH,
  AUDIT_BUNDLE_SIGNATURE_FORMAT,
  AUDIT_BUNDLE_SIGNATURE_PATH,
  AUDIT_BUNDLE_SIGNATURE_VERSION,
  AUDIT_SIGNING_ALGORITHM,
  auditBundleSignedBytes,
  canonicalJson,
  prepareZip,
  zipCollisionKey,
  RUN_MANIFEST_FORMAT,
  RUN_MANIFEST_VERSION,
  runManifestAttestationBytes,
  runManifestSchema,
  type AuditBundleIndexEntry,
  type AuditBundleSignature,
  type McpCatalogEntry,
  type PreparedZip,
  type RunManifest,
  type RunManifestApproval,
  type RunManifestCitation,
  type RunManifestGuardExtension,
  type RunManifestMcpServer,
  type RunManifestModelCall,
  type RunManifestNode,
  type RunManifestPrompt,
  type RunManifestToolCall,
  type RunManifestToolOutcome,
  type RunManifestView,
  type Workflow
} from "@ai-orchestrator/shared";
import { parseMcpRuntimeRejection } from "@ai-orchestrator/mcp-sdk";
import type { ExecutionManifestRecord, McpServerRecord, SqliteStore } from "../db/database.js";
import type { AuditSigningService } from "./audit-signing-service.js";
import { findCatalogEntryForCommand, packageSpecOf } from "./mcp-catalog.js";
import { REDACTED, SecretScrubber } from "./audit-scrub.js";
import type { SecretService } from "./secret-service.js";

export { REDACTED };

const deflateRawAsync = promisify(deflateRaw);
/** Moderate compression: level 9 costs much more CPU for little gain on JSON. */
const DEFLATE_LEVEL = 6;
export const AUDIT_BUNDLE_REDACTIONS_PATH = "redactions.json";

/** Statuses of a run that has not finished; no manifest is generated for them. */
const IN_PROGRESS_STATUSES = new Set(["running", "pending", "queued", "waiting_approval"]);

const SENSITIVE_KEY = /(api[-_]?key|token|password|passwd|secret|authorization|private[-_]?key|client[-_]?secret|credential|cookie)/i;
const LLM_NODE_TYPES = new Set([
  "llm_call",
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model"
]);
const AGENT_NODE_TYPES = new Set(["agent_orchestrator", "supervisor_node"]);
const MAX_WORKER_DEPTH = 4;
const RENDERED_OUTPUT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx"
};

export class AuditBundleError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "in_progress" | "too_large" | "invalid"
  ) {
    super(message);
    this.name = "AuditBundleError";
  }
}

export interface AuditBundleServiceOptions {
  store: SqliteStore;
  signing: AuditSigningService;
  secrets: SecretService;
  /** USD for one model call; null when the model is not priced. */
  priceTurn: (providerId: string, model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number) => number | null;
  catalogEntries: () => McpCatalogEntry[];
  maxBundleBytes: number;
  /** Secret values that live outside the secret store: provider API keys and other credentials from the environment. */
  environmentSecretValues?: () => string[];
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  now?: () => Date;
}

/** What `captureRunContext` stores when a run finishes. */
interface RunContext {
  version: 1;
  capturedAt: string;
  /** The workflow as it ran, with secret-looking literals redacted and timestamps left out. */
  workflow: Record<string, unknown>;
  workflowHash: string;
  savedVersion: number | null;
  mcpServers: RunManifestMcpServer[];
}

export interface PreparedAuditBundle {
  fileName: string;
  zip: PreparedZip;
  manifestDigest: string;
  keyId: string;
  files: number;
}

type HistoryRecord = NonNullable<ReturnType<SqliteStore["getExecutionHistory"]>>;
type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of the canonical JSON of a value; null for a missing value. */
export function digestOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return sha256Hex(canonicalJson(value));
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An endpoint without user info, query string or fragment (those can carry credentials). */
export function sanitizeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * A node configuration as it can appear in a manifest: secret references
 * kept, literal values under secret-looking keys replaced, URLs stripped of
 * credentials and query strings.
 */
export function sanitizeConfig(value: unknown, depth = 0): unknown {
  if (depth > 32) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => sanitizeConfig(entry, depth + 1));
  const record = asRecord(value);
  if (!record) {
    if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value)) return sanitizeUrl(value) ?? REDACTED;
    return value;
  }
  const out = Object.create(null) as JsonRecord;
  for (const [key, inner] of Object.entries(record)) {
    if ((key === "secretId" || key.endsWith("SecretId")) && typeof inner === "string") {
      out[key] = inner;
    } else if (key === "secretRef" || key.endsWith("SecretRef")) {
      const ref = asRecord(inner);
      out[key] = ref && typeof ref.secretId === "string" ? { secretId: ref.secretId } : inner === null || inner === undefined ? inner : REDACTED;
    } else if (SENSITIVE_KEY.test(key) && inner !== null && inner !== undefined && typeof inner !== "number" && typeof inner !== "boolean") {
      out[key] = typeof inner === "string" && inner.length === 0 ? inner : REDACTED;
    } else {
      out[key] = sanitizeConfig(inner, depth + 1);
    }
  }
  return out;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80);
  return cleaned || "item";
}

function pretty(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** The workflow fields that define what runs; timestamps and run-time pins are left out. */
function workflowForHash(workflow: Workflow): Record<string, unknown> {
  const sanitized = sanitizeConfig({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    schemaVersion: workflow.schemaVersion,
    workflowVersion: workflow.workflowVersion,
    variables: workflow.variables,
    settings: workflow.settings,
    projectId: workflow.projectId,
    nodes: workflow.nodes,
    edges: workflow.edges
  });
  return JSON.parse(canonicalJson(sanitized)) as Record<string, unknown>;
}

function classifyToolOutcome(error: unknown, ok: boolean): RunManifestToolOutcome {
  if (ok) return "ok";
  const rejection = parseMcpRuntimeRejection(error);
  if (rejection === "rate_limited") return "rate_limited";
  if (rejection === "concurrency_limited") return "concurrency_limited";
  if (rejection === "circuit_open") return "breaker_rejected";
  const text = typeof error === "string" ? error : "";
  if (/was blocked by the guard/i.test(text)) return "guard_blocked";
  if (/is blocked by policy|counts as a write tool|no-write|not allowed by (the )?(tool )?policy/i.test(text)) return "policy_blocked";
  return "error";
}

function isFinished(history: HistoryRecord): boolean {
  return Boolean(history.completedAt) && !IN_PROGRESS_STATUSES.has(history.status);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AuditBundleService {
  constructor(private readonly options: AuditBundleServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** MCP server identity as the manifest records it (no secrets, no credentials in URLs). */
  private serverIdentity(server: McpServerRecord): RunManifestMcpServer {
    const connection = asRecord(server.connection) ?? {};
    const adapter = server.adapterId.toLowerCase();
    const command = typeof connection.command === "string" ? connection.command : "";
    const args = Array.isArray(connection.args) ? connection.args.map(String) : [];
    const transport: RunManifestMcpServer["transport"] = command || adapter.includes("stdio") ? "stdio" : adapter.includes("http") || connection.endpoint || connection.url ? "http" : "other";
    const url = transport === "http" ? sanitizeUrl(connection.endpoint ?? connection.url) : null;
    const spec = transport === "stdio" && command ? packageSpecOf(command, args) : null;
    let catalogEntryId: string | null = null;
    try {
      const entries = this.options.catalogEntries();
      if (transport === "stdio" && command) {
        catalogEntryId = findCatalogEntryForCommand(command, args, entries)?.id ?? null;
      } else if (url) {
        catalogEntryId =
          entries.find((entry) => entry.approved && entry.adapter === "http_mcp" && sanitizeUrl(entry.connection.endpoint ?? entry.connection.url) === url)?.id ?? null;
      }
    } catch {
      catalogEntryId = null;
    }
    const snapshot = server.currentSnapshotId ? this.options.store.getMcpToolSnapshot(server.currentSnapshotId) : null;
    return {
      registryServerId: server.id,
      name: server.name,
      adapterId: server.adapterId,
      transport,
      url,
      package: spec ? { runner: spec.runner, spec: spec.spec, pinned: spec.pinned } : null,
      catalogEntryId,
      snapshotId: snapshot?.id ?? null,
      snapshotHash: snapshot?.hash ?? null
    };
  }

  private static identityLabel(server: RunManifestMcpServer | undefined, adapterId: string | null): string | null {
    if (!server) return adapterId ? `adapter:${adapterId}` : null;
    if (server.catalogEntryId) return `catalog:${server.catalogEntryId}@${server.package?.spec ?? server.url ?? server.adapterId}`;
    if (server.package) return `package:${server.package.spec}`;
    if (server.url) return `url:${server.url}`;
    return `adapter:${server.adapterId}`;
  }

  /**
   * Records, when a run finishes, the workflow as it ran and the identity of
   * the registry MCP servers it references, so a manifest generated later
   * still describes this run even if the workflow or a server changed.
   */
  captureRunContext(executionId: string, workflow: Workflow): void {
    const hashed = workflowForHash(workflow);
    const workflowHash = sha256Hex(canonicalJson(hashed));
    let savedVersion: number | null = null;
    const latest = this.options.store.maxWorkflowVersionNumber(workflow.id);
    if (latest > 0) {
      const entry = this.options.store.getWorkflowVersion(workflow.id, latest);
      if (entry) {
        try {
          if (sha256Hex(canonicalJson(workflowForHash(JSON.parse(entry.workflowJson) as Workflow))) === workflowHash) savedVersion = latest;
        } catch {
          savedVersion = null;
        }
      }
    }
    const serverIds = new Set<string>();
    for (const node of workflow.nodes) {
      const id = str(asRecord(node.config)?.registryServerId);
      if (id) serverIds.add(id);
    }
    const mcpServers = [...serverIds]
      .sort()
      .map((id) => this.options.store.getMcpServer(id))
      .filter((server): server is McpServerRecord => Boolean(server))
      .map((server) => this.serverIdentity(server));
    const context: RunContext = { version: 1, capturedAt: this.now().toISOString(), workflow: hashed, workflowHash, savedVersion, mcpServers };
    this.options.store.saveExecutionRunContext(executionId, context, context.capturedAt);
  }

  private readRunContext(record: ExecutionManifestRecord | null): RunContext | null {
    const context = asRecord(record?.runContext);
    if (!context || context.version !== 1 || !asRecord(context.workflow) || typeof context.workflowHash !== "string") return null;
    return context as unknown as RunContext;
  }

  /** The finished execution's history, or a typed refusal. */
  private requireFinished(executionId: string): HistoryRecord {
    const history = this.options.store.getExecutionHistory(executionId);
    if (!history) throw new AuditBundleError("Execution not found", "not_found");
    if (!isFinished(history)) {
      throw new AuditBundleError("The run is still in progress; its manifest is generated once it finishes", "in_progress");
    }
    return history;
  }

  /**
   * Every secret value the run could have used: all secrets in the secret
   * store (local values of every project, since a node can reference any
   * secret id; internal secrets such as MCP OAuth tokens; locally cached
   * values of external secrets, never fetched for this) and the credentials
   * L2M reads from its environment (provider API keys and similar).
   */
  private scrubber(): SecretScrubber {
    const values: string[] = [];
    try {
      values.push(...this.options.secrets.valuesForScrubbing());
    } catch {
      // The secret store is unreadable: nothing from it can be scrubbed, or have been used.
    }
    try {
      values.push(...(this.options.environmentSecretValues?.() ?? []));
    } catch {
      // No environment values.
    }
    return new SecretScrubber(values);
  }

  /** The cached manifest, generated and signed on first request after the run finished. */
  async getManifest(executionId: string): Promise<RunManifestView> {
    const history = this.requireFinished(executionId);
    let record = this.options.store.getExecutionManifest(executionId);
    if (!record?.manifestJson) {
      record = await this.generate(history, record);
    }
    return AuditBundleService.view(record);
  }

  private static view(record: ExecutionManifestRecord): RunManifestView {
    return {
      executionId: record.executionId,
      manifest: JSON.parse(record.manifestJson!) as RunManifest,
      digest: record.manifestDigest!,
      keyId: record.keyId!,
      algorithm: AUDIT_SIGNING_ALGORITHM,
      signedAt: record.signedAt!,
      signature: record.signature!
    };
  }

  private async generate(history: HistoryRecord, existing: ExecutionManifestRecord | null): Promise<ExecutionManifestRecord> {
    const context = this.readRunContext(existing);
    const manifest = this.buildManifest(history, context);
    const scrubbed = this.scrubber().tree(manifest);
    const parsed = runManifestSchema.safeParse(scrubbed);
    if (!parsed.success) {
      this.options.logger?.warn("Generated run manifest failed validation", { executionId: history.id, issues: parsed.error.issues.length });
      throw new AuditBundleError("The run manifest could not be built from this execution's records", "invalid");
    }
    const manifestJson = canonicalJson(scrubbed);
    const manifestDigest = sha256Hex(manifestJson);
    const signedAt = manifest.generatedAt;
    const signature = this.options.signing.sign(
      runManifestAttestationBytes({ executionId: history.id, manifestDigest, keyId: manifest.deployment.keyId, signedAt })
    );
    if (signature.keyId !== manifest.deployment.keyId) {
      throw new AuditBundleError("The signing key changed while the manifest was generated; try again", "invalid");
    }
    return this.options.store.saveExecutionManifest({
      executionId: history.id,
      manifestJson,
      manifestDigest,
      keyId: signature.keyId,
      signature: signature.signature,
      signedAt
    });
  }

  /** Builds the manifest object (not yet scrubbed, validated or signed). */
  buildManifest(history: HistoryRecord, context: RunContext | null): RunManifest {
    const store = this.options.store;
    const generatedAt = this.now().toISOString();
    const keyId = this.options.signing.activeKeyId();

    let workflowDef: Record<string, unknown> | null = context?.workflow ?? null;
    let workflowSource: RunManifest["workflow"]["source"] = context ? "captured" : "unavailable";
    let workflowHash = context?.workflowHash ?? null;
    let savedVersion = context?.savedVersion ?? null;
    if (!workflowDef) {
      const current = store.getWorkflow(history.workflowId);
      if (current) {
        workflowDef = workflowForHash(current);
        workflowHash = sha256Hex(canonicalJson(workflowDef));
        workflowSource = "current";
        savedVersion = null;
      }
    }
    const workflowNodes = (Array.isArray(workflowDef?.nodes) ? workflowDef.nodes : []) as Array<{ id: string; type: string; name?: string; config?: unknown }>;
    const workflowEdges = Array.isArray(workflowDef?.edges) ? workflowDef.edges : [];
    const nodeById = new Map(workflowNodes.map((node) => [node.id, node]));

    // Servers: captured identities, plus current records for servers seen only in tool calls.
    const servers = new Map<string, RunManifestMcpServer>((context?.mcpServers ?? []).map((server) => [server.registryServerId, server]));
    const serverFor = (registryServerId: string | null): RunManifestMcpServer | undefined => {
      if (!registryServerId) return undefined;
      if (!servers.has(registryServerId)) {
        const record = store.getMcpServer(registryServerId);
        if (record) servers.set(registryServerId, this.serverIdentity(record));
      }
      return servers.get(registryServerId);
    };

    const results = (Array.isArray(history.nodeResults) ? history.nodeResults : []).map(asRecord).filter((entry): entry is JsonRecord => Boolean(entry && typeof entry.nodeId === "string"));
    const lastResult = new Map<string, JsonRecord>();
    for (const result of results) lastResult.set(result.nodeId as string, result);

    // Nodes: the workflow's nodes in order, then results of nodes the definition no longer has.
    const nodes: RunManifestNode[] = [];
    const describeNode = (id: string, type: string, name: string, config: unknown, result: JsonRecord | undefined): RunManifestNode => ({
      id,
      type,
      name,
      status: str(result?.status) ?? "not_run",
      startedAt: str(result?.startedAt),
      completedAt: str(result?.completedAt),
      durationMs: num(result?.durationMs),
      attempts: num(result?.attempts),
      errorCategory: str(result?.errorCategory),
      config: (asRecord(sanitizeConfig(config ?? {})) ?? {}) as Record<string, unknown>,
      inputDigest: digestOf(result?.input),
      outputDigest: digestOf(result?.output)
    });
    for (const node of workflowNodes) nodes.push(describeNode(node.id, node.type, node.name ?? node.id, node.config, lastResult.get(node.id)));
    for (const [id, result] of lastResult) if (!nodeById.has(id)) nodes.push(describeNode(id, "unknown", id, {}, result));

    const modelCalls: RunManifestModelCall[] = [];
    const toolCalls: RunManifestToolCall[] = [];
    const prompts: RunManifestPrompt[] = [];
    const citations: RunManifestCitation[] = [];
    const approvals: RunManifestApproval[] = [];

    const providerParameters = (provider: JsonRecord | null): Record<string, unknown> => {
      if (!provider) return {};
      const out: JsonRecord = {};
      for (const [key, value] of Object.entries(provider)) {
        if (key === "providerId" || key === "model" || key === "secretRef") continue;
        out[key] = key === "baseUrl" || key === "endpoint" ? sanitizeUrl(value) : value;
      }
      return (asRecord(sanitizeConfig(out)) ?? {}) as Record<string, unknown>;
    };
    const pushModelCall = (nodeId: string, iteration: number | null, providerId: string, model: string, provider: JsonRecord | null, usage: JsonRecord | null, latencyMs: number | null) => {
      const inputTokens = num(usage?.inputTokens);
      const outputTokens = num(usage?.outputTokens);
      const cachedInputTokens = num(usage?.cachedInputTokens);
      const costUsd = inputTokens !== null || outputTokens !== null ? this.options.priceTurn(providerId, model, inputTokens ?? 0, outputTokens ?? 0, cachedInputTokens ?? 0) : null;
      modelCalls.push({ nodeId, iteration, providerId, model, parameters: providerParameters(provider), inputTokens, outputTokens, cachedInputTokens, costUsd, latencyMs });
    };

    const scanAgentTools = (output: JsonRecord, nodeId: string, depth: number) => {
      const steps = Array.isArray(output.steps) ? output.steps : [];
      const attribution = asRecord(output._mcpTools) ?? {};
      for (const rawStep of steps) {
        const step = asRecord(rawStep);
        if (!step) continue;
        const iteration = num(step.iteration);
        const requested = new Map<string, unknown>();
        for (const call of Array.isArray(step.requestedTools) ? step.requestedTools : []) {
          const entry = asRecord(call);
          if (entry && typeof entry.id === "string") requested.set(entry.id, entry.arguments ?? entry.args);
        }
        for (const rawResult of Array.isArray(step.toolResults) ? step.toolResults : []) {
          const result = asRecord(rawResult);
          if (!result) continue;
          const exposed = str(result.toolName);
          const target = exposed ? asRecord(attribution[exposed]) : null;
          if (target) {
            const registryServerId = str(target.registryServerId);
            const server = serverFor(registryServerId);
            const adapterId = str(target.adapterId);
            const toolCallId = str(result.toolCallId);
            const error = result.error;
            toolCalls.push({
              nodeId,
              iteration,
              toolCallId,
              toolName: str(target.toolName) ?? exposed!,
              adapterId,
              registryServerId,
              serverIdentity: AuditBundleService.identityLabel(server, adapterId),
              schemaSnapshotHash: server?.snapshotHash ?? null,
              argsDigest: digestOf(toolCallId ? requested.get(toolCallId) : undefined),
              resultDigest: digestOf(result.output),
              outcome: classifyToolOutcome(error, error === undefined || error === null || error === ""),
              startedAt: str(result.startedAt),
              durationMs: num(result.durationMs)
            });
          }
          const nested = asRecord(result.output);
          if (nested && depth < MAX_WORKER_DEPTH && Array.isArray(nested.steps)) scanAgentTools(nested, nodeId, depth + 1);
        }
      }
    };

    for (const result of results) {
      const nodeId = result.nodeId as string;
      const node = nodeById.get(nodeId);
      const type = node?.type ?? "";
      const config = asRecord(node?.config) ?? {};
      const output = asRecord(result.output);
      const input = asRecord(result.input);
      const status = str(result.status);
      const consumed = output?.reason === "attachment_consumed_by_agent";

      // Approval decisions recorded when a paused run was resumed.
      if (input && (input.decision === "approve" || input.decision === "reject")) {
        approvals.push({ nodeId, decision: input.decision, actedBy: str(input.actedBy), reason: str(input.reason), decidedAt: str(result.startedAt) });
      }
      if (!output || consumed) continue;

      const telemetry = asRecord(output._telemetry);
      const provider = asRecord(output._provider);
      if (AGENT_NODE_TYPES.has(type) || Array.isArray(output.steps)) {
        const providerId = str(telemetry?.providerId) ?? str(provider?.providerId);
        const model = str(telemetry?.model) ?? str(provider?.model);
        const steps = (Array.isArray(output.steps) ? output.steps : []).map(asRecord).filter((step): step is JsonRecord => Boolean(step));
        if (providerId && model) {
          if (steps.length > 0) {
            for (const step of steps) pushModelCall(nodeId, num(step.iteration), providerId, model, provider, asRecord(step.usage), num(step.latencyMs));
          } else if (telemetry) {
            pushModelCall(nodeId, null, providerId, model, provider, asRecord(telemetry.usage), num(telemetry.latencyMs));
          }
        }
        scanAgentTools(output, nodeId, 0);
        const messages = Array.isArray(output.messages) ? output.messages.map(asRecord) : [];
        const systemMessage = messages.find((message) => message?.role === "system");
        const userMessage = messages.find((message) => message?.role === "user");
        const systemTemplate = str(config.systemPromptTemplate) ?? str(config.systemPrompt);
        const userTemplate = str(config.userPromptTemplate) ?? str(config.userPrompt) ?? str(config.promptTemplate);
        const renderedSystem = typeof systemMessage?.content === "string" ? systemMessage.content : null;
        const renderedUser = typeof userMessage?.content === "string" ? userMessage.content : null;
        if (systemTemplate || renderedSystem) prompts.push({ nodeId, role: "system", template: systemTemplate, rendered: renderedSystem });
        if (userTemplate || renderedUser) prompts.push({ nodeId, role: "user", template: userTemplate, rendered: renderedUser });
      } else if (LLM_NODE_TYPES.has(type) || telemetry) {
        const providerId = str(telemetry?.providerId) ?? str(provider?.providerId);
        const model = str(telemetry?.model) ?? str(provider?.model);
        if (providerId && model) pushModelCall(nodeId, null, providerId, model, provider, asRecord(telemetry?.usage), num(telemetry?.latencyMs));
        if (LLM_NODE_TYPES.has(type)) {
          const promptKey = str(config.promptKey) ?? "prompt";
          const systemKey = str(config.systemPromptKey) ?? "system_prompt";
          const renderedUser = str(input?.[promptKey]) ?? str(input?.user_prompt);
          const renderedSystem = str(input?.[systemKey]);
          const userTemplate = str(config.userPromptTemplate) ?? str(config.promptTemplate) ?? str(config.userPrompt);
          const systemTemplate = str(config.systemPromptTemplate) ?? str(config.systemPrompt);
          if (systemTemplate || renderedSystem) prompts.push({ nodeId, role: "system", template: systemTemplate, rendered: renderedSystem });
          if (userTemplate || renderedUser) prompts.push({ nodeId, role: "user", template: userTemplate, rendered: renderedUser });
        }
      }

      // Direct MCP Tool nodes that ran.
      const request = asRecord(output.invocation_request);
      if (type === "mcp_tool" && (request || status === "error")) {
        const registryServerId = str(request?.registry_server_id) ?? str(config.registryServerId);
        const server = serverFor(registryServerId);
        const adapterId = str(request?.server_id) ?? str(config.serverId) ?? server?.adapterId ?? null;
        toolCalls.push({
          nodeId,
          iteration: null,
          toolCallId: null,
          toolName: str(request?.tool_name) ?? str(output.tool_name) ?? str(config.toolName) ?? "unknown",
          adapterId,
          registryServerId,
          serverIdentity: AuditBundleService.identityLabel(server, adapterId),
          schemaSnapshotHash: server?.snapshotHash ?? null,
          argsDigest: digestOf(request?.tool_args),
          resultDigest: digestOf(output.tool_output),
          outcome: classifyToolOutcome(result.error, status === "success"),
          startedAt: str(result.startedAt),
          durationMs: num(result.durationMs)
        });
      }

      // RAG: cited chunks, and the documents a retrieval node returned.
      const cited = Array.isArray(output.citations) ? output.citations : [];
      for (const raw of cited) {
        const citation = asRecord(raw);
        if (!citation) continue;
        citations.push({
          nodeId,
          marker: str(citation.marker),
          index: num(citation.index),
          chunkId: str(citation.chunkId),
          sourceId: str(citation.sourceId),
          knowledgeBaseId: str(citation.knowledgeBaseId),
          score: num(citation.rerankerScore) ?? num(citation.similarityScore),
          retrievalMode: str(citation.retrievalMode),
          textDigest: typeof citation.text === "string" ? sha256Hex(citation.text) : null
        });
      }
      if (cited.length === 0 && (type === "rag_retrieve" || typeof output.citationInstructions === "string") && Array.isArray(output.documents)) {
        output.documents.forEach((raw, index) => {
          const document = asRecord(raw);
          if (!document) return;
          const metadata = asRecord(document.metadata) ?? {};
          citations.push({
            nodeId,
            marker: null,
            index: index + 1,
            chunkId: str(metadata.chunkId) ?? str(document.id),
            sourceId: str(metadata.sourceId),
            knowledgeBaseId: str(metadata.knowledgeBaseId),
            score: num(metadata.rerankerScore) ?? num(metadata.similarityScore),
            retrievalMode: str(asRecord(metadata.retrieval)?.mode),
            textDigest: typeof document.text === "string" ? sha256Hex(document.text) : null
          });
        });
      }
    }

    // Guard verdicts (Phase 12.7): no evidence, no matched content.
    const guardEvents = store.listGuardEventsForExecution(history.id);
    const verdictActions = new Map<string, { action: string; shadow: boolean }>();
    for (const event of guardEvents) if (!verdictActions.has(event.verdictId)) verdictActions.set(event.verdictId, { action: event.verdictAction, shadow: event.shadow });
    const byAction: Record<string, number> = {};
    for (const { action } of verdictActions.values()) byAction[action] = (byAction[action] ?? 0) + 1;
    const guard: RunManifestGuardExtension = {
      verdicts: guardEvents.map((event) => ({
        verdictId: event.verdictId,
        nodeId: event.nodeId,
        channel: event.channel,
        placement: event.placement,
        iteration: event.iteration,
        toolName: event.toolName,
        detectorId: event.detectorId,
        category: event.category,
        requestedAction: event.requestedAction,
        effectiveAction: event.effectiveAction,
        verdictAction: event.verdictAction,
        shadow: event.shadow,
        profileId: event.profileId,
        profileVersion: event.profileVersion,
        profileHash: event.profileHash
      })),
      summary: {
        verdicts: verdictActions.size,
        findings: guardEvents.filter((event) => event.detectorId !== null).length,
        blocked: [...verdictActions.values()].filter((entry) => entry.action === "block" && !entry.shadow).length,
        byAction
      }
    };

    const inputTokens = modelCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0);
    const outputTokens = modelCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0);
    const cachedInputTokens = modelCalls.reduce((sum, call) => sum + (call.cachedInputTokens ?? 0), 0);
    const priced = modelCalls.filter((call) => call.costUsd !== null);
    const costUsd = priced.length > 0 ? Math.round(priced.reduce((sum, call) => sum + (call.costUsd ?? 0), 0) * 1_000_000) / 1_000_000 : null;

    return {
      format: RUN_MANIFEST_FORMAT,
      manifestVersion: RUN_MANIFEST_VERSION,
      generatedAt,
      deployment: { keyId, algorithm: AUDIT_SIGNING_ALGORITHM },
      run: {
        executionId: history.id,
        status: history.status,
        triggerType: history.triggerType,
        subject: history.triggeredBy,
        startedAt: history.startedAt,
        completedAt: history.completedAt ?? history.startedAt,
        durationMs: history.durationMs,
        error: history.error,
        inputDigest: digestOf(history.input),
        outputDigest: digestOf(history.output)
      },
      workflow: {
        id: history.workflowId,
        name: str(workflowDef?.name) ?? history.workflowName,
        schemaVersion: str(workflowDef?.schemaVersion),
        workflowVersion: num(workflowDef?.workflowVersion),
        savedVersion,
        hash: workflowHash ?? sha256Hex(canonicalJson({})),
        source: workflowSource,
        nodeCount: workflowNodes.length,
        edgeCount: workflowEdges.length
      },
      nodes,
      modelCalls,
      toolCalls,
      mcpServers: [...servers.values()].sort((a, b) => a.registryServerId.localeCompare(b.registryServerId)),
      prompts,
      citations,
      approvals,
      totals: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd,
        modelCalls: modelCalls.length,
        toolCalls: toolCalls.length
      },
      extensions: { guard }
    };
  }

  // -------------------------------------------------------------------------
  // Bundle
  // -------------------------------------------------------------------------

  /**
   * Builds and signs the bundle; refuses runs in progress and bundles over
   * the size limit. The limit is enforced while the files are assembled
   * (uncompressed bytes), before any compression work, and again on the
   * final archive. `includeActorEmails` is for admins: other exporters get
   * audit-log rows with the actor's user id and role only.
   */
  async prepareBundle(executionId: string, options: { includeActorEmails?: boolean } = {}): Promise<PreparedAuditBundle> {
    const view = await this.getManifest(executionId);
    const history = this.requireFinished(executionId);
    const record = this.options.store.getExecutionManifest(executionId);
    const context = this.readRunContext(record);
    const workflow = context?.workflow ?? (() => {
      const current = this.options.store.getWorkflow(history.workflowId);
      return current ? workflowForHash(current) : null;
    })();
    const scrubber = this.scrubber();
    const encoder = new TextEncoder();
    const maxBytes = this.options.maxBundleBytes;
    const files: Array<{ path: string; data: Uint8Array }> = [];
    const usedNames = new Set<string>();
    const redactions: { scrubbed: Array<{ path: string; reason: string }>; omitted: Array<{ path: string; reason: string }> } = { scrubbed: [], omitted: [] };
    let rawBytes = 0;
    const add = (path: string, data: Uint8Array) => {
      rawBytes += data.length;
      if (rawBytes > maxBytes) throw new AuditBundleError(this.tooLargeMessage(rawBytes, true), "too_large");
      usedNames.add(zipCollisionKey(path));
      files.push({ path, data });
    };
    const noteScrubbed = (path: string) => {
      if (scrubber.hits > 0) redactions.scrubbed.push({ path, reason: "secret value replaced with [REDACTED]" });
    };
    /** JSON file: scrubbed as a value tree, then its text again for escaped forms. */
    const textFile = (path: string, value: unknown) => {
      scrubber.resetHits();
      const data = encoder.encode(scrubber.text(new TextDecoder().decode(pretty(scrubber.tree(value)))));
      noteScrubbed(path);
      add(path, data);
    };

    const manifestBytes = encoder.encode(record!.manifestJson!);
    if (sha256Hex(manifestBytes) !== view.digest) throw new AuditBundleError("The cached manifest does not match its digest", "invalid");
    add(AUDIT_BUNDLE_MANIFEST_PATH, manifestBytes);

    if (workflow) textFile("workflow.json", workflow);
    const { nodeResults, ...run } = history;
    textFile("execution/run.json", run);
    const results = (Array.isArray(nodeResults) ? nodeResults : []).map(asRecord).filter((entry): entry is JsonRecord => Boolean(entry));
    results.forEach((result, index) => {
      textFile(`execution/nodes/${String(index + 1).padStart(3, "0")}-${safeSegment(String(result.nodeId ?? "node"))}.json`, result);
    });
    textFile("execution/trace.json", {
      executionId,
      nodes: results.map((result) => ({
        nodeId: result.nodeId,
        status: result.status,
        startedAt: result.startedAt ?? null,
        completedAt: result.completedAt ?? null,
        durationMs: result.durationMs ?? null,
        attempts: result.attempts ?? null,
        errorCategory: result.errorCategory ?? null
      })),
      mcpToolCalls: this.options.store.listMcpToolCallsForExecution(executionId),
      guardEvents: this.options.store.listGuardEventsForExecution(executionId)
    });

    // Logs: each line is scrubbed as a value before it is serialised, then as text.
    scrubber.resetHits();
    const logLines: string[] = [];
    const logLine = (value: unknown) => logLines.push(scrubber.text(JSON.stringify(scrubber.tree(value))));
    for (const result of results) {
      for (const activity of Array.isArray(result.activity) ? result.activity : []) logLine({ source: "node_activity", ...asRecord(activity) });
      if (typeof result.error === "string") logLine({ source: "node_error", nodeId: result.nodeId, at: result.completedAt ?? result.startedAt ?? null, error: result.error });
      for (const warning of Array.isArray(result.warnings) ? result.warnings : []) logLine({ source: "node_warning", nodeId: result.nodeId, warning });
    }
    for (const entry of this.options.store.listAuditLogsForExecution(executionId)) {
      const { actorEmail, ...rest } = entry;
      logLine({ source: "audit_log", ...rest, ...(options.includeActorEmails ? { actorEmail } : {}) });
    }
    noteScrubbed("execution/logs.jsonl");
    add("execution/logs.jsonl", encoder.encode(logLines.join("\n") + (logLines.length ? "\n" : "")));

    // Rendered outputs: files a node produced as data URLs (PDFs, charts, documents).
    // Text outputs are scrubbed; binary outputs that carry a secret value are left out.
    const seen = new Set<string>();
    const uniquePath = (path: string): string => {
      if (!usedNames.has(zipCollisionKey(path))) return path;
      const dot = path.lastIndexOf(".");
      for (let suffix = 2; ; suffix += 1) {
        const candidate = `${path.slice(0, dot)}-${suffix}${path.slice(dot)}`;
        if (!usedNames.has(zipCollisionKey(candidate))) return candidate;
      }
    };
    results.forEach((result) => {
      const nodeId = safeSegment(String(result.nodeId ?? "node"));
      let count = 0;
      const visit = (value: unknown, key: string, depth: number, filename: string | null) => {
        if (depth > 12) return;
        if (typeof value === "string") {
          if (!value.startsWith("data:")) return;
          const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
          const mime = match?.[1]?.toLowerCase();
          const extension = mime ? RENDERED_OUTPUT_TYPES[mime] : undefined;
          if (!match || !mime || !extension) return;
          const raw = new Uint8Array(Buffer.from(match[2]!.replace(/\s+/g, ""), "base64"));
          const fingerprint = `${nodeId}:${sha256Hex(raw)}`;
          if (raw.length === 0 || seen.has(fingerprint)) return;
          seen.add(fingerprint);
          count += 1;
          const base = safeSegment((filename ?? key).replace(/\.[A-Za-z0-9]+$/, ""));
          const path = uniquePath(`outputs/${nodeId}/${String(count).padStart(2, "0")}-${base}.${extension}`);
          scrubber.resetHits();
          const data = scrubber.bytes(raw, mime);
          if (data === null) {
            usedNames.add(zipCollisionKey(path));
            redactions.omitted.push({ path, reason: `${mime} output contains a secret value; left out` });
            return;
          }
          noteScrubbed(path);
          add(path, data);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((entry) => visit(entry, key, depth + 1, filename));
          return;
        }
        const record = asRecord(value);
        if (!record) return;
        const name = str(record.filename) ?? str(record.name) ?? filename;
        for (const [innerKey, inner] of Object.entries(record)) visit(inner, innerKey, depth + 1, name);
      };
      visit(result.output, "output", 0, null);
    });

    add(
      AUDIT_BUNDLE_REDACTIONS_PATH,
      pretty({
        format: "l2m.audit-bundle-redactions",
        version: 1,
        policy:
          "Secret values held by the deployment (its secret store in every project, cached external secrets, credentials from its environment; " +
          "values of at least 6 characters) " +
          "are replaced with [REDACTED] in every JSON, log and text file. Binary outputs that contain one are left out. " +
          "Content compressed inside binary formats (PDF streams, DOCX/XLSX parts) is not inspected.",
        scrubbed: redactions.scrubbed,
        omitted: redactions.omitted
      })
    );
    add(AUDIT_BUNDLE_README_PATH, encoder.encode(readmeText(view)));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const index: AuditBundleIndexEntry[] = files.map((file) => ({ path: file.path, sha256: sha256Hex(file.data), bytes: file.data.length }));
    const signedAt = this.now().toISOString();
    const unsigned: Omit<AuditBundleSignature, "signature" | "keyId" | "publicKey"> = {
      format: AUDIT_BUNDLE_SIGNATURE_FORMAT,
      version: AUDIT_BUNDLE_SIGNATURE_VERSION,
      algorithm: AUDIT_SIGNING_ALGORITHM,
      signedAt,
      index: { executionId, workflowId: history.workflowId, manifestDigest: view.digest, files: index }
    };
    // The signer reports which key signed; the signed bytes name that key and its public key.
    const { keyId, publicKey } = this.options.signing.activePublicKey();
    const body = { ...unsigned, keyId, publicKey };
    const signed = this.options.signing.sign(auditBundleSignedBytes(body));
    if (signed.keyId !== keyId) throw new AuditBundleError("The signing key changed while the bundle was signed; try again", "invalid");
    const signature: AuditBundleSignature = { ...body, signature: signed.signature };
    const signatureFile = { path: AUDIT_BUNDLE_SIGNATURE_PATH, data: pretty(signature) };

    const ordered = [
      files.find((file) => file.path === AUDIT_BUNDLE_MANIFEST_PATH)!,
      signatureFile,
      files.find((file) => file.path === AUDIT_BUNDLE_README_PATH)!,
      ...files.filter((file) => file.path !== AUDIT_BUNDLE_MANIFEST_PATH && file.path !== AUDIT_BUNDLE_README_PATH)
    ];
    // Compress off the event loop (zlib's thread pool), one file at a time.
    const compressed = new Map<Uint8Array, Uint8Array>();
    for (const file of ordered) {
      if (file.data.length > 0) compressed.set(file.data, new Uint8Array(await deflateRawAsync(file.data, { level: DEFLATE_LEVEL })));
    }
    const completed = history.completedAt ? new Date(history.completedAt) : new Date(history.startedAt);
    const zip = prepareZip(ordered, {
      deflateRaw: (data) => compressed.get(data) ?? new Uint8Array(deflateRawSync(data, { level: DEFLATE_LEVEL })),
      modifiedAt: completed
    });
    if (zip.size > maxBytes) throw new AuditBundleError(this.tooLargeMessage(zip.size, false), "too_large");
    return { fileName: `l2m-audit-${safeSegment(executionId)}.zip`, zip, manifestDigest: view.digest, keyId, files: ordered.length };
  }

  private tooLargeMessage(size: number, uncompressed: boolean): string {
    const what = uncompressed ? `The audit bundle's files add up to at least ${size} bytes` : `The audit bundle would be ${size} bytes`;
    return `${what}, over the ${this.options.maxBundleBytes}-byte limit (AUDIT_BUNDLE_MAX_BYTES). Raise the limit or export the manifest alone.`;
  }
}

function readmeText(view: RunManifestView): string {
  const manifest = view.manifest;
  return [
    "L2M audit bundle",
    "================",
    "",
    `Execution:      ${manifest.run.executionId}`,
    `Workflow:       ${manifest.workflow.id}${manifest.workflow.name ? ` (${manifest.workflow.name})` : ""}`,
    `Status:         ${manifest.run.status}`,
    `Finished:       ${manifest.run.completedAt}`,
    `Manifest:       sha256 ${view.digest}`,
    "",
    "Contents",
    "--------",
    "manifest.json          The signed run manifest (canonical JSON: sorted keys, no whitespace).",
    "signature.json         Ed25519 signature, signing key id and public key, and the signed index:",
    "                       the SHA-256 digest and size of every other file in this bundle.",
    "workflow.json          The workflow as it ran (secret-looking literals redacted). Its canonical",
    "                       JSON hashes to manifest.workflow.hash.",
    "execution/run.json     The execution record as stored (redacted input, output, status).",
    "execution/nodes/       Each node's input and output as stored in execution history (redacted).",
    "execution/trace.json   Node timings, MCP tool-call telemetry and guard events (masked evidence).",
    "execution/logs.jsonl   Node activity, errors, warnings and the run's audit-log entries",
    "                       (actor user id and role; actor emails only in bundles exported by an admin).",
    "outputs/               Files the run produced (PDFs, charts, documents), when there are any.",
    "redactions.json        Which files had secret values replaced, and which outputs were left out.",
    "",
    "Verify offline",
    "--------------",
    "1. Get the deployment's public key from an admin (Settings > Audit signing, or",
    "   GET /api/audit/signing-keys) through a channel you trust.",
    "2. Run:  l2m audit verify <this-bundle.zip> --public-key <key file or base64>",
    "   It checks the signature, every file digest against the signed index, that no",
    "   file was added or removed, and the manifest digest. No network access is needed.",
    "",
    "Only the deployment's public key, obtained through a channel you trust, proves who",
    "signed this bundle. Without --public-key the verifier checks the signature against",
    "the key inside signature.json and reports SIGNER NOT VERIFIED (exit code 3): that only",
    "shows the bundle is internally consistent. Anyone who changes a bundle can re-sign it",
    "with a key of their own, so it proves neither who signed it nor that it is unchanged.",
    "",
    "Manifest fields hold digests (SHA-256 of canonical JSON) of node inputs and outputs,",
    "not the payloads; compare them with the files under execution/nodes/. The digests are",
    "not salted: for a small or guessable value, a digest confirms a correct guess.",
    "",
    "Secrets: node configs keep secretRef.secretId only, and literals under credential-like",
    "keys are [REDACTED]. Every secret value the deployment holds (its secret store, cached",
    "external secrets, provider keys from its environment; values of 6 characters or more)",
    "is replaced with [REDACTED] in the manifest and in every JSON, log and text file. Binary",
    "outputs containing one are left out (see redactions.json). Content compressed inside a",
    "binary file (PDF streams, DOCX/XLSX parts) is not inspected.",
    ""
  ].join("\n");
}
