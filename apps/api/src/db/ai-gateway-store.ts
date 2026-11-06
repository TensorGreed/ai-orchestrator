/**
 * 12.6b — the AI gateway's part of the Store contract (route sets, routes, client grants, per-request usage), and the
 * row mapping both stores share. SQLite: ai-gateway-sqlite.ts; Postgres: postgres/ai-gateway.ts.
 */
import {
  AI_GATEWAY_REQUEST_STATUSES,
  parseStoredGatewayRateLimit,
  type AiGatewayGuardOutcome,
  type AiGatewayRequestRecord,
  type AiGatewayRequestStatus,
  type AiGatewayRoute,
  type AiGatewayRouteDefaults,
  type AiGatewayRouteKind,
  type AiGatewayRouteSet,
  type AiGatewayUsageTotals,
  type McpGatewayRateLimit
} from "@ai-orchestrator/shared";

export interface AiGatewayRouteSetWrite {
  name: string;
  description: string;
  projectId: string | null;
  enabled: boolean;
  rateLimit: McpGatewayRateLimit | null;
}

export interface AiGatewayRouteWrite {
  alias: string;
  kind: AiGatewayRouteKind;
  providerId: string;
  model: string;
  baseUrl: string | null;
  secretId: string | null;
  extra: Record<string, unknown>;
  defaults: AiGatewayRouteDefaults;
  enabled: boolean;
}

/** A route a client may call, with its set: what one `/v1` request resolves to. */
export interface AiGatewayResolvedRoute {
  route: AiGatewayRoute;
  routeSet: AiGatewayRouteSet;
}

export interface AiGatewayUsageFilter {
  from: string;
  clientId?: string;
  routeSetId?: string;
}

/** The alias is taken by another route (aliases are unique across the deployment). */
export class AiGatewayAliasTakenError extends Error {
  readonly statusCode = 409;
  constructor(readonly alias: string) {
    super(`The model name '${alias}' is already used by another route.`);
    this.name = "AiGatewayAliasTakenError";
  }
}

export interface AiGatewayStore {
  listAiGatewayRouteSets(): Promise<AiGatewayRouteSet[]>;
  getAiGatewayRouteSet(id: string): Promise<AiGatewayRouteSet | null>;
  createAiGatewayRouteSet(input: AiGatewayRouteSetWrite & { id: string; createdBy: string | null }): Promise<AiGatewayRouteSet>;
  updateAiGatewayRouteSet(id: string, patch: Partial<AiGatewayRouteSetWrite>): Promise<AiGatewayRouteSet | null>;
  /** Deletes the set, its routes and every client's grant of it. False when it does not exist. */
  deleteAiGatewayRouteSet(id: string): Promise<boolean>;
  /** Routes of one set, or of every set; ordered by alias. */
  listAiGatewayRoutes(routeSetId?: string): Promise<AiGatewayRoute[]>;
  getAiGatewayRoute(id: string): Promise<AiGatewayRoute | null>;
  /** Throws AiGatewayAliasTakenError when another route has the alias. */
  createAiGatewayRoute(input: AiGatewayRouteWrite & { id: string; routeSetId: string; createdBy: string | null }): Promise<AiGatewayRoute>;
  /** Throws AiGatewayAliasTakenError when another route has the new alias. */
  updateAiGatewayRoute(id: string, patch: Partial<AiGatewayRouteWrite>): Promise<AiGatewayRoute | null>;
  deleteAiGatewayRoute(id: string): Promise<boolean>;
  /** The route sets granted to a client, in grant order. */
  listAiGatewayClientGrants(clientId: string): Promise<string[]>;
  /** Replaces the client's grants as a whole; returns them. */
  setAiGatewayClientGrants(clientId: string, routeSetIds: string[], createdBy: string | null): Promise<string[]>;
  /** Every grant: client id -> route set ids (the admin views). */
  listAllAiGatewayClientGrants(): Promise<Array<{ clientId: string; routeSetId: string }>>;
  /**
   * The request path (one read): the enabled route named `alias` in an enabled set granted to the client, or null
   * (unknown, not granted, or disabled: the caller answers the same 404 for each).
   */
  resolveAiGatewayRoute(clientId: string, alias: string): Promise<AiGatewayResolvedRoute | null>;
  /** The enabled routes of the enabled sets granted to a client (GET /v1/models), ordered by alias. */
  listAiGatewayRoutesForClient(clientId: string): Promise<AiGatewayResolvedRoute[]>;
  /** Records one request's metadata (A5: never prompts or answers). */
  insertAiGatewayRequest(record: AiGatewayRequestRecord): Promise<void>;
  /** Most recent first. */
  listAiGatewayRequests(filter: AiGatewayUsageFilter & { limit: number }): Promise<AiGatewayRequestRecord[]>;
  /** Totals since `from`, overall, per alias and per client. */
  summarizeAiGatewayUsage(filter: AiGatewayUsageFilter): Promise<{
    totals: AiGatewayUsageTotals;
    byAlias: Array<AiGatewayUsageTotals & { alias: string; providerId: string; model: string }>;
    byClient: Array<AiGatewayUsageTotals & { clientId: string }>;
  }>;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : text(value));
const num = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : text(value));
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function routeDefaults(value: unknown): AiGatewayRouteDefaults {
  const raw = jsonObject(value);
  const out: AiGatewayRouteDefaults = {};
  if (typeof raw.temperature === "number") out.temperature = raw.temperature;
  if (typeof raw.maxTokens === "number") out.maxTokens = raw.maxTokens;
  if (typeof raw.topP === "number") out.topP = raw.topP;
  return out;
}

export function mapAiGatewayRouteSetRow(row: Row, prefix = ""): AiGatewayRouteSet {
  const at = (column: string) => row[`${prefix}${column}`];
  return {
    id: text(at("id")),
    name: text(at("name")),
    description: text(at("description")),
    projectId: textOrNull(at("project_id")),
    enabled: num(at("enabled")) === 1,
    rateLimit: parseStoredGatewayRateLimit(at("rate_limit_json") ?? null),
    createdBy: textOrNull(at("created_by")),
    createdAt: iso(at("created_at")),
    updatedAt: iso(at("updated_at"))
  };
}

export function mapAiGatewayRouteRow(row: Row): AiGatewayRoute {
  const secretId = textOrNull(row.secret_id);
  return {
    id: text(row.id),
    routeSetId: text(row.route_set_id),
    alias: text(row.alias),
    kind: row.kind === "embedding" ? "embedding" : "chat",
    providerId: text(row.provider_id),
    model: text(row.model),
    baseUrl: textOrNull(row.base_url),
    secretRef: secretId ? { secretId } : null,
    extra: jsonObject(row.extra_json),
    defaults: routeDefaults(row.defaults_json),
    enabled: num(row.enabled) === 1,
    createdBy: textOrNull(row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export function mapAiGatewayRequestRow(row: Row): AiGatewayRequestRecord {
  const status = text(row.status);
  const guard = text(row.guard_outcome);
  return {
    id: text(row.id),
    createdAt: iso(row.created_at),
    clientId: text(row.client_id),
    routeSetId: text(row.route_set_id),
    routeId: text(row.route_id),
    projectId: textOrNull(row.project_id),
    alias: text(row.alias),
    kind: row.kind === "embedding" ? "embedding" : "chat",
    providerId: text(row.provider_id),
    model: text(row.model),
    stream: num(row.stream) === 1,
    status: (AI_GATEWAY_REQUEST_STATUSES as readonly string[]).includes(status) ? (status as AiGatewayRequestStatus) : "error",
    httpStatus: num(row.http_status),
    finishReason: textOrNull(row.finish_reason),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cachedInputTokens: num(row.cached_input_tokens),
    totalTokens: num(row.total_tokens),
    usageEstimated: num(row.usage_estimated) === 1,
    costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : num(row.cost_usd),
    latencyMs: num(row.latency_ms),
    guardOutcome: (["none", "allow", "rewrite", "block"] as const).includes(guard as AiGatewayGuardOutcome) ? (guard as AiGatewayGuardOutcome) : "none",
    errorCode: textOrNull(row.error_code)
  };
}

/** The aggregate columns both stores select (same names), as totals. */
export const AI_GATEWAY_TOTALS_SQL = `COUNT(*) AS requests,
  SUM(CASE WHEN status IN ('upstream_error', 'error') THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN status IN ('blocked_prompt', 'blocked_output') THEN 1 ELSE 0 END) AS blocked,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(total_tokens) AS total_tokens,
  SUM(COALESCE(cost_usd, 0)) AS cost_usd,
  MAX(created_at) AS last_request_at`;

export function mapAiGatewayTotals(row: Row | null | undefined): AiGatewayUsageTotals {
  return {
    requests: num(row?.requests),
    errors: num(row?.errors),
    blocked: num(row?.blocked),
    inputTokens: num(row?.input_tokens),
    outputTokens: num(row?.output_tokens),
    totalTokens: num(row?.total_tokens),
    costUsd: Math.round(num(row?.cost_usd) * 1_000_000) / 1_000_000,
    lastRequestAt: isoOrNull(row?.last_request_at)
  };
}

/** The values of a request row, in the column order of AI_GATEWAY_REQUEST_COLUMNS. */
export const AI_GATEWAY_REQUEST_COLUMNS = [
  "id",
  "created_at",
  "client_id",
  "route_set_id",
  "route_id",
  "project_id",
  "alias",
  "kind",
  "provider_id",
  "model",
  "stream",
  "status",
  "http_status",
  "finish_reason",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "total_tokens",
  "usage_estimated",
  "cost_usd",
  "latency_ms",
  "guard_outcome",
  "error_code"
] as const;

export function aiGatewayRequestValues(record: AiGatewayRequestRecord): unknown[] {
  return [
    record.id,
    record.createdAt,
    record.clientId,
    record.routeSetId,
    record.routeId,
    record.projectId,
    record.alias,
    record.kind,
    record.providerId,
    record.model,
    record.stream ? 1 : 0,
    record.status,
    record.httpStatus,
    record.finishReason,
    Math.max(0, Math.round(record.inputTokens)),
    Math.max(0, Math.round(record.outputTokens)),
    Math.max(0, Math.round(record.cachedInputTokens)),
    Math.max(0, Math.round(record.totalTokens)),
    record.usageEstimated ? 1 : 0,
    record.costUsd,
    Math.max(0, Math.round(record.latencyMs)),
    record.guardOutcome,
    record.errorCode
  ];
}
