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
import { isAuxiliaryEdge, isExecutionEdge } from "./graph";
import {
  type RetrieverAdapter,
  InMemoryRetrieverAdapter,
  TokenEmbeddingAdapter,
  OpenAIEmbeddingAdapter,
  InMemoryVectorStoreAdapter,
  PineconeVectorStoreAdapter,
  PGVectorStoreAdapter,
  type EmbeddingRegistry,
  type VectorStoreRegistry
} from "./rag-adapters";
import { renderTemplate, tryParseJson } from "./template";
import { sortWorkflowNodes, validateWorkflowGraph } from "./validation";

export interface WorkflowExecutionDependencies {
  providerRegistry: ProviderRegistry;
  mcpRegistry: MCPRegistry;
  connectorRegistry: ConnectorRegistry;
  embeddingRegistry?: EmbeddingRegistry;
  vectorStoreRegistry?: VectorStoreRegistry;
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

    case "document_chunker": {
      const chunkSize = typeof config.chunkSize === "number" && config.chunkSize > 0 ? Math.floor(config.chunkSize) : 500;
      const chunkOverlap = typeof config.chunkOverlap === "number" && config.chunkOverlap >= 0 ? Math.floor(config.chunkOverlap) : 50;
      const separator = typeof config.separator === "string" ? config.separator : "\n\n";

      const upstreamDocs = normalizeDocuments(templateData.documents);
      const chunkedDocs: ConnectorDocument[] = [];

      for (const doc of upstreamDocs) {
        const text = doc.text.trim();
        if (!text) continue;

        const chunks = text.split(separator).filter(Boolean);
        let currentChunk = "";
        let index = 0;

        for (const chunk of chunks) {
          if ((currentChunk + separator + chunk).length > chunkSize && currentChunk.length > 0) {
            chunkedDocs.push({
              id: `${doc.id}-chunk-${index++}`,
              text: currentChunk,
              metadata: { ...toRecord(doc.metadata), chunkIndex: index - 1, originalId: doc.id }
            });

            // Very naive overlap implementation for string lengths
            const overlapAmount = Math.min(chunkOverlap, currentChunk.length);
            currentChunk = currentChunk.slice(-overlapAmount) + separator + chunk;
          } else {
            currentChunk = currentChunk ? currentChunk + separator + chunk : chunk;
          }
        }

        if (currentChunk) {
          chunkedDocs.push({
             id: `${doc.id}-chunk-${index}`,
             text: currentChunk,
             metadata: { ...toRecord(doc.metadata), chunkIndex: index, originalId: doc.id }
          });
        }
      }

      return {
        documents: chunkedDocs,
        count: chunkedDocs.length
      };
    }

    case "rag_retrieve": {
      const queryTemplate = typeof config.queryTemplate === "string" ? config.queryTemplate : "{{user_prompt}}";
      const query = renderTemplate(queryTemplate, templateData).trim();
      const topK = typeof config.topK === "number" && config.topK > 0 ? Math.floor(config.topK) : 3;

      const inlineDocs = normalizeDocuments(config.documents);
      const upstreamDocs = normalizeDocuments(templateData.documents);
      const allDocs = [...upstreamDocs, ...inlineDocs];

      const embedderId = typeof config.embedderId === "string" ? config.embedderId : "token-embedder";
      const vectorStoreId = typeof config.vectorStoreId === "string" ? config.vectorStoreId : "in-memory-vector-store";

      let embedder = dependencies.embeddingRegistry?.get(embedderId);
      if (!embedder) {
        if (embedderId === "token-embedder") embedder = new TokenEmbeddingAdapter();
        else if (embedderId === "openai-embedder") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.OPENAI_API_KEY;
           embedder = new OpenAIEmbeddingAdapter({ apiKey: apiKey || "", ...toRecord(config.vectorStoreConfig) });
        }
        else throw new Error(`Unknown embedder ID: ${embedderId}`);
      }

      let store = dependencies.vectorStoreRegistry?.get(vectorStoreId);
      if (!store) {
         if (vectorStoreId === "in-memory-vector-store") store = new InMemoryVectorStoreAdapter();
         else if (vectorStoreId === "pinecone-vector-store") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.PINECONE_API_KEY;
           store = new PineconeVectorStoreAdapter({ apiKey: apiKey || "", indexName: typeof toRecord(config.vectorStoreConfig).indexName === "string" ? toRecord(config.vectorStoreConfig).indexName as string : "" });
         } else if (vectorStoreId === "pgvector-store") {
           const connRef = config.embeddingSecretRef;
           const connStr = typeof connRef === "object" && connRef ? await dependencies.resolveSecret(connRef as SecretReference) : process.env.DATABASE_URL;
           store = new PGVectorStoreAdapter({ connectionString: connStr || "", tableName: typeof toRecord(config.vectorStoreConfig).tableName === "string" ? toRecord(config.vectorStoreConfig).tableName as string : "vectors" });
         }
         else throw new Error(`Unknown vector store ID: ${vectorStoreId}`);
      }

      await store.upsert(allDocs, embedder);
      const documents = await store.similaritySearch(query, topK, embedder);

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
      const provider = attachedModelNode ? normalizeProvider(toRecord(attachedModelNode.config).provider) : undefined;
      if (!provider) {
        throw new Error("Agent Orchestrator requires an attached LLM Call node on chat_model.");
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

    case "output_parser": {
      const mode = typeof config.mode === "string" ? config.mode : "json_schema";
      const inputKey = typeof config.inputKey === "string" && config.inputKey ? config.inputKey : "answer";
      const rawInput = String(templateData[inputKey] ?? templateData.text ?? templateData.answer ?? "");
      const maxRetries = typeof config.maxRetries === "number" && config.maxRetries > 0 ? Math.floor(config.maxRetries) : 2;

      if (mode === "item_list") {
        const separator = typeof config.itemSeparator === "string" ? config.itemSeparator : "\n";
        const items = rawInput.split(separator).map((item) => item.trim()).filter(Boolean);
        return { items, count: items.length, raw: rawInput };
      }

      // json_schema and auto_fix modes
      let schemaObj: Record<string, unknown> | undefined;
      if (mode === "json_schema" && typeof config.jsonSchema === "string") {
        try {
          schemaObj = JSON.parse(config.jsonSchema) as Record<string, unknown>;
        } catch {
          throw new Error("Output Parser: jsonSchema config is not valid JSON.");
        }
      }

      const validateJsonOutput = (text: string): { ok: boolean; parsed?: unknown; error?: string } => {
        // Extract JSON from text (handle markdown code fences)
        let jsonText = text.trim();
        const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
          jsonText = fenceMatch[1].trim();
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonText);
        } catch (parseError) {
          return { ok: false, error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : "parse error"}` };
        }

        if (mode === "auto_fix") {
          return { ok: true, parsed };
        }

        // json_schema mode: validate required fields and types
        if (schemaObj && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          const required = Array.isArray(schemaObj.required) ? schemaObj.required.map(String) : [];
          for (const field of required) {
            if (!(field in record)) {
              return { ok: false, parsed, error: `Missing required field: ${field}` };
            }
          }
          const properties = toRecord(schemaObj.properties);
          for (const [key, propSchema] of Object.entries(properties)) {
            if (!(key in record)) continue;
            const prop = toRecord(propSchema);
            if (typeof prop.type === "string" && record[key] !== undefined && record[key] !== null) {
              const actualType = typeof record[key];
              if (prop.type === "string" && actualType !== "string") return { ok: false, parsed, error: `Field '${key}' should be string, got ${actualType}` };
              if (prop.type === "number" && actualType !== "number") return { ok: false, parsed, error: `Field '${key}' should be number, got ${actualType}` };
              if (prop.type === "boolean" && actualType !== "boolean") return { ok: false, parsed, error: `Field '${key}' should be boolean, got ${actualType}` };
            }
            if (Array.isArray(prop.enum) && record[key] !== undefined) {
              if (!prop.enum.includes(record[key])) return { ok: false, parsed, error: `Field '${key}' value '${String(record[key])}' not in enum: ${prop.enum.join(", ")}` };
            }
          }
        }
        return { ok: true, parsed };
      };

      let result = validateJsonOutput(rawInput);
      let retries = 0;

      if (!result.ok) {
        // Find a provider to use for retry calls from templateData or upstream llm_call
        const upstreamProvider = (templateData as Record<string, unknown>).__output_parser_provider as Record<string, unknown> | undefined;
        const providerId = typeof upstreamProvider?.providerId === "string" ? upstreamProvider.providerId : undefined;

        if (providerId) {
          const providerAdapter = dependencies.providerRegistry.get(providerId);
          for (let attempt = 0; attempt < maxRetries && !result.ok; attempt += 1) {
            const correctionPrompt = mode === "json_schema" && schemaObj
              ? `Your previous output was invalid. Error: ${result.error}. Required schema: ${JSON.stringify(schemaObj)}. Original output: ${rawInput}. Please output ONLY valid JSON matching the schema, with no other text.`
              : `Your previous output was not valid JSON. Error: ${result.error}. Original output: ${rawInput}. Please output ONLY valid JSON with no other text.`;

            const retryResponse = await providerAdapter.generate(
              {
                provider: upstreamProvider as unknown as Parameters<typeof providerAdapter.generate>[0]["provider"],
                messages: [
                  { role: "system", content: "You are a JSON formatting assistant. Output ONLY valid JSON." },
                  { role: "user", content: correctionPrompt }
                ]
              },
              { resolveSecret: dependencies.resolveSecret }
            );
            result = validateJsonOutput(retryResponse.content);
            retries += 1;
          }
        }
      }

      if (!result.ok) {
        throw new Error(`Output Parser failed after ${retries} retries: ${result.error}`);
      }

      return { parsed: result.parsed, raw: rawInput, retries };
    }

    case "if_node": {
      const conditionTemplate = typeof config.condition === "string" ? config.condition : "";
      const evaluated = renderTemplate(conditionTemplate, templateData).trim();
      const isTruthy = Boolean(evaluated) && evaluated !== "false" && evaluated !== "0" && evaluated !== "null" && evaluated !== "undefined";
      return {
        result: isTruthy,
        evaluatedValue: evaluated,
        _branchHandle: isTruthy ? "true" : "false"
      };
    }

    case "switch_node": {
      const switchTemplate = typeof config.switchValue === "string" ? config.switchValue : "";
      const evaluated = renderTemplate(switchTemplate, templateData).trim();
      const cases = Array.isArray(config.cases) ? config.cases as Array<{ value: string; label: string }> : [];
      const defaultLabel = typeof config.defaultLabel === "string" ? config.defaultLabel : "default";
      let matchedLabel = defaultLabel;
      for (const switchCase of cases) {
        if (String(switchCase.value).trim() === evaluated) {
          matchedLabel = switchCase.label;
          break;
        }
      }
      return {
        matched: matchedLabel,
        evaluatedValue: evaluated,
        _branchHandle: matchedLabel
      };
    }

    case "try_catch": {
      // try_catch is structural — execution routing is handled by the executor loop
      return { _branchHandle: "success" };
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

interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

function getRetryConfig(config: Record<string, unknown>): RetryConfig | undefined {
  const retry = toRecord(config.retry);
  if (!retry || retry.enabled !== true) {
    return undefined;
  }
  return {
    enabled: true,
    maxAttempts: typeof retry.maxAttempts === "number" && retry.maxAttempts >= 1 ? Math.floor(retry.maxAttempts) : 3,
    delayMs: typeof retry.delayMs === "number" && retry.delayMs >= 0 ? Math.floor(retry.delayMs) : 1000,
    backoffMultiplier: typeof retry.backoffMultiplier === "number" && retry.backoffMultiplier >= 1 ? retry.backoffMultiplier : 2
  };
}

function getOnError(config: Record<string, unknown>): "stop" | "continue" | "branch" {
  const value = config.onError;
  if (value === "continue" || value === "branch") {
    return value;
  }
  return "stop";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeNodeWithRetry(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): Promise<{ output: unknown; attempts: number }> {
  const config = toRecord(node.config);
  const retry = getRetryConfig(config);
  if (!retry) {
    return { output: await executeNode(node, context, dependencies), attempts: 1 };
  }

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const output = await executeNode(node, context, dependencies);
      return { output, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Node execution failed");
      if (attempt < retry.maxAttempts) {
        const delay = retry.delayMs * Math.pow(retry.backoffMultiplier, attempt - 1);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error("Node execution failed after retries");
}

function collectDescendants(
  nodeId: string,
  outgoingExecution: Map<string, string[]>,
  workflow: { edges: { source: string; target: string; sourceHandle?: string }[] }
): Set<string> {
  const descendants = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const targets = outgoingExecution.get(current) ?? [];
    for (const target of targets) {
      if (!descendants.has(target)) {
        descendants.add(target);
        queue.push(target);
      }
    }
  }
  return descendants;
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
  let hadContinuedErrors = false;

  // Branch-aware skip tracking:
  // When a branching node (if_node, switch_node, try_catch) runs, we add
  // all nodes on non-taken branches to this set.
  const skippedByBranch = new Set<string>();

  // try_catch error routing: maps try_catch nodeId -> error branch target nodeIds
  const tryCatchScopes = new Map<string, { errorTargets: string[]; successDescendants: Set<string> }>();

  // Build a map of sourceHandle -> target nodeIds for branching edges
  const branchTargets = new Map<string, Map<string, string[]>>();
  for (const edge of request.workflow.edges) {
    if (!edge.sourceHandle || isAuxiliaryEdge(edge)) {
      continue;
    }
    let handleMap = branchTargets.get(edge.source);
    if (!handleMap) {
      handleMap = new Map();
      branchTargets.set(edge.source, handleMap);
    }
    const targets = handleMap.get(edge.sourceHandle) ?? [];
    targets.push(edge.target);
    handleMap.set(edge.sourceHandle, targets);
  }

  for (let index = 0; index < nodeOrder.length; index += 1) {
    const nodeId = nodeOrder[index];
    const node = graphIndexes.nodeById.get(nodeId);
    if (!node) {
      continue;
    }

    // Skip nodes on non-taken branches
    if (skippedByBranch.has(node.id)) {
      nodeResults.push({
        nodeId: node.id,
        status: "skipped",
        startedAt: nowIso(),
        completedAt: nowIso(),
        durationMs: 0,
        output: { reason: "branch_not_taken" }
      });
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
    const nodeConfig = toRecord(node.config);
    const onError = getOnError(nodeConfig);

    try {
      const parentIds = graphIndexes.incomingExecution.get(node.id) ?? [];
      const parentOutputs: Record<string, unknown> = {};
      for (const parentId of parentIds) {
        if (nodeOutputs.has(parentId)) {
          parentOutputs[parentId] = nodeOutputs.get(parentId);
        }
      }

      const merged = mergeParentOutputs(parentOutputs);
      const { output, attempts } = await executeNodeWithRetry(
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
        output,
        attempts: attempts > 1 ? attempts : undefined
      });

      if (node.type === "output") {
        finalOutput = output;
      }

      // Handle branching: determine which branches to skip
      const outputRecord = toRecord(output);
      const activeBranch = typeof outputRecord._branchHandle === "string" ? outputRecord._branchHandle : undefined;

      if (activeBranch && branchTargets.has(node.id)) {
        const handleMap = branchTargets.get(node.id)!;
        for (const [handle, targets] of handleMap.entries()) {
          if (handle === activeBranch) {
            continue; // This is the taken branch
          }
          // Mark all nodes on non-taken branches as skipped
          for (const target of targets) {
            const descendants = collectDescendants(target, graphIndexes.outgoingExecution, request.workflow);
            skippedByBranch.add(target);
            for (const desc of descendants) {
              skippedByBranch.add(desc);
            }
          }
        }
      }

      // try_catch: register scope for error routing
      if (node.type === "try_catch") {
        const handleMap = branchTargets.get(node.id);
        const successTargets = handleMap?.get("success") ?? [];
        const errorTargets = handleMap?.get("error") ?? [];
        const successDescendants = new Set<string>();
        for (const t of successTargets) {
          successDescendants.add(t);
          for (const desc of collectDescendants(t, graphIndexes.outgoingExecution, request.workflow)) {
            successDescendants.add(desc);
          }
        }
        tryCatchScopes.set(node.id, { errorTargets, successDescendants });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Node execution failed";

      // Check if this node is inside a try_catch scope
      let caughtByTryCatch = false;
      for (const [tryCatchId, scope] of tryCatchScopes.entries()) {
        if (scope.successDescendants.has(node.id)) {
          // Skip remaining nodes in the success branch
          for (const desc of scope.successDescendants) {
            if (desc !== node.id) {
              skippedByBranch.add(desc);
            }
          }
          // Un-skip error branch targets (they were initially skipped by branch routing)
          for (const errorTarget of scope.errorTargets) {
            skippedByBranch.delete(errorTarget);
            for (const desc of collectDescendants(errorTarget, graphIndexes.outgoingExecution, request.workflow)) {
              skippedByBranch.delete(desc);
            }
          }
          // Set error info as output for the error branch
          nodeOutputs.set(tryCatchId, {
            error: errorMessage,
            failedNodeId: node.id,
            failedNodeType: node.type,
            caught: true
          });

          caughtByTryCatch = true;
          nodeResults.push({
            nodeId: node.id,
            status: "error",
            startedAt: startedAtNode,
            completedAt: nowIso(),
            durationMs: Date.now() - started,
            error: errorMessage
          });
          hadContinuedErrors = true;
          break;
        }
      }

      if (!caughtByTryCatch) {
        if (onError === "continue") {
          nodeOutputs.set(node.id, { error: errorMessage });
          nodeResults.push({
            nodeId: node.id,
            status: "error",
            startedAt: startedAtNode,
            completedAt: nowIso(),
            durationMs: Date.now() - started,
            error: errorMessage
          });
          hadContinuedErrors = true;
          continue;
        }

        if (onError === "branch" && branchTargets.has(node.id)) {
          const handleMap = branchTargets.get(node.id)!;
          const errorBranchTargets = handleMap.get("error") ?? [];
          if (errorBranchTargets.length > 0) {
            // Skip non-error branches, un-skip error branch
            for (const [handle, targets] of handleMap.entries()) {
              if (handle === "error") {
                for (const t of targets) {
                  skippedByBranch.delete(t);
                  for (const desc of collectDescendants(t, graphIndexes.outgoingExecution, request.workflow)) {
                    skippedByBranch.delete(desc);
                  }
                }
              } else {
                for (const t of targets) {
                  skippedByBranch.add(t);
                  for (const desc of collectDescendants(t, graphIndexes.outgoingExecution, request.workflow)) {
                    skippedByBranch.add(desc);
                  }
                }
              }
            }
            nodeOutputs.set(node.id, { error: errorMessage });
            nodeResults.push({
              nodeId: node.id,
              status: "error",
              startedAt: startedAtNode,
              completedAt: nowIso(),
              durationMs: Date.now() - started,
              error: errorMessage
            });
            hadContinuedErrors = true;
            continue;
          }
        }

        // Default: stop execution
        failedError = errorMessage;
        nodeResults.push({
          nodeId: node.id,
          status: "error",
          startedAt: startedAtNode,
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          error: failedError
        });

        // Skip remaining nodes
        for (let remaining = index + 1; remaining < nodeOrder.length; remaining += 1) {
          const remainingId = nodeOrder[remaining];
          nodeResults.push({
            nodeId: remainingId,
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
    }
  }

  if (finalOutput === undefined && nodeOrder.length > 0) {
    finalOutput = nodeOutputs.get(nodeOrder[nodeOrder.length - 1]);
  }

  return {
    workflowId: request.workflow.id,
    status: hadContinuedErrors ? "partial" : "success",
    startedAt,
    completedAt: nowIso(),
    nodeResults,
    output: finalOutput
  };
}

