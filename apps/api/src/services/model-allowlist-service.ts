/**
 * 12.6 (D7) — model allowlists.
 *
 * Admin rows `{providerId, modelGlob}` at deployment scope and per project
 * (table `model_allowlist_entries`, v55). A model call is allowed when it
 * matches the deployment list (if it has entries) AND the project's list (if
 * it has entries); see `evaluateModelAllowlist` in the shared package. No
 * entries anywhere = every model allowed, as before.
 *
 * Enforcement is one seam: `registry(base, scope)` wraps a provider registry
 * so every adapter call asks `check(scope, …)` first, and `embeddingCheck`
 * does the same for RAG and knowledge-base embedders. app.ts gives each run,
 * gateway sampling call, provider test, eval judge call and knowledge-base
 * request a view for its project; the /v1 AI gateway calls `check` itself, once
 * per request, for its route set's project. A refused call throws `ModelNotAllowedError`
 * (a node error in runs, a sampling error on the gateway) and is audited once
 * per run key, node, provider and model.
 *
 * Replays answering from a model tape are not checked call by call: the
 * calls the tape answered are reported afterwards (`reportTapeAnswers`), and
 * a lenient replay's tape misses go live through an enforcing view.
 *
 * The entries live in an in-process snapshot, indexed by scope: loaded at
 * startup, replaced at once after a local edit, and re-read every
 * `refreshMs` (2 s) in the background so other instances' edits apply
 * within a few seconds. A model call never reads the store, except when no
 * snapshot was ever loaded. A failed re-read keeps the last good snapshot
 * (and is logged); with no snapshot at all a call is refused (fail closed).
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_PROJECT_ID,
  MODEL_ALLOWLIST_MAX_ENTRIES_PER_SCOPE,
  MODEL_NOT_ALLOWED_ISSUE_CODE,
  evaluateModelAllowlist,
  type ModelAllowlistCall,
  type ModelAllowlistDecision,
  type ModelAllowlistEntry,
  type ModelAllowlistEntryCreate,
  type Workflow,
  type WorkflowValidationIssue
} from "@ai-orchestrator/shared";
import { createGatedProviderRegistry, ModelNotAllowedError, type ModelCallGate, type ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { workflowModelReferences } from "@ai-orchestrator/workflow-engine";
import type { Store } from "../db/store.js";
import type { AuditEventInput } from "./audit-service.js";

export class ModelAllowlistError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "ModelAllowlistError";
  }
}

/** The allowlist could not be read and no earlier copy exists: the call is refused (fail closed). */
export class ModelAllowlistUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`The model allowlist could not be read, so the model call was refused: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ModelAllowlistUnavailableError";
  }
}

/**
 * Where a model call comes from, for the audit event. `deployment`: a call made through the deployment-wide registry
 * with no run, session or request behind it (a fallback; every built-in path has its own source).
 */
export type ModelCallSource = "run" | "gateway_sampling" | "ai_gateway" | "provider_test" | "eval_judge" | "knowledge_base" | "deployment";

export interface ModelAllowlistFinding {
  providerId: string;
  model: string;
  nodeId: string | null;
  refusedBy: "deployment" | "project";
  message: string;
}

/** One model call to check: a chat/completion call (`generate`, `stream`, `test`) or an embedding (`embed`). */
export interface ModelAllowlistCheck {
  providerId: string;
  model: string;
  operation: "generate" | "stream" | "test" | "embed";
  nodeId?: string | null;
}

export interface ModelAllowlistScope {
  /** The project whose list applies; null: the deployment list alone. */
  projectId: string | null;
  /** More projects whose lists apply too (each can only narrow): the provider test's secret's project. */
  alsoProjectIds?: string[];
  source: ModelCallSource;
  /** Refusals are audited once per run key + node + provider + model (an execution id, a gateway session). */
  runKey?: string;
  executionId?: string;
  /** An error workflow's run: the failed run that started it. */
  sourceExecutionId?: string;
  workflowId?: string;
  /** A gateway sampling call or a /v1 AI gateway request: the client (and toolset), for the audit event. */
  clientId?: string;
  toolsetId?: string;
  /** A knowledge-base request: the knowledge base. */
  knowledgeBaseId?: string;
}

export interface ModelAllowlistServiceOptions {
  /** Writes an audit event with no request behind it (refused calls). */
  auditRaw: (event: AuditEventInput) => Promise<void>;
  logger?: (message: string, metadata?: Record<string, unknown>) => void;
  /** How often the snapshot is re-read in the background (default 2000 ms). */
  refreshMs?: number;
}

interface Snapshot {
  deployment: ModelAllowlistEntry[];
  byProject: Map<string, ModelAllowlistEntry[]>;
  total: number;
}

const AUDITED_KEYS_MAX = 5_000;
export const MODEL_ALLOWLIST_REFRESH_MS = 2_000;

function snapshotOf(entries: ModelAllowlistEntry[]): Snapshot {
  const deployment: ModelAllowlistEntry[] = [];
  const byProject = new Map<string, ModelAllowlistEntry[]>();
  for (const entry of entries) {
    if (entry.scope === "deployment") {
      deployment.push(entry);
    } else if (entry.projectId) {
      const list = byProject.get(entry.projectId) ?? [];
      list.push(entry);
      byProject.set(entry.projectId, list);
    }
  }
  return { deployment, byProject, total: entries.length };
}

export class ModelAllowlistService {
  private readonly auditedKeys = new Set<string>();
  private snapshot: Snapshot | null = null;
  private loadedAt = 0;
  private loading: Promise<Snapshot> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly refreshMs: number;

  constructor(
    private readonly store: Store,
    private readonly options: ModelAllowlistServiceOptions
  ) {
    this.refreshMs = options.refreshMs ?? MODEL_ALLOWLIST_REFRESH_MS;
  }

  /** Loads the snapshot (a failure is logged; calls then load it themselves) and starts the background re-read. */
  async start(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // Logged by refresh; a model call loads the snapshot itself until one read succeeds.
    }
    if (!this.timer && this.refreshMs > 0) {
      this.timer = setInterval(() => {
        this.refresh().catch(() => undefined);
      }, this.refreshMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-reads the entries. On failure the last good snapshot stays (the error is logged and rethrown). */
  async refresh(): Promise<void> {
    await this.load();
  }

  private load(): Promise<Snapshot> {
    if (this.loading) return this.loading;
    const loading = (async () => {
      try {
        const next = snapshotOf(await this.store.listModelAllowlistEntries());
        this.snapshot = next;
        this.loadedAt = Date.now();
        return next;
      } catch (error) {
        this.options.logger?.(
          this.snapshot ? "Could not re-read the model allowlist; keeping the last copy" : "Could not read the model allowlist; model calls are refused until it can be read",
          { error: error instanceof Error ? error.message : String(error) }
        );
        throw error;
      } finally {
        this.loading = null;
      }
    })();
    this.loading = loading;
    return loading;
  }

  /** The snapshot; read from the store only when none was ever loaded (then a failure refuses the call). */
  private async current(): Promise<Snapshot> {
    if (this.snapshot) {
      // Not started (no background re-read): re-read here at most every `refreshMs`, keeping the copy on failure.
      if (!this.timer && this.refreshMs > 0 && Date.now() - this.loadedAt > this.refreshMs) {
        this.loadedAt = Date.now();
        return await this.load().catch(() => this.snapshot!);
      }
      return this.snapshot;
    }
    try {
      return await this.load();
    } catch (error) {
      throw new ModelAllowlistUnavailableError(error);
    }
  }

  /** Every entry (fresh from the store: the Security page). */
  async list(): Promise<ModelAllowlistEntry[]> {
    return await this.store.listModelAllowlistEntries();
  }

  private entriesFor(snapshot: Snapshot, projectId: string | null): ModelAllowlistEntry[] {
    const project = projectId ? snapshot.byProject.get(projectId) : undefined;
    return project ? [...snapshot.deployment, ...project] : snapshot.deployment;
  }

  private decide(snapshot: Snapshot, call: ModelAllowlistCall): ModelAllowlistDecision {
    return evaluateModelAllowlist(this.entriesFor(snapshot, call.projectId ?? null), call);
  }

  async evaluate(call: ModelAllowlistCall): Promise<ModelAllowlistDecision> {
    return this.decide(await this.current(), call);
  }

  async add(input: ModelAllowlistEntryCreate, actor: string | null): Promise<ModelAllowlistEntry> {
    if (input.scope === "project" && input.projectId && !(await this.store.getProject(input.projectId))) {
      throw new ModelAllowlistError(404, "Project not found");
    }
    const entry: ModelAllowlistEntry = {
      id: `mal_${randomUUID()}`,
      scope: input.scope,
      projectId: input.scope === "project" ? (input.projectId ?? null) : null,
      providerId: input.providerId.trim().toLowerCase(),
      modelGlob: input.modelGlob.trim().toLowerCase(),
      note: input.note ? input.note : null,
      createdAt: new Date().toISOString(),
      createdBy: actor
    };
    const result = await this.store.insertModelAllowlistEntry(entry, MODEL_ALLOWLIST_MAX_ENTRIES_PER_SCOPE);
    if (!result.ok) {
      throw result.reason === "duplicate"
        ? new ModelAllowlistError(409, "This provider and model pattern is already on the list")
        : new ModelAllowlistError(409, `A list holds at most ${MODEL_ALLOWLIST_MAX_ENTRIES_PER_SCOPE} entries`);
    }
    await this.refreshAfterEdit();
    return result.entry;
  }

  async remove(id: string): Promise<ModelAllowlistEntry | null> {
    const removed = await this.store.deleteModelAllowlistEntry(id);
    if (removed) await this.refreshAfterEdit();
    return removed;
  }

  /** A project was deleted (its entries went with it): drop them from the snapshot now. */
  async projectDeleted(): Promise<void> {
    await this.refreshAfterEdit();
  }

  /** A local edit applies to this instance's next call; if the re-read fails, the background re-read catches up. */
  private async refreshAfterEdit(): Promise<void> {
    try {
      // A re-read already in flight may have started before the edit: wait for it, then read again.
      if (this.loading) await this.loading.catch(() => undefined);
      await this.load();
    } catch {
      // Logged by load.
    }
  }

  /** Builder warnings: each node whose saved model the allowlist refuses for the workflow's project. */
  async warningsFor(workflow: Pick<Workflow, "nodes" | "projectId">): Promise<WorkflowValidationIssue[]> {
    const references = workflowModelReferences(workflow);
    if (references.length === 0) return [];
    const snapshot = await this.current();
    if (snapshot.total === 0) return [];
    const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
    const issues: WorkflowValidationIssue[] = [];
    for (const reference of references) {
      const decision = this.decide(snapshot, { providerId: reference.providerId, model: reference.model, projectId });
      if (decision.allowed) continue;
      issues.push({
        code: MODEL_NOT_ALLOWED_ISSUE_CODE,
        severity: "warning",
        nodeId: reference.nodeId,
        message: `${reference.nodeName}: ${decision.message} Runs will fail at this node until the model is allowed or changed.`
      });
    }
    return issues;
  }

  /** Refuses (throws `ModelNotAllowedError`) a model call of `scope` the allowlist does not allow. */
  async check(scope: ModelAllowlistScope, call: ModelAllowlistCheck): Promise<void> {
    const snapshot = await this.current();
    // No entries anywhere: nothing to check (the default).
    if (snapshot.total === 0) return;
    const projects = [scope.projectId, ...(scope.alsoProjectIds ?? [])].filter((value, index, all) => all.indexOf(value) === index);
    for (const projectId of projects) {
      const decision = this.decide(snapshot, { providerId: call.providerId, model: call.model, projectId });
      if (decision.allowed) continue;
      const finding: ModelAllowlistFinding = { providerId: call.providerId, model: call.model, nodeId: call.nodeId ?? null, refusedBy: decision.reason, message: decision.message };
      await this.auditRefusal(scope, projectId, finding, call.operation);
      throw new ModelNotAllowedError(decision.message, {
        providerId: call.providerId,
        model: call.model,
        refusedBy: decision.reason,
        projectId
      });
    }
  }

  /** The check every model call of `scope` runs before it reaches the provider. */
  gate(scope: ModelAllowlistScope): ModelCallGate {
    return async (call, context) =>
      await this.check(scope, { providerId: call.providerId, model: call.model, operation: call.operation, nodeId: context?.callSite?.nodeId ?? null });
  }

  /** The same check for an embedder's call (`openai`, `azure_openai`, `gemini`, `mistral`, `cohere`, `huggingface`). */
  embeddingCheck(scope: ModelAllowlistScope): (target: { providerId: string; model: string }, context: { nodeId: string | null }) => Promise<void> {
    return async (target, context) => await this.check(scope, { ...target, operation: "embed", nodeId: context.nodeId });
  }

  /** `base` with every call checked for `scope`. */
  registry(base: ProviderRegistry, scope: ModelAllowlistScope): ProviderRegistry {
    return createGatedProviderRegistry(base, this.gate(scope));
  }

  /**
   * A tape replay: the calls the tape answered (no request left the server), checked now and reported, never
   * refused. A read failure reports nothing; it never fails the replay.
   */
  async reportTapeAnswers(projectId: string | null, answers: ReadonlyArray<{ nodeId: string | null; providerId: string; model: string }>): Promise<ModelAllowlistFinding[]> {
    if (answers.length === 0) return [];
    let snapshot: Snapshot;
    try {
      snapshot = await this.current();
    } catch {
      return [];
    }
    if (snapshot.total === 0) return [];
    const findings: ModelAllowlistFinding[] = [];
    for (const answer of answers) {
      const decision = this.decide(snapshot, { providerId: answer.providerId, model: answer.model, projectId });
      if (!decision.allowed) findings.push({ ...answer, refusedBy: decision.reason, message: decision.message });
    }
    return findings;
  }

  private async auditRefusal(scope: ModelAllowlistScope, projectId: string | null, finding: ModelAllowlistFinding, operation: string): Promise<void> {
    if (scope.runKey) {
      const key = JSON.stringify([scope.runKey, finding.nodeId, finding.providerId, finding.model]);
      if (this.auditedKeys.has(key)) return;
      if (this.auditedKeys.size >= AUDITED_KEYS_MAX) this.auditedKeys.delete(this.auditedKeys.values().next().value!);
      this.auditedKeys.add(key);
    }
    try {
      await this.options.auditRaw({
        category: "system",
        eventType: "model_allowlist.call_denied",
        action: "execute",
        outcome: "denied",
        actor: { type: "system" },
        resourceType: "model",
        resourceId: `${finding.providerId}:${finding.model}`,
        projectId,
        metadata: {
          providerId: finding.providerId,
          model: finding.model,
          refusedBy: finding.refusedBy,
          source: scope.source,
          operation,
          ...(finding.nodeId ? { nodeId: finding.nodeId } : {}),
          ...(scope.executionId ? { executionId: scope.executionId } : {}),
          ...(scope.sourceExecutionId ? { sourceExecutionId: scope.sourceExecutionId } : {}),
          ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
          ...(scope.clientId ? { clientId: scope.clientId } : {}),
          ...(scope.toolsetId ? { toolsetId: scope.toolsetId } : {}),
          ...(scope.knowledgeBaseId ? { knowledgeBaseId: scope.knowledgeBaseId } : {})
        }
      });
    } catch (error) {
      // The refusal stands whether or not the audit write succeeded.
      this.options.logger?.("Could not audit a refused model call", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
