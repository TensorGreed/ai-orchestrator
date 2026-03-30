import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import {
  agentWebhookPayloadSchema,
  nodeDefinitions,
  workflowExecuteRequestSchema,
  workflowSchema,
  type MCPServerConfig,
  type Workflow
} from "@ai-orchestrator/shared";
import { executeWorkflow, exportWorkflowToJson, importWorkflowFromJson, validateWorkflowGraph } from "@ai-orchestrator/workflow-engine";
import { SqliteStore } from "./db/database";
import type { AppConfig } from "./config";
import { SecretService } from "./services/secret-service";

const secretCreateSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  value: z.string().min(1)
});

const workflowImportSchema = z.object({
  json: z.string().optional(),
  workflow: z.unknown().optional()
});

const mcpDiscoverSchema = z.object({
  serverId: z.string().min(1),
  label: z.string().optional(),
  connection: z.record(z.string(), z.unknown()).optional(),
  allowedTools: z.array(z.string()).optional()
});

async function selectWebhookWorkflow(store: SqliteStore, workflowId?: string): Promise<Workflow | null> {
  if (workflowId) {
    return store.getWorkflow(workflowId);
  }

  const workflows = store.listWorkflows();
  for (const workflowSummary of workflows) {
    const workflow = store.getWorkflow(workflowSummary.id);
    if (!workflow) {
      continue;
    }

    if (workflow.nodes.some((node) => node.type === "webhook_input")) {
      return workflow;
    }
  }

  return workflows.length ? store.getWorkflow(workflows[0].id) : null;
}

export function createApp(config: AppConfig, store: SqliteStore, secretService: SecretService) {
  const app = Fastify({ logger: true });
  const providerRegistry = createDefaultProviderRegistry();
  const connectorRegistry = createDefaultConnectorRegistry();
  const mcpRegistry = createDefaultMCPRegistry();
  const agentRuntime = createDefaultAgentRuntime();

  app.register(cors, {
    origin: config.WEB_ORIGIN
  });

  app.get("/health", async () => {
    return {
      ok: true,
      now: new Date().toISOString()
    };
  });

  app.get("/api/definitions", async () => {
    return {
      nodes: nodeDefinitions,
      providers: providerRegistry.listDefinitions(),
      connectors: connectorRegistry.listDefinitions(),
      mcpServers: mcpRegistry.listDefinitions()
    };
  });

  app.get("/api/workflows", async () => {
    return store.listWorkflows();
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return workflow;
  });

  app.post<{ Body: unknown }>("/api/workflows", async (request, reply) => {
    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid workflow payload",
        details: parsed.error.issues
      };
    }

    const validation = validateWorkflowGraph(parsed.data);
    if (!validation.valid) {
      reply.code(400);
      return {
        error: "Workflow validation failed",
        validation
      };
    }

    return store.upsertWorkflow(parsed.data);
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id", async (request, reply) => {
    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid workflow payload",
        details: parsed.error.issues
      };
    }

    if (parsed.data.id !== request.params.id) {
      reply.code(400);
      return { error: "Workflow ID mismatch between path and payload" };
    }

    const validation = validateWorkflowGraph(parsed.data);
    if (!validation.valid) {
      reply.code(400);
      return {
        error: "Workflow validation failed",
        validation
      };
    }

    return store.upsertWorkflow(parsed.data);
  });

  app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (request, reply) => {
    const deleted = store.deleteWorkflow(request.params.id);
    if (!deleted) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return { ok: true };
  });

  app.post<{ Body: unknown }>("/api/workflows/import", async (request, reply) => {
    const parsed = workflowImportSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid import payload", details: parsed.error.issues };
    }

    try {
      const workflow = parsed.data.json
        ? importWorkflowFromJson(parsed.data.json)
        : workflowSchema.parse(parsed.data.workflow);

      const validation = validateWorkflowGraph(workflow);
      if (!validation.valid) {
        reply.code(400);
        return {
          error: "Workflow validation failed",
          validation
        };
      }

      return store.upsertWorkflow(workflow);
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to import workflow"
      };
    }
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/export", async (request, reply) => {
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return {
      json: exportWorkflowToJson(workflow)
    };
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/validate", async (request, reply) => {
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    return validateWorkflowGraph(workflow);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/execute", async (request, reply) => {
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) {
      reply.code(404);
      return { error: "Workflow not found" };
    }

    const parsed = workflowExecuteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid execution payload",
        details: parsed.error.issues
      };
    }

    const result = await executeWorkflow(
      {
        workflow,
        input: parsed.data.input,
        variables: parsed.data.variables,
        systemPrompt: parsed.data.system_prompt,
        userPrompt: parsed.data.user_prompt,
        sessionId: parsed.data.sessionId
      },
      {
        providerRegistry,
        connectorRegistry,
        mcpRegistry,
        agentRuntime,
        resolveSecret: (secretRef) => secretService.resolveSecret(secretRef)
      }
    );

    if (result.status === "error") {
      reply.code(400);
    }

    return result;
  });

  app.post<{ Body: unknown }>("/api/webhooks/execute", async (request, reply) => {
    const parsed = agentWebhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid webhook payload",
        details: parsed.error.issues
      };
    }

    const workflow = await selectWebhookWorkflow(store, parsed.data.workflow_id);
    if (!workflow) {
      reply.code(404);
      return { error: "No workflows available" };
    }

    const result = await executeWorkflow(
      {
        workflow,
        webhookPayload: {
          system_prompt: parsed.data.system_prompt,
          user_prompt: parsed.data.user_prompt,
          session_id: parsed.data.session_id,
          variables: parsed.data.variables
        },
        variables: parsed.data.variables,
        systemPrompt: parsed.data.system_prompt,
        userPrompt: parsed.data.user_prompt,
        sessionId: parsed.data.session_id
      },
      {
        providerRegistry,
        connectorRegistry,
        mcpRegistry,
        agentRuntime,
        resolveSecret: (secretRef) => secretService.resolveSecret(secretRef)
      }
    );

    if (result.status === "error") {
      reply.code(400);
    }

    return {
      ...result,
      selectedWorkflowId: workflow.id
    };
  });

  app.post<{ Body: unknown }>("/api/secrets", async (request, reply) => {
    const parsed = secretCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid secret payload",
        details: parsed.error.issues
      };
    }

    const secretRef = secretService.createSecret(parsed.data);
    return {
      id: secretRef.secretId,
      name: parsed.data.name,
      provider: parsed.data.provider
    };
  });

  app.get("/api/secrets", async () => {
    return secretService.listSecrets();
  });

  app.post<{ Body: unknown }>("/api/mcp/discover-tools", async (request, reply) => {
    const parsed = mcpDiscoverSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid MCP discover payload",
        details: parsed.error.issues
      };
    }

    try {
      const serverConfig: MCPServerConfig = {
        serverId: parsed.data.serverId,
        label: parsed.data.label,
        connection: parsed.data.connection,
        allowedTools: parsed.data.allowedTools
      };

      const tools = await mcpRegistry.get(parsed.data.serverId).discoverTools(serverConfig, {
        resolveSecret: (secretRef) => secretService.resolveSecret(secretRef)
      });

      return {
        serverId: parsed.data.serverId,
        tools
      };
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Failed to discover MCP tools"
      };
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    app.log.error({ err: secretService.redact(message) }, "Unhandled API error");
    reply.code(500).send({
      error: "Internal server error"
    });
  });

  return app;
}
