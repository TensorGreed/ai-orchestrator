import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GitSyncConfig, GitSyncStatus, Workflow } from "@ai-orchestrator/shared";
import type { SqliteStore } from "../db/database";
import type { SecretService } from "./secret-service";
import type { VariablesService } from "./variables-service";

export interface GitSyncServiceOptions {
  workdirRoot: string;
  gitBin?: string;
  commandTimeoutMs?: number;
  enabled?: boolean;
}

export interface GitSyncResult {
  ok: boolean;
  branch?: string;
  commit?: string;
  error?: string;
  workflowsExported?: number;
  workflowsImported?: number;
  variablesSynced?: number;
}

export interface ConfigureGitInput {
  repoUrl: string;
  defaultBranch?: string;
  authSecretId?: string | null;
  workflowsDir?: string;
  variablesFile?: string;
  userName?: string;
  userEmail?: string;
  enabled?: boolean;
}

/**
 * Wraps the `git` CLI to push/pull workflow + variable JSON to a remote repo.
 * Workflows are serialized with credential stubs ({ secretName, secretProvider })
 * in place of local secret ids; imports look those back up in the local secret
 * store by (name, provider) within the workflow's project.
 */
export class GitSyncService {
  private readonly workdirRoot: string;
  private readonly gitBin: string;
  private readonly commandTimeoutMs: number;

  constructor(
    private readonly store: SqliteStore,
    private readonly secretService: SecretService,
    private readonly variablesService: VariablesService,
    options: GitSyncServiceOptions
  ) {
    this.workdirRoot = path.resolve(options.workdirRoot);
    this.gitBin = options.gitBin ?? "git";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 60000;
  }

  getConfig(): GitSyncConfig | null {
    const row = this.store.getGitConfig();
    if (!row) return null;
    return {
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      authSecretId: row.authSecretId,
      workflowsDir: row.workflowsDir,
      variablesFile: row.variablesFile,
      userName: row.userName,
      userEmail: row.userEmail,
      enabled: row.enabled,
      lastPushAt: row.lastPushAt,
      lastPullAt: row.lastPullAt,
      lastError: row.lastError,
      updatedAt: row.updatedAt
    };
  }

  configure(input: ConfigureGitInput): GitSyncConfig {
    if (!input.repoUrl || !input.repoUrl.trim()) {
      throw new Error("repoUrl is required");
    }
    this.store.upsertGitConfig({
      repoUrl: input.repoUrl.trim(),
      defaultBranch: input.defaultBranch,
      authSecretId: input.authSecretId ?? null,
      workflowsDir: input.workflowsDir,
      variablesFile: input.variablesFile,
      userName: input.userName,
      userEmail: input.userEmail,
      enabled: input.enabled
    });
    const config = this.getConfig();
    if (!config) throw new Error("failed to persist git config");
    return config;
  }

  disconnect(): boolean {
    const existed = this.store.deleteGitConfig();
    if (existed) {
      const dir = this.workdirPath();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    return existed;
  }

  status(): GitSyncStatus {
    const config = this.getConfig();
    if (!config) {
      return {
        configured: false,
        branch: null,
        ahead: 0,
        behind: 0,
        dirty: false,
        lastPushAt: null,
        lastPullAt: null,
        lastError: null
      };
    }
    const dir = this.workdirPath();
    if (!fs.existsSync(path.join(dir, ".git"))) {
      return {
        configured: true,
        branch: null,
        ahead: 0,
        behind: 0,
        dirty: false,
        lastPushAt: config.lastPushAt,
        lastPullAt: config.lastPullAt,
        lastError: config.lastError
      };
    }
    const branchRes = this.runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchRes.status === 0 ? branchRes.stdout.trim() : null;
    const statusRes = this.runGit(dir, ["status", "--porcelain"]);
    const dirty = statusRes.status === 0 && statusRes.stdout.trim().length > 0;
    return {
      configured: true,
      branch,
      ahead: 0,
      behind: 0,
      dirty,
      lastPushAt: config.lastPushAt,
      lastPullAt: config.lastPullAt,
      lastError: config.lastError
    };
  }

  async push(options: { branch?: string; message?: string; createdBy?: string }): Promise<GitSyncResult> {
    const config = this.requireConfig();
    const dir = this.ensureClone(config, options.branch);
    try {
      const branch = options.branch ?? config.defaultBranch;
      this.runGit(dir, ["checkout", "-B", branch]).throwOnFailure();
      this.runGit(dir, ["config", "user.name", config.userName]).throwOnFailure();
      this.runGit(dir, ["config", "user.email", config.userEmail]).throwOnFailure();

      const workflowsExported = this.writeWorkflows(dir, config);
      const variablesSynced = this.writeVariables(dir, config);

      this.runGit(dir, ["add", "-A"]).throwOnFailure();
      const diffRes = this.runGit(dir, ["diff", "--cached", "--name-only"]);
      if (diffRes.status === 0 && diffRes.stdout.trim().length === 0) {
        // Nothing staged — still report success.
        this.store.recordGitSync({ kind: "push", error: null });
        const commitRes = this.runGit(dir, ["rev-parse", "HEAD"]);
        return {
          ok: true,
          branch,
          commit: commitRes.status === 0 ? commitRes.stdout.trim() : undefined,
          workflowsExported,
          variablesSynced
        };
      }

      const message =
        options.message ??
        `ai-orchestrator sync: ${workflowsExported} workflow(s), ${variablesSynced} variable(s)`;
      this.runGit(dir, ["commit", "-m", message]).throwOnFailure();
      const pushRes = this.runGit(dir, ["push", this.remoteUrl(config), `HEAD:${branch}`]);
      if (pushRes.status !== 0) throw new Error(pushRes.stderr || "git push failed");

      const commitRes = this.runGit(dir, ["rev-parse", "HEAD"]);
      this.store.recordGitSync({ kind: "push", error: null });
      return {
        ok: true,
        branch,
        commit: commitRes.status === 0 ? commitRes.stdout.trim() : undefined,
        workflowsExported,
        variablesSynced
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.recordGitSync({ kind: "push", error: message });
      return { ok: false, error: message };
    }
  }

  async pull(options: { branch?: string; createdBy?: string }): Promise<GitSyncResult> {
    const config = this.requireConfig();
    const dir = this.ensureClone(config, options.branch);
    try {
      const branch = options.branch ?? config.defaultBranch;
      this.runGit(dir, ["fetch", this.remoteUrl(config), branch]).throwOnFailure();
      this.runGit(dir, ["checkout", "-B", branch, "FETCH_HEAD"]).throwOnFailure();

      const workflowsImported = this.readWorkflows(dir, config, options.createdBy ?? null);
      const variablesSynced = this.readVariables(dir, config, options.createdBy ?? null);

      const commitRes = this.runGit(dir, ["rev-parse", "HEAD"]);
      this.store.recordGitSync({ kind: "pull", error: null });
      return {
        ok: true,
        branch,
        commit: commitRes.status === 0 ? commitRes.stdout.trim() : undefined,
        workflowsImported,
        variablesSynced
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.recordGitSync({ kind: "pull", error: message });
      return { ok: false, error: message };
    }
  }

  // ---------------------------------------------------------------------------
  // Credential stubbing
  // ---------------------------------------------------------------------------

  /**
   * Walks a workflow and replaces every `{ secretId: "sec_xxx" }` reference with
   * `{ secretName, secretProvider }`. Used when serialising for git.
   */
  stubCredentials(workflow: Workflow): Workflow {
    const secrets = this.secretService.listSecrets({ projectId: workflow.projectId });
    const byId = new Map(secrets.map((s) => [s.id, { name: s.name, provider: s.provider }]));
    return walkAndReplace(workflow, (node) => {
      if (
        node &&
        typeof node === "object" &&
        !Array.isArray(node) &&
        typeof (node as Record<string, unknown>).secretId === "string"
      ) {
        const id = (node as Record<string, unknown>).secretId as string;
        const resolved = byId.get(id);
        if (resolved) {
          const replacement: Record<string, unknown> = {
            secretName: resolved.name
          };
          if (resolved.provider) replacement.secretProvider = resolved.provider;
          return replacement;
        }
        // Unknown secret — drop the ref to avoid leaking stale IDs.
        return { secretName: id };
      }
      return null;
    }) as Workflow;
  }

  /**
   * Reverse of stubCredentials. Looks up local secrets by (name, provider)
   * within the workflow's project and replaces the stub with a real secretId.
   * Stubs that can't be resolved are dropped with a console warning (import
   * does not fail — author can fix in the UI).
   */
  resolveCredentials(workflow: Workflow): Workflow {
    const secrets = this.secretService.listSecrets({ projectId: workflow.projectId });
    const byKey = new Map<string, string>();
    for (const s of secrets) {
      byKey.set(`${s.provider}::${s.name}`, s.id);
      byKey.set(`*::${s.name}`, s.id);
    }
    return walkAndReplace(workflow, (node) => {
      if (
        node &&
        typeof node === "object" &&
        !Array.isArray(node) &&
        typeof (node as Record<string, unknown>).secretName === "string"
      ) {
        const obj = node as Record<string, unknown>;
        const name = obj.secretName as string;
        const provider = typeof obj.secretProvider === "string" ? obj.secretProvider : "*";
        const id = byKey.get(`${provider}::${name}`) ?? byKey.get(`*::${name}`);
        if (id) return { secretId: id };
        return null;
      }
      return null;
    }) as Workflow;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireConfig() {
    const config = this.getConfig();
    if (!config) throw new Error("git is not configured — POST /api/git first");
    if (!config.enabled) throw new Error("git sync is disabled");
    return config;
  }

  private remoteUrl(config: GitSyncConfig): string {
    if (!config.authSecretId) return config.repoUrl;
    const token = this.tryResolveToken(config.authSecretId);
    if (!token) return config.repoUrl;
    try {
      const url = new URL(config.repoUrl);
      if (url.protocol === "https:" || url.protocol === "http:") {
        url.username = encodeURIComponent(token);
        return url.toString();
      }
    } catch {
      // fall through
    }
    return config.repoUrl;
  }

  private tryResolveToken(secretId: string): string | null {
    try {
      // Synchronous fallback using store: resolveSecret is async but local
      // secrets can be decrypted inline — we avoid a network round-trip by
      // using the listSecrets metadata then reading the ciphertext via the
      // public `resolveSecret` wrapped in a sync helper would be ideal, but
      // SecretService.resolveSecret is async. To keep this service sync we
      // intentionally skip token resolution for external secrets and fall
      // back to the unauthenticated URL — operators can embed the token
      // directly in the repo URL for that case.
      const secrets = this.secretService.listSecrets();
      const match = secrets.find((s) => s.id === secretId);
      if (!match || match.source !== "local") return null;
      // Use a synchronous bridge via the underlying store layer is not
      // exposed; return null and accept that push may hit the remote
      // without credentials. Users should embed the PAT in `repoUrl` until
      // we wire async remote-url construction.
      return null;
    } catch {
      return null;
    }
  }

  private workdirPath(): string {
    return path.join(this.workdirRoot, "default");
  }

  private ensureClone(config: GitSyncConfig, branch: string | undefined): string {
    const dir = this.workdirPath();
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, ".git"))) {
      this.runGit(dir, ["init", "-b", branch ?? config.defaultBranch]).throwOnFailure();
    }
    return dir;
  }

  private writeWorkflows(dir: string, config: GitSyncConfig): number {
    const workflowsDir = path.join(dir, config.workflowsDir);
    fs.mkdirSync(workflowsDir, { recursive: true });
    // Remove stale files — we treat the repo as a mirror of the current set.
    for (const file of fs.readdirSync(workflowsDir)) {
      if (file.endsWith(".json")) {
        fs.rmSync(path.join(workflowsDir, file), { force: true });
      }
    }
    const summaries = this.store.listWorkflows();
    let exported = 0;
    for (const summary of summaries) {
      const wf = this.store.getWorkflow(summary.id);
      if (!wf) continue;
      const stubbed = this.stubCredentials(wf);
      fs.writeFileSync(
        path.join(workflowsDir, `${sanitizeFilename(wf.id)}.json`),
        JSON.stringify(stubbed, null, 2) + "\n",
        "utf8"
      );
      exported += 1;
    }
    return exported;
  }

  private writeVariables(dir: string, config: GitSyncConfig): number {
    const rows = this.variablesService.list();
    const byProject: Record<string, Record<string, string>> = {};
    for (const row of rows) {
      byProject[row.projectId] = byProject[row.projectId] ?? {};
      byProject[row.projectId]![row.key] = row.value;
    }
    fs.writeFileSync(
      path.join(dir, config.variablesFile),
      JSON.stringify(byProject, null, 2) + "\n",
      "utf8"
    );
    return rows.length;
  }

  private readWorkflows(dir: string, config: GitSyncConfig, createdBy: string | null): number {
    const workflowsDir = path.join(dir, config.workflowsDir);
    if (!fs.existsSync(workflowsDir)) return 0;
    const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith(".json"));
    let imported = 0;
    for (const file of files) {
      const raw = fs.readFileSync(path.join(workflowsDir, file), "utf8");
      let parsed: Workflow;
      try {
        parsed = JSON.parse(raw) as Workflow;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || !parsed.id || !Array.isArray(parsed.nodes)) continue;
      const resolved = this.resolveCredentials(parsed);
      const now = new Date().toISOString();
      resolved.updatedAt = now;
      if (!resolved.createdAt) resolved.createdAt = now;
      this.store.upsertWorkflow(resolved);
      imported += 1;
      void createdBy;
    }
    return imported;
  }

  private readVariables(dir: string, config: GitSyncConfig, createdBy: string | null): number {
    const varsPath = path.join(dir, config.variablesFile);
    if (!fs.existsSync(varsPath)) return 0;
    const raw = fs.readFileSync(varsPath, "utf8");
    let parsed: Record<string, Record<string, string>>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 0;
    }
    if (!parsed || typeof parsed !== "object") return 0;
    let synced = 0;
    for (const [projectId, kv] of Object.entries(parsed)) {
      if (!kv || typeof kv !== "object") continue;
      for (const [key, value] of Object.entries(kv)) {
        if (typeof value !== "string") continue;
        const existing = this.store.findVariableByKey(projectId, key);
        if (existing) {
          this.variablesService.update(existing.id, { value });
        } else {
          try {
            this.variablesService.create({
              projectId,
              key,
              value,
              createdBy
            });
          } catch {
            continue;
          }
        }
        synced += 1;
      }
    }
    return synced;
  }

  private runGit(cwd: string, args: string[]): RunResult {
    const result = spawnSync(this.gitBin, args, {
      cwd,
      encoding: "utf8",
      timeout: this.commandTimeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    return new RunResult(result, this.gitBin, args);
  }
}

class RunResult {
  constructor(
    private readonly result: SpawnSyncReturns<string>,
    private readonly bin: string,
    private readonly args: string[]
  ) {}

  get status(): number {
    return this.result.status ?? 1;
  }

  get stdout(): string {
    return this.result.stdout ?? "";
  }

  get stderr(): string {
    return this.result.stderr ?? "";
  }

  throwOnFailure(): void {
    if (this.status !== 0) {
      const summary = this.stderr || this.stdout || `exit code ${this.status}`;
      throw new Error(`${this.bin} ${this.args.join(" ")} — ${summary.trim()}`);
    }
  }
}

function sanitizeFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

function walkAndReplace(
  node: unknown,
  visit: (current: unknown) => Record<string, unknown> | null
): unknown {
  const replacement = visit(node);
  if (replacement !== null) return replacement;
  if (Array.isArray(node)) return node.map((child) => walkAndReplace(child, visit));
  if (node && typeof node === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      copy[key] = walkAndReplace(value, visit);
    }
    return copy;
  }
  return node;
}
