/**
 * Phase 12.2 — provenance (taint) policies over the MCP tool rules: safety presets, the per-workflow
 * "Approve writes only after untrusted content" switch and per-tool open-world overrides.
 *
 *   GET  /api/mcp/policies/presets                         the presets, and whether each one's rule exists (builders)
 *   POST /api/mcp/policies/presets/:presetId               add a preset's rule, in SHADOW mode (admin)
 *   GET  /api/workflows/:id/untrusted-write-approval       the workflow's switch (workflow readers)
 *   PUT  /api/workflows/:id/untrusted-write-approval       turn it on or off (builders who can edit the workflow)
 *   PUT  /api/mcp/servers/:id/tools/:toolName/open-world   set or clear a tool's open-world override (admin)
 *
 * A preset's rule is an ordinary tool rule with a fixed id (`mtp_preset_<preset>`): it logs what it would have done
 * and changes nothing until an admin enforces it with POST /api/mcp/policies/:id/enforce, which runs the usual
 * tighten-only checks. The switch's rule (`mtp_wf_untrusted_writes_<workflow>`) is enforced at once, but only through
 * the same tighten-only guard: `createEnforcedMcpToolPolicy` creates and enforces it in one transaction with the guard
 * inside; a refusal writes nothing, is audited as `mcp_policy.create_refused` and answers 409. Both kinds of rule are
 * additive: they only add approvals or denies and never set another rule aside, so a deny an admin adds later still
 * wins. Turning the switch off deletes the rule; once an admin has changed the rule, only an admin can. Every change
 * is audited like any rule change.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  MCP_SAFETY_PRESETS,
  mcpSafetyPresetIdSchema,
  mcpSafetyPresetRule,
  mcpSafetyPresetRuleId,
  mcpToolOpenWorldSchema,
  untrustedWriteSwitchRule,
  untrustedWriteSwitchRuleId,
  untrustedWriteSwitchSchema,
  type McpToolPolicyRule,
  type UntrustedWriteSwitchState,
  type Workflow
} from "@ai-orchestrator/shared";
import { hashMcpToolPolicyRule } from "@ai-orchestrator/mcp-sdk";
import type { Store } from "./db/store.js";
import { McpPolicyEnforceRefusedError } from "./db/store-errors.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { enforceRefusal } from "./mcp-policy-learning-routes.js";
import { loadMcpOpenWorldContext, resolveOpenWorldFor } from "./services/mcp-open-world.js";

export interface McpSafetyPresetRoutesDeps {
  app: FastifyInstance;
  store: Store;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  canAccessWorkflow: (user: SafeUser, workflow: Workflow, permission: "workflow:read" | "workflow:write") => Promise<boolean>;
  recordPolicyAudit: (
    user: SafeUser,
    eventType: string,
    action: "create" | "update" | "delete" | "read",
    resourceId: string,
    metadata: Record<string, unknown>,
    projectId?: string | null
  ) => Promise<void>;
  policyAuditMetadata: (rule: McpToolPolicyRule) => Record<string, unknown>;
  policyRuleResponse: (rule: McpToolPolicyRule) => McpToolPolicyRule & { hash: string };
}

/** True when a rule's create failed because a rule with that id exists (a concurrent add). */
async function existsNow(store: Store, id: string): Promise<boolean> {
  return (await store.getMcpToolPolicy(id).catch(() => null)) !== null;
}

function switchState(workflowId: string, rule: McpToolPolicyRule | null): UntrustedWriteSwitchState {
  const ruleId = untrustedWriteSwitchRuleId(workflowId);
  if (!rule) return { enabled: false, ruleId };
  return {
    enabled: true,
    ruleId,
    mode: rule.mode === "shadow" ? "shadow" : "enforce",
    ruleEnabled: rule.enabled,
    customised: hashMcpToolPolicyRule(rule) !== hashMcpToolPolicyRule(untrustedWriteSwitchRule(workflowId))
  };
}

export function registerMcpSafetyPresetRoutes(deps: McpSafetyPresetRoutesDeps): void {
  const { app, store, requireRole } = deps;
  const fail = (reply: FastifyReply, status: number, error: string, details?: unknown) => {
    reply.code(status);
    return details === undefined ? { error } : { error, details };
  };

  app.get("/api/mcp/policies/presets", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const presets = [];
    for (const preset of MCP_SAFETY_PRESETS) {
      const ruleId = mcpSafetyPresetRuleId(preset.id);
      const rule = await store.getMcpToolPolicy(ruleId);
      presets.push({
        id: preset.id,
        title: preset.title,
        summary: preset.summary,
        rule: preset.rule,
        ruleId,
        added: rule !== null,
        ...(rule
          ? {
              mode: rule.mode === "shadow" ? "shadow" : "enforce",
              enabled: rule.enabled,
              customised: hashMcpToolPolicyRule(rule) !== hashMcpToolPolicyRule(mcpSafetyPresetRule(preset.id))
            }
          : {})
      });
    }
    return { presets };
  });

  app.post<{ Params: { presetId: string } }>("/api/mcp/policies/presets/:presetId", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const presetId = mcpSafetyPresetIdSchema.safeParse(request.params.presetId);
    if (!presetId.success) return fail(reply, 404, "Unknown safety preset");
    const draft = mcpSafetyPresetRule(presetId.data);
    if (await store.getMcpToolPolicy(draft.id)) return fail(reply, 409, "This preset was already added. Find its rule in the list.");
    let rule: McpToolPolicyRule;
    try {
      rule = await store.createMcpToolPolicy({ ...draft, createdBy: user.email });
    } catch (error) {
      if (await existsNow(store, draft.id)) return fail(reply, 409, "This preset was added meanwhile.");
      throw error;
    }
    await deps.recordPolicyAudit(user, "mcp_policy.created", "create", rule.id, { ...deps.policyAuditMetadata(rule), preset: presetId.data });
    reply.code(201);
    return { rule: deps.policyRuleResponse(rule) };
  });

  const findWorkflow = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, user: SafeUser, permission: "workflow:read" | "workflow:write") => {
    const workflow = await store.getWorkflow(request.params.id);
    if (!workflow || !(await deps.canAccessWorkflow(user, workflow, permission))) {
      reply.code(404);
      return null;
    }
    return workflow;
  };

  app.get<{ Params: { id: string } }>("/api/workflows/:id/untrusted-write-approval", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const workflow = await findWorkflow(request, reply, user, "workflow:read");
    if (!workflow) return { error: "Workflow not found" };
    return { switch: switchState(workflow.id, await store.getMcpToolPolicy(untrustedWriteSwitchRuleId(workflow.id))) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/untrusted-write-approval", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = untrustedWriteSwitchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "Send { enabled: true } or { enabled: false }", parsed.error.issues);
    const workflow = await findWorkflow(request, reply, user, "workflow:write");
    if (!workflow) return { error: "Workflow not found" };
    const ruleId = untrustedWriteSwitchRuleId(workflow.id);
    const existing = await store.getMcpToolPolicy(ruleId);

    if (!parsed.data.enabled) {
      if (!existing) return { switch: switchState(workflow.id, null) };
      // An admin's edit of the rule is a policy decision: only an admin can undo it.
      if (switchState(workflow.id, existing).customised && user.role !== "admin") {
        return fail(reply, 403, "An admin changed this workflow's rule on the Policies page. Ask an admin to turn it off.");
      }
      await store.deleteMcpToolPolicy(ruleId);
      await deps.recordPolicyAudit(
        user,
        "mcp_policy.deleted",
        "delete",
        ruleId,
        { ...deps.policyAuditMetadata(existing), source: "workflow_switch", workflowId: workflow.id },
        existing.projectId
      );
      return { switch: switchState(workflow.id, null) };
    }

    if (existing) return { switch: switchState(workflow.id, existing) };
    const draft = untrustedWriteSwitchRule(workflow.id);
    // Created and enforced in one transaction, with the tighten-only guard inside it: no other request ever sees the
    // rule in shadow, and a refusal leaves nothing behind.
    let rule: McpToolPolicyRule | null;
    try {
      rule = await store.createEnforcedMcpToolPolicy(
        { ...draft, createdBy: user.email },
        { guard: (state) => enforceRefusal([ruleId], state.rules, state.accepted) }
      );
    } catch (error) {
      if (error instanceof McpPolicyEnforceRefusedError) {
        await deps.recordPolicyAudit(
          user,
          "mcp_policy.create_refused",
          "create",
          ruleId,
          { ...deps.policyAuditMetadata(draft), source: "workflow_switch", workflowId: workflow.id, reason: error.message },
          draft.projectId
        );
        return fail(reply, 409, `This workflow's rule cannot be turned on: ${error.message}`);
      }
      // A concurrent request turned the switch on first.
      if (await existsNow(store, ruleId)) return { switch: switchState(workflow.id, await store.getMcpToolPolicy(ruleId)) };
      throw error;
    }
    if (!rule) return fail(reply, 409, "This workflow's rule changed meanwhile. Reload and try again.");
    await deps.recordPolicyAudit(
      user,
      "mcp_policy.created",
      "create",
      rule.id,
      { ...deps.policyAuditMetadata(rule), source: "workflow_switch", workflowId: workflow.id },
      rule.projectId
    );
    return { switch: switchState(workflow.id, rule) };
  });

  app.put<{ Params: { id: string; toolName: string }; Body: unknown }>("/api/mcp/servers/:id/tools/:toolName/open-world", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const server = await store.getMcpServer(request.params.id);
    if (!server) return fail(reply, 404, "MCP server not found");
    const toolName = request.params.toolName.trim();
    if (!toolName || toolName.length > 200) return fail(reply, 400, "Tool name is required");
    const parsed = mcpToolOpenWorldSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "Send { openWorld: true | false | null }", parsed.error.issues);
    const override = await store.setMcpToolOpenWorld({ registryServerId: server.id, toolName, openWorld: parsed.data.openWorld, setBy: user.email });
    await deps.recordPolicyAudit(
      user,
      parsed.data.openWorld === null ? "mcp_policy.open_world_cleared" : "mcp_policy.open_world_set",
      "update",
      `${server.id}:${toolName}`,
      { serverId: server.id, serverName: server.name, toolName, openWorld: parsed.data.openWorld },
      server.projectId
    );
    const snapshot = server.currentSnapshotId ? await store.getMcpToolSnapshot(server.currentSnapshotId) : null;
    const annotations = snapshot?.tools.find((tool) => tool.name === toolName)?.annotations;
    const openWorld = resolveOpenWorldFor(
      await loadMcpOpenWorldContext(store, server.id),
      { adapterId: server.adapterId, registryServerId: server.id, connection: server.connection },
      toolName,
      annotations
    );
    return { serverId: server.id, toolName, override, openWorld, manualOpenWorld: override ? override.openWorld : null };
  });
}
