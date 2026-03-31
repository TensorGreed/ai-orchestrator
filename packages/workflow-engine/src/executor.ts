import type { AgentRuntimeAdapter, AgentSessionMemoryStore } from "@ai-orchestrator/agent-runtime";
import type { ConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { invokeDirectMCPTool, resolveMCPTools, type MCPRegistry } from "@ai-orchestrator/mcp-sdk";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type {
  ChatMessage,
  ConnectorDocument,
  LLMProviderConfig,
  MCPServerConfig,
  NodeExecutionResult,
  SecretReference,
  Workflow,
  WorkflowExecutionResult,
  WorkflowNode
} from "@ai-orchestrator/shared";
import { isExecutionEdge } from "./graph";
import { InMemoryRetrieverAdapter } from "./rag-adapters";
import { renderTemplate, tryParseJson } from "./template";
import { sortWorkflowNodes, validateWorkflowGraph } from "./validation";

export interface WorkflowExecutionDependencies {
  providerRegistry: ProviderRegistry;
  mcpRegistry: MCPRegistry;
  connectorRegistry: ConnectorRegistry;
  agentRuntime: AgentRuntimeAdapter;
  memoryStore?: AgentSessionMemoryStore;
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
  workflow: Workflow;
  nodeById: Map<string, WorkflowNode>;
  attachmentsBySource: Map<string, Map<AgentAttachmentHandle, string[]>>;
}

type AgentAttachmentHandle = "chat_model" | "memory" | "tool";
const AGENT_ATTACHMENT_HANDLES = new Set<AgentAttachmentHandle>(["chat_model", "memory", "tool"]);
const ALL_MCP_TOOLS_SENTINEL = "__all__";

function nowIso() {
  return new Date().toISOString();
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function getAttachmentHandle(sourceHandle: string | undefined): AgentAttachmentHandle | undefined {
  if (!sourceHandle || !AGENT_ATTACHMENT_HANDLES.has(sourceHandle as AgentAttachmentHandle)) {
    return undefined;
  }

  return sourceHandle as AgentAttachmentHandle;
}

function normalizeProvider(value: unknown): LLMProviderConfig | undefined {
  const provider = toRecord(value);
  if (typeof provider.providerId !== "string" || typeof provider.model !== "string") {
    return undefined;
  }

  return provider as unknown as LLMProviderConfig;
}

function buildServerConfigKey(server: MCPServerConfig): string {
  const connection = JSON.stringify(server.connection ?? {});
  const secretId = server.secretRef?.secretId ?? "";
  return `${server.serverId}::${secretId}::${connection}`;
}

function mergeMCPServerConfigs(base: MCPServerConfig[], additional: MCPServerConfig[]): MCPServerConfig[] {
  const grouped = new Map<
    string,
    {
      server: MCPServerConfig;
      allowedTools?: Set<string>;
    }
  >();

  for (const entry of [...base, ...additional]) {
    const key = buildServerConfigKey(entry);
    const current = grouped.get(key);

    if (!current) {
      grouped.set(key, {
        server: {
          ...entry,
          allowedTools: entry.allowedTools ? [...entry.allowedTools] : undefined
        },
        allowedTools: entry.allowedTools ? new Set(entry.allowedTools) : undefined
      });
      continue;
    }

    if (!current.allowedTools || !entry.allowedTools) {
      current.allowedTools = undefined;
      current.server.allowedTools = undefined;
      continue;
    }

    for (const tool of entry.allowedTools) {
      current.allowedTools.add(tool);
    }
    current.server.allowedTools = [...current.allowedTools];
  }

  return [...grouped.values()].map((entry) => entry.server);
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

interface GraphIndexes {
  nodeById: Map<string, WorkflowNode>;
  incomingExecution: Map<string, string[]>;
  outgoingExecution: Map<string, string[]>;
  incomingAttachments: Map<string, string[]>;
  attachmentsBySource: Map<string, Map<AgentAttachmentHandle, string[]>>;
}

function buildGraphIndexes(workflow: Workflow): GraphIndexes {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const incomingExecution = new Map<string, string[]>();
  const outgoingExecution = new Map<string, string[]>();
  const incomingAttachments = new Map<string, string[]>();
  const attachmentsBySource = new Map<string, Map<AgentAttachmentHandle, string[]>>();

  for (const node of workflow.nodes) {
    incomingExecution.set(node.id, []);
    outgoingExecution.set(node.id, []);
    incomingAttachments.set(node.id, []);
  }

  for (const edge of workflow.edges) {
    const attachmentHandle = getAttachmentHandle(edge.sourceHandle);
    if (attachmentHandle) {
      const incoming = incomingAttachments.get(edge.target);
      if (incoming) {
        incoming.push(edge.source);
      }

      let sourceMap = attachmentsBySource.get(edge.source);
      if (!sourceMap) {
        sourceMap = new Map<AgentAttachmentHandle, string[]>();
        attachmentsBySource.set(edge.source, sourceMap);
      }
      const targets = sourceMap.get(attachmentHandle) ?? [];
      targets.push(edge.target);
      sourceMap.set(attachmentHandle, targets);
      continue;
    }

    if (!isExecutionEdge(edge)) {
      continue;
    }

    const incoming = incomingExecution.get(edge.target);
    if (incoming) {
      incoming.push(edge.source);
    }

    const outgoing = outgoingExecution.get(edge.source);
    if (outgoing) {
      outgoing.push(edge.target);
    }
  }

  return {
    nodeById,
    incomingExecution,
    outgoingExecution,
    incomingAttachments,
    attachmentsBySource
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

    case "local_memory": {
      const namespaceTemplate =
        typeof config.namespace === "string" && config.namespace.trim()
          ? config.namespace
          : `${context.workflow.id}:${node.id}`;
      const sessionTemplate = typeof config.sessionIdTemplate === "string" ? config.sessionIdTemplate : "{{session_id}}";
      const maxMessages = typeof config.maxMessages === "number" && config.maxMessages > 0 ? Math.floor(config.maxMessages) : 20;
      const sessionId = renderTemplate(sessionTemplate, templateData).trim();
      const namespace = renderTemplate(namespaceTemplate, templateData).trim() || `${context.workflow.id}:${node.id}`;

      if (!sessionId || !dependencies.memoryStore) {
        return {
          namespace,
          sessionId,
          maxMessages,
          messages: []
        };
      }

      const messages = await dependencies.memoryStore.loadMessages(namespace, sessionId);
      return {
        namespace,
        sessionId,
        maxMessages,
        messages: messages.slice(-maxMessages)
      };
    }

    case "mcp_tool": {
      const serverId = String(config.serverId ?? "");
      const toolName = String(config.toolName ?? "");
      if (toolName.trim() === ALL_MCP_TOOLS_SENTINEL) {
        throw new Error("Direct MCP Tool execution requires a specific tool name (single-tool mode).");
      }
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
      const attachedByHandle = context.attachmentsBySource.get(node.id);
      const getAttachedNodes = (handle: AgentAttachmentHandle) => {
        const ids = attachedByHandle?.get(handle) ?? [];
        return ids
          .map((id) => context.nodeById.get(id))
          .filter((attached): attached is WorkflowNode => Boolean(attached));
      };

      const attachedModelNode = getAttachedNodes("chat_model").find((attached) => attached.type === "llm_call");
      const attachedProvider = attachedModelNode
        ? normalizeProvider(toRecord(attachedModelNode.config).provider)
        : undefined;
      const inlineProvider = normalizeProvider(config.provider);
      const provider = attachedProvider ?? inlineProvider;
      if (!provider) {
        throw new Error("Agent Orchestrator requires inline provider config or an attached LLM Call node on chat_model.");
      }

      const maxIterations = typeof config.maxIterations === "number" ? Math.max(1, Math.floor(config.maxIterations)) : 4;
      const toolCallingEnabled = config.toolCallingEnabled !== false;

      const systemTemplate =
        typeof config.systemPromptTemplate === "string" ? config.systemPromptTemplate : "{{system_prompt}}";
      const userTemplate = typeof config.userPromptTemplate === "string" ? config.userPromptTemplate : "{{user_prompt}}";
      const sessionTemplate = typeof config.sessionIdTemplate === "string" ? config.sessionIdTemplate : "{{session_id}}";
      const systemPrompt = renderTemplate(systemTemplate, templateData);
      const userPrompt = renderTemplate(userTemplate, templateData);
      const resolvedSessionId = renderTemplate(sessionTemplate, templateData).trim();
      const sessionId =
        resolvedSessionId || (typeof templateData.session_id === "string" ? String(templateData.session_id) : undefined);

      const inlineServerConfigs = Array.isArray(config.mcpServers)
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

      const attachedToolServerConfigs: MCPServerConfig[] = [];
      for (const attached of getAttachedNodes("tool").filter((entry) => entry.type === "mcp_tool")) {
        const attachedConfig = toRecord(attached.config);
        const serverId = String(attachedConfig.serverId ?? "").trim();
        if (!serverId) {
          continue;
        }

        const allowedTools = new Set<string>();
        if (Array.isArray(attachedConfig.allowedTools)) {
          for (const tool of attachedConfig.allowedTools) {
            const normalized = String(tool ?? "").trim();
            if (normalized) {
              allowedTools.add(normalized);
            }
          }
        }

        const toolName = String(attachedConfig.toolName ?? "").trim();
        if (toolName && toolName !== ALL_MCP_TOOLS_SENTINEL) {
          allowedTools.add(toolName);
        }

        attachedToolServerConfigs.push({
          serverId,
          connection: toRecord(attachedConfig.connection),
          secretRef: attachedConfig.secretRef as SecretReference | undefined,
          allowedTools: allowedTools.size ? [...allowedTools] : undefined
        });
      }

      const serverConfigs = mergeMCPServerConfigs(inlineServerConfigs, attachedToolServerConfigs);
      const mcpExecutionContext = {
        resolveSecret: dependencies.resolveSecret,
        runtimeState: new Map<string, unknown>()
      };

      const resolvedTools = await resolveMCPTools(serverConfigs, dependencies.mcpRegistry, mcpExecutionContext);

      const attachedMemoryNode = getAttachedNodes("memory").find((attached) => attached.type === "local_memory");
      let memory: { namespace?: string; maxMessages?: number; persistToolMessages?: boolean } | undefined;
      if (attachedMemoryNode) {
        const memoryConfig = toRecord(attachedMemoryNode.config);
        const namespaceTemplate =
          typeof memoryConfig.namespace === "string" && memoryConfig.namespace.trim()
            ? memoryConfig.namespace
            : `${context.workflow.id}:${node.id}`;
        const namespace = renderTemplate(namespaceTemplate, templateData).trim() || `${context.workflow.id}:${node.id}`;
        const maxMessages =
          typeof memoryConfig.maxMessages === "number" && memoryConfig.maxMessages > 0
            ? Math.floor(memoryConfig.maxMessages)
            : 20;
        const persistToolMessages = memoryConfig.persistToolMessages !== false;
        memory = {
          namespace,
          maxMessages,
          persistToolMessages
        };
      }

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
          sessionId,
          memory
        },
        {
          tools: resolvedTools.tools,
          invokeTool: resolvedTools.invokeByExposedName
        },
        {
          providerRegistry: dependencies.providerRegistry,
          resolveSecret: dependencies.resolveSecret,
          memoryStore: dependencies.memoryStore
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
  const graphIndexes = buildGraphIndexes(request.workflow);

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
    const node = graphIndexes.nodeById.get(nodeId);
    if (!node) {
      continue;
    }

    const hasExecutionIncoming = (graphIndexes.incomingExecution.get(node.id)?.length ?? 0) > 0;
    const hasExecutionOutgoing = (graphIndexes.outgoingExecution.get(node.id)?.length ?? 0) > 0;
    const hasAttachmentIncoming = (graphIndexes.incomingAttachments.get(node.id)?.length ?? 0) > 0;
    const isAttachmentOnlyNode = hasAttachmentIncoming && !hasExecutionIncoming && !hasExecutionOutgoing;

    if (isAttachmentOnlyNode) {
      nodeResults.push({
        nodeId: node.id,
        status: "skipped",
        startedAt: nowIso(),
        completedAt: nowIso(),
        durationMs: 0,
        output: {
          reason: "attachment_only_node",
          message: "Node is attached to an agent port and is not part of the execution DAG."
        }
      });
      continue;
    }

    const started = Date.now();
    const startedAtNode = nowIso();

    try {
      const parentIds = graphIndexes.incomingExecution.get(node.id) ?? [];
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
          parentOutputs,
          workflow: request.workflow,
          nodeById: graphIndexes.nodeById,
          attachmentsBySource: graphIndexes.attachmentsBySource
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
