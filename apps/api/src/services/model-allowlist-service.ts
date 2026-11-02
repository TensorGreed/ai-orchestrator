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
 * so every adapter call asks `gate(scope)` first. app.ts builds the
 * deployment's registry this way (no project: the deployment list), and each
 * run, gateway sampling call, provider test and eval judge call gets a view
 * for its project. A refused call throws `ModelNotAllowedError` (a node error
 * in runs, a sampling error on the gateway) and is audited once per run key,
 * node, provider and model.
 *
 * Replays answering from a model tape use `mode: "report"`: the check runs and
 * is reported to `onReport`, and the recorded answer is used anyway (a
 * recording is evidence of what happened, not a new call).
 *
 * The entries are read from the store on every check (a small, indexed table),
 * so a change applies to the next model call on every instance.
 */

import { randomUUID } from "node:crypto";
import {
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

/** Where a model call comes from, for the audit event. */
export type ModelCallSource = "run" | "gateway_sampling" | "provider_test" | "eval_judge" | "deployment";

export interface ModelAllowlistFinding {
  providerId: string;
  model: string;
  nodeId: string | null;
  refusedBy: "deployment" | "project";
  message: string;
}

export interface ModelAllowlistScope {
  /** The project whose list applies; null: the deployment list alone. */
  projectId: string | null;
  /** `enforce` (default) refuses; `report` only calls `onReport` (tape replays). */
  mode?: "enforce" | "report";
  source: ModelCallSource;
  /** Refusals are audited once per run key + node + provider + model (an execution id, a gateway session). */
  runKey?: string;
  executionId?: string;
  workflowId?: string;
  /** A gateway sampling call: the client and toolset, for the audit event. */
  clientId?: string;
  toolsetId?: string;
  onReport?: (finding: ModelAllowlistFinding) => void;
}

export interface ModelAllowlistServiceOptions {
  /** Writes an audit event with no request behind it (refused calls). */
  auditRaw: (event: AuditEventInput) => Promise<void>;
  logger?: (message: string, metadata?: Record<string, unknown>) => void;
}

const AUDITED_KEYS_MAX = 5_000;

export class ModelAllowlistService {
  private readonly auditedKeys = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly options: ModelAllowlistServiceOptions
  ) {}

  async list(): Promise<ModelAllowlistEntry[]> {
    return await this.store.listModelAllowlistEntries();
  }

  async evaluate(call: ModelAllowlistCall): Promise<ModelAllowlistDecision> {
    return evaluateModelAllowlist(await this.store.listModelAllowlistEntries(), call);
  }

  async add(input: ModelAllowlistEntryCreate, actor: string | null): Promise<ModelAllowlistEntry> {
    if (input.scope === "project" && input.projectId && !(await this.store.getProject(input.projectId))) {
      throw new ModelAllowlistError(404, "Project not found");
    }
    const entry: ModelAllowlistEntry = {
      id: `mal_${randomUUID()}`,
      scope: input.scope,
      projectId: input.scope === "project" ? (input.projectId ?? null) : null,
      providerId: input.providerId,
      modelGlob: input.modelGlob,
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
    return result.entry;
  }

  async remove(id: string): Promise<ModelAllowlistEntry | null> {
    return await this.store.deleteModelAllowlistEntry(id);
  }

  /** Builder warnings: each node whose saved model the allowlist refuses for the workflow's project. */
  async warningsFor(workflow: Pick<Workflow, "nodes" | "projectId">): Promise<WorkflowValidationIssue[]> {
    const references = workflowModelReferences(workflow);
    if (references.length === 0) return [];
    const entries = await this.store.listModelAllowlistEntries();
    if (entries.length === 0) return [];
    const projectId = workflow.projectId ?? "default";
    const issues: WorkflowValidationIssue[] = [];
    for (const reference of references) {
      const decision = evaluateModelAllowlist(entries, { providerId: reference.providerId, model: reference.model, projectId });
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

  /** The check every model call of `scope` runs before it reaches the provider. */
  gate(scope: ModelAllowlistScope): ModelCallGate {
    return async (call, context) => {
      const decision = await this.evaluate({ providerId: call.providerId, model: call.model, projectId: scope.projectId });
      if (decision.allowed) return;
      const nodeId = context?.callSite?.nodeId ?? null;
      const finding: ModelAllowlistFinding = { providerId: call.providerId, model: call.model, nodeId, refusedBy: decision.reason, message: decision.message };
      if (scope.mode === "report") {
        scope.onReport?.(finding);
        return;
      }
      await this.auditRefusal(scope, finding, call.operation);
      throw new ModelNotAllowedError(decision.message, {
        providerId: call.providerId,
        model: call.model,
        refusedBy: decision.reason,
        projectId: scope.projectId
      });
    };
  }

  /** `base` with every call checked for `scope`. */
  registry(base: ProviderRegistry, scope: ModelAllowlistScope): ProviderRegistry {
    return createGatedProviderRegistry(base, this.gate(scope));
  }

  private async auditRefusal(scope: ModelAllowlistScope, finding: ModelAllowlistFinding, operation: string): Promise<void> {
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
        projectId: scope.projectId,
        metadata: {
          providerId: finding.providerId,
          model: finding.model,
          refusedBy: finding.refusedBy,
          source: scope.source,
          operation,
          ...(finding.nodeId ? { nodeId: finding.nodeId } : {}),
          ...(scope.executionId ? { executionId: scope.executionId } : {}),
          ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
          ...(scope.clientId ? { clientId: scope.clientId } : {}),
          ...(scope.toolsetId ? { toolsetId: scope.toolsetId } : {})
        }
      });
    } catch (error) {
      // The refusal stands whether or not the audit write succeeded.
      this.options.logger?.("Could not audit a refused model call", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
