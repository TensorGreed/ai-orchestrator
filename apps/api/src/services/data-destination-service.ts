/**
 * Phase 16 — data destinations: the admin rows that say how far each place
 * outgoing data can go is from home (local, private, vendor, public), and
 * the "not classified yet" list.
 *
 * The list is derived from configuration only: model providers set on
 * workflow nodes (their base URL, or the adapter's default), MCP servers in
 * the registry and on MCP Tool nodes, HTTP and connector nodes, in each
 * workflow's draft and its published version. Disabled nodes and providers
 * that send nothing over the network are skipped. No traffic
 * is stored. Only hosts are read from URLs; paths, queries and credentials
 * never leave this module.
 *
 * Rows live in SQLite (migration 38). On Postgres the service is unavailable
 * and the routes answer 501.
 */

import { randomUUID } from "node:crypto";
import {
  BUILTIN_DESTINATIONS,
  chatModelDestinationOf,
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
import { PROVIDERS_WITH_FIXED_HOST, PROVIDERS_WITHOUT_NETWORK, providerDefaultBaseUrl } from "@ai-orchestrator/provider-sdk";
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

/** A non-empty string setting, trimmed; undefined when the setting is absent or blank. */
function setting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Where a provider node sends its calls: `null` for a provider that sends
 * nothing over the network, otherwise the host (undefined when the base URL
 * is set but cannot be read, such as a template: the real host is unknown, so
 * the default is never assumed).
 */
function providerHost(providerId: string, provider: Record<string, unknown>, env: Record<string, string | undefined>): string | undefined | null {
  if (PROVIDERS_WITHOUT_NETWORK.has(providerId)) return null;
  if (PROVIDERS_WITH_FIXED_HOST.has(providerId)) return hostFrom(providerDefaultBaseUrl(providerId, env));
  const configured =
    setting(provider.baseUrl) ??
    (providerId === "azure_openai" ? setting(record(provider.extra)?.endpoint) ?? setting(env.AZURE_OPENAI_ENDPOINT) : undefined);
  if (configured !== undefined) return hostFrom(configured);
  return hostFrom(providerDefaultBaseUrl(providerId, env));
}

type CollectWorkflow = Pick<Workflow, "id" | "name" | "nodes"> & {
  /** The published version's nodes, when one is published. */
  published?: Pick<Workflow, "nodes"> | null;
};

export interface CollectInput {
  workflows: ReadonlyArray<CollectWorkflow>;
  mcpServers: ReadonlyArray<Pick<McpServerRecord, "id" | "name" | "connection">>;
  env?: Record<string, string | undefined>;
}

function refKey(ref: ConfiguredDestination["ref"]): string {
  return `${ref.kind}\u0000${ref.id ?? ""}\u0000${ref.host ?? ""}`;
}

function collectNodes(
  nodes: Workflow["nodes"] | undefined,
  label: (nodeName: string) => string,
  registryHosts: ReadonlyMap<string, string | undefined>,
  env: Record<string, string | undefined>
): ConfiguredDestination[] {
  const out: ConfiguredDestination[] = [];
  for (const node of nodes ?? []) {
    if (node.disabled) continue;
    const config = record(node.config) ?? {};
    const seenIn = label(node.name || node.id);
    const provider = record(config.provider);
    if (provider && typeof provider.providerId === "string" && provider.providerId.trim()) {
      const providerId = provider.providerId.trim();
      const host = providerHost(providerId, provider, env);
      if (host === null) continue;
      out.push({ ref: { kind: "model_provider", id: providerId, ...(host ? { host } : {}) }, seenIn });
      continue;
    }
    const chatModel = chatModelDestinationOf(node);
    if (chatModel) {
      const host = providerHost(chatModel.providerId, { baseUrl: chatModel.baseUrl }, env);
      if (host === null) continue;
      out.push({ ref: { kind: "model_provider", id: chatModel.providerId, ...(host ? { host } : {}) }, seenIn });
      continue;
    }
    if (node.type === "azure_openai_chat_model") {
      const configured = setting(config.endpoint) ?? setting(env.AZURE_OPENAI_ENDPOINT);
      const host = configured !== undefined ? hostFrom(configured) : undefined;
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
  return out;
}

/**
 * Every place the configuration sends data to, with where it was seen. Pure.
 * A workflow's published version adds only what its draft does not already
 * send to, marked "(published)".
 */
export function collectConfiguredDestinations(input: CollectInput): ConfiguredDestination[] {
  const env = input.env ?? process.env;
  const out: ConfiguredDestination[] = [];
  const registryHosts = new Map<string, string | undefined>();
  for (const server of input.mcpServers) {
    const host = hostFrom(record(server.connection)?.endpoint);
    registryHosts.set(server.id, host);
    out.push({ ref: { kind: "mcp_server", id: server.id, ...(host ? { host } : {}) }, seenIn: `MCP server "${server.name}"` });
  }
  for (const workflow of input.workflows) {
    const draft = collectNodes(workflow.nodes, (node) => `Workflow "${workflow.name}" · ${node}`, registryHosts, env);
    out.push(...draft);
    if (!workflow.published) continue;
    const inDraft = new Set(draft.map((entry) => refKey(entry.ref)));
    for (const entry of collectNodes(workflow.published.nodes, (node) => `Workflow "${workflow.name}" (published) · ${node}`, registryHosts, env)) {
      if (!inDraft.has(refKey(entry.ref))) out.push(entry);
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
    const parse = (json: string | null): Workflow | null => {
      if (!json) return null;
      try {
        return JSON.parse(json) as Workflow;
      } catch {
        return null;
      }
    };
    // One query for every workflow's draft and published JSON (no per-workflow loads).
    const workflows: CollectWorkflow[] = [];
    for (const item of store.listWorkflowConfigsForDestinations()) {
      if (workflowIds !== null && !workflowIds.has(item.id)) continue;
      const draft = parse(item.draftJson);
      if (!draft) continue;
      workflows.push({ id: item.id, name: item.name, nodes: draft.nodes ?? [], published: parse(item.publishedJson) });
    }
    const mcpServers = store.listMcpServers().filter((server) => projectIds === null || server.projectId === null || projectIds.has(server.projectId));
    const configured = collectConfiguredDestinations({ workflows, mcpServers, env: this.deps.env });
    return findUnclassifiedDestinations(configured, store.listDataDestinations());
  }
}
