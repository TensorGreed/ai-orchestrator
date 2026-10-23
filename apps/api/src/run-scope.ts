/**
 * Project scope of a running workflow: what a run may reach at run time.
 *
 * Route checks (run-access.ts) decide who may start a run. This module
 * decides what the run itself can touch once it is going, by the project of
 * the workflow that is executing:
 *
 *   - Sub-workflows and error workflows: the same project, a workflow without
 *     a project, or a workflow its owner shared to the caller's project with
 *     `execute`. Anything else fails with a clear error. Who started the run
 *     does not matter: an admin approving or retrying a builder's run must not
 *     widen what that run can call.
 *   - Secrets: the workflow's project, a secret shared to the workflow's
 *     project, and, in `role` isolation only, the default project (shared).
 *     The run's user, when there is one, also needs `secret:use` in the
 *     workflow's project or in a project the workflow is shared to with
 *     `execute`.
 *   - Registry MCP servers: one with a project is usable only from that
 *     project (the default project's servers count as shared in `role`
 *     isolation, like its secrets).
 *   - Session memory, the session tool cache and session artifacts: keys are
 *     prefixed with the project, so two projects never see each other's
 *     sessions even when they pick the same namespace. Rows written before
 *     the prefix existed are still read (never written), only from a
 *     workflow's exact own default namespace (`<workflowId>:<nodeId>`) or,
 *     from the default project, a namespace no workflow of another project
 *     claims.
 *
 * Phase 15.4 — a run carries its release channel: a production run (a
 * production webhook, a schedule, the MCP gateway...) loads the published
 * version of each sub-workflow and error workflow it calls, a draft run (the
 * editor, a manual run, `/webhook-test/`) loads the drafts. Without a
 * published version both load the draft.
 *
 * A sub-workflow gets its own scope (its project's secrets, knowledge bases
 * and session keys) through the engine's `scopeSubWorkflow` hook. The run's
 * user carries over only to a child in the same project; a child in another
 * project runs on its owner's execute share, not on the user.
 */

import { DEFAULT_PROJECT_ID, type MCPServerConfig, type ReleaseChannel, type SecretReference, type Workflow } from "@ai-orchestrator/shared";
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

/** Where a secret is used from: a workflow, or just a project (no workflow, so no shares). */
export type SecretScope = { id?: string; projectId?: string | null };

export interface RunScopeDeps {
  getWorkflow: (id: string) => Workflow | null | undefined;
  /** Phase 15.4 — the version an entry point on `channel` runs; without it every channel loads the draft. */
  getRunnableWorkflow?: (id: string, channel: ReleaseChannel) => Workflow | null | undefined;
  /** Phase 15.4 — why production refuses an existing workflow (a deactivated gated one), so a production parent fails with that reason. */
  productionRefusal?: (id: string) => string | null;
  /** Workflow shares as stored: which project gets which access level. */
  listWorkflowShares: (workflowId: string) => Array<{ projectId: string; accessLevel: string }>;
  /** The secret's project (the default project when it has none), or null if it does not exist. */
  getSecretProjectId: (secretId: string) => string | null;
  listSecretIdsSharedToProject: (projectId: string) => string[];
  canUseSecretsInProject: (user: SafeUser, projectId: string) => boolean;
  /**
   * Do default-project secrets and MCP servers count as shared with every
   * project? True in `role` isolation; in `strict` they need an explicit share.
   */
  defaultSecretsShared: boolean;
  /** A registry MCP server's project (null when it has none), or undefined if it does not exist. */
  getMcpServerProjectId: (serverId: string) => string | null | undefined;
  resolveRegisteredMcpServer: McpServerResolver;
  /**
   * Projects of the workflows that claim a pre-scoping session namespace:
   * as their default `<workflowId>:<nodeId>` or as a literal custom namespace.
   */
  legacyNamespaceOwnerProjects: (namespace: string) => string[];
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

type McpServerResolver = (registryServerId: string) => MCPServerConfig | Promise<MCPServerConfig>;

export type ScopedRunDependencies = Required<
  Pick<
    WorkflowExecutionDependencies,
    | "loadWorkflow"
    | "scopeSubWorkflow"
    | "resolveSecret"
    | "resolveRegisteredMcpServer"
    | "knowledgeBaseStore"
    | "memoryStore"
    | "toolDataStore"
    | "sessionArtifactStore"
  >
>;

export interface RunScopeOptions {
  /** The run's user, if a user started (or approved, or retried) it. */
  actor?: SafeUser | null;
  /** Registry server lookup for this run (a cassette plan's, for recorded runs); inherited by sub-workflows. */
  resolveRegisteredMcpServer?: McpServerResolver;
  /** Phase 15.4 — the run's release channel (default `draft`); inherited by sub-workflows. */
  channel?: ReleaseChannel;
}

/** The stored key for a namespace in a project. The length prefix keeps it unambiguous. */
export function projectSessionNamespace(projectId: string, namespace: string): string {
  return `project:${projectId.length}:${projectId}:${namespace}`;
}

export function createRunScope(deps: RunScopeDeps) {
  /**
   * May `caller` load `targetId` as a sub-workflow or error workflow? Only the
   * projects decide, never the run's user. Throws a clear error when not.
   */
  const loadWorkflowFor = (caller: Workflow, purpose: "Sub-workflow" | "Error workflow", channel: ReleaseChannel = "draft") => (targetId: string): Workflow | undefined => {
    const target = channel === "production" && deps.getRunnableWorkflow ? deps.getRunnableWorkflow(targetId, "production") : deps.getWorkflow(targetId);
    if (!target) {
      const refusal = channel === "production" ? deps.productionRefusal?.(targetId) : null;
      if (refusal) throw new Error(`${purpose} '${targetId}': ${refusal}`);
      return undefined;
    }
    if (!target.projectId) return target;
    const callerProject = caller.projectId ?? DEFAULT_PROJECT_ID;
    if (target.projectId === callerProject) return target;
    if (deps.listWorkflowShares(target.id).some((share) => share.projectId === callerProject && share.accessLevel === "execute")) return target;
    throw new Error(
      `${purpose} '${targetId}' is in another project and is not shared to this workflow's project with execute access, so this run cannot call it.`
    );
  };

  // The default project's secrets and servers are shared only in `role` isolation.
  const sharedFromDefault = (ownerProject: string) => deps.defaultSecretsShared && ownerProject === DEFAULT_PROJECT_ID;

  // `secret:use` where the workflow lives, or where it is shared to with
  // execute: an execute share is how another project's users run it.
  const actorMayUseSecrets = (workflow: SecretScope, actor: SafeUser) =>
    deps.canUseSecretsInProject(actor, workflow.projectId ?? DEFAULT_PROJECT_ID) ||
    (workflow.id ? deps.listWorkflowShares(workflow.id) : [])
      .some((share) => share.accessLevel === "execute" && deps.canUseSecretsInProject(actor, share.projectId));

  /**
   * Why a run of `workflow` as `actor` may not use this secret, or null when
   * it may (or the secret does not exist, which resolves to nothing).
   */
  const secretProblem = (workflow: SecretScope, actor: SafeUser | null | undefined, secretId: string): string | null => {
    const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
    const secretProject = deps.getSecretProjectId(secretId);
    if (secretProject === null) return null;
    const visible =
      secretProject === projectId || sharedFromDefault(secretProject) || deps.listSecretIdsSharedToProject(projectId).includes(secretId);
    if (!visible) return `Secret '${secretId}' belongs to another project and is not shared to this workflow's project.`;
    if (actor && actor.role !== "admin" && !actorMayUseSecrets(workflow, actor)) {
      return `Permission 'secret:use' is required in this workflow's project to use secret '${secretId}'.`;
    }
    return null;
  };

  const resolveSecretFor = (workflow: Workflow, actor: SafeUser | null | undefined) => async (secretRef?: SecretReference) => {
    if (!secretRef?.secretId) return undefined;
    if (deps.getSecretProjectId(secretRef.secretId) === null) return undefined;
    const problem = secretProblem(workflow, actor, secretRef.secretId);
    if (problem) throw new Error(problem);
    return deps.resolveSecret(secretRef);
  };

  const mcpServerResolverFor = (workflow: Workflow, base: McpServerResolver): McpServerResolver => (registryServerId) => {
    const serverProject = deps.getMcpServerProjectId(registryServerId);
    const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
    if (serverProject && serverProject !== projectId && !sharedFromDefault(serverProject)) {
      throw new Error(`MCP server '${registryServerId}' belongs to another project, so workflows in this project cannot use it.`);
    }
    return base(registryServerId);
  };

  const sessionStoresFor = (workflow: Workflow) => {
    const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
    const key = (namespace: string) => projectSessionNamespace(projectId, namespace);
    // Unprefixed rows from before project scoping, read only where they can be
    // this workflow's own: its exact default namespace, or (from the default
    // project, where every pre-scoping row was written) any namespace that no
    // workflow of another project claims.
    const ownLegacy = (namespace: string) => workflow.nodes.some((node) => namespace === `${workflow.id}:${node.id}`);
    const legacyReadable = (namespace: string) =>
      (projectId === DEFAULT_PROJECT_ID || ownLegacy(namespace)) &&
      deps.legacyNamespaceOwnerProjects(namespace).every((owner) => owner === projectId);
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
        if (rows.length >= limit || !legacyReadable(input.namespace)) return rows.map((row) => asCaller(row, input.namespace));
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
  const dependenciesFor = (workflow: Workflow, options: RunScopeOptions = {}): ScopedRunDependencies => {
    const actor = options.actor ?? null;
    const baseMcpResolver = options.resolveRegisteredMcpServer ?? deps.resolveRegisteredMcpServer;
    const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
    const channel = options.channel ?? "draft";
    return {
      loadWorkflow: loadWorkflowFor(workflow, "Sub-workflow", channel),
      // The user's own secret:use counts only for a child in this project.
      scopeSubWorkflow: (child) =>
        dependenciesFor(child, {
          actor: (child.projectId ?? DEFAULT_PROJECT_ID) === projectId ? actor : null,
          resolveRegisteredMcpServer: baseMcpResolver,
          channel
        }),
      resolveSecret: resolveSecretFor(workflow, actor),
      resolveRegisteredMcpServer: mcpServerResolverFor(workflow, baseMcpResolver),
      knowledgeBaseStore: deps.knowledgeBaseStoreFor(workflow.projectId),
      ...sessionStoresFor(workflow)
    };
  };

  return {
    dependenciesFor,
    /**
     * May a run of `workflow` as `actor` use this secret? The same rules a
     * run's own nodes follow (project visibility, then `secret:use` in the
     * workflow's project or where it is shared to with execute). False when
     * the secret does not exist.
     */
    canUseSecretFor(workflow: SecretScope, actor: SafeUser, secretId: string): boolean {
      return deps.getSecretProjectId(secretId) !== null && secretProblem(workflow, actor, secretId) === null;
    },
    /** The error workflow `failing` may hand its failure to, or a reason it may not. */
    errorWorkflowFor(failing: Workflow, errorWorkflowId: string, channel: ReleaseChannel = "draft"): { workflow: Workflow } | { error: string } {
      try {
        const workflow = loadWorkflowFor(failing, "Error workflow", channel)(errorWorkflowId);
        return workflow ? { workflow } : { error: `Error workflow '${errorWorkflowId}' was not found.` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

export type RunScope = ReturnType<typeof createRunScope>;
