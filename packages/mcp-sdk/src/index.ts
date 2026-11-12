import { MockMCPServerAdapter } from "./adapters/mock-mcp";
import { SnapshotMockMCPServerAdapter, type McpSnapshotSource } from "./snapshot-mock";
import { HttpMCPServerAdapter, type HttpMcpProtocolOptions } from "./adapters/http-mcp";
import { StdioMCPServerAdapter } from "./adapters/stdio-mcp";
import { BuiltInToolsMCPServerAdapter, type BuiltInToolsAdapterOptions } from "./adapters/built-in-tools";
import { WorkflowToolMCPServerAdapter } from "./adapters/workflow-tool";
import { MCPRegistry } from "./registry";
import { withSecretBundle } from "./secret-bundle";
import { withRuntimeLimits, type McpRuntimeGuard } from "./runtime-limits";
import { ContainerSandboxLauncher, type McpSandboxPolicy, type StdioLauncher } from "./sandbox";
import { InstrumentedMCPRegistry } from "./tracing";
import type { McpOAuthTokenProvider, MCPServerAdapter } from "./types";
import type { RunInstrumentation } from "@ai-orchestrator/shared";

export * from "./types";
export * from "./registry";
export * from "./tool-resolution";
export * from "./schema-diff";
export * from "./tool-policy";
export * from "./tool-annotations";
export * from "./structured-output";
export * from "./progress";
export * from "./client-features";
export * from "./protocol";
export * from "./oauth";
export * from "./gateway-naming";
export * from "./secret-bundle";
export * from "./errors";
export * from "./sandbox";
export * from "./runtime-limits";
export * from "./delegated";
export * from "./cassette";
export * from "./tool-argument-summary";
export * from "./tracing";
export * from "./snapshot-mock";
export * from "./mock-stdio-server";
export * from "./adapters/mock-mcp";
export * from "./adapters/http-mcp";
export * from "./adapters/stdio-mcp";
export * from "./adapters/built-in-tools";
export * from "./adapters/workflow-tool";
export { isL2mOwnToolAdapter } from "./adapters/own-adapters";

export interface DefaultMCPRegistryOptions {
  oauth?: McpOAuthTokenProvider;
  snapshots?: McpSnapshotSource;
  /**
   * Phase 10.7 — how stdio servers start: a sandbox policy (container
   * sandboxes, MCP_SANDBOX_REQUIRED enforcement) or a ready launcher.
   * Without it stdio servers run on the host as before.
   */
  sandbox?: McpSandboxPolicy | StdioLauncher;
  /** Phase 10.7 — rate limits, concurrency caps and the circuit breaker shared by every caller of this registry. */
  runtimeGuard?: McpRuntimeGuard;
  /**
   * Phase 6.4 — the built-in tools (Wikipedia, SearXNG, SerpAPI, Wolfram
   * Alpha). The API passes its fetch with the outbound URL checks here; without one the
   * runtime's fetch is used with no outbound policy.
   */
  builtInTools?: BuiltInToolsAdapterOptions;
  /**
   * MCP 2026-07-28 — how the HTTP client picks a server's protocol era
   * (default `legacy`), the input round limit, and the safe re-issue rule for
   * legacy servers. Unset keeps earlier behaviour apart from that rule, which
   * is on by default.
   */
  httpProtocol?: HttpMcpProtocolOptions;
  /**
   * Tracing, passed only while it is on: every MCP operation gets a CLIENT span (`tools/call search`), and the HTTP
   * and stdio clients send the active trace context to the server (`params._meta` and, over HTTP, headers). Unset or
   * the no-op: no spans, nothing sent, the registry is a plain one.
   */
  instrument?: RunInstrumentation;
}

function isLauncher(value: McpSandboxPolicy | StdioLauncher): value is StdioLauncher {
  return typeof (value as StdioLauncher).prepare === "function";
}

export function createDefaultMCPRegistry(options?: DefaultMCPRegistryOptions): MCPRegistry {
  const instrument = options?.instrument?.enabled ? options.instrument : undefined;
  const registry = instrument ? new InstrumentedMCPRegistry(instrument) : new MCPRegistry();
  const guard = options?.runtimeGuard;
  const limited = <T extends MCPServerAdapter>(adapter: T): T => (guard ? withRuntimeLimits(adapter, guard) : adapter);
  const launcher = options?.sandbox ? (isLauncher(options.sandbox) ? options.sandbox : new ContainerSandboxLauncher(options.sandbox)) : undefined;
  // Phase 10.6 — servers with several credentials keep them in one JSON secret bundle.
  registry.register(
    limited(
      withSecretBundle(
        new HttpMCPServerAdapter({
          ...(options?.oauth ? { oauth: options.oauth } : {}),
          ...(options?.httpProtocol ? { protocol: options.httpProtocol } : {}),
          ...(instrument ? { trace: instrument } : {})
        })
      )
    )
  );
  registry.register(limited(withSecretBundle(new StdioMCPServerAdapter(launcher || instrument ? { ...(launcher ? { launcher } : {}), ...(instrument ? { trace: instrument } : {}) } : undefined))));
  registry.register(limited(new MockMCPServerAdapter()));
  // Phase 6.4 — built-in tools, under the same rate limits and breaker as any other server.
  registry.register(limited(new BuiltInToolsMCPServerAdapter(options?.builtInTools)));
  // Phase 6.4 — workflow tools run in this process; the child's own calls meet the limits of their servers.
  registry.register(new WorkflowToolMCPServerAdapter());
  // Phase 10.8 — offline stubs generated from a server's accepted snapshot.
  registry.register(new SnapshotMockMCPServerAdapter(options?.snapshots));
  return registry;
}
export * from "./tool-policy-simulation";
