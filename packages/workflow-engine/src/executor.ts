import { randomUUID } from "node:crypto";
import vm from "node:vm";
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
  WorkflowExecutionState,
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
  persistPausedExecution?: (input: {
    executionId: string;
    workflowId: string;
    workflowName: string;
    triggerType?: string;
    triggeredBy?: string;
    waitingNodeId: string;
    approvalMessage: string;
    timeoutMinutes: number;
    startedAt: string;
    state: WorkflowExecutionState;
  }) => Promise<void>;
  onNodeStart?: (event: {
    nodeId: string;
    nodeType: string;
    startedAt: string;
  }) => Promise<void> | void;
  onNodeComplete?: (event: {
    nodeId: string;
    nodeType: string;
    status: NodeExecutionResult["status"];
    completedAt: string;
    durationMs: number;
    output?: unknown;
    error?: string;
  }) => Promise<void> | void;
  onLLMDelta?: (event: {
    nodeId: string;
    delta: string;
    index: number;
  }) => Promise<void> | void;
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
  executionId?: string;
  triggerType?: string;
  triggeredBy?: string;
  resumeState?: WorkflowExecutionState;
  approvalDecision?: {
    decision: "approve" | "reject";
    actedBy?: string;
    reason?: string;
  };
}

export interface ResumeWorkflowRequest {
  executionId: string;
  state: WorkflowExecutionState;
  decision: "approve" | "reject";
  actedBy?: string;
  reason?: string;
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

function getValueByPath(input: Record<string, unknown>, path: string): unknown {
  const parts = path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return undefined;
  }

  let current: unknown = input;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function validateGuardrailChecks(text: string, checks: string[]): string[] {
  const failures: string[] = [];
  const normalizedText = String(text ?? "");

  for (const check of checks) {
    if (check === "no_pii") {
      const piiPatterns = [
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
        /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
        /\b\d{3}-\d{2}-\d{4}\b/,
        /\b(?:\d[ -]*?){13,16}\b/
      ];
      if (piiPatterns.some((pattern) => pattern.test(normalizedText))) {
        failures.push("no_pii");
      }
      continue;
    }

    if (check === "no_profanity") {
      const profanityTokens = ["damn", "shit", "fuck", "bitch", "bastard"];
      const lower = normalizedText.toLowerCase();
      if (profanityTokens.some((token) => lower.includes(token))) {
        failures.push("no_profanity");
      }
      continue;
    }

    if (check === "must_contain_json") {
      const candidate = extractJsonFromText(normalizedText);
      try {
        JSON.parse(candidate);
      } catch {
        failures.push("must_contain_json");
      }
    }
  }

  return failures;
}

export interface CodeNodeExecutionInput {
  code: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
}

export interface CodeNodeExecutionOutput {
  result: unknown;
  logs: string[];
}

function toJsonSafeValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export async function executeCodeNodeSandbox(input: CodeNodeExecutionInput): Promise<CodeNodeExecutionOutput> {
  const code = String(input.code ?? "");
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : 1500;
  const logs: string[] = [];

  const sandboxConsole = {
    log: (...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    },
    error: (...args: unknown[]) => {
      logs.push(`ERROR: ${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}`);
    },
    warn: (...args: unknown[]) => {
      logs.push(`WARN: ${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}`);
    },
    info: (...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    }
  };

  const contextObject: Record<string, unknown> = {
    input: toJsonSafeValue(input.input),
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Date,
    console: sandboxConsole,
    require: undefined,
    process: undefined,
    fs: undefined,
    fetch: undefined,
    globalThis: undefined,
    Function: undefined,
    eval: undefined
  };

  const context = vm.createContext(contextObject);
  const wrappedCode = `(async () => {\n${code}\n})()`;

  try {
    const runResult = vm.runInContext(wrappedCode, context, {
      timeout: timeoutMs
    });
    const resolvedResult = await Promise.resolve(runResult);
    return {
      result: toJsonSafeValue(resolvedResult),
      logs
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Code node execution failed.";
    throw new Error(`Code node sandbox error: ${message}`);
  }
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

    case "input_validator": {
      const rules = Array.isArray(config.rules)
        ? config.rules.map((entry) => toRecord(entry))
        : [];
      const onFail = config.onFail === "branch" ? "branch" : "error";
      const payloadSources = [
        toRecord(context.globals.webhook),
        toRecord(context.globals),
        toRecord(templateData.input)
      ];
      const payload = Object.assign({}, ...payloadSources);
      const errors: Array<{ field: string; check: string; message: string }> = [];

      for (const rule of rules) {
        const field = String(rule.field ?? "").trim();
        const check = String(rule.check ?? "").trim();
        const expectedValue = String(rule.value ?? "");
        if (!field || !check) {
          continue;
        }

        const actualValue = getValueByPath(payload, field);
        if (check === "required") {
          const missing =
            actualValue === undefined ||
            actualValue === null ||
            (typeof actualValue === "string" && actualValue.trim() === "");
          if (missing) {
            errors.push({
              field,
              check,
              message: `Field '${field}' is required.`
            });
          }
          continue;
        }

        if (check === "max_length") {
          const maxLength = Number(expectedValue);
          const currentLength = String(actualValue ?? "").length;
          if (Number.isFinite(maxLength) && currentLength > maxLength) {
            errors.push({
              field,
              check,
              message: `Field '${field}' exceeds max length of ${maxLength}.`
            });
          }
          continue;
        }

        if (check === "regex") {
          try {
            const pattern = new RegExp(expectedValue);
            if (!pattern.test(String(actualValue ?? ""))) {
              errors.push({
                field,
                check,
                message: `Field '${field}' does not match regex '${expectedValue}'.`
              });
            }
          } catch {
            errors.push({
              field,
              check,
              message: `Invalid regex for field '${field}'.`
            });
          }
        }
      }

      if (errors.length > 0 && onFail === "error") {
        throw new Error(`Input validation failed: ${errors.map((error) => error.message).join(" ")}`);
      }

      return {
        valid: errors.length === 0,
        errors
      };
    }

    case "code_node": {
      const timeout =
        typeof config.timeout === "number" && Number.isFinite(config.timeout) && config.timeout > 0
          ? Math.floor(config.timeout)
          : 1500;
      const code = typeof config.code === "string" ? config.code : "";
      if (!code.trim()) {
        throw new Error("Code Node requires a non-empty code script.");
      }

      const sandboxInput = {
        ...templateData,
        input: templateData
      };
      const result = await executeCodeNodeSandbox({
        code,
        input: sandboxInput,
        timeoutMs: timeout
      });

      if (result.result && typeof result.result === "object" && !Array.isArray(result.result)) {
        return {
          ...(result.result as Record<string, unknown>),
          code_result: result.result,
          code_logs: result.logs
        };
      }

      return {
        code_result: result.result,
        code_logs: result.logs
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

      const providerAdapter = dependencies.providerRegistry.get(provider.providerId);
      if (dependencies.onLLMDelta && providerAdapter.generateStream) {
        let streamedText = "";
        const toolCallById = new Map<string, { id: string; name: string; argumentsText: string }>();
        let llmDeltaIndex = 0;

        for await (const chunk of providerAdapter.generateStream(
          {
            provider,
            messages
          },
          {
            resolveSecret: dependencies.resolveSecret
          }
        )) {
          if (chunk.type === "text_delta" && chunk.textDelta) {
            streamedText += chunk.textDelta;
            await dependencies.onLLMDelta({
              nodeId: node.id,
              delta: chunk.textDelta,
              index: llmDeltaIndex
            });
            llmDeltaIndex += 1;
          } else if (chunk.type === "tool_call_delta") {
            const toolCallId = chunk.toolCallId ?? `toolcall_${toolCallById.size}`;
            const existing = toolCallById.get(toolCallId) ?? {
              id: toolCallId,
              name: chunk.name ?? `tool_${toolCallById.size}`,
              argumentsText: ""
            };
            if (typeof chunk.name === "string" && chunk.name) {
              existing.name = chunk.name;
            }
            if (typeof chunk.argumentsDelta === "string") {
              existing.argumentsText += chunk.argumentsDelta;
            }
            toolCallById.set(toolCallId, existing);
          }
        }

        const toolCalls = [...toolCallById.values()].map((entry) => {
          let parsedArguments: Record<string, unknown> = {};
          try {
            parsedArguments = JSON.parse(entry.argumentsText || "{}") as Record<string, unknown>;
          } catch {
            parsedArguments = {};
          }
          return {
            id: entry.id,
            name: entry.name,
            arguments: parsedArguments
          };
        });

        return {
          text: streamedText,
          answer: streamedText,
          toolCalls,
          raw: {
            streamed: true
          },
          _provider: provider
        };
      }

      const response = await providerAdapter.generate(
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
        raw: response.raw,
        _provider: provider
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

    case "output_guardrail": {
      const checks = Array.isArray(config.checks)
        ? config.checks.map((value) => String(value)).filter(Boolean)
        : [];
      const onFail = config.onFail === "retry" ? "retry" : "error";
      const inputKey = typeof config.inputKey === "string" && config.inputKey ? config.inputKey : "answer";
      let candidate = String(templateData[inputKey] ?? templateData.answer ?? templateData.text ?? "");
      let failures = validateGuardrailChecks(candidate, checks);
      let attempts = 0;

      if (failures.length > 0 && onFail === "retry") {
        const provider = normalizeProvider(templateData._provider);
        if (!provider) {
          throw new Error("Output Guardrail retry requested but no upstream provider context was found.");
        }

        const providerAdapter = dependencies.providerRegistry.get(provider.providerId);
        while (attempts < 3 && failures.length > 0) {
          attempts += 1;
          const retryResponse = await providerAdapter.generate(
            {
              provider,
              messages: [
                {
                  role: "system",
                  content:
                    "You must rewrite the assistant output so it passes all guardrail checks. Return revised content only."
                },
                {
                  role: "user",
                  content: `Failed checks: ${failures.join(", ")}\n\nOriginal output:\n${candidate}`
                }
              ]
            },
            {
              resolveSecret: dependencies.resolveSecret
            }
          );
          candidate = retryResponse.content;
          failures = validateGuardrailChecks(candidate, checks);
        }
      }

      if (failures.length > 0) {
        throw new Error(`Output guardrail checks failed: ${failures.join(", ")}`);
      }

      return {
        answer: candidate,
        text: candidate,
        guardrail: {
          checks,
          attempts,
          passed: true
        }
      };
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

    case "human_approval": {
      return {
        waiting: true
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

function serializeNodeOutputs(nodeOutputs: Map<string, unknown>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [nodeId, output] of nodeOutputs.entries()) {
    serialized[nodeId] = output;
  }
  return serialized;
}

function deserializeNodeOutputs(nodeOutputs: Record<string, unknown>): Map<string, unknown> {
  const restored = new Map<string, unknown>();
  for (const [nodeId, output] of Object.entries(nodeOutputs ?? {})) {
    restored.set(nodeId, output);
  }
  return restored;
}

function serializeTryCatchScopes(
  scopes: Map<string, { errorTargets: string[]; successDescendants: Set<string> }>
): WorkflowExecutionState["tryCatchScopes"] {
  return [...scopes.entries()].map(([nodeId, scope]) => ({
    nodeId,
    errorTargets: scope.errorTargets,
    successDescendants: [...scope.successDescendants]
  }));
}

function deserializeTryCatchScopes(
  serialized: WorkflowExecutionState["tryCatchScopes"]
): Map<string, { errorTargets: string[]; successDescendants: Set<string> }> {
  const scopes = new Map<string, { errorTargets: string[]; successDescendants: Set<string> }>();
  for (const entry of serialized ?? []) {
    scopes.set(entry.nodeId, {
      errorTargets: Array.isArray(entry.errorTargets) ? entry.errorTargets : [],
      successDescendants: new Set(Array.isArray(entry.successDescendants) ? entry.successDescendants : [])
    });
  }
  return scopes;
}

function appendSkippedNodes(nodeOrder: string[], startIndex: number, nodeResults: NodeExecutionResult[]): void {
  for (let index = startIndex; index < nodeOrder.length; index += 1) {
    nodeResults.push({
      nodeId: nodeOrder[index],
      status: "skipped",
      startedAt: nowIso(),
      completedAt: nowIso(),
      durationMs: 0
    });
  }
}

export async function executeWorkflow(
  request: ExecuteWorkflowRequest,
  dependencies: WorkflowExecutionDependencies
): Promise<WorkflowExecutionResult> {
  const workflow = request.resumeState?.workflow ?? request.workflow;
  const startedAt = request.resumeState?.startedAt ?? nowIso();
  const validation = validateWorkflowGraph(workflow);

  if (!validation.valid) {
    return {
      workflowId: workflow.id,
      status: "error",
      startedAt,
      completedAt: nowIso(),
      executionId: request.executionId,
      nodeResults: [],
      error: validation.issues.map((issue) => issue.message).join("; ")
    };
  }

  const nodeOrder =
    request.resumeState?.nodeOrder?.length ? request.resumeState.nodeOrder : validation.orderedNodeIds ?? sortWorkflowNodes(workflow);
  const graphIndexes = buildGraphIndexes(workflow);

  const globals: Record<string, unknown> = request.resumeState
    ? toRecord(request.resumeState.globals)
    : {
        ...(request.input ?? {}),
        ...(request.variables ?? {}),
        webhook: request.webhookPayload ?? {},
        system_prompt:
          request.systemPrompt ??
          (typeof request.webhookPayload?.system_prompt === "string" ? request.webhookPayload.system_prompt : ""),
        user_prompt:
          request.userPrompt ??
          (typeof request.webhookPayload?.user_prompt === "string" ? request.webhookPayload.user_prompt : ""),
        session_id:
          request.sessionId ??
          (typeof request.webhookPayload?.session_id === "string" ? request.webhookPayload.session_id : undefined)
      };

  const nodeOutputs = request.resumeState
    ? deserializeNodeOutputs(toRecord(request.resumeState.nodeOutputs))
    : new Map<string, unknown>();
  const nodeResults: NodeExecutionResult[] = request.resumeState ? [...request.resumeState.nodeResults] : [];
  let finalOutput: unknown = request.resumeState?.finalOutput;
  let failedError: string | undefined;
  let hadContinuedErrors = request.resumeState?.hadContinuedErrors === true;
  let startIndex = request.resumeState?.nextNodeIndex ?? 0;

  // Branch-aware skip tracking:
  // When a branching node (if_node, switch_node, try_catch) runs, we add
  // all nodes on non-taken branches to this set.
  const skippedByBranch = new Set<string>(request.resumeState?.skippedByBranch ?? []);

  // try_catch error routing: maps try_catch nodeId -> error branch target nodeIds
  const tryCatchScopes = request.resumeState
    ? deserializeTryCatchScopes(request.resumeState.tryCatchScopes)
    : new Map<string, { errorTargets: string[]; successDescendants: Set<string> }>();

  if (request.resumeState && !request.approvalDecision) {
    return {
      workflowId: workflow.id,
      status: "error",
      startedAt,
      completedAt: nowIso(),
      executionId: request.executionId,
      nodeResults,
      error: "Resume execution requires an approval decision."
    };
  }

  // Build a map of sourceHandle -> target nodeIds for branching edges
  const branchTargets = new Map<string, Map<string, string[]>>();
  for (const edge of workflow.edges) {
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

  if (request.resumeState && request.approvalDecision) {
    const waitingNode = graphIndexes.nodeById.get(request.resumeState.waitingNodeId);
    if (!waitingNode) {
      return {
        workflowId: workflow.id,
        status: "error",
        startedAt,
        completedAt: nowIso(),
        executionId: request.executionId,
        nodeResults,
        error: "Unable to resume: waiting approval node is missing from the workflow."
      };
    }

    const filteredNodeResults = nodeResults.filter(
      (entry) => !(entry.nodeId === waitingNode.id && entry.status === "waiting_approval")
    );
    nodeResults.splice(0, nodeResults.length, ...filteredNodeResults);

    const decidedAt = nowIso();
    const decisionPayload = {
      approved: request.approvalDecision.decision === "approve",
      rejected: request.approvalDecision.decision === "reject",
      timestamp: decidedAt,
      actedBy: request.approvalDecision.actedBy
    };

    if (request.approvalDecision.decision === "approve") {
      nodeOutputs.set(waitingNode.id, decisionPayload);
      nodeResults.push({
        nodeId: waitingNode.id,
        status: "success",
        startedAt: decidedAt,
        completedAt: decidedAt,
        durationMs: 0,
        output: decisionPayload
      });
    } else {
      const rejectionError = request.approvalDecision.reason?.trim() || "Human approval rejected";
      nodeResults.push({
        nodeId: waitingNode.id,
        status: "error",
        startedAt: decidedAt,
        completedAt: decidedAt,
        durationMs: 0,
        output: decisionPayload,
        error: rejectionError
      });

      let caughtByTryCatch = false;
      for (const [tryCatchId, scope] of tryCatchScopes.entries()) {
        if (scope.successDescendants.has(waitingNode.id)) {
          for (const desc of scope.successDescendants) {
            if (desc !== waitingNode.id) {
              skippedByBranch.add(desc);
            }
          }
          for (const errorTarget of scope.errorTargets) {
            skippedByBranch.delete(errorTarget);
            for (const desc of collectDescendants(errorTarget, graphIndexes.outgoingExecution, workflow)) {
              skippedByBranch.delete(desc);
            }
          }
          nodeOutputs.set(tryCatchId, {
            error: rejectionError,
            failedNodeId: waitingNode.id,
            failedNodeType: waitingNode.type,
            caught: true
          });
          hadContinuedErrors = true;
          caughtByTryCatch = true;
          break;
        }
      }

      if (!caughtByTryCatch) {
        const onError = getOnError(toRecord(waitingNode.config));
        if (onError === "continue") {
          nodeOutputs.set(waitingNode.id, {
            ...decisionPayload,
            error: rejectionError
          });
          hadContinuedErrors = true;
        } else if (onError === "branch" && branchTargets.has(waitingNode.id)) {
          const handleMap = branchTargets.get(waitingNode.id)!;
          const errorBranchTargets = handleMap.get("error") ?? [];
          if (errorBranchTargets.length > 0) {
            for (const [handle, targets] of handleMap.entries()) {
              if (handle === "error") {
                for (const target of targets) {
                  skippedByBranch.delete(target);
                  for (const desc of collectDescendants(target, graphIndexes.outgoingExecution, workflow)) {
                    skippedByBranch.delete(desc);
                  }
                }
              } else {
                for (const target of targets) {
                  skippedByBranch.add(target);
                  for (const desc of collectDescendants(target, graphIndexes.outgoingExecution, workflow)) {
                    skippedByBranch.add(desc);
                  }
                }
              }
            }
            nodeOutputs.set(waitingNode.id, {
              ...decisionPayload,
              error: rejectionError
            });
            hadContinuedErrors = true;
          } else {
            appendSkippedNodes(nodeOrder, startIndex, nodeResults);
            return {
              workflowId: workflow.id,
              status: "error",
              startedAt,
              completedAt: nowIso(),
              executionId: request.executionId,
              nodeResults,
              error: rejectionError
            };
          }
        } else {
          appendSkippedNodes(nodeOrder, startIndex, nodeResults);
          return {
            workflowId: workflow.id,
            status: "error",
            startedAt,
            completedAt: nowIso(),
            executionId: request.executionId,
            nodeResults,
            error: rejectionError
          };
        }
      }
    }
  }

  for (let index = startIndex; index < nodeOrder.length; index += 1) {
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
    await dependencies.onNodeStart?.({
      nodeId: node.id,
      nodeType: node.type,
      startedAt: startedAtNode
    });

    try {
      const parentIds = graphIndexes.incomingExecution.get(node.id) ?? [];
      const parentOutputs: Record<string, unknown> = {};
      for (const parentId of parentIds) {
        if (nodeOutputs.has(parentId)) {
          parentOutputs[parentId] = nodeOutputs.get(parentId);
        }
      }

      const merged = mergeParentOutputs(parentOutputs);
      if (node.type === "human_approval") {
        const approvalMessageTemplate =
          typeof nodeConfig.approvalMessage === "string" && nodeConfig.approvalMessage.trim()
            ? nodeConfig.approvalMessage
            : "Approval required to continue.";
        const timeoutMinutes =
          typeof nodeConfig.timeoutMinutes === "number" && Number.isFinite(nodeConfig.timeoutMinutes) && nodeConfig.timeoutMinutes > 0
            ? Math.floor(nodeConfig.timeoutMinutes)
            : 60;
        const approvalMessage = renderTemplate(approvalMessageTemplate, {
          ...globals,
          ...merged,
          parent_outputs: parentOutputs
        });

        nodeResults.push({
          nodeId: node.id,
          status: "waiting_approval",
          startedAt: startedAtNode,
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          output: {
            message: approvalMessage,
            timeoutMinutes
          }
        });
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "waiting_approval",
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          output: {
            message: approvalMessage,
            timeoutMinutes
          }
        });

        const executionId = request.executionId ?? randomUUID();
        const stateSnapshot: WorkflowExecutionState = {
          workflow,
          nodeOrder,
          nextNodeIndex: index + 1,
          waitingNodeId: node.id,
          startedAt,
          globals,
          nodeOutputs: serializeNodeOutputs(nodeOutputs),
          nodeResults,
          skippedByBranch: [...skippedByBranch],
          tryCatchScopes: serializeTryCatchScopes(tryCatchScopes),
          hadContinuedErrors,
          finalOutput
        };

        if (dependencies.persistPausedExecution) {
          await dependencies.persistPausedExecution({
            executionId,
            workflowId: workflow.id,
            workflowName: workflow.name,
            triggerType: request.triggerType,
            triggeredBy: request.triggeredBy,
            waitingNodeId: node.id,
            approvalMessage,
            timeoutMinutes,
            startedAt,
            state: stateSnapshot
          });
        }

        return {
          workflowId: workflow.id,
          status: "waiting_approval",
          startedAt,
          completedAt: nowIso(),
          executionId,
          nodeResults,
          output: {
            waitingForApproval: true,
            waitingNodeId: node.id,
            approvalMessage,
            timeoutMinutes
          }
        };
      }

      const { output, attempts } = await executeNodeWithRetry(
        node,
        {
          globals,
          merged,
          parentOutputs,
          workflow,
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
      await dependencies.onNodeComplete?.({
        nodeId: node.id,
        nodeType: node.type,
        status: "success",
        completedAt: nowIso(),
        durationMs: Date.now() - started,
        output
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
            const descendants = collectDescendants(target, graphIndexes.outgoingExecution, workflow);
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
          for (const desc of collectDescendants(t, graphIndexes.outgoingExecution, workflow)) {
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
            for (const desc of collectDescendants(errorTarget, graphIndexes.outgoingExecution, workflow)) {
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
          await dependencies.onNodeComplete?.({
            nodeId: node.id,
            nodeType: node.type,
            status: "error",
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
          await dependencies.onNodeComplete?.({
            nodeId: node.id,
            nodeType: node.type,
            status: "error",
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
                  for (const desc of collectDescendants(t, graphIndexes.outgoingExecution, workflow)) {
                    skippedByBranch.delete(desc);
                  }
                }
              } else {
                for (const t of targets) {
                  skippedByBranch.add(t);
                  for (const desc of collectDescendants(t, graphIndexes.outgoingExecution, workflow)) {
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
            await dependencies.onNodeComplete?.({
              nodeId: node.id,
              nodeType: node.type,
              status: "error",
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
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "error",
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
          workflowId: workflow.id,
          status: "error",
          startedAt,
          completedAt: nowIso(),
          executionId: request.executionId,
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
    workflowId: workflow.id,
    status: hadContinuedErrors ? "partial" : "success",
    startedAt,
    completedAt: nowIso(),
    executionId: request.executionId,
    nodeResults,
    output: finalOutput
  };
}

export async function resumeWorkflowExecution(
  request: ResumeWorkflowRequest,
  dependencies: WorkflowExecutionDependencies
): Promise<WorkflowExecutionResult> {
  return executeWorkflow(
    {
      workflow: request.state.workflow,
      executionId: request.executionId,
      triggerType: "approval_resume",
      triggeredBy: request.actedBy,
      resumeState: request.state,
      approvalDecision: {
        decision: request.decision,
        actedBy: request.actedBy,
        reason: request.reason
      }
    },
    dependencies
  );
}

