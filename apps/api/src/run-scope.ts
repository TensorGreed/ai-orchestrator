/**
 * Project scope of a running workflow: what a run may reach at run time.
 *
 * Route checks (run-access.ts) decide who may start a run. This module
 * decides what the run itself can touch once it is going, by the project of
 * the workflow that is executing:
 *
 *   - Sub-workflows and error workflows: the same project, a workflow without
 *     a project, a workflow shared to the caller's project with `execute`, or
 *     one the run's user may execute. Anything else fails with a clear error.
 *   - Secrets: the workflow's project, the default project (shared), or a
 *     secret shared to the workflow's project. The run's user, when there is
 *     one, also needs `secret:use` in the workflow's project.
 *   - Session memory, the session tool cache and session artifacts: keys are
 *     prefixed with the project, so two projects never see each other's
 *     sessions even when they pick the same namespace. Rows written before
 *     the prefix existed are still read (never written) where they can only
 *     belong to this workflow: from the default project, or under the
 *     workflow's own default namespace (`<workflowId>:<nodeId>`).
 *
 * A sub-workflow gets its own scope (its project's secrets, knowledge bases
 * and session keys) through the engine's `scopeSubWorkflow` hook.
 */

import { DEFAULT_PROJECT_ID, type SecretReference, type Workflow } from "@ai-orchestrator/shared";
import type {
  AgentSessionArtifactStore,
  KnowledgeBaseStore,
  WorkflowExecutionDependencies
} from "@ai-orchestrator/workflow-engine";
import type { SafeUser } from "./services/auth-service.js";

type MemoryStore = NonNullable<WorkflowExecutionDependencies["memoryStore"]>;
type ToolDataStore = NonNullable<WorkflowExecutionDependencies["toolDataStore"]>;
type ChatMessages = Awaited<ReturnType<MemoryStore["loadMessages"]>>;
type ToolCallInput = Parameters<ToolDataStore["saveToolCall"]>[0];
type ToolCallRecord = Awaited<ReturnType<ToolDataStore["saveToolCall"]>>;
type ToolCallSummary = Awaited<ReturnType<ToolDataStore["listToolCalls"]>>[number];
type ArtifactRecord = NonNullable<Awaited<ReturnType<AgentSessionArtifactStore["loadArtifact"]>>>;

export interface RunScopeDeps {
  getWorkflow: (id: string) => Workflow | null | undefined;
  /** Workflow shares as stored: which project gets which access level. */
  listWorkflowShares: (workflowId: string) => Array<{ projectId: string; accessLevel: string }>;
  /** May this user execute the workflow (project role or share)? */
  canExecuteWorkflow: (user: SafeUser, workflow: Workflow) => boolean;
  /** The secret's project (the default project when it has none), or null if it does not exist. */
  getSecretProjectId: (secretId: string) => string | null;
  listSecretIdsSharedToProject: (projectId: string) => string[];
  canUseSecretsInProject: (user: SafeUser, projectId: string) => boolean;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  knowledgeBaseStoreFor: (projectId: string | null | undefined) => KnowledgeBaseStore;
  sessions: {
    loadMemory: (namespace: string, sessionId: string) => ChatMessages;
    saveMemory: (namespace: string, sessionId: string, messages: ChatMessages) => void;
    saveToolCall: (input: ToolCallInput) => ToolCallRecord;
    listToolCalls: (input: { namespace: string; sessionId: string; toolName?: string; limit?: number }) => ToolCallSummary[];
    getToolCall: (input: { namespace: string; sessionId: string; id: string }) => ToolCallRecord | null;
    saveArtifact: (input: { namespace: string; sessionId: string; artifactKey: string; value: unknown }) => ArtifactRecord;
    loadArtifact: (input: { namespace: string; sessionId: string; artifactKey: string }) => ArtifactRecord | null;
  };
}

export type ScopedRunDependencies = Required<
  Pick<
    WorkflowExecutionDependencies,
    "loadWorkflow" | "scopeSubWorkflow" | "resolveSecret" | "knowledgeBaseStore" | "memoryStore" | "toolDataStore" | "sessionArtifactStore"
  >
>;

/** The stored key for a namespace in a project. The length prefix keeps it unambiguous. */
export function projectSessionNamespace(projectId: string, namespace: string): string {
  return `project:${projectId.length}:${projectId}:${namespace}`;
}

export function createRunScope(deps: RunScopeDeps) {
  /**
   * May `caller` (running for `actor`, if a user started the run) load
   * `targetId` as a sub-workflow or error workflow? Throws a clear error when not.
   */
  const loadWorkflowFor = (caller: Workflow, actor: SafeUser | null | undefined, purpose: "Sub-workflow" | "Error workflow") => (targetId: string): Workflow | undefined => {
    const target = deps.getWorkflow(targetId);
    if (!target) return undefined;
    if (!target.projectId) return target;
    const callerProject = caller.projectId ?? DEFAULT_PROJECT_ID;
    if (target.projectId === callerProject) return target;
    if (deps.listWorkflowShares(target.id).some((share) => share.projectId === callerProject && share.accessLevel === "execute")) return target;
    if (actor && deps.canExecuteWorkflow(actor, target)) return target;
    throw new Error(
      `${purpose} '${targetId}' is in another project and is not shared to this workflow's project with execute access, so this run cannot call it.`
    );
  };

  const resolveSecretFor = (workflow: Workflow, actor: SafeUser | null | undefined) => async (secretRef?: SecretReference) => {
    if (!secretRef?.secretId) return undefined;
    const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
    const secretProject = deps.getSecretProjectId(secretRef.secretId);
    if (secretProject === null) return undefined;
    const visible =
      secretProject === DEFAULT_PROJECT_ID ||
      secretProject === projectId ||
      deps.listSecretIdsSharedToProject(projectId).includes(secretRef.secretId);
    if (!visible) {
      throw new Error(`Secret '${secretRef.secretId}' belongs to another project and is not shared to this workflow's project.`);
    }
    if (actor && actor.role !== "admin" && !deps.canUseSecretsInProject(actor, projectId)) {
      throw new Error(`Permission 'secret:use' is required in this workflow's project to use secret '${secretRef.secretId}'.`);
    }
    return deps.resolveSecret(secretRef);
  };

  const sessionStoresFor = (workflow: Workflow) => {
    const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
    const key = (namespace: string) => projectSessionNamespace(projectId, namespace);
    // Unprefixed rows from before project scoping, read only where they can be this workflow's own.
    const legacyReadable = (namespace: string) => projectId === DEFAULT_PROJECT_ID || namespace.startsWith(`${workflow.id}:`);
    const asCaller = <T extends { namespace: string }>(row: T, namespace: string): T => ({ ...row, namespace });

    const memoryStore: ScopedRunDependencies["memoryStore"] = {
      loadMessages: async (namespace, sessionId) => {
        const messages = deps.sessions.loadMemory(key(namespace), sessionId);
        if (messages.length > 0 || !legacyReadable(namespace)) return messages;
        return deps.sessions.loadMemory(namespace, sessionId);
      },
      saveMessages: async (namespace, sessionId, messages) => {
        deps.sessions.saveMemory(key(namespace), sessionId, messages);
      }
    };

    const toolDataStore: ScopedRunDependencies["toolDataStore"] = {
      saveToolCall: async (input) => asCaller(deps.sessions.saveToolCall({ ...input, namespace: key(input.namespace) }), input.namespace),
      listToolCalls: async (input) => {
        const rows = deps.sessions.listToolCalls({ ...input, namespace: key(input.namespace) });
        const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 20;
        if (!legacyReadable(input.namespace) || rows.length >= limit) return rows.map((row) => asCaller(row, input.namespace));
        const legacy = deps.sessions.listToolCalls(input);
        return [...rows, ...legacy]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit)
          .map((row) => asCaller(row, input.namespace));
      },
      getToolCall: async (input) => {
        const row =
          deps.sessions.getToolCall({ ...input, namespace: key(input.namespace) }) ??
          (legacyReadable(input.namespace) ? deps.sessions.getToolCall(input) : null);
        return row ? asCaller(row, input.namespace) : null;
      }
    };

    const sessionArtifactStore: ScopedRunDependencies["sessionArtifactStore"] = {
      saveArtifact: async (input) => asCaller(deps.sessions.saveArtifact({ ...input, namespace: key(input.namespace) }), input.namespace),
      loadArtifact: async (input) => {
        const row =
          deps.sessions.loadArtifact({ ...input, namespace: key(input.namespace) }) ??
          (legacyReadable(input.namespace) ? deps.sessions.loadArtifact(input) : null);
        return row ? asCaller(row, input.namespace) : null;
      }
    };

    return { memoryStore, toolDataStore, sessionArtifactStore };
  };

  /** Everything project-scoped a run of `workflow` needs; sub-workflows get their own. */
  const dependenciesFor = (workflow: Workflow, actor?: SafeUser | null): ScopedRunDependencies => ({
    loadWorkflow: loadWorkflowFor(workflow, actor, "Sub-workflow"),
    scopeSubWorkflow: (child) => dependenciesFor(child, actor),
    resolveSecret: resolveSecretFor(workflow, actor),
    knowledgeBaseStore: deps.knowledgeBaseStoreFor(workflow.projectId),
    ...sessionStoresFor(workflow)
  });

  return {
    dependenciesFor,
    /** The error workflow `failing` may hand its failure to, or a reason it may not. */
    errorWorkflowFor(failing: Workflow, actor: SafeUser | null | undefined, errorWorkflowId: string): { workflow: Workflow } | { error: string } {
      try {
        const workflow = loadWorkflowFor(failing, actor, "Error workflow")(errorWorkflowId);
        return workflow ? { workflow } : { error: `Error workflow '${errorWorkflowId}' was not found.` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

export type RunScope = ReturnType<typeof createRunScope>;
