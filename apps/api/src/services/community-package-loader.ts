/**
 * Community-package loader. Scans a plugins directory for npm packages
 * named `l2m-nodes-*`, validates each one's manifest, dynamic-imports it,
 * and calls its `register()` function with a RegistrationApi that wires
 * contributions into the running L2M registries.
 *
 * Off by default. Enable via COMMUNITY_NODES_ENABLED=true. Admin-only at
 * the route layer. See `apps/docs/docs/extensions/community-nodes.md` for
 * the authoring guide and threat model.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  COMMUNITY_PACKAGE_PREFIX,
  CURRENT_API_VERSION,
  isSupportedApiVersion,
  type CommunityNodePackage,
  type LoadedCommunityPackage,
  type RegistrationApi
} from "@ai-orchestrator/community-sdk";
import type { ConnectorAdapter, ConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import type { MCPRegistry, MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import type { LLMProviderAdapter, ProviderRegistry } from "@ai-orchestrator/provider-sdk";

export interface CommunityLoaderLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CommunityLoaderConfig {
  /** Absolute path to the directory `npm install` writes into. node_modules/ lives below this. */
  pluginsDir: string;
  /**
   * Allowlist patterns for packages that may be installed/loaded. Each entry
   * is either an exact package name (`l2m-nodes-cohere`) or a glob with `*`
   * as the only wildcard (`l2m-nodes-*`). Empty/undefined = allow any
   * `l2m-nodes-*` package. Useful for paranoid orgs that vet packages.
   */
  allowlist?: string[];
  logger: CommunityLoaderLogger;
}

export interface CommunityLoaderDependencies {
  providerRegistry: ProviderRegistry;
  mcpRegistry: MCPRegistry;
  connectorRegistry: ConnectorRegistry;
}

export class CommunityPackageLoader {
  private readonly state = new Map<string, LoadedCommunityPackage>();

  constructor(
    private readonly config: CommunityLoaderConfig,
    private readonly deps: CommunityLoaderDependencies
  ) {}

  /**
   * Discover and load every `l2m-nodes-*` package currently installed in the
   * plugins directory. Safe to call multiple times — already-loaded packages
   * stay loaded; packages that have been npm-uninstalled since the last call
   * are marked as removed but their modules remain in memory until restart.
   */
  async loadAll(): Promise<LoadedCommunityPackage[]> {
    const nodeModulesDir = path.join(this.config.pluginsDir, "node_modules");
    if (!fs.existsSync(nodeModulesDir)) {
      this.config.logger.info("Community plugins directory has no node_modules yet — nothing to load.", {
        pluginsDir: this.config.pluginsDir
      });
      return [];
    }
    const candidates = fs
      .readdirSync(nodeModulesDir)
      .filter((entry) => entry.startsWith(COMMUNITY_PACKAGE_PREFIX))
      .map((entry) => path.join(nodeModulesDir, entry))
      .filter((entryPath) => fs.statSync(entryPath).isDirectory());

    for (const packageDir of candidates) {
      try {
        await this.loadOne(packageDir);
      } catch (err) {
        const packageName = path.basename(packageDir);
        const message = err instanceof Error ? err.message : String(err);
        this.config.logger.error("Failed to load community package", { packageName, error: message });
        this.state.set(packageName, {
          packageName,
          version: "unknown",
          state: "errored",
          contributions: { providers: 0, mcpAdapters: 0, connectors: 0 },
          error: message
        });
      }
    }
    return this.list();
  }

  list(): LoadedCommunityPackage[] {
    return [...this.state.values()];
  }

  /**
   * Install a package by npm spec (`l2m-nodes-cohere` or
   * `l2m-nodes-cohere@1.2.3`), then load it. Runs `npm install` with
   * --ignore-scripts to refuse to execute the installed package's
   * postinstall hooks (a non-trivial RCE vector).
   *
   * Returns the loaded-package state, including any registration error.
   */
  async install(packageSpec: string): Promise<LoadedCommunityPackage> {
    const baseName = packageSpec.split("@")[0]!;
    if (!baseName.startsWith(COMMUNITY_PACKAGE_PREFIX)) {
      throw new Error(`Community packages must be named '${COMMUNITY_PACKAGE_PREFIX}*', got '${baseName}'`);
    }
    if (!this.isAllowlisted(baseName)) {
      throw new Error(`Package '${baseName}' is not in COMMUNITY_NODES_ALLOWLIST.`);
    }
    fs.mkdirSync(this.config.pluginsDir, { recursive: true });
    // Ensure a package.json exists so npm install doesn't complain.
    const rootPackageJson = path.join(this.config.pluginsDir, "package.json");
    if (!fs.existsSync(rootPackageJson)) {
      fs.writeFileSync(
        rootPackageJson,
        JSON.stringify({ name: "l2m-community-plugins", private: true, version: "0.0.0" }, null, 2)
      );
    }
    await this.runNpm(["install", "--ignore-scripts", "--no-fund", "--no-audit", packageSpec]);
    const packageDir = path.join(this.config.pluginsDir, "node_modules", baseName);
    if (!fs.existsSync(packageDir)) {
      throw new Error(`npm install completed but ${baseName} not found at ${packageDir}`);
    }
    return this.loadOne(packageDir);
  }

  /**
   * Uninstall removes the package's files from disk and marks it removed
   * in our state, but does NOT unload its registered adapters from the
   * live registries — the running process still holds references. Take
   * effect requires a server restart.
   */
  async uninstall(packageName: string): Promise<void> {
    if (!packageName.startsWith(COMMUNITY_PACKAGE_PREFIX)) {
      throw new Error(`Refusing to uninstall non-community package: ${packageName}`);
    }
    await this.runNpm(["uninstall", "--no-fund", "--no-audit", packageName]);
    const existing = this.state.get(packageName);
    if (existing) {
      this.state.set(packageName, {
        ...existing,
        state: "errored",
        error: "Package uninstalled — restart the API to fully unload its registered adapters."
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async loadOne(packageDir: string): Promise<LoadedCommunityPackage> {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`No package.json at ${packageJsonPath}`);
    }
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as {
      name?: string;
      version?: string;
      main?: string;
      module?: string;
      exports?: unknown;
      l2m?: { kind?: string; apiVersion?: number };
    };
    const packageName = pkg.name ?? path.basename(packageDir);
    const version = pkg.version ?? "unknown";

    if (!pkg.l2m || pkg.l2m.kind !== "community-node-package") {
      throw new Error(`${packageName}: missing or invalid 'l2m' manifest in package.json (kind must be 'community-node-package')`);
    }
    const declaredApiVersion = pkg.l2m.apiVersion;
    if (typeof declaredApiVersion !== "number") {
      throw new Error(`${packageName}: l2m.apiVersion must be a number`);
    }
    if (!isSupportedApiVersion(declaredApiVersion)) {
      const state: LoadedCommunityPackage = {
        packageName,
        version,
        state: "unsupported",
        apiVersion: declaredApiVersion as 1,
        contributions: { providers: 0, mcpAdapters: 0, connectors: 0 },
        error: `Package targets community-sdk apiVersion ${declaredApiVersion} but this L2M supports ${CURRENT_API_VERSION}.`
      };
      this.state.set(packageName, state);
      this.config.logger.warn("Skipping community package — unsupported apiVersion", { packageName, declaredApiVersion });
      return state;
    }

    const entryRel = pickEntryPoint(pkg);
    if (!entryRel) {
      throw new Error(`${packageName}: no resolvable entry point (need 'main' or 'module' or 'exports')`);
    }
    const entryAbs = path.resolve(packageDir, entryRel);
    if (!fs.existsSync(entryAbs)) {
      throw new Error(`${packageName}: entry point ${entryRel} resolves to ${entryAbs} which does not exist`);
    }

    // Dynamic ESM import. The community package's deps under its own
    // node_modules/ resolve via Node's normal resolution.
    const mod = (await import(pathToFileURL(entryAbs).href)) as {
      default?: CommunityNodePackage;
    };
    const contribution = mod.default;
    if (!contribution || typeof contribution.register !== "function") {
      throw new Error(`${packageName}: default export must be a CommunityNodePackage with a register() function`);
    }
    if (contribution.apiVersion !== declaredApiVersion) {
      throw new Error(
        `${packageName}: default export apiVersion (${contribution.apiVersion}) disagrees with package.json l2m.apiVersion (${declaredApiVersion})`
      );
    }

    const counts = { providers: 0, mcpAdapters: 0, connectors: 0 };
    const api: RegistrationApi = {
      registerProvider: (adapter: LLMProviderAdapter) => {
        if (this.deps.providerRegistry.tryGet(adapter.definition.id)) {
          this.config.logger.warn(
            `${packageName} overrides built-in provider '${adapter.definition.id}'`,
            { packageName, providerId: adapter.definition.id }
          );
        }
        this.deps.providerRegistry.register(adapter);
        counts.providers += 1;
      },
      registerMCPAdapter: (adapter: MCPServerAdapter) => {
        if (this.deps.mcpRegistry.tryGet(adapter.definition.id)) {
          this.config.logger.warn(
            `${packageName} overrides built-in MCP adapter '${adapter.definition.id}'`,
            { packageName, mcpServerId: adapter.definition.id }
          );
        }
        this.deps.mcpRegistry.register(adapter);
        counts.mcpAdapters += 1;
      },
      registerConnector: (adapter: ConnectorAdapter) => {
        if (this.deps.connectorRegistry.tryGet(adapter.definition.id)) {
          this.config.logger.warn(
            `${packageName} overrides built-in connector '${adapter.definition.id}'`,
            { packageName, connectorId: adapter.definition.id }
          );
        }
        this.deps.connectorRegistry.register(adapter);
        counts.connectors += 1;
      },
      log: {
        info: (message, fields) => this.config.logger.info(`[${packageName}] ${message}`, fields),
        warn: (message, fields) => this.config.logger.warn(`[${packageName}] ${message}`, fields),
        error: (message, fields) => this.config.logger.error(`[${packageName}] ${message}`, fields)
      }
    };
    await contribution.register(api);

    const loaded: LoadedCommunityPackage = {
      packageName,
      version,
      state: "loaded",
      apiVersion: contribution.apiVersion,
      displayName: contribution.displayName,
      description: contribution.description,
      author: contribution.author,
      homepage: contribution.homepage,
      license: contribution.license,
      contributions: counts
    };
    this.state.set(packageName, loaded);
    this.config.logger.info("Loaded community package", {
      packageName,
      version,
      apiVersion: contribution.apiVersion,
      contributions: counts
    });
    return loaded;
  }

  private isAllowlisted(packageName: string): boolean {
    const list = this.config.allowlist;
    if (!list || list.length === 0) return true;
    for (const pattern of list) {
      if (pattern === packageName) return true;
      if (pattern.endsWith("*") && packageName.startsWith(pattern.slice(0, -1))) return true;
    }
    return false;
  }

  private runNpm(args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(npmBin, args, {
        cwd: this.config.pluginsDir,
        stdio: ["ignore", "pipe", "pipe"],
        // shell:true on Windows because npm.cmd needs cmd.exe to resolve.
        shell: process.platform === "win32"
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm ${args.join(" ")} exited with code ${code}: ${stderr.slice(0, 2000)}`));
      });
    });
  }
}

function pickEntryPoint(pkg: { main?: string; module?: string; exports?: unknown }): string | null {
  if (typeof pkg.module === "string" && pkg.module) return pkg.module;
  if (typeof pkg.main === "string" && pkg.main) return pkg.main;
  // Minimal exports-field handling: resolve "." -> string or { import: string }
  if (pkg.exports && typeof pkg.exports === "object") {
    const root = (pkg.exports as Record<string, unknown>)["."];
    if (typeof root === "string") return root;
    if (root && typeof root === "object") {
      const importEntry = (root as Record<string, unknown>).import;
      if (typeof importEntry === "string") return importEntry;
    }
  }
  return null;
}
