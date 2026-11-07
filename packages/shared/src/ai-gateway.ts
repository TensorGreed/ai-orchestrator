import { z } from "zod";
import { mcpGatewayRateLimitSchema, type McpGatewayRateLimit } from "./gateway-limits";

/**
 * 12.6b — the OpenAI-compatible `/v1` AI gateway.
 *
 * Admins define routes: a public model name (`alias`) that maps to a provider, an upstream model, an optional base URL
 * and a stored secret (by id only). Routes are grouped in route sets, each owned by a project (budgets, model
 * allowlists, the project rule set floor and usage attribution follow it), and route sets are granted to MCP gateway
 * clients beside their toolsets: one token, one Governance panel. Nothing answers on `/v1` until an admin creates a
 * route set and grants it to a client.
 */

export const AI_GATEWAY_ROUTE_KINDS = ["chat", "embedding"] as const;
export type AiGatewayRouteKind = (typeof AI_GATEWAY_ROUTE_KINDS)[number];

/** The most route sets and routes one deployment or set may hold, and the grants one client may have. */
export const AI_GATEWAY_LIMITS = { routeSets: 500, routesPerSet: 200, grantsPerClient: 50 } as const;

/**
 * A public model name: what callers send as `model`. Unique across the deployment, so a name means one route.
 * Letters, digits and `. _ : / -`, starting with a letter or digit.
 */
export const aiGatewayAliasSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Use letters, digits and . _ : / - (starting with a letter or digit)");

/** Defaults a route applies when the request does not set them. */
export interface AiGatewayRouteDefaults {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export const aiGatewayRouteDefaultsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(1_000_000).optional(),
    topP: z.number().min(0).max(1).optional()
  })
  .strict();

/** `extra` keys that would carry a credential: credentials go through a stored secret (`secretRef`) only. */
const CREDENTIAL_EXTRA_KEYS = new Set(["apikey", "api_key", "key", "token", "accesstoken", "access_token", "authorization", "password", "secret"]);

export const aiGatewayRouteExtraSchema = z
  .record(z.string().min(1).max(64), z.unknown())
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (CREDENTIAL_EXTRA_KEYS.has(key.toLowerCase())) {
        ctx.addIssue({ code: "custom", path: [key], message: "Credentials go in a stored secret (secretRef), not in extra" });
      }
    }
    if (JSON.stringify(value).length > 8_000) ctx.addIssue({ code: "custom", message: "extra is limited to 8000 characters of JSON" });
  });

export interface AiGatewayRoute {
  id: string;
  routeSetId: string;
  alias: string;
  kind: AiGatewayRouteKind;
  providerId: string;
  /** The upstream model (Azure OpenAI: the deployment name). */
  model: string;
  baseUrl: string | null;
  /** The stored secret holding the provider key, by id; null = the provider's environment key, or none. */
  secretRef: { secretId: string } | null;
  /** Adapter settings (Azure `apiVersion`, `timeoutMs`, `streamUsage: false` for servers without stream usage). */
  extra: Record<string, unknown>;
  defaults: AiGatewayRouteDefaults;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiGatewayRouteSet {
  id: string;
  name: string;
  description: string;
  /** The project that owns the set: its budgets and model allowlist apply, and its enforced rule set on top of a bound one. Null = deployment only. */
  projectId: string | null;
  enabled: boolean;
  /** The default rate limit for each client of the set (a client's own limit replaces it). */
  rateLimit: McpGatewayRateLimit | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const aiGatewayRouteSetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    projectId: z.string().trim().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    rateLimit: mcpGatewayRateLimitSchema.nullable().optional()
  })
  .strict();

export const aiGatewayRouteSetUpdateSchema = aiGatewayRouteSetInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "Empty update payload" });

export const aiGatewayRouteInputSchema = z
  .object({
    alias: aiGatewayAliasSchema,
    kind: z.enum(AI_GATEWAY_ROUTE_KINDS).optional(),
    providerId: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(256),
    baseUrl: z.string().trim().url().max(2048).nullable().optional(),
    secretRef: z.object({ secretId: z.string().trim().min(1) }).strict().nullable().optional(),
    extra: aiGatewayRouteExtraSchema.optional(),
    defaults: aiGatewayRouteDefaultsSchema.optional(),
    enabled: z.boolean().optional()
  })
  .strict();

export const aiGatewayRouteUpdateSchema = aiGatewayRouteInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "Empty update payload" });

/** The route sets a client may call (replaces the client's grants as a whole). */
export const aiGatewayGrantsInputSchema = z
  .object({ routeSetIds: z.array(z.string().trim().min(1)).max(AI_GATEWAY_LIMITS.grantsPerClient) })
  .strict();

/** How a request ended, for usage rows. */
export const AI_GATEWAY_REQUEST_STATUSES = ["ok", "blocked_prompt", "blocked_output", "upstream_error", "client_closed", "error"] as const;
export type AiGatewayRequestStatus = (typeof AI_GATEWAY_REQUEST_STATUSES)[number];

/** What Content rules did on a request: nothing applied, allowed, rewrote, or blocked (the prompt or the answer). */
export type AiGatewayGuardOutcome = "none" | "allow" | "rewrite" | "block";

/**
 * 12.6b (A5, A11) — one `/v1` request that reached content rules or the provider: metadata only, never prompts or answers.
 * Counted by budgets (client, the route set's project, global).
 */
export interface AiGatewayRequestRecord {
  id: string;
  createdAt: string;
  clientId: string;
  routeSetId: string;
  routeId: string;
  /** The route set's project when the request was made. */
  projectId: string | null;
  alias: string;
  kind: AiGatewayRouteKind;
  providerId: string;
  model: string;
  stream: boolean;
  status: AiGatewayRequestStatus;
  httpStatus: number;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  /** The provider gave no usage (or only part of it): the tokens and cost are the gateway's estimate, leaning high. */
  usageEstimated: boolean;
  /** Null when the model has no price in the pricing table. */
  costUsd: number | null;
  latencyMs: number;
  guardOutcome: AiGatewayGuardOutcome;
  errorCode: string | null;
}

export interface AiGatewayUsageTotals {
  requests: number;
  errors: number;
  blocked: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  lastRequestAt: string | null;
}

export interface AiGatewayUsageSummary {
  window: string;
  totals: AiGatewayUsageTotals;
  byAlias: Array<AiGatewayUsageTotals & { alias: string; providerId: string; model: string }>;
  byClient: Array<AiGatewayUsageTotals & { clientId: string }>;
}

// ---------------------------------------------------------------------------
// The OpenAI wire format (requests). Unknown fields are ignored, as OpenAI clients add new ones over time.
// ---------------------------------------------------------------------------

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const imagePartSchema = z
  .object({ type: z.literal("image_url"), image_url: z.union([z.string(), z.object({ url: z.string(), detail: z.string().optional() }).passthrough()]) })
  .passthrough();
const contentPartSchema = z.union([textPartSchema, imagePartSchema, z.object({ type: z.string() }).passthrough()]);
const messageContentSchema = z.union([z.string(), z.array(contentPartSchema), z.null()]);

const toolCallSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("function").optional(),
    function: z.object({ name: z.string().min(1).max(256), arguments: z.string() }).passthrough()
  })
  .passthrough();

export const openAiChatMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: messageContentSchema, name: z.string().optional() }).passthrough(),
  z.object({ role: z.literal("developer"), content: messageContentSchema, name: z.string().optional() }).passthrough(),
  z.object({ role: z.literal("user"), content: messageContentSchema, name: z.string().optional() }).passthrough(),
  z
    .object({
      role: z.literal("assistant"),
      content: messageContentSchema.optional(),
      name: z.string().optional(),
      tool_calls: z.array(toolCallSchema).max(128).optional(),
      refusal: z.string().nullable().optional()
    })
    .passthrough(),
  z.object({ role: z.literal("tool"), content: messageContentSchema, tool_call_id: z.string().min(1).max(256) }).passthrough()
]);
export type OpenAiChatMessage = z.infer<typeof openAiChatMessageSchema>;

const stopSchema = z.union([z.string(), z.array(z.string()).max(4)]).nullable();

export const openAiChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(openAiChatMessageSchema).min(1).max(2048),
    stream: z.boolean().nullable().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    top_p: z.number().min(0).max(1).nullable().optional(),
    max_tokens: z.number().int().min(1).nullable().optional(),
    max_completion_tokens: z.number().int().min(1).nullable().optional(),
    stop: stopSchema.optional(),
    seed: z.number().int().nullable().optional(),
    n: z.number().int().min(1).nullable().optional(),
    presence_penalty: z.number().min(-2).max(2).nullable().optional(),
    frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
    user: z.string().max(256).optional(),
    logprobs: z.boolean().nullable().optional(),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            function: z
              .object({
                name: z.string().min(1).max(64),
                description: z.string().max(4096).optional(),
                parameters: z.record(z.string(), z.unknown()).optional(),
                strict: z.boolean().nullable().optional()
              })
              .passthrough()
          })
          .passthrough()
      )
      .max(128)
      .optional(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]),
        z.object({ type: z.literal("function"), function: z.object({ name: z.string().min(1) }).passthrough() }).passthrough()
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: z
      .union([
        z.object({ type: z.literal("text") }).passthrough(),
        z.object({ type: z.literal("json_object") }).passthrough(),
        z
          .object({
            type: z.literal("json_schema"),
            json_schema: z
              .object({
                name: z.string().min(1).max(64),
                description: z.string().optional(),
                schema: z.record(z.string(), z.unknown()).optional(),
                strict: z.boolean().nullable().optional()
              })
              .passthrough()
          })
          .passthrough()
      ])
      .optional()
  })
  .passthrough();
export type OpenAiChatCompletionRequest = z.infer<typeof openAiChatCompletionRequestSchema>;

/** At most this many inputs in one embeddings request (OpenAI's own cap). */
export const AI_GATEWAY_MAX_EMBEDDING_INPUTS = 2048;

export const openAiEmbeddingsRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    input: z.union([
      z.string(),
      z.array(z.string()).min(1).max(AI_GATEWAY_MAX_EMBEDDING_INPUTS),
      z.array(z.number().int()).min(1),
      z.array(z.array(z.number().int()).min(1)).min(1).max(AI_GATEWAY_MAX_EMBEDDING_INPUTS)
    ]),
    encoding_format: z.enum(["float", "base64"]).optional(),
    dimensions: z.number().int().min(1).max(65_536).optional(),
    user: z.string().max(256).optional()
  })
  .passthrough();
export type OpenAiEmbeddingsRequest = z.infer<typeof openAiEmbeddingsRequestSchema>;

/** The OpenAI error envelope every `/v1` error answers with. */
export interface OpenAiErrorBody {
  error: { message: string; type: string; code: string | null; param: string | null };
}
