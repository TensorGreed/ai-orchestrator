/**
 * Integration catalog: registered MCP servers' tools and stored OpenAPI specs' operations, offered in the palette.
 *
 *   GET    /api/catalog?projectId=                       palette entries for a project (builder)
 *   GET    /api/catalog/openapi-specs?projectId=         the project's specs (builder, project read)
 *   GET    /api/catalog/openapi-specs/:id                one spec with its operations (builder, project read)
 *   POST   /api/catalog/openapi-specs                    add a spec from a URL or a file's text (builder, project write)
 *   PATCH  /api/catalog/openapi-specs/:id                rename it or set its base URL (builder, project write)
 *   POST   /api/catalog/openapi-specs/:id/refresh        read it again from its URL, or from new text (builder, project write)
 *   DELETE /api/catalog/openapi-specs/:id                remove it (builder, project write)
 *
 * A spec is read through the outbound URL checks, at most OPENAPI_SPEC_MAX_BYTES, with a time limit. It never holds a
 * credential: nodes made from it pick a secret. MCP tools come from each server's last probe (its tool snapshot);
 * refreshing them is the server's probe. Nothing here calls a tool or an API operation.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  BodyTooLargeError,
  catalogEntryLabel,
  DEFAULT_PROJECT_ID,
  normalizeApiBaseUrl,
  OPENAPI_SPEC_MAX_BYTES,
  OpenApiSpecError,
  parseOpenApiDocument,
  readBodyCapped,
  type CatalogPaletteEntry,
  type CatalogSourceSummary,
  type OpenApiCatalog
} from "@ai-orchestrator/shared";
import type { McpServerRecord } from "./db/database.js";
import type { OpenApiSpecRecord, Store } from "./db/store.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";

/** How long reading a spec URL may take. */
export const OPENAPI_FETCH_TIMEOUT_MS = 15_000;
const MAX_NAME = 120;

export interface CatalogMcpTool {
  name: string;
  description?: string;
}

export interface IntegrationCatalogDeps {
  app: FastifyInstance;
  store: Store;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  can: (user: SafeUser, projectId: string, permission: "workflow:read" | "workflow:write") => Promise<boolean>;
  auditUser: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => Promise<void>;
  /** Fetch through the outbound URL checks (each redirect checked again). */
  fetchSpec: (url: string, init: RequestInit) => Promise<Response>;
  /** The server's tools from its last probe that this user may call in this project (tool policy applied). */
  listCallableMcpTools: (server: McpServerRecord, user: SafeUser, projectId: string) => Promise<CatalogMcpTool[]>;
  /** Servers the palette never offers (adapter ids of internal adapters). */
  hiddenAdapterIds?: ReadonlySet<string>;
}

const specCreateSchema = z
  .object({
    projectId: z.string().min(1).max(120).optional(),
    name: z.string().trim().max(MAX_NAME).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
    specText: z.string().min(1).max(OPENAPI_SPEC_MAX_BYTES).optional(),
    baseUrl: z.string().trim().max(2048).optional()
  })
  .strict()
  .refine((body) => Boolean(body.url) !== Boolean(body.specText), { message: "Give either url or specText." });

const specPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME).optional(),
    baseUrl: z.string().trim().max(2048).optional()
  })
  .strict();

const specRefreshSchema = z.object({ specText: z.string().min(1).max(OPENAPI_SPEC_MAX_BYTES).optional() }).strict();

/** Reads a spec's text as JSON, else YAML (anchors and aliases limited). */
export function parseSpecText(text: string, sourceUrl?: string): OpenApiCatalog {
  if (Buffer.byteLength(text, "utf8") > OPENAPI_SPEC_MAX_BYTES) {
    throw new OpenApiSpecError(`The spec is larger than ${Math.round(OPENAPI_SPEC_MAX_BYTES / 1024 / 1024)} MB.`);
  }
  let document: unknown;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw new OpenApiSpecError(`The spec is not valid JSON: ${error instanceof Error ? error.message.slice(0, 200) : "parse error"}.`);
    }
  } else {
    try {
      document = parseYaml(text, { maxAliasCount: 100, prettyErrors: false, uniqueKeys: false });
    } catch (error) {
      throw new OpenApiSpecError(`The spec is neither JSON nor YAML: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "parse error"}.`);
    }
  }
  return parseOpenApiDocument(document, sourceUrl ? { sourceUrl } : {});
}

function checkSpecUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenApiSpecError("The spec URL is not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new OpenApiSpecError("The spec URL must start with http:// or https://.");
  if (url.username || url.password) throw new OpenApiSpecError("The spec URL must not contain a user name or password.");
  url.hash = "";
  return url.toString();
}

/** The URL without its query, for messages and the stored record's display. */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "the URL";
  }
}

export function specView(record: OpenApiSpecRecord, options: { operations: boolean }) {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    sourceUrl: record.sourceUrl,
    baseUrl: record.baseUrl,
    title: record.catalog.title,
    version: record.catalog.version,
    operationCount: record.operationCount,
    warnings: record.catalog.warnings,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    fetchedAt: record.fetchedAt,
    ...(options.operations ? { operations: record.catalog.operations } : {})
  };
}

export function registerIntegrationCatalogRoutes(deps: IntegrationCatalogDeps): void {
  const { app, store } = deps;

  const projectOf = (raw: unknown): string => (typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_PROJECT_ID);

  const allowed = async (user: SafeUser, projectId: string, permission: "workflow:read" | "workflow:write") =>
    user.role === "admin" || (await deps.can(user, projectId, permission));

  /** Reads a spec URL: outbound checks, a time limit and a size cap. */
  const readSpecUrl = async (url: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAPI_FETCH_TIMEOUT_MS);
    try {
      const response = await deps.fetchSpec(url, {
        method: "GET",
        headers: { Accept: "application/json, application/yaml, text/yaml, */*;q=0.5" },
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new OpenApiSpecError(`Could not read the spec from ${displayUrl(url)}: the server answered ${response.status}.`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > OPENAPI_SPEC_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new OpenApiSpecError(`The spec at ${displayUrl(url)} is larger than ${Math.round(OPENAPI_SPEC_MAX_BYTES / 1024 / 1024)} MB.`);
      }
      const bytes = await readBodyCapped(response, OPENAPI_SPEC_MAX_BYTES, { maxExpansion: 50 });
      return new TextDecoder().decode(bytes);
    } catch (error) {
      if (error instanceof OpenApiSpecError) throw error;
      if (error instanceof BodyTooLargeError) {
        throw new OpenApiSpecError(`The spec at ${displayUrl(url)} is larger than ${Math.round(OPENAPI_SPEC_MAX_BYTES / 1024 / 1024)} MB.`);
      }
      if (controller.signal.aborted) throw new OpenApiSpecError(`Reading the spec from ${displayUrl(url)} took longer than ${OPENAPI_FETCH_TIMEOUT_MS / 1000} seconds.`);
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenApiSpecError(`Could not read the spec from ${displayUrl(url)}: ${message.slice(0, 300)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof OpenApiSpecError) {
      reply.code(400);
      return { error: error.message };
    }
    throw error;
  };

  /** The spec, when this user may use its project with this permission (404 otherwise, as for a missing one). */
  const specFor = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    user: SafeUser,
    permission: "workflow:read" | "workflow:write"
  ): Promise<OpenApiSpecRecord | null> => {
    const record = await store.getOpenApiSpec(request.params.id);
    if (!record || !(await allowed(user, record.projectId, "workflow:read"))) {
      reply.code(404);
      return null;
    }
    if (permission === "workflow:write" && !(await allowed(user, record.projectId, "workflow:write"))) {
      reply.code(403);
      return null;
    }
    return record;
  };

  app.get("/api/catalog", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const projectId = projectOf((request.query as { projectId?: unknown } | undefined)?.projectId);
    if (!(await allowed(user, projectId, "workflow:read"))) {
      reply.code(403);
      return { error: "Insufficient permissions for project" };
    }
    const entries: CatalogPaletteEntry[] = [];
    const sources: CatalogSourceSummary[] = [];
    for (const server of await store.listMcpServers({ projectId })) {
      if (deps.hiddenAdapterIds?.has(server.adapterId)) continue;
      const tools = await deps.listCallableMcpTools(server, user, projectId);
      sources.push({ kind: "mcp_server", id: server.id, name: server.name, itemCount: tools.length, refreshedAt: server.lastProbeAt ?? null, projectId: server.projectId ?? null });
      for (const tool of tools) {
        entries.push({
          key: `mcp:${server.id}:${tool.name}`,
          kind: "mcp_tool",
          label: catalogEntryLabel(server.name, tool.name),
          description: (tool.description ?? "").slice(0, 300),
          sourceName: server.name,
          sourceId: server.id,
          itemId: tool.name
        });
      }
    }
    for (const spec of await store.listOpenApiSpecs(projectId)) {
      sources.push({ kind: "openapi_spec", id: spec.id, name: spec.name, itemCount: spec.operationCount, refreshedAt: spec.fetchedAt, sourceUrl: spec.sourceUrl, projectId: spec.projectId });
      for (const operation of spec.catalog.operations) {
        entries.push({
          key: `openapi:${spec.id}:${operation.id}`,
          kind: "openapi_operation",
          label: catalogEntryLabel(spec.name, operation.summary || operation.id),
          description: `${operation.method} ${operation.path}${operation.description ? ` — ${operation.description.split(/\r?\n/)[0]!.slice(0, 200)}` : ""}`,
          sourceName: spec.name,
          sourceId: spec.id,
          itemId: operation.id
        });
      }
    }
    return { projectId, entries, sources };
  });

  app.get("/api/catalog/openapi-specs", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const projectId = projectOf((request.query as { projectId?: unknown } | undefined)?.projectId);
    if (!(await allowed(user, projectId, "workflow:read"))) {
      reply.code(403);
      return { error: "Insufficient permissions for project" };
    }
    return { specs: (await store.listOpenApiSpecs(projectId)).map((spec) => specView(spec, { operations: false })) };
  });

  app.get<{ Params: { id: string } }>("/api/catalog/openapi-specs/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const record = await specFor(request, reply, user, "workflow:read");
    if (!record) return { error: "OpenAPI spec not found" };
    return { spec: specView(record, { operations: true }) };
  });

  app.post<{ Body: unknown }>("/api/catalog/openapi-specs", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = specCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid OpenAPI spec payload", details: parsed.error.issues };
    }
    const projectId = projectOf(parsed.data.projectId);
    if (!(await allowed(user, projectId, "workflow:write"))) {
      reply.code(403);
      return { error: "Insufficient permissions to add APIs to this project" };
    }
    try {
      const sourceUrl = parsed.data.url ? checkSpecUrl(parsed.data.url) : null;
      const specText = sourceUrl ? await readSpecUrl(sourceUrl) : parsed.data.specText!;
      const catalog = parseSpecText(specText, sourceUrl ?? undefined);
      const baseUrl = parsed.data.baseUrl ? normalizeApiBaseUrl(parsed.data.baseUrl) : catalog.baseUrl;
      const record = await store.saveOpenApiSpec({
        id: `oas_${crypto.randomUUID()}`,
        projectId,
        name: parsed.data.name || catalog.title,
        sourceUrl,
        baseUrl,
        specText,
        catalog,
        createdBy: user.email
      });
      await deps.auditUser(request, user, {
        category: "project",
        eventType: "openapi_spec.created",
        action: "create",
        outcome: "success",
        resourceType: "openapi_spec",
        resourceId: record.id,
        projectId,
        metadata: { name: record.name, operations: record.operationCount, source: sourceUrl ? displayUrl(sourceUrl) : "upload" }
      });
      reply.code(201);
      return { spec: specView(record, { operations: false }) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/catalog/openapi-specs/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = specPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid OpenAPI spec payload", details: parsed.error.issues };
    }
    const record = await specFor(request, reply, user, "workflow:write");
    if (!record) return { error: reply.statusCode === 403 ? "Insufficient permissions to change APIs in this project" : "OpenAPI spec not found" };
    try {
      const baseUrl =
        parsed.data.baseUrl === undefined ? record.baseUrl : parsed.data.baseUrl === "" ? record.catalog.baseUrl : normalizeApiBaseUrl(parsed.data.baseUrl);
      const specText = (await store.getOpenApiSpecText(record.id)) ?? "";
      const saved = await store.saveOpenApiSpec({
        id: record.id,
        projectId: record.projectId,
        name: parsed.data.name ?? record.name,
        sourceUrl: record.sourceUrl,
        baseUrl,
        specText,
        catalog: record.catalog,
        createdBy: record.createdBy
      });
      await deps.auditUser(request, user, {
        category: "project",
        eventType: "openapi_spec.updated",
        action: "update",
        outcome: "success",
        resourceType: "openapi_spec",
        resourceId: saved.id,
        projectId: saved.projectId,
        metadata: { name: saved.name, baseUrlChanged: baseUrl !== record.baseUrl }
      });
      return { spec: specView(saved, { operations: false }) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/catalog/openapi-specs/:id/refresh", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = specRefreshSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid refresh payload", details: parsed.error.issues };
    }
    const record = await specFor(request, reply, user, "workflow:write");
    if (!record) return { error: reply.statusCode === 403 ? "Insufficient permissions to change APIs in this project" : "OpenAPI spec not found" };
    try {
      if (!record.sourceUrl && !parsed.data.specText) throw new OpenApiSpecError("This spec was uploaded. Upload the new file to refresh it.");
      const specText = parsed.data.specText ?? (await readSpecUrl(record.sourceUrl!));
      const catalog = parseSpecText(specText, record.sourceUrl ?? undefined);
      // A base URL someone set stays; one that came from the spec follows the spec.
      const baseUrl = record.baseUrl && record.baseUrl !== record.catalog.baseUrl ? record.baseUrl : catalog.baseUrl;
      const saved = await store.saveOpenApiSpec({
        id: record.id,
        projectId: record.projectId,
        name: record.name,
        sourceUrl: parsed.data.specText ? null : record.sourceUrl,
        baseUrl,
        specText,
        catalog,
        createdBy: record.createdBy
      });
      const before = new Set(record.catalog.operations.map((operation) => operation.id));
      const after = new Set(catalog.operations.map((operation) => operation.id));
      const removed = [...before].filter((id) => !after.has(id));
      await deps.auditUser(request, user, {
        category: "project",
        eventType: "openapi_spec.refreshed",
        action: "update",
        outcome: "success",
        resourceType: "openapi_spec",
        resourceId: saved.id,
        projectId: saved.projectId,
        metadata: { operations: saved.operationCount, removed: removed.length }
      });
      return { spec: specView(saved, { operations: false }), added: [...after].filter((id) => !before.has(id)), removed };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/catalog/openapi-specs/:id", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const record = await specFor(request, reply, user, "workflow:write");
    if (!record) return { error: reply.statusCode === 403 ? "Insufficient permissions to change APIs in this project" : "OpenAPI spec not found" };
    await store.deleteOpenApiSpec(record.id);
    await deps.auditUser(request, user, {
      category: "project",
      eventType: "openapi_spec.deleted",
      action: "delete",
      outcome: "success",
      resourceType: "openapi_spec",
      resourceId: record.id,
      projectId: record.projectId,
      metadata: { name: record.name }
    });
    return { ok: true };
  });
}
