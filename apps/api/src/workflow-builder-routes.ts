/**
 * Describe-it builder.
 *
 *   GET  /api/workflow-builder         builder+: { enabled, defaultModel? } (the model a build in ?projectId= uses)
 *   POST /api/workflow-builder/build   builder+: a description in, a workflow draft preview out (nothing is saved)
 *
 * The model is the one the request names, else the default model (a provider whose key the server's environment sets,
 * else a saved secret the person may use, else Echo). On Echo no model is called: the answer says a real model is
 * needed and offers the three closest templates. The model's answer is data only: it is checked against the workflow
 * schema and graph rules (with up to WORKFLOW_BUILDER_MAX_ATTEMPTS submissions) and nothing in it runs. The studio
 * saves the preview through POST /api/workflows as a new workflow, which runs every save check again.
 * WORKFLOW_BUILDER_ENABLED=false turns the route off.
 *
 * Spending: a build's model calls count toward the model spending limits as a run's do. A used-up `block` budget that
 * applies to the person or the project (or the deployment) refuses the build before any model call (402). The calls a
 * build made, also one that failed or was stopped, are recorded as usage of the project and the person, under the
 * usage row "Describe it (builds)" (trigger type `workflow_builder`), so they show in the usage and cost views and
 * count toward the next budget check.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createMeteredProviderRegistry, type MeteredModelCall, type ProviderRegistry } from "@ai-orchestrator/provider-sdk";
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

/** The usage row builds are recorded under (`usage_events.workflow_id`; no workflow has this id) and its label. */
export const WORKFLOW_BUILDER_USAGE_WORKFLOW_ID = "workflow-builder";
export const WORKFLOW_BUILDER_USAGE_LABEL = "Describe it (builds)";
export const WORKFLOW_BUILDER_TRIGGER_TYPE = "workflow_builder";

/** A used-up `block` budget that applies to a build. */
export interface WorkflowBuilderBudgetRefusal {
  budgetId: string;
  budgetName: string;
  period: "day" | "week" | "month";
  periodStart: string;
}

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
  listTemplates: () => Promise<Array<{ id: string; name: string; description?: string; category?: string; tags?: string[]; featured?: boolean; needsModel?: boolean }>>;
  /** Gives the draft trigger paths nobody uses and takes out settings only an admin sets. */
  prepareDraft: (workflow: Workflow) => Promise<Workflow>;
  /**
   * A used-up `block` budget that applies to a build by this person in this project (a project, person or deployment
   * budget), or null. Throws when the budgets cannot be read.
   */
  checkBudget: (user: SafeUser, projectId: string) => Promise<WorkflowBuilderBudgetRefusal | null>;
  /** Records a build's model calls as usage of the project and the person (and tells budget alerts). */
  recordUsage: (input: {
    user: SafeUser;
    projectId: string;
    buildId: string;
    status: "success" | "error";
    durationMs: number;
    calls: MeteredModelCall[];
  }) => Promise<void>;
  isModelNotAllowed: (error: unknown) => boolean;
  redact: (text: string) => string;
  timeoutMs?: number;
}

/** Builds running at once on one API process. */
export const WORKFLOW_BUILDER_MAX_CONCURRENT_BUILDS = 8;

export function registerWorkflowBuilderRoutes(deps: WorkflowBuilderRoutesDeps): void {
  const { app } = deps;
  // One build at a time per person, and a few at a time on this server: each one makes several model calls.
  const building = new Set<string>();

  const defaultModelFor = async (user: SafeUser, projectId: string): Promise<LLMProviderConfig> =>
    pickDefaultModelProvider({
      envProviders: envModelProviders(process.env),
      secrets: await deps.usableSecrets(user, projectId)
    }) as LLMProviderConfig;

  // Whether builders get "Describe it", and the model a build in the project would use (shown in the dialog).
  app.get<{ Querystring: { projectId?: string } }>("/api/workflow-builder", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!deps.enabled) return { enabled: false };
    const projectId = typeof request.query.projectId === "string" && request.query.projectId ? request.query.projectId : DEFAULT_PROJECT_ID;
    if (!(await deps.canCreateIn(user, projectId)).ok) return { enabled: true };
    const model = await defaultModelFor(user, projectId);
    return { enabled: true, defaultModel: { providerId: model.providerId, model: model.model } };
  });

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
      // The secret must be one this person may use in the target project (the list the dialog offers), not any secret they may use.
      if (secretId && (!(await deps.canUseSecret(user, secretId)) || !(await deps.usableSecrets(user, projectId)).some((secret) => secret.id === secretId))) {
        reply.code(403);
        return { error: `Secret '${secretId}' is not available to you.` };
      }
      provider = { ...parsed.data.model } as LLMProviderConfig;
    } else {
      provider = await defaultModelFor(user, projectId);
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

    // Model spending limits apply to builds as to runs: checked before any model call.
    let refusal: WorkflowBuilderBudgetRefusal | null;
    try {
      refusal = await deps.checkBudget(user, projectId);
    } catch (error) {
      request.log.warn({ err: error }, "A build was refused because its budgets could not be checked");
      reply.header("retry-after", "5");
      reply.code(503);
      return { error: "Model spending limits could not be checked. Try again shortly." };
    }
    if (refusal) {
      await deps.audit(request, user, {
        category: "workflow",
        eventType: "workflow.builder.build",
        action: "build",
        resourceType: "workflow",
        projectId,
        outcome: "denied",
        metadata: { status: "budget_exceeded", budgetId: refusal.budgetId, period: refusal.period, periodStart: refusal.periodStart, providerId: provider.providerId, model: provider.model }
      });
      reply.code(402);
      return {
        error:
          `The model spending limit "${refusal.budgetName}" is used up for this ${refusal.period}, and describing a workflow uses the model too. ` +
          "Try again when the limit resets, or ask an admin to raise it.",
        code: "budget_exceeded",
        budgetId: refusal.budgetId,
        periodStart: refusal.periodStart
      };
    }

    if (building.has(user.id)) {
      reply.code(409);
      return { error: "A workflow is already being built for you. Wait for it to finish." };
    }
    if (building.size >= WORKFLOW_BUILDER_MAX_CONCURRENT_BUILDS) {
      reply.code(429);
      return { error: "Several workflows are being built on this server. Try again in a minute." };
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
    // Every call that answers is recorded below, whatever the build's outcome.
    const calls: MeteredModelCall[] = [];
    const meteredRegistry = createMeteredProviderRegistry(registry, (call) => calls.push(call));
    let succeeded = false;
    try {
      const outcome = await runWorkflowBuilder({
        prompt: parsed.data.prompt,
        provider,
        providerRegistry: meteredRegistry,
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
      } else if (outcome.status === "failed") {
        // A provider's error text can echo a request header: redacted like every other model error.
        result = { ...outcome, message: deps.redact(outcome.message) };
      } else {
        result = { ...outcome, question: deps.redact(outcome.question) };
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
      succeeded = result.status === "ready";
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
      if (calls.length > 0) {
        try {
          await deps.recordUsage({
            user,
            projectId,
            buildId: `build_${crypto.randomUUID()}`,
            status: succeeded ? "success" : "error",
            durationMs: Date.now() - startedAt,
            calls
          });
        } catch (error) {
          request.log.warn({ err: error, calls: calls.length }, "A build's model usage was not recorded");
        }
      }
    }
  });
}
