/**
 * Phase 10.6 — deployment-local catalog of approved MCP servers.
 *
 * `MCP_CATALOG_FILE` points at a JSON file the operator maintains next to the
 * deployment. It is read on start, re-read when it changes (polling, so a
 * replaced file or a bind mount works) and on demand, validated entry by
 * entry, and never fetched from the network. A broken file never stops the
 * API: the last good catalog stays in use and the errors are reported.
 *
 * Stdio entries must pin the package they run (`npx -y @scope/pkg@1.2.3`,
 * `uvx pkg==1.2.3`, `docker run image@sha256:…`), because the catalog is what
 * enforcement (`MCP_CATALOG_ENFORCE`) compares registrations against: an
 * admin may then only register a stdio server whose command runs exactly an
 * approved, pinned package.
 */

import fs from "node:fs";
import path from "node:path";
import {
  mcpCatalogEntrySchema,
  mcpCatalogFileSchema,
  type McpCatalogEntry,
  type McpCatalogIssue,
  type McpCatalogStatus
} from "@ai-orchestrator/shared";
import { MCP_PRESETS, type McpPreset } from "./mcp-presets.js";

export type McpCatalogMode = "merge" | "exclusive";

/** A preset as the API lists it: built-in or from the catalog. */
export interface McpListedPreset extends McpPreset {
  origin: "builtin" | "catalog";
  tags?: string[];
  requiredSecrets?: Array<{ name: string; description?: string }>;
}

// ---------------------------------------------------------------------------
// Package pinning
// ---------------------------------------------------------------------------

const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Flags of package runners that take a value, so the value is not mistaken for the package. */
const DOCKER_VALUE_FLAGS = new Set([
  "-e",
  "--env",
  "-v",
  "--volume",
  "--name",
  "-p",
  "--publish",
  "--network",
  "--mount",
  "-w",
  "--workdir",
  "-u",
  "--user",
  "--entrypoint",
  "--env-file",
  "--platform",
  "--memory",
  "--cpus",
  "-l",
  "--label"
]);

export interface PackageSpec {
  runner: "npx" | "uvx" | "docker" | "pipx" | "dlx";
  spec: string;
  pinned: boolean;
}

function commandBase(command: string): string {
  return path.basename(command.trim()).replace(/\.(cmd|exe)$/i, "").toLowerCase();
}

function firstPositional(args: string[], valueFlags: Set<string> = new Set()): number {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return index + 1 < args.length ? index + 1 : -1;
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function npmPinned(spec: string): boolean {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return false;
  return EXACT_SEMVER.test(spec.slice(at + 1));
}

function pythonPinned(spec: string): boolean {
  const eq = spec.match(/^[A-Za-z0-9._\-[\]]+==(.+)$/);
  if (eq) return EXACT_SEMVER.test(eq[1]!) || /^\d+(\.\d+)*$/.test(eq[1]!);
  const at = spec.match(/^[A-Za-z0-9._\-[\]]+@(.+)$/);
  return at ? EXACT_SEMVER.test(at[1]!) || /^\d+(\.\d+)*$/.test(at[1]!) : false;
}

function imagePinned(image: string): boolean {
  if (/@sha256:[a-f0-9]{64}$/i.test(image)) return true;
  const lastSegment = image.split("/").pop() ?? image;
  const colon = lastSegment.lastIndexOf(":");
  if (colon < 0) return false;
  const tag = lastSegment.slice(colon + 1);
  return tag !== "latest" && /^[\w][\w.-]{0,127}$/.test(tag) && /\d/.test(tag);
}

/**
 * The package a runner command executes, or null when the command is not a
 * package runner (a local binary or script, which is pinned by its path).
 */
export function packageSpecOf(command: string, args: string[]): PackageSpec | null {
  const base = commandBase(command);
  if (base === "npx" || base === "bunx" || base === "pnpx") {
    const pkgFlag = args.findIndex((arg) => arg === "-p" || arg === "--package");
    const spec = pkgFlag >= 0 ? args[pkgFlag + 1] : (() => {
      const index = firstPositional(args);
      return index >= 0 ? args[index] : undefined;
    })();
    return spec ? { runner: "npx", spec, pinned: npmPinned(spec) } : { runner: "npx", spec: "", pinned: false };
  }
  if ((base === "pnpm" || base === "yarn" || base === "npm") && (args[0] === "dlx" || args[0] === "exec")) {
    const rest = args.slice(1);
    const index = firstPositional(rest);
    const spec = index >= 0 ? rest[index]! : "";
    return { runner: "dlx", spec, pinned: npmPinned(spec) };
  }
  if (base === "uvx" || (base === "uv" && args[0] === "tool" && args[1] === "run")) {
    const rest = base === "uv" ? args.slice(2) : args;
    const fromFlag = rest.findIndex((arg) => arg === "--from");
    const spec = fromFlag >= 0 ? rest[fromFlag + 1] ?? "" : (() => {
      const index = firstPositional(rest);
      return index >= 0 ? rest[index]! : "";
    })();
    return { runner: "uvx", spec, pinned: pythonPinned(spec) };
  }
  if (base === "pipx" && args[0] === "run") {
    const rest = args.slice(1);
    const index = firstPositional(rest, new Set(["--spec"]));
    const specFlag = rest.findIndex((arg) => arg === "--spec");
    const spec = specFlag >= 0 ? rest[specFlag + 1] ?? "" : index >= 0 ? rest[index]! : "";
    return { runner: "pipx", spec, pinned: pythonPinned(spec) };
  }
  if ((base === "docker" || base === "podman") && args[0] === "run") {
    const rest = args.slice(1);
    const index = firstPositional(rest, DOCKER_VALUE_FLAGS);
    const spec = index >= 0 ? rest[index]! : "";
    return { runner: "docker", spec, pinned: imagePinned(spec) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadedCatalog {
  entries: McpCatalogEntry[];
  errors: McpCatalogIssue[];
  /** File-level failure: nothing could be read. */
  fatal: boolean;
}

function issuePath(pathParts: ReadonlyArray<PropertyKey>): string {
  return pathParts.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("").replace(/^\./, "");
}

/** Validate catalog file text. Pure; used on load and by tests. */
export function parseMcpCatalog(text: string): LoadedCatalog {
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return {
      entries: [],
      errors: [{ index: null, message: `The catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }],
      fatal: true
    };
  }
  const file = mcpCatalogFileSchema.safeParse(doc);
  if (!file.success) {
    return {
      entries: [],
      errors: file.error.issues.map((issue) => ({ index: null, path: issuePath(issue.path), message: issue.message })),
      fatal: true
    };
  }
  const entries: McpCatalogEntry[] = [];
  const errors: McpCatalogIssue[] = [];
  const seen = new Set<string>();
  file.data.servers.forEach((raw, index) => {
    const rawId = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : undefined;
    const parsed = mcpCatalogEntrySchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ index, ...(rawId ? { entryId: rawId } : {}), path: issuePath(issue.path), message: issue.message });
      }
      return;
    }
    const entry = parsed.data;
    if (seen.has(entry.id)) {
      errors.push({ index, entryId: entry.id, path: "id", message: `Duplicate id '${entry.id}'; the first entry wins.` });
      return;
    }
    if (entry.adapter === "stdio_mcp") {
      const command = typeof entry.connection.command === "string" ? entry.connection.command.trim() : "";
      const args = Array.isArray(entry.connection.args) ? entry.connection.args.map(String) : [];
      if (!command) {
        errors.push({ index, entryId: entry.id, path: "connection.command", message: "A stdio entry needs connection.command." });
        return;
      }
      const spec = packageSpecOf(command, args);
      if (spec && !spec.pinned) {
        errors.push({
          index,
          entryId: entry.id,
          path: "connection.args",
          message: spec.spec
            ? `'${spec.spec}' is not pinned to an exact version (use e.g. pkg@1.2.3, pkg==1.2.3 or image@sha256:…).`
            : `No package found in the ${spec.runner} arguments.`
        });
        return;
      }
    } else if (typeof entry.connection.endpoint !== "string" || !/^https?:\/\//i.test(entry.connection.endpoint)) {
      errors.push({ index, entryId: entry.id, path: "connection.endpoint", message: "An http entry needs an http(s) connection.endpoint." });
      return;
    }
    seen.add(entry.id);
    entries.push(entry);
  });
  return { entries, errors, fatal: false };
}

/** Why `command args` may not be registered under enforcement, or null when an approved entry allows it. */
export function checkCommandAgainstCatalog(command: string, args: string[], entries: McpCatalogEntry[]): string | null {
  const approved = entries.filter((entry) => entry.approved && entry.adapter === "stdio_mcp");
  const spec = packageSpecOf(command, args);
  if (spec) {
    if (!spec.pinned) {
      return `'${[command, ...args].join(" ")}' does not pin its package to an exact version; MCP_CATALOG_ENFORCE allows only approved, pinned catalog packages.`;
    }
    const match = approved.find((entry) => {
      const entrySpec = packageSpecOf(String(entry.connection.command), (entry.connection.args as unknown[] | undefined)?.map(String) ?? []);
      return entrySpec?.runner === spec.runner && entrySpec.spec === spec.spec;
    });
    return match ? null : `Package '${spec.spec}' is not an approved entry in the MCP catalog (MCP_CATALOG_ENFORCE is on).`;
  }
  const match = approved.find((entry) => {
    if (String(entry.connection.command).trim() !== command.trim()) return false;
    const entryArgs = Array.isArray(entry.connection.args) ? entry.connection.args.map(String) : [];
    return entryArgs.length === 0 || entryArgs[0] === args[0];
  });
  return match ? null : `Command '${command}' is not an approved entry in the MCP catalog (MCP_CATALOG_ENFORCE is on).`;
}

function toPreset(entry: McpCatalogEntry): McpListedPreset {
  const firstSecret = entry.requiredSecrets[0];
  return {
    id: `catalog:${entry.id}`,
    name: entry.name,
    category: entry.tags[0] ?? "Catalog",
    description: entry.description,
    source: entry.source ?? "Deployment catalog",
    serverAdapter: entry.adapter,
    connection: entry.connection,
    ...(firstSecret
      ? {
          credentialHint: {
            envVar: firstSecret.name,
            ...(entry.adapter === "stdio_mcp" && entry.requiredSecrets.length === 1 ? { secretEnvVar: firstSecret.name } : {}),
            description: entry.requiredSecrets.map((secret) => `${secret.name}: ${secret.description ?? "required"}`).join(" ")
          }
        }
      : {}),
    ...(entry.notes ? { notes: entry.notes } : {}),
    origin: "catalog",
    tags: entry.tags,
    requiredSecrets: entry.requiredSecrets
  };
}

export interface McpCatalogServiceOptions {
  filePath: string;
  mode: McpCatalogMode;
  enforce: boolean;
  /** Poll interval for file changes; 0 turns watching off (tests reload explicitly). */
  watchIntervalMs?: number;
  logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };
}

export class McpCatalogService {
  private entries: McpCatalogEntry[] = [];
  private errors: McpCatalogIssue[] = [];
  private state: McpCatalogStatus["state"] = "off";
  private loadedAt: string | null = null;
  private watching = false;
  private readonly resolvedPath: string | null;

  constructor(private readonly options: McpCatalogServiceOptions) {
    this.resolvedPath = options.filePath.trim() ? path.resolve(options.filePath.trim()) : null;
    this.reload();
  }

  get configured(): boolean {
    return this.resolvedPath !== null;
  }

  /** Re-read the file. Keeps the last good entries when the file cannot be used. */
  reload(): McpCatalogStatus {
    if (!this.resolvedPath) {
      this.state = "off";
      return this.status();
    }
    let text: string;
    try {
      text = fs.readFileSync(this.resolvedPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.errors = [
        { index: null, message: code === "ENOENT" ? "The catalog file does not exist." : `The catalog file could not be read (${code ?? "error"}).` }
      ];
      this.state = "error";
      this.options.logger?.warn("MCP catalog could not be read", { code });
      return this.status();
    }
    const loaded = parseMcpCatalog(text);
    this.errors = loaded.errors;
    if (loaded.fatal) {
      this.state = "error";
      this.options.logger?.warn("MCP catalog is invalid; keeping the last good catalog", { errors: loaded.errors.length });
      return this.status();
    }
    this.entries = loaded.entries;
    this.state = loaded.errors.length > 0 ? "partial" : "ok";
    this.loadedAt = new Date().toISOString();
    this.options.logger?.info("MCP catalog loaded", { entries: loaded.entries.length, errors: loaded.errors.length });
    return this.status();
  }

  start(): void {
    const interval = this.options.watchIntervalMs ?? 2000;
    if (!this.resolvedPath || interval <= 0 || this.watching) return;
    this.watching = true;
    const watcher = fs.watchFile(this.resolvedPath, { interval, persistent: false }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.ino !== previous.ino) {
        this.reload();
      }
    });
    watcher.unref?.();
  }

  stop(): void {
    if (this.resolvedPath && this.watching) {
      fs.unwatchFile(this.resolvedPath);
      this.watching = false;
    }
  }

  status(): McpCatalogStatus {
    return {
      configured: this.configured,
      fileName: this.resolvedPath ? path.basename(this.resolvedPath) : null,
      mode: this.options.mode,
      enforce: this.options.enforce,
      state: this.state,
      loadedAt: this.loadedAt,
      entryCount: this.entries.length,
      approvedCount: this.entries.filter((entry) => entry.approved).length,
      errors: this.errors
    };
  }

  listEntries(): McpCatalogEntry[] {
    return this.entries;
  }

  get enforcing(): boolean {
    return this.options.enforce;
  }

  /**
   * Under enforcement, why a stdio command may not be registered (null = allowed).
   * Without a usable catalog every stdio command is refused: enforcement fails closed.
   */
  checkStdioCommand(command: string, args: string[]): string | null {
    if (!this.options.enforce) return null;
    if (!this.configured || this.entries.length === 0) {
      return "MCP_CATALOG_ENFORCE is on but no approved catalog is loaded, so stdio servers cannot be registered.";
    }
    return checkCommandAgainstCatalog(command, args, this.entries);
  }

  /** Presets for the registration form: catalog entries (approved only) and, in merge mode, the built-ins. */
  presets(): McpListedPreset[] {
    const catalog = this.entries.filter((entry) => entry.approved).map(toPreset);
    if (this.configured && this.options.mode === "exclusive") return catalog;
    const builtin: McpListedPreset[] = MCP_PRESETS.map((preset) => ({ ...preset, origin: "builtin" as const })).filter(
      (preset) =>
        // Under enforcement, a built-in stdio preset the catalog does not approve would only fail on save.
        preset.serverAdapter !== "stdio_mcp" ||
        !this.options.enforce ||
        this.checkStdioCommand(String(preset.connection.command), (preset.connection.args as unknown[] | undefined)?.map(String) ?? []) === null
    );
    return [...catalog, ...builtin];
  }
}
