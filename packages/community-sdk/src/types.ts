import type { LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type { MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import type { ConnectorAdapter } from "@ai-orchestrator/connector-sdk";

/**
 * Community-package contribution surface. Every `l2m-nodes-*` package
 * default-exports a `CommunityNodePackage` whose `register` method is
 * called once at load time with a `RegistrationApi` instance.
 *
 * Stability: this contract is versioned via `apiVersion`. Bumping the
 * version is a breaking change — old packages stop loading until their
 * authors update.
 */

export type CommunityApiVersion = 1;

export interface CommunityPackageLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * The single object passed to a community package's `register()` function.
 * Provides typed methods to contribute adapters into the running L2M
 * instance's registries. Adapters layer on top of the built-ins; community
 * adapters with the same id as a built-in win (last-write-wins) and a
 * warning is logged.
 */
export interface RegistrationApi {
  /** Register an LLM provider (e.g. cohere, mistral, custom-gateway). */
  registerProvider(adapter: LLMProviderAdapter): void;
  /** Register an MCP server transport (e.g. websocket, custom-protocol). */
  registerMCPAdapter(adapter: MCPServerAdapter): void;
  /** Register a connector for an external system (e.g. zendesk, shopify). */
  registerConnector(adapter: ConnectorAdapter): void;
  /** Logger scoped to the package. Output appears in API logs prefixed with the package name. */
  log: CommunityPackageLogger;
}

/**
 * The shape of a community package's default export. The package's
 * `package.json` advertises this with the field
 *   "l2m": { "kind": "community-node-package", "apiVersion": 1 }
 * which the loader checks before importing the module.
 */
export interface CommunityNodePackage {
  /** Stable contract version. Currently `1`. */
  apiVersion: CommunityApiVersion;
  /** Human-readable display name shown in the install UI. */
  displayName: string;
  /** Short description shown in the install UI. */
  description?: string;
  /** Author / maintainer. */
  author?: string;
  /** Project homepage (used by the install UI). */
  homepage?: string;
  /** SPDX license identifier. */
  license?: string;
  /**
   * Minimum L2M API version the package needs (semver range). The loader
   * skips packages that ask for a newer L2M than the running instance.
   */
  l2mVersion?: string;
  /**
   * Called once when the package is loaded. Synchronous or async. Any
   * thrown error fails the load and the package is marked errored in the
   * install UI; other packages keep loading.
   */
  register(api: RegistrationApi): void | Promise<void>;
}

/**
 * Manifest fields the loader reads from a community package's package.json.
 * Mirrors the `l2m` field's expected shape.
 */
export interface CommunityPackageManifest {
  kind: "community-node-package";
  apiVersion: CommunityApiVersion;
}

/**
 * Machine-friendly state for a loaded (or errored) community package.
 * Surfaced by the install UI so admins can see what's running.
 */
export interface LoadedCommunityPackage {
  packageName: string;
  version: string;
  state: "loaded" | "errored" | "unsupported";
  apiVersion?: CommunityApiVersion;
  displayName?: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  /** Counts of registered contributions for the UI. */
  contributions: {
    providers: number;
    mcpAdapters: number;
    connectors: number;
  };
  /** Set when state === "errored" or "unsupported". */
  error?: string;
}
