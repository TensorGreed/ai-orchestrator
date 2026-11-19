/**
 * Describe-it builder.
 *
 *   POST /api/workflow-builder/build   builder+: a description in, a workflow draft preview out (nothing is saved)
 *
 * The model is the one the request names, else the default model (a provider whose key the server's environment sets,
 * else a saved secret the person may use, else Echo). On Echo no model is called: the answer says a real model is
 * needed and offers the three closest templates. The model's answer is data only: it is checked against the workflow
 * schema and graph rules (with up to WORKFLOW_BUILDER_MAX_ATTEMPTS submissions) and nothing in it runs. The studio
 * saves the preview through POST /api/workflows as a new workflow, which runs every save check again.
 * WORKFLOW_BUILDER_ENABLED=false turns the route off.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import {
  DEFAULT_PROJECT_ID,
  envModelProviders,
  pickDefaultModelProvider,
  rankTemplatesForPrompt,
  workflowBuilderRequestSchema,
  type LLMProviderConfig,
  type SecretReference,
  type Workflow,
  type WorkflowBuilderResult
} from "@ai-orchestrator/shared";
import { runWorkflowBuilder } from "@ai-orchestrator/workflow-engine";
import type { AuditActor, AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";

/** How long one build may take, model calls included. */
export const WORKFLOW_BUILDER_TIMEOUT_MS = 120_000;

export const WORKFLOW_BUILDER_DISABLED_CODE = "workflow_builder_disabled";

type Denial = { ok: false; status: number; error: string };

export interface WorkflowBuilderRoutesDeps {
  app: FastifyInstance;
  enabled: boolean;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  audit: (
    request: FastifyRequest,
    user: SafeUser | null,
    event: Omit<AuditEventInput, "actor"> & { actor?: Partial<AuditActor> }
  ) => Promise<void>;
  /** Whether the person may create workflows in the project (`workflow:write`). */
  canCreateIn: (user: SafeUser, projectId: string) => Promise<{ ok: true } | Denial>;
  /** The saved secrets the person may use in a run in the project, for the default model. */
  usableSecrets: (user: SafeUser, projectId: string) => Promise<Array<{ id: string; provider: string }>>;
  /** Whether the person may use this secret (a model the request names). */
  canUseSecret: (user: SafeUser, secretId: string) => Promise<boolean>;
  resolveSecretForUser: (user: SafeUser) => (secretRef?: SecretReference) => Promise<string | undefined>;
  /** The model registry for the project (its model allowlist applies). */
  providerRegistryFor: (projectId: string) => ProviderRegistry;
  /** Templates every signed-in person may read. */
  listTemplates: () => Promise<Array<{ id: string; name: string; description?: string; category?: string; tags?: string[]; featured?: boolean }>>;
  /** Gives the draft trigger paths nobody uses and takes out settings only an admin sets. */
  prepareDraft: (workflow: Workflow) => Promise<Workflow>;
  isModelNotAllowed: (error: unknown) => boolean;
  redact: (text: string) => string;
  timeoutMs?: number;
}

export function registerWorkflowBuilderRoutes(deps: WorkflowBuilderRoutesDeps): void {
  const { app } = deps;
  // One build at a time per person: each one makes several model calls.
  const building = new Set<string>();

  app.post<{ Body: unknown }>("/api/workflow-builder/build", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!deps.enabled) {
      reply.code(403);
      return { error: "Describing a workflow is turned off on this server.", code: WORKFLOW_BUILDER_DISABLED_CODE };
    }
    const parsed = workflowBuilderRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid workflow builder request", details: parsed.error.issues };
    }
    const projectId = parsed.data.projectId ?? DEFAULT_PROJECT_ID;
    const access = await deps.canCreateIn(user, projectId);
    if (!access.ok) {
      reply.code(access.status);
      return { error: access.error };
    }

    let provider: LLMProviderConfig;
    if (parsed.data.model) {
      const secretId = parsed.data.model.secretRef?.secretId;
      if (secretId && !(await deps.canUseSecret(user, secretId))) {
        reply.code(403);
        return { error: `Secret '${secretId}' is not available to you.` };
      }
      provider = { ...parsed.data.model } as LLMProviderConfig;
    } else {
      provider = pickDefaultModelProvider({
        envProviders: envModelProviders(process.env),
        secrets: await deps.usableSecrets(user, projectId)
      }) as LLMProviderConfig;
    }
    const registry = deps.providerRegistryFor(projectId);
    if (!registry.tryGet(provider.providerId)) {
      reply.code(400);
      return { error: `Unknown model provider '${provider.providerId}'` };
    }

    if (provider.providerId === "echo") {
      const templates = rankTemplatesForPrompt(parsed.data.prompt, await deps.listTemplates(), 3).map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description ?? "",
        ...(template.category ? { category: template.category } : {})
      }));
      const result: WorkflowBuilderResult = {
        status: "needs_model",
        message:
          "Describing a workflow needs a real model, and the built-in Echo model only repeats its input. Add a model key " +
          "(a secret for OpenAI, Anthropic or Gemini), or choose another model, then try again. Or start from one of these templates.",
        templates
      };
      return result;
    }

    if (building.has(user.id)) {
      reply.code(409);
      return { error: "A workflow is already being built for you. Wait for it to finish." };
    }
    building.add(user.id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), deps.timeoutMs ?? WORKFLOW_BUILDER_TIMEOUT_MS);
    // The response's close before it finished: the person left, so the model calls stop.
    const onClose = () => {
      if (!reply.raw.writableFinished) controller.abort(new Error("client closed"));
    };
    reply.raw.once("close", onClose);
    const startedAt = Date.now();
    try {
      const outcome = await runWorkflowBuilder({
        prompt: parsed.data.prompt,
        provider,
        providerRegistry: registry,
        resolveSecret: deps.resolveSecretForUser(user),
        workflowId: crypto.randomUUID(),
        projectId,
        signal: controller.signal
      });
      let result: WorkflowBuilderResult;
      if (outcome.status === "ready") {
        result = { ...outcome, workflow: await deps.prepareDraft(outcome.workflow) };
      } else if (outcome.status === "needs_model") {
        result = { status: "needs_model", message: "Describing a workflow needs a real model.", templates: [] };
      } else {
        result = outcome;
      }
      await deps.audit(request, user, {
        category: "workflow",
        eventType: "workflow.builder.build",
        action: "build",
        resourceType: "workflow",
        ...(result.status === "ready" ? { resourceId: result.workflow.id } : {}),
        projectId,
        outcome: result.status === "ready" ? "success" : "failure",
        metadata: {
          status: result.status,
          providerId: provider.providerId,
          model: provider.model,
          promptChars: parsed.data.prompt.length,
          durationMs: Date.now() - startedAt,
          ...(result.status === "ready" || result.status === "failed" ? { attempts: result.attempts } : {}),
          ...(result.status === "ready" ? { nodes: result.workflow.nodes.length } : {})
        }
      });
      return result;
    } catch (error) {
      if (deps.isModelNotAllowed(error)) {
        reply.code(403);
        return { error: (error as Error).message, code: (error as { code?: string }).code };
      }
      if (controller.signal.aborted) {
        reply.code(504);
        return { error: "The model took too long to answer. Try again, or describe a smaller workflow." };
      }
      request.log.warn({ err: error }, "Workflow builder failed");
      reply.code(502);
      return { error: deps.redact(`The model call failed: ${error instanceof Error ? error.message : String(error)}`) };
    } finally {
      clearTimeout(timer);
      reply.raw.off("close", onClose);
      building.delete(user.id);
    }
  });
}
