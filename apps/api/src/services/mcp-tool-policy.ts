import { evaluateMcpToolAccess, type McpToolAccessDecision } from "@ai-orchestrator/mcp-sdk";
import {
  MCP_POLICY_ROLES,
  type McpPolicyKind,
  type McpPolicyRole,
  type McpToolAnnotations,
  type McpToolClassification,
  type McpToolClassificationOverride,
  type McpOpenWorldResolution,
  type McpToolPolicyRule,
  type McpToolPolicySubject
} from "@ai-orchestrator/shared";
import { openWorldOverrideFor, resolveOpenWorldFor, rulesReadOpenWorld, type McpOpenWorldContext } from "./mcp-open-world.js";

/**
 * Phase 10.2 — API-side helpers for the MCP tool policy: marking discovered
 * tools with what the current user may use, and shaping dry-run decisions.
 * Enforcement itself happens in the workflow engine.
 */

/** The store reads the subject resolution needs. */
export interface McpToolPolicySubjectStore {
  getWorkflowCreatedBy(workflowId: string): Promise<string | null>;
  getUserById(id: string): Promise<{ id: string; email: string; role: string } | null>;
}

/**
 * Whose role the tool policy uses for a run: the signed-in user who started
 * it; otherwise (webhooks, schedules, queue, public chat and forms) the
 * workflow's creator; otherwise the lowest role, viewer, with the reason.
 */
export async function resolveMcpToolPolicySubject(
  store: McpToolPolicySubjectStore,
  workflowId: string,
  actor?: { id: string; email: string; role: McpPolicyRole } | null
): Promise<McpToolPolicySubject> {
  if (actor) {
    return { role: actor.role, source: "user", userId: actor.id, email: actor.email };
  }
  const ownerId = await store.getWorkflowCreatedBy(workflowId);
  if (!ownerId) {
    return { role: "viewer", source: "fallback", fallbackReason: "the workflow has no recorded owner" };
  }
  const owner = await store.getUserById(ownerId);
  if (!owner || !MCP_POLICY_ROLES.includes(owner.role as McpPolicyRole)) {
    return { role: "viewer", source: "fallback", userId: ownerId, fallbackReason: "the workflow owner no longer exists" };
  }
  return { role: owner.role as McpPolicyRole, source: "owner", userId: owner.id, email: owner.email };
}

export interface McpToolAccessMark {
  allowed: boolean;
  reason?: "policy" | "no_write_tools";
  ruleId?: string;
  ruleName?: string;
  message?: string;
}

export interface MarkedMcpTool {
  classification: McpToolClassification;
  /** Manual override for registry tools; null when annotations (or nothing) decide. */
  manualReadOnly: boolean | null;
  access: McpToolAccessMark;
  /** Phase 12.2 — whether the tool counts as open world and why; present when the context carries `openWorld`. */
  openWorld?: McpOpenWorldResolution;
  /** Phase 12.2 — the admin's open-world override; null when the destination and annotations decide. */
  manualOpenWorld?: boolean | null;
}

export interface McpToolMarkingContext {
  rules: readonly McpToolPolicyRule[];
  classifications: readonly McpToolClassificationOverride[];
  role: McpPolicyRole;
  projectId: string | null;
  adapterId: string;
  registryServerId?: string;
  /** Registry server name used in block messages. */
  serverLabel?: string;
  noWriteTools?: boolean;
  /** Phase 12.4 — the workflow whose run makes the call, for rules scoped to workflows. */
  workflowId?: string | null;
  /** Phase 12.4 — the MCP gateway client making the call, for rules scoped to clients. */
  clientId?: string | null;
  /**
   * Phase 12.2 — what open-world resolution reads (overrides, destination rows) and the server's connection. Absent:
   * `open_world` hints read the annotation alone, as before.
   */
  openWorld?: McpOpenWorldContext & { connection?: unknown };
}

/** Phase 12.4 — the call being made; without it, rules with conditions cannot decide (discovery). */
export interface McpToolCallContext {
  arguments: Record<string, unknown>;
  dataLabels?: { provenance: readonly string[]; dataClasses: readonly string[] } | null;
}

function toAccessMark(decision: McpToolAccessDecision): McpToolAccessMark {
  if (decision.allowed) return { allowed: true };
  return {
    allowed: false,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    ...(decision.ruleName ? { ruleName: decision.ruleName } : {}),
    ...(decision.message ? { message: decision.message } : {})
  };
}

export function manualReadOnlyFor(
  classifications: readonly McpToolClassificationOverride[],
  registryServerId: string | undefined,
  toolName: string
): boolean | null {
  if (!registryServerId) return null;
  const match = classifications.find(
    (entry) => entry.registryServerId === registryServerId && entry.toolName === toolName
  );
  return match ? match.readOnly : null;
}

export function evaluateToolForContext(
  context: McpToolMarkingContext,
  tool: { name: string; annotations?: McpToolAnnotations },
  /** Phase 10.5 — what `tool.name` is: a tool (default), a resource URI, a prompt name or a sampling model. */
  kind: McpPolicyKind = "tool",
  call?: McpToolCallContext
): McpToolAccessDecision {
  return evaluateMcpToolAccess({
    rules: context.rules,
    projectId: context.projectId,
    role: context.role,
    adapterId: context.adapterId,
    registryServerId: context.registryServerId,
    toolName: tool.name,
    kind,
    annotations: tool.annotations,
    manualReadOnly: manualReadOnlyFor(context.classifications, context.registryServerId, tool.name),
    ...(context.openWorld && kind === "tool" && rulesReadOpenWorld(context.rules)
      ? {
          openWorld: resolveOpenWorldFor(
            context.openWorld,
            { adapterId: context.adapterId, registryServerId: context.registryServerId ?? null, connection: context.openWorld.connection },
            tool.name,
            tool.annotations
          ).openWorld
        }
      : {}),
    noWriteTools: context.noWriteTools,
    workflowId: context.workflowId ?? null,
    clientId: context.clientId ?? null,
    ...(call ? { arguments: call.arguments, dataLabels: call.dataLabels ?? null } : {}),
    ...(context.serverLabel ? { serverLabel: context.serverLabel } : {})
  });
}

/** Adds `classification`, `manualReadOnly` and `access` to each tool; never hides any. */
export function markMcpTools<T extends { name: string; annotations?: McpToolAnnotations }>(
  tools: readonly T[],
  context: McpToolMarkingContext
): Array<T & MarkedMcpTool> {
  return tools.map((tool) => {
    const decision = evaluateToolForContext(context, tool);
    const openWorld = context.openWorld
      ? resolveOpenWorldFor(context.openWorld, { adapterId: context.adapterId, registryServerId: context.registryServerId ?? null, connection: context.openWorld.connection }, tool.name, tool.annotations)
      : undefined;
    return {
      ...tool,
      classification: decision.classification,
      manualReadOnly: manualReadOnlyFor(context.classifications, context.registryServerId, tool.name),
      access: toAccessMark(decision),
      ...(openWorld && context.openWorld
        ? { openWorld, manualOpenWorld: openWorldOverrideFor(context.openWorld.overrides, context.registryServerId, tool.name) }
        : {})
    };
  });
}
