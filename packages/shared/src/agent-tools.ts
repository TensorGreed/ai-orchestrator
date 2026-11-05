/**
 * Phase 6.4 — agent tools that ship with L2M.
 *
 * Built-in tools (Wikipedia, SearXNG, SerpAPI, Wolfram Alpha) are served by
 * the in-process `l2m-tools` MCP adapter, so an MCP Tool node on an agent's
 * `tool` port uses them like any other MCP server: tool policy, the write
 * gate, content rules, data labels, runtime limits, telemetry and cassette replay all
 * apply. One node serves one provider; its `connection.provider` says which.
 *
 * Workflow tools (`workflow_tool` nodes) let an agent call another workflow.
 * They are served by the in-process `l2m-workflow` adapter under the policy
 * key `workflow:<workflowId>`, which tool rules can name as their server.
 */

import type { McpToolAnnotations } from "./types";

export const BUILT_IN_TOOLS_ADAPTER_ID = "l2m-tools";

export const BUILT_IN_TOOL_PROVIDERS = ["wikipedia", "searxng", "serpapi", "wolfram"] as const;
export type BuiltInToolProvider = (typeof BUILT_IN_TOOL_PROVIDERS)[number];

export interface BuiltInToolProviderInfo {
  provider: BuiltInToolProvider;
  label: string;
  description: string;
  /** The tools the provider's node exposes. Names differ across providers so two nodes on one agent never collide. */
  toolNames: readonly string[];
  /** Where calls go when the node sets no endpoint; null when the node must set one (a self-hosted instance). */
  defaultEndpoint: string | null;
  /** A secret is required (`required`), accepted (`optional`) or not used (`none`). */
  secret: "required" | "optional" | "none";
  secretHint?: string;
}

export const BUILT_IN_TOOL_PROVIDER_INFO: Readonly<Record<BuiltInToolProvider, BuiltInToolProviderInfo>> = Object.freeze({
  wikipedia: {
    provider: "wikipedia",
    label: "Wikipedia",
    description: "Search Wikipedia and read page summaries. No key needed.",
    toolNames: ["wikipedia_search", "wikipedia_page"],
    defaultEndpoint: "https://en.wikipedia.org",
    secret: "none"
  },
  searxng: {
    provider: "searxng",
    label: "SearXNG web search",
    description: "Web search through your own SearXNG instance (JSON output must be enabled on it).",
    toolNames: ["searxng_search"],
    defaultEndpoint: null,
    secret: "optional",
    secretHint: "Optional bearer token, when the instance sits behind an authenticating proxy."
  },
  serpapi: {
    provider: "serpapi",
    label: "SerpAPI web search",
    description: "Google results through SerpAPI.",
    toolNames: ["serpapi_search"],
    defaultEndpoint: "https://serpapi.com",
    secret: "required",
    secretHint: "Your SerpAPI API key."
  },
  wolfram: {
    provider: "wolfram",
    label: "Wolfram Alpha",
    description: "Computation and facts from the Wolfram Alpha LLM API.",
    toolNames: ["wolfram_alpha"],
    defaultEndpoint: "https://www.wolframalpha.com",
    secret: "required",
    secretHint: "Your Wolfram Alpha AppID."
  }
});

/** Every built-in tool is a read of outside content: read-only for the write gate, open world for taint rules. */
export const BUILT_IN_TOOL_ANNOTATIONS: Readonly<McpToolAnnotations> = Object.freeze({ readOnlyHint: true, openWorldHint: true });

export function isBuiltInToolProvider(value: unknown): value is BuiltInToolProvider {
  return typeof value === "string" && (BUILT_IN_TOOL_PROVIDERS as readonly string[]).includes(value);
}

function plain(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The provider a built-in tools connection names, or null. */
export function builtInToolProviderOf(connection: unknown): BuiltInToolProvider | null {
  const provider = plain(connection).provider;
  return isBuiltInToolProvider(provider) ? provider : null;
}

/**
 * The base URL a built-in tools connection sends to: its own `endpoint`, else
 * the provider's default (Wikipedia: the `language` edition). Null when the
 * provider needs an endpoint and none is set, or the value is not http(s).
 */
export function builtInToolsEndpoint(connection: unknown): string | null {
  const record = plain(connection);
  const provider = builtInToolProviderOf(record);
  if (!provider) return null;
  const own = typeof record.endpoint === "string" ? record.endpoint.trim() : "";
  let endpoint = own;
  if (!endpoint && provider === "wikipedia") {
    const language = typeof record.language === "string" && /^[a-z][a-z-]{1,15}$/.test(record.language.trim()) ? record.language.trim() : "en";
    endpoint = `https://${language}.wikipedia.org`;
  }
  if (!endpoint) endpoint = BUILT_IN_TOOL_PROVIDER_INFO[provider].defaultEndpoint ?? "";
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The connection a built-in tools node carries for destination rules: the endpoint is filled in when the node left it to the default. */
export function builtInToolsDestinationConnection(connection: unknown): Record<string, unknown> {
  const endpoint = builtInToolsEndpoint(connection);
  return endpoint ? { ...plain(connection), endpoint } : plain(connection);
}

// ---------------------------------------------------------------------------
// Workflow tools
// ---------------------------------------------------------------------------

export const WORKFLOW_TOOL_ADAPTER_ID = "l2m-workflow";

/** The pseudo server id a workflow tool is governed under (tool rules, approvals, telemetry, cassettes). */
export function workflowToolServerKey(workflowId: string): string {
  return `workflow:${workflowId}`;
}

/** The workflow id of a `workflow:<id>` key, or null. */
export function workflowIdOfToolServerKey(key: string | undefined): string | null {
  return typeof key === "string" && key.startsWith("workflow:") && key.length > "workflow:".length ? key.slice("workflow:".length) : null;
}

/** What a workflow tool shows the model, derived from the child workflow. */
export interface WorkflowToolDescriptor {
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Where the schema came from. */
  source: "mcp_server_trigger" | "sub_workflow_trigger" | "default";
  /** The workflow's own trigger declares it read-only (`readOnly` on that trigger); a caller cannot. */
  readOnly: boolean;
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A model-safe tool name from free text ("Look up order" → "look_up_order"). */
export function toWorkflowToolName(value: string, fallback = "run_workflow"): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return name && TOOL_NAME_PATTERN.test(name) ? name : fallback;
}

function objectSchema(value: unknown): Record<string, unknown> | null {
  const schema = plain(value);
  if (Object.keys(schema).length === 0) return null;
  return schema.type === "object" ? schema : { ...schema, type: "object" };
}

/** The fallback schema: one free-text `input`. */
export const DEFAULT_WORKFLOW_TOOL_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: { input: { type: "string", description: "What to ask the workflow, in plain words." } },
  required: ["input"]
});

/**
 * The tool a workflow becomes: its "Expose as MCP Tool" trigger's name,
 * description and input schema when it has one, else its Sub-Workflow
 * Trigger's description and input schema, else one free-text `input`. The
 * node's own name and description override the derived ones. Read-only comes
 * only from that trigger: the workflow's own editors declare it.
 */
export function deriveWorkflowToolDescriptor(
  workflow: { id: string; name?: string; nodes?: ReadonlyArray<{ type: string; config?: unknown; disabled?: boolean }> },
  overrides: { toolName?: unknown; toolDescription?: unknown } = {}
): WorkflowToolDescriptor {
  const nodes = (workflow.nodes ?? []).filter((node) => node && node.disabled !== true);
  const mcpTrigger = nodes.find((node) => node.type === "mcp_server_trigger");
  const subTrigger = nodes.find((node) => node.type === "sub_workflow_trigger");
  const label = workflow.name?.trim() || workflow.id;
  let toolName = toWorkflowToolName(label);
  let description = `Runs the workflow '${label}' and returns its output.`;
  let inputSchema: Record<string, unknown> = { ...DEFAULT_WORKFLOW_TOOL_SCHEMA };
  let source: WorkflowToolDescriptor["source"] = "default";
  let readOnly = false;
  if (mcpTrigger) {
    const config = plain(mcpTrigger.config);
    if (typeof config.toolName === "string" && config.toolName.trim()) toolName = toWorkflowToolName(config.toolName, toolName);
    if (typeof config.toolDescription === "string" && config.toolDescription.trim()) description = config.toolDescription.trim();
    inputSchema = objectSchema(config.inputSchema) ?? inputSchema;
    source = "mcp_server_trigger";
    readOnly = config.readOnly === true;
  } else if (subTrigger) {
    const config = plain(subTrigger.config);
    if (typeof config.description === "string" && config.description.trim()) description = config.description.trim();
    inputSchema = objectSchema(config.inputSchema) ?? inputSchema;
    source = "sub_workflow_trigger";
    readOnly = config.readOnly === true;
  }
  if (typeof overrides.toolName === "string" && overrides.toolName.trim()) toolName = toWorkflowToolName(overrides.toolName, toolName);
  if (typeof overrides.toolDescription === "string" && overrides.toolDescription.trim()) description = overrides.toolDescription.trim();
  return { toolName, description, inputSchema, source, readOnly };
}
