/**
 * Client entry for the official MCP conformance suite. The suite starts one scenario server per run, appends its
 * URL as the last argument and sets:
 *
 *   MCP_CONFORMANCE_SCENARIO          the scenario name
 *   MCP_CONFORMANCE_PROTOCOL_VERSION  the spec version under test (default 2025-11-25)
 *   MCP_CONFORMANCE_CONTEXT           scenario data as JSON (tool calls to make, OAuth client data), when there is any
 *
 * The harness drives the real `HttpMCPServerAdapter` the way a run does: version 2026-07-28 or later uses protocol
 * mode `modern` (no initialize handshake, per-request `_meta`), earlier versions use `legacy` (initialize handshake).
 * For the `auth/*` scenarios it first runs the OAuth authorization-code flow with the building blocks of `oauth.ts`
 * (a re-implementation of the connect flow) and then connects through the adapter's OAuth path: the adapter takes
 * the access token from the harness's token provider and reports 403 `insufficient_scope` challenges to it, as it
 * does to the API's (where a person then reconnects the server). After a challenge the harness authorizes again with
 * the union of the scope it asked for and the challenged scope and sends the request again, at most twice per run.
 * Any failed request makes the process exit 1, except in scenarios that expect client errors.
 *
 *   tsx src/bin/conformance-client.ts <server-url>
 */
import type { McpElicitationRequest, McpElicitationResult, MCPServerConfig, MCPToolDefinition } from "@ai-orchestrator/shared";
import { HttpMCPServerAdapter } from "../adapters/http-mcp";
import {
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  discoverMcpOAuth,
  exchangeAuthorizationCode,
  registerOAuthClient,
  unionOAuthScopes,
  validateAuthorizationResponseIssuer,
  type McpOAuthDiscovery,
  type OAuthClientRegistration
} from "../oauth";
import type { McpOAuthTokenProvider, MCPExecutionContext } from "../types";

const MODERN_VERSION = "2026-07-28";
/** Scenarios that call a tool the client must refuse, so a failed call is part of the expected behaviour. */
const EXPECTS_CLIENT_ERRORS = new Set(["http-invalid-tool-headers"]);
const REDIRECT_URI = "http://localhost:3000/callback";

interface ToolCallPlan {
  name: string;
  arguments?: Record<string, unknown>;
}

function parseContext(): Record<string, unknown> {
  const raw = process.env.MCP_CONFORMANCE_CONTEXT;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A value that satisfies a property schema well enough for a conformance server to accept the call. */
function sampleValue(schema: unknown): unknown {
  const record = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  if (record.default !== undefined) return record.default;
  if (Array.isArray(record.enum) && record.enum.length > 0) return record.enum[0];
  switch (record.type) {
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "test";
  }
}

function sampleArguments(tool: MCPToolDefinition): Record<string, unknown> {
  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  const args: Record<string, unknown> = {};
  for (const key of schema.required ?? []) args[key] = sampleValue(schema.properties?.[key]);
  return args;
}

/** Accepts an elicitation with every property's default (or a plain sample), which is what the default-value scenario checks. */
async function acceptWithDefaults(request: McpElicitationRequest): Promise<McpElicitationResult> {
  const schema = (request as { requestedSchema?: { properties?: Record<string, unknown> } }).requestedSchema;
  const content: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema?.properties ?? {})) content[key] = sampleValue(property);
  return { action: "accept", content } as McpElicitationResult;
}

/** What one authorization produced; a step-up reuses the discovery and the client registration. */
interface Authorization {
  accessToken: string;
  scope?: string;
  discovery: McpOAuthDiscovery;
  registration: OAuthClientRegistration;
}

/** Discovery and client registration (pre-registered from the scenario context, else dynamic). */
async function prepareAuthorization(url: string, context: Record<string, unknown>): Promise<Pick<Authorization, "discovery" | "registration" | "scope">> {
  const discovery = await discoverMcpOAuth(url);
  const scope =
    discovery.scopeHint ??
    (Array.isArray(discovery.resourceMetadata.scopes_supported) ? discovery.resourceMetadata.scopes_supported.join(" ") : undefined);
  let registration: OAuthClientRegistration;
  const preRegisteredId = typeof context.client_id === "string" ? context.client_id : undefined;
  if (preRegisteredId) {
    registration = {
      clientId: preRegisteredId,
      ...(typeof context.client_secret === "string" ? { clientSecret: context.client_secret } : {}),
      tokenEndpointAuthMethod: typeof context.client_secret === "string" ? "client_secret_basic" : "none"
    };
  } else if (discovery.authorizationServer.registration_endpoint) {
    registration = await registerOAuthClient(discovery.authorizationServer.registration_endpoint, {
      redirectUri: REDIRECT_URI,
      clientName: "ai-orchestrator-conformance",
      ...(scope ? { scope } : {})
    });
  } else {
    throw new Error("The authorization server offers no registration endpoint and the scenario gave no client.");
  }
  return { discovery, registration, ...(scope ? { scope } : {}) };
}

/** Authorization-code flow with PKCE against the scenario's authorization server, asking for `scope`. */
async function authorize(prepared: Pick<Authorization, "discovery" | "registration" | "scope">): Promise<Authorization> {
  const { discovery, registration, scope } = prepared;
  const pkce = createPkcePair();
  const state = createOAuthState();
  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: discovery.authorizationServer.authorization_endpoint,
    clientId: registration.clientId,
    redirectUri: REDIRECT_URI,
    state,
    codeChallenge: pkce.challenge,
    resource: discovery.resource,
    ...(scope ? { scope } : {})
  });
  const redirect = await fetch(authorizationUrl, { redirect: "manual" });
  const location = redirect.headers.get("location");
  if (!location) throw new Error(`The authorization endpoint answered HTTP ${redirect.status} without a redirect.`);
  const callback = new URL(location);
  const issuerCheck = validateAuthorizationResponseIssuer({
    recordedIssuer: discovery.authorizationServer.issuer,
    issParameterSupported: discovery.authorizationServer.authorization_response_iss_parameter_supported === true,
    iss: callback.searchParams.getAll("iss").length > 1 ? callback.searchParams.getAll("iss") : (callback.searchParams.get("iss") ?? undefined)
  });
  if (!issuerCheck.ok) throw new Error(issuerCheck.message);
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.get("state") !== state) throw new Error("The authorization response carried no code or a wrong state.");
  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: discovery.authorizationServer.token_endpoint,
    clientId: registration.clientId,
    ...(registration.clientSecret ? { clientSecret: registration.clientSecret } : {}),
    tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: REDIRECT_URI,
    resource: discovery.resource
  });
  return { accessToken: tokens.accessToken, discovery, registration, ...(scope ? { scope } : {}) };
}

/** At most this many step-up authorizations per run (the specification asks for a retry limit). */
const MAX_STEP_UPS = 2;

async function main(): Promise<void> {
  const url = process.argv[process.argv.length - 1];
  if (!url || !/^https?:\/\//.test(url)) throw new Error("Usage: conformance-client <server-url>");
  const version = process.env.MCP_CONFORMANCE_PROTOCOL_VERSION ?? "2025-11-25";
  const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? "";
  const context = parseContext();
  const modern = version >= MODERN_VERSION;

  const connection: Record<string, unknown> = { endpoint: url, protocolMode: modern ? "modern" : "legacy", timeoutMs: 20_000 };
  let authorization: Authorization | undefined;
  /** Scopes the server challenged (403 insufficient_scope) since the last authorization, as the adapter reported them. */
  let challenged: { scope?: string } | undefined;
  const tokenProvider: McpOAuthTokenProvider = {
    getAccessToken: async () => {
      if (!authorization) throw new Error("Not authorized.");
      return authorization.accessToken;
    },
    noteInsufficientScope: async (_serverId, scope) => {
      challenged = { scope: unionOAuthScopes(challenged?.scope, scope) };
    }
  };
  if (scenario.startsWith("auth/")) {
    authorization = await authorize(await prepareAuthorization(url, context));
    // The adapter's OAuth path: tokens from the provider, scope challenges reported to it.
    connection.authType = "oauth";
  } else {
    connection.authType = "none";
  }

  const config: MCPServerConfig = { serverId: "conformance", registryServerId: "conformance", label: "conformance", connection };
  const runtimeState = new Map<string, unknown>();
  const ctx: MCPExecutionContext = {
    resolveSecret: async () => undefined,
    runtimeState,
    onElicitation: acceptWithDefaults
  };
  // A new adapter after a step-up, so no connection keeps the old token in its headers.
  const newAdapter = () => new HttpMCPServerAdapter({ oauth: tokenProvider, protocol: { defaultMode: modern ? "modern" : "legacy" } });
  let adapter = newAdapter();
  const failures: string[] = [];
  let stepUps = 0;
  /**
   * Runs `operation`. When the adapter reported a scope challenge during it, authorizes again with the union of the
   * scope asked for before and the challenged scope (step-up), then runs it once more.
   */
  const withStepUp = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      challenged = undefined;
      let outcome: { value: T } | { error: unknown };
      try {
        outcome = { value: await operation() };
      } catch (error) {
        outcome = { error };
      }
      const challenge = challenged as { scope?: string } | undefined;
      if (!challenge || !authorization || stepUps >= MAX_STEP_UPS) {
        if ("error" in outcome) throw outcome.error;
        return outcome.value;
      }
      stepUps += 1;
      authorization = await authorize({ ...authorization, scope: unionOAuthScopes(authorization.scope, challenge.scope) });
      await adapter.closeSessions?.(ctx);
      adapter = newAdapter();
    }
  };
  const attempt = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await withStepUp(run);
    } catch (error) {
      failures.push(label);
      process.stderr.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  try {
    const tools = await withStepUp(() => adapter.discoverTools(config, ctx));
    const planned = Array.isArray(context.toolCalls) ? (context.toolCalls as ToolCallPlan[]) : null;
    const calls: ToolCallPlan[] = planned
      ? planned
      : scenario === "tools_call"
        ? [{ name: "add_numbers", arguments: { a: 1, b: 2 } }]
        : tools.map((tool) => ({ name: tool.name, arguments: sampleArguments(tool) }));
    if (scenario === "json-schema-2020-12-preservation") {
      // The scenario asks for the focal tool's input schema, as the client parsed it, to be passed back verbatim.
      const focal = tools.find((tool) => tool.name === "json_schema_2020_12_tool");
      const echo = tools.find((tool) => tool.name !== "json_schema_2020_12_tool");
      if (focal && echo) await attempt("tools/call echo", () => adapter.invokeTool(echo.name, { schema: focal.inputSchema }, config, ctx));
      return;
    }
    for (const call of calls) {
      await attempt(`tools/call ${call.name}`, () => adapter.invokeTool(call.name, call.arguments ?? {}, config, ctx));
    }
    if (scenario.startsWith("http-standard-headers") || scenario.startsWith("sep-2243")) {
      const resources = await adapter.listResources?.(config, ctx);
      for (const resource of resources?.slice(0, 1) ?? []) await attempt("resources/read", () => adapter.readResource!(resource.uri, config, ctx));
      const prompts = await adapter.listPrompts?.(config, ctx);
      for (const prompt of prompts?.slice(0, 1) ?? []) await attempt("prompts/get", () => adapter.getPrompt!(prompt.name, {}, config, ctx));
    }
  } finally {
    await adapter.closeSessions?.(ctx);
  }
  if (failures.length > 0 && !EXPECTS_CLIENT_ERRORS.has(scenario)) throw new Error(`Failed requests: ${failures.join(", ")}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  }
);
