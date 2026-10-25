/**
 * Phase 16 — data destinations: the admin rows that say how far each place
 * outgoing data can go is from home (local, private, vendor, public), and
 * the "not classified yet" list.
 *
 * The list is derived from configuration only: model providers set on
 * workflow nodes (their base URL, or the adapter's default), MCP servers in
 * the registry and on MCP Tool nodes, HTTP and connector nodes. No traffic
 * is stored. Only hosts are read from URLs; paths, queries and credentials
 * never leave this module.
 *
 * Rows live in SQLite (migration 38). On Postgres the service is unavailable
 * and the routes answer 501.
 */

import { randomUUID } from "node:crypto";
import {
  BUILTIN_DESTINATIONS,
  dataDestinationInputSchema,
  destinationHostOfUrl,
  findUnclassifiedDestinations,
  getNodeDefinition,
  normalizeDataDestinationInput,
  normalizeDestinationHost,
  type ConfiguredDestination,
  type DataDestinationRow,
  type UnclassifiedDestination,
  type Workflow
} from "@ai-orchestrator/shared";
import { providerDefaultBaseUrl } from "@ai-orchestrator/provider-sdk";
import type { DataDestinationWrite, McpServerRecord, SqliteStore } from "../db/database.js";
import type { SafeUser } from "./auth-service.js";

export class DataDestinationError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DataDestinationError";
  }
}

/** Config keys that may hold the URL or host a connector talks to. */
const URL_KEYS = ["endpoint", "url", "baseUrl", "apiUrl", "serverUrl", "webhookUrl", "accountUrl", "instanceUrl", "uri", "urlTemplate", "host"];
/** Node types that make plain web requests: their destination is the host, not a connector type. */
const HTTP_NODE_TYPES = new Set(["http_request", "web_browse"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A host from a URL or bare host value; templated or unreadable values give nothing. */
function hostFrom(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return destinationHostOfUrl(text);
  return text.includes("{{") || text.includes("/") ? undefined : normalizeDestinationHost(text);
}

/** The first host found in a config object or one level below it (credentials and secret references are skipped). */
function configHost(config: Record<string, unknown>): string | undefined {
  for (const key of URL_KEYS) {
    const host = hostFrom(config[key]);
    if (host) return host;
  }
  for (const [key, value] of Object.entries(config)) {
    if (/secret|credential|password|token/i.test(key)) continue;
    const nested = record(value);
    if (!nested) continue;
    for (const inner of URL_KEYS) {
      const host = hostFrom(nested[inner]);
      if (host) return host;
    }
  }
  return undefined;
}

export interface CollectInput {
  workflows: ReadonlyArray<Pick<Workflow, "id" | "name" | "nodes">>;
  mcpServers: ReadonlyArray<Pick<McpServerRecord, "id" | "name" | "connection">>;
  env?: Record<string, string | undefined>;
}

/** Every place the configuration sends data to, with where it was seen. Pure. */
export function collectConfiguredDestinations(input: CollectInput): ConfiguredDestination[] {
  const out: ConfiguredDestination[] = [];
  const registryHosts = new Map<string, string | undefined>();
  for (const server of input.mcpServers) {
    const host = hostFrom(record(server.connection)?.endpoint);
    registryHosts.set(server.id, host);
    out.push({ ref: { kind: "mcp_server", id: server.id, ...(host ? { host } : {}) }, seenIn: `MCP server "${server.name}"` });
  }
  for (const workflow of input.workflows) {
    for (const node of workflow.nodes ?? []) {
      const config = record(node.config) ?? {};
      const seenIn = `Workflow "${workflow.name}" · ${node.name || node.id}`;
      const provider = record(config.provider);
      if (provider && typeof provider.providerId === "string" && provider.providerId.trim()) {
        const providerId = provider.providerId.trim();
        const host =
          hostFrom(provider.baseUrl) ?? hostFrom(record(provider.extra)?.endpoint) ?? hostFrom(providerDefaultBaseUrl(providerId, input.env ?? process.env));
        out.push({ ref: { kind: "model_provider", id: providerId, ...(host ? { host } : {}) }, seenIn });
        continue;
      }
      if (node.type === "azure_openai_chat_model") {
        const host = hostFrom(config.endpoint);
        out.push({ ref: { kind: "model_provider", id: "azure_openai", ...(host ? { host } : {}) }, seenIn });
        continue;
      }
      if (node.type === "mcp_tool") {
        const registryId = typeof config.registryServerId === "string" && config.registryServerId.trim() ? config.registryServerId.trim() : undefined;
        const host = (registryId ? registryHosts.get(registryId) : undefined) ?? hostFrom(record(config.connection)?.endpoint);
        if (registryId || host) out.push({ ref: { kind: "mcp_server", ...(registryId ? { id: registryId } : {}), ...(host ? { host } : {}) }, seenIn });
        continue;
      }
      if (HTTP_NODE_TYPES.has(node.type)) {
        const host = hostFrom(config.url) ?? hostFrom(config.urlTemplate);
        if (host) out.push({ ref: { kind: "http", host }, seenIn });
        continue;
      }
      if (getNodeDefinition(node.type)?.category === "Connector") {
        const host = configHost(config);
        out.push({ ref: { kind: "connector", id: node.type, ...(host ? { host } : {}) }, seenIn });
      }
    }
  }
  return out;
}

export interface DataDestinationServiceDeps {
  /** Null on Postgres: rows are SQLite only in this release. */
  store: SqliteStore | null;
  /** Workflow ids the user can read, or null for every workflow (admins). */
  readableWorkflowIds: (user: SafeUser) => string[] | null;
  /** Project ids the user can read, or null for every project (admins). */
  readableProjectIds: (user: SafeUser) => string[] | null;
  env?: Record<string, string | undefined>;
}

export interface DataDestinationListView {
  destinations: DataDestinationRow[];
  builtIns: DataDestinationRow[];
}

export class DataDestinationService {
  constructor(private readonly deps: DataDestinationServiceDeps) {}

  get available(): boolean {
    return this.deps.store !== null;
  }

  private get store(): SqliteStore {
    if (!this.deps.store) throw new DataDestinationError(501, "Data destinations need the SQLite store in this release");
    return this.deps.store;
  }

  list(): DataDestinationListView {
    return { destinations: this.store.listDataDestinations(), builtIns: [...BUILTIN_DESTINATIONS] };
  }

  /** Every admin row, for resolving destinations. */
  rows(): DataDestinationRow[] {
    return this.deps.store ? this.deps.store.listDataDestinations() : [];
  }

  private parse(body: unknown): DataDestinationWrite {
    const parsed = dataDestinationInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message }));
      throw new DataDestinationError(400, issues[0]?.message ?? "Invalid destination", { issues });
    }
    return normalizeDataDestinationInput(parsed.data);
  }

  private refuseBuiltIn(id: string): void {
    if (id.startsWith("builtin:") || BUILTIN_DESTINATIONS.some((row) => row.id === id)) {
      throw new DataDestinationError(400, "Built-in destinations are read-only; add a destination for the same host to override one");
    }
  }

  private refuseDuplicate(write: DataDestinationWrite, exceptId?: string): void {
    const existing = this.store.findDataDestinationByMatch(write.kind, write.targetId, write.host);
    if (existing && existing.id !== exceptId) {
      throw new DataDestinationError(409, `"${existing.name}" already classifies this destination; edit it instead`, { existingId: existing.id });
    }
  }

  create(body: unknown, actor: string | null): DataDestinationRow {
    const write = this.parse(body);
    this.refuseDuplicate(write);
    return this.store.insertDataDestination({ ...write, id: `dst_${randomUUID()}`, actor });
  }

  /** Returns the row before and after the change. */
  update(id: string, body: unknown, actor: string | null): { before: DataDestinationRow; after: DataDestinationRow } {
    this.refuseBuiltIn(id);
    const before = this.store.getDataDestination(id);
    if (!before) throw new DataDestinationError(404, "Destination not found");
    const write = this.parse(body);
    this.refuseDuplicate(write, id);
    const after = this.store.updateDataDestination(id, { ...write, actor });
    if (!after) throw new DataDestinationError(404, "Destination not found");
    return { before, after };
  }

  remove(id: string): DataDestinationRow {
    this.refuseBuiltIn(id);
    const before = this.store.getDataDestination(id);
    if (!before || !this.store.deleteDataDestination(id)) throw new DataDestinationError(404, "Destination not found");
    return before;
  }

  /**
   * Configured destinations no row covers (they count as public), from what
   * the user can read: their workflows, and MCP servers that are global or in
   * their projects.
   */
  unclassified(user: SafeUser): UnclassifiedDestination[] {
    const store = this.store;
    const readableWorkflows = this.deps.readableWorkflowIds(user);
    const readableProjects = this.deps.readableProjectIds(user);
    const workflowIds = readableWorkflows === null ? null : new Set(readableWorkflows);
    const projectIds = readableProjects === null ? null : new Set(readableProjects);
    const workflows = store
      .listWorkflows()
      .filter((item) => workflowIds === null || workflowIds.has(item.id))
      .map((item) => store.getWorkflow(item.id))
      .filter((workflow): workflow is Workflow => workflow !== null);
    const mcpServers = store.listMcpServers().filter((server) => projectIds === null || server.projectId === null || projectIds.has(server.projectId));
    const configured = collectConfiguredDestinations({ workflows, mcpServers, env: this.deps.env });
    return findUnclassifiedDestinations(configured, store.listDataDestinations());
  }
}
