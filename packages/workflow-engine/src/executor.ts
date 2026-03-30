import type { AgentRuntimeAdapter } from "@ai-orchestrator/agent-runtime";
import type { ConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { invokeDirectMCPTool, resolveMCPTools, type MCPRegistry } from "@ai-orchestrator/mcp-sdk";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type {
  ConnectorDocument,
  LLMProviderConfig,
  MCPServerConfig,
  NodeExecutionResult,
  SecretReference,
  Workflow,
  WorkflowExecutionResult,
  WorkflowNode
} from "@ai-orchestrator/shared";
import { InMemoryRetrieverAdapter } from "./rag-adapters";
import { renderTemplate, tryParseJson } from "./template";
import { sortWorkflowNodes, validateWorkflowGraph } from "./validation";

export interface WorkflowExecutionDependencies {
  providerRegistry: ProviderRegistry;
  mcpRegistry: MCPRegistry;
  connectorRegistry: ConnectorRegistry;
  agentRuntime: AgentRuntimeAdapter;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  logger?: (message: string, metadata?: unknown) => void;
}

export interface ExecuteWorkflowRequest {
  workflow: Workflow;
  input?: Record<string, unknown>;
  webhookPayload?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  systemPrompt?: string;
  userPrompt?: string;
  sessionId?: string;
}

interface NodeRuntimeContext {
  globals: Record<string, unknown>;
  merged: Record<string, unknown>;
  parentOutputs: Record<string, unknown>;
}

function nowIso() {
  return new Date().toISOString();
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mergeParentOutputs(parentOutputs: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const [nodeId, output] of Object.entries(parentOutputs)) {
    merged[nodeId] = output;
    if (output && typeof output === "object" && !Array.isArray(output)) {
      Object.assign(merged, output as Record<string, unknown>);
    }
  }

  return merged;
}

function normalizeDocuments(raw: unknown): ConnectorDocument[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          id: `doc-${index + 1}`,
          text: item
        };
      }

      if (item && typeof item === "object") {
        const asRecord = item as Record<string, unknown>;
        const text =
          typeof asRecord.text === "string"
            ? asRecord.text
            : typeof asRecord.content === "string"
              ? asRecord.content
              : JSON.stringify(asRecord);

        return {
          id: typeof asRecord.id === "string" ? asRecord.id : `doc-${index + 1}`,
          text,
          metadata: toRecord(asRecord.metadata)
        };
      }

      return {
        id: `doc-${index + 1}`,
        text: String(item)
      };
    })
    .filter((document) => Boolean(document.text?.trim()));
}

function buildTemplateData(context: NodeRuntimeContext): Record<string, unknown> {
  return {
    ...context.globals,
    ...context.merged,
    parent_outputs: context.parentOutputs
  };
}

async function executeNode(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): Promise<unknown> {
  const config = toRecord(node.config);
  const templateData = buildTemplateData(context);

  switch (node.type) {
    case "webhook_input": {
      const webhook = toRecord(context.globals.webhook);
      const passThrough = Array.isArray(config.passThroughFields)
        ? config.passThroughFields.map((value) => String(value))
        : [];

      if (!passThrough.length) {
        return webhook;
      }

      const picked: Record<string, unknown> = {};
      for (const field of passThrough) {
        if (field in webhook) {
          picked[field] = webhook[field];
        }
      }
      return picked;
    }

    case "text_input": {
      const text =
        typeof config.text === "string"
          ? config.text
          : typeof context.globals.user_prompt === "string"
            ? context.globals.user_prompt
            : "";

      return {
        text,
        user_prompt: text
      };
    }

    case "system_prompt": {
      return {
        system_prompt:
          typeof config.text === "string"
            ? config.text
            : typeof context.globals.system_prompt === "string"
              ? context.globals.system_prompt
              : ""
      };
    }

    case "user_prompt": {
      return {
        user_prompt:
          typeof config.text === "string"
            ? config.text
            : typeof context.globals.user_prompt === "string"
              ? context.globals.user_prompt
              : ""
      };
    }

    case "prompt_template": {
      const template = typeof config.template === "string" ? config.template : "{{user_prompt}}";
      const outputKey = typeof config.outputKey === "string" && config.outputKey ? config.outputKey : "prompt";
      const rendered = renderTemplate(template, templateData);
      return {
        [outputKey]: rendered,
        prompt: rendered
      };
    }

    case "llm_call": {
      const provider = config.provider as LLMProviderConfig;
      const promptKey = typeof config.promptKey === "string" ? config.promptKey : "prompt";
      const systemPromptKey = typeof config.systemPromptKey === "string" ? config.systemPromptKey : "system_prompt";
      const userPrompt = String(templateData[promptKey] ?? templateData.user_prompt ?? "");
      const systemPrompt = String(templateData[systemPromptKey] ?? "");

      const messages = [] as Array<{ role: "system" | "user"; content: string }>;
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: userPrompt });

      const response = await dependencies.providerRegistry
        .get(provider.providerId)
        .generate(
          {
            provider,
            messages
          },
          {
            resolveSecret: dependencies.resolveSecret
          }
        );

      return {
        text: response.content,
        answer: response.content,
        toolCalls: response.toolCalls,
        raw: response.raw
      };
    }

    case "connector_source": {
      const connectorId = String(config.connectorId ?? "");
      const connector = dependencies.connectorRegistry.get(connectorId);
      const connectorConfig = toRecord(config.connectorConfig ?? config);
      const output = await connector.fetchData(connectorConfig, {
        resolveSecret: dependencies.resolveSecret
      });

      return {
        documents: output.documents,
        connectorRaw: output.raw
      };
    }

    case "rag_retrieve": {
      const retriever = new InMemoryRetrieverAdapter();
      const queryTemplate = typeof config.queryTemplate === "string" ? config.queryTemplate : "{{user_prompt}}";
      const query = renderTemplate(queryTemplate, templateData).trim();
      const topK = typeof config.topK === "number" && config.topK > 0 ? Math.floor(config.topK) : 3;

      const inlineDocs = normalizeDocuments(config.documents);
      const upstreamDocs = normalizeDocuments(templateData.documents);
      const allDocs = [...upstreamDocs, ...inlineDocs];
      const documents = retriever.retrieve(query, allDocs, topK);

      return {
        query,
        documents,
        context: documents.map((doc, index) => `[${index + 1}] ${doc.text}`).join("\n")
      };
    }

    case "mcp_tool": {
      const serverId = String(config.serverId ?? "");
      const toolName = String(config.toolName ?? "");
      const argsTemplate = typeof config.argsTemplate === "string" ? config.argsTemplate : "{}";
      const args = tryParseJson(renderTemplate(argsTemplate, templateData));
      const serverConfig: MCPServerConfig = {
        serverId,
        connection: toRecord(config.connection),
        secretRef: config.secretRef as SecretReference | undefined,
        allowedTools: Array.isArray(config.allowedTools)
          ? config.allowedTools.map((tool) => String(tool))
          : undefined
      };

      const result = await invokeDirectMCPTool(
        serverConfig,
        toolName,
        args,
        dependencies.mcpRegistry,
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      if (!result.ok) {
        throw new Error(result.error ?? "MCP tool invocation failed");
      }

      return {
        tool_output: result.output,
        tool_name: toolName
      };
    }

    case "agent_orchestrator": {
      const provider = config.provider as LLMProviderConfig;
      const maxIterations = typeof config.maxIterations === "number" ? Math.max(1, Math.floor(config.maxIterations)) : 4;
      const toolCallingEnabled = config.toolCallingEnabled !== false;

      const systemTemplate =
        typeof config.systemPromptTemplate === "string" ? config.systemPromptTemplate : "{{system_prompt}}";
      const userTemplate = typeof config.userPromptTemplate === "string" ? config.userPromptTemplate : "{{user_prompt}}";
      const systemPrompt = renderTemplate(systemTemplate, templateData);
      const userPrompt = renderTemplate(userTemplate, templateData);

      const serverConfigs = Array.isArray(config.mcpServers)
        ? config.mcpServers
            .map((entry) => toRecord(entry))
            .filter((entry) => typeof entry.serverId === "string")
            .map(
              (entry) =>
                ({
                  serverId: String(entry.serverId),
                  label: typeof entry.label === "string" ? entry.label : undefined,
                  connection: toRecord(entry.connection),
                  secretRef: entry.secretRef as SecretReference | undefined,
                  allowedTools: Array.isArray(entry.allowedTools)
                    ? entry.allowedTools.map((tool) => String(tool))
                    : undefined
                }) satisfies MCPServerConfig
            )
        : [];

      const resolvedTools = await resolveMCPTools(serverConfigs, dependencies.mcpRegistry, {
        resolveSecret: dependencies.resolveSecret
      });

      const agentState = await dependencies.agentRuntime.run(
        {
          provider,
          systemPrompt,
          userPrompt,
          maxIterations,
          toolCallingEnabled,
          tools: resolvedTools.resolved.map((entry) => ({
            serverId: entry.serverId,
            name: entry.exposedName,
            description: entry.definition.description,
            inputSchema: entry.definition.inputSchema
          })),
          sessionId: typeof templateData.session_id === "string" ? templateData.session_id : undefined
        },
        {
          tools: resolvedTools.tools,
          invokeTool: resolvedTools.invokeByExposedName
        },
        {
          providerRegistry: dependencies.providerRegistry,
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        answer: agentState.finalAnswer,
        iterations: agentState.iterations,
        stopReason: agentState.stopReason,
        steps: agentState.steps,
        messages: agentState.messages
      };
    }

    case "output": {
      const outputKey = typeof config.outputKey === "string" && config.outputKey ? config.outputKey : "result";
      const responseTemplate = typeof config.responseTemplate === "string" ? config.responseTemplate : undefined;

      let value: unknown;
      if (responseTemplate) {
        value = renderTemplate(responseTemplate, templateData);
      } else {
        value =
          templateData.answer ??
          templateData.text ??
          templateData.prompt ??
          templateData.user_prompt ??
          templateData.system_prompt ??
          templateData;
      }

      return {
        [outputKey]: value,
        result: value
      };
    }

    default:
      throw new Error(`Unsupported node type '${String(node.type)}'`);
  }
}

export async function executeWorkflow(
  request: ExecuteWorkflowRequest,
  dependencies: WorkflowExecutionDependencies
): Promise<WorkflowExecutionResult> {
  const startedAt = nowIso();
  const validation = validateWorkflowGraph(request.workflow);

  if (!validation.valid) {
    return {
      workflowId: request.workflow.id,
      status: "error",
      startedAt,
      completedAt: nowIso(),
      nodeResults: [],
      error: validation.issues.map((issue) => issue.message).join("; ")
    };
  }

  const nodeOrder = validation.orderedNodeIds ?? sortWorkflowNodes(request.workflow);
  const nodeById = new Map(request.workflow.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();

  for (const node of request.workflow.nodes) {
    incoming.set(node.id, []);
  }
  for (const edge of request.workflow.edges) {
    const items = incoming.get(edge.target);
    if (items) {
      items.push(edge.source);
    }
  }

  const globals: Record<string, unknown> = {
    ...(request.input ?? {}),
    ...(request.variables ?? {}),
    webhook: request.webhookPayload ?? {},
    system_prompt:
      request.systemPrompt ??
      (typeof request.webhookPayload?.system_prompt === "string" ? request.webhookPayload.system_prompt : ""),
    user_prompt:
      request.userPrompt ?? (typeof request.webhookPayload?.user_prompt === "string" ? request.webhookPayload.user_prompt : ""),
    session_id:
      request.sessionId ??
      (typeof request.webhookPayload?.session_id === "string" ? request.webhookPayload.session_id : undefined)
  };

  const nodeOutputs = new Map<string, unknown>();
  const nodeResults: NodeExecutionResult[] = [];
  let finalOutput: unknown;
  let failedError: string | undefined;
  let failedIndex = -1;

  for (let index = 0; index < nodeOrder.length; index += 1) {
    const nodeId = nodeOrder[index];
    const node = nodeById.get(nodeId);
    if (!node) {
      continue;
    }

    const started = Date.now();
    const startedAtNode = nowIso();

    try {
      const parentIds = incoming.get(node.id) ?? [];
      const parentOutputs: Record<string, unknown> = {};
      for (const parentId of parentIds) {
        if (nodeOutputs.has(parentId)) {
          parentOutputs[parentId] = nodeOutputs.get(parentId);
        }
      }

      const merged = mergeParentOutputs(parentOutputs);
      const output = await executeNode(
        node,
        {
          globals,
          merged,
          parentOutputs
        },
        dependencies
      );

      nodeOutputs.set(node.id, output);

      nodeResults.push({
        nodeId: node.id,
        status: "success",
        startedAt: startedAtNode,
        completedAt: nowIso(),
        durationMs: Date.now() - started,
        output
      });

      if (node.type === "output") {
        finalOutput = output;
      }
    } catch (error) {
      failedError = error instanceof Error ? error.message : "Node execution failed";
      failedIndex = index;
      nodeResults.push({
        nodeId: node.id,
        status: "error",
        startedAt: startedAtNode,
        completedAt: nowIso(),
        durationMs: Date.now() - started,
        error: failedError
      });
      break;
    }
  }

  if (failedError) {
    for (let index = failedIndex + 1; index < nodeOrder.length; index += 1) {
      const nodeId = nodeOrder[index];
      nodeResults.push({
        nodeId,
        status: "skipped",
        startedAt: nowIso(),
        completedAt: nowIso(),
        durationMs: 0
      });
    }

    return {
      workflowId: request.workflow.id,
      status: "error",
      startedAt,
      completedAt: nowIso(),
      nodeResults,
      error: failedError
    };
  }

  if (finalOutput === undefined && nodeOrder.length > 0) {
    finalOutput = nodeOutputs.get(nodeOrder[nodeOrder.length - 1]);
  }

  return {
    workflowId: request.workflow.id,
    status: "success",
    startedAt,
    completedAt: nowIso(),
    nodeResults,
    output: finalOutput
  };
}