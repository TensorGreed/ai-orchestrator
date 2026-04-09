import { randomUUID } from "node:crypto";
import vm from "node:vm";
import type { AgentRuntimeAdapter, AgentSessionMemoryStore, AgentSessionToolDataStore } from "@ai-orchestrator/agent-runtime";
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
  AzureOpenAIEmbeddingAdapter,
  InMemoryVectorStoreAdapter,
  PineconeVectorStoreAdapter,
  PGVectorStoreAdapter,
  AzureAiSearchVectorStoreAdapter,
  QdrantVectorStoreAdapter,
  type EmbeddingRegistry,
  type VectorStoreRegistry
} from "./rag-adapters";
import { renderTemplate, tryParseJson } from "./template";
import { sortWorkflowNodes, validateWorkflowGraph } from "./validation";
import { WorkflowError } from "@ai-orchestrator/shared";

export interface WorkflowExecutionDependencies {
  providerRegistry: ProviderRegistry;
  mcpRegistry: MCPRegistry;
  connectorRegistry: ConnectorRegistry;
  embeddingRegistry?: EmbeddingRegistry;
  vectorStoreRegistry?: VectorStoreRegistry;
  agentRuntime: AgentRuntimeAdapter;
  memoryStore?: AgentSessionMemoryStore;
  toolDataStore?: AgentSessionToolDataStore;
  loadWorkflow?: (workflowId: string) => Workflow | undefined;
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
    input?: unknown;
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
  startNodeId?: string;
  input?: Record<string, unknown>;
  webhookPayload?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  systemPrompt?: string;
  userPrompt?: string;
  sessionId?: string;
  executionId?: string;
  triggerType?: string;
  triggeredBy?: string;
  callStack?: string[];
  resumeState?: WorkflowExecutionState;
  approvalDecision?: {
    decision: "approve" | "reject";
    actedBy?: string;
    reason?: string;
  };
  executionTimeoutMs?: number;
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
  callStack: string[];
  recordAttachmentUsage?: (usage: {
    attachedNodeId: string;
    usedByNodeId: string;
    handle: AgentAttachmentHandle;
    input?: unknown;
    output?: unknown;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  }) => Promise<void> | void;
}

type AgentAttachmentHandle = "chat_model" | "memory" | "tool" | "worker";
const AGENT_ATTACHMENT_HANDLES = new Set<AgentAttachmentHandle>(["chat_model", "memory", "tool", "worker"]);
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

function isWebhookTrigger(globals: Record<string, unknown>): boolean {
  const triggerType = typeof globals.trigger_type === "string" ? globals.trigger_type.trim().toLowerCase() : "";
  return triggerType.startsWith("webhook");
}

function resolveWebhookPrompt(globals: Record<string, unknown>): string | undefined {
  const webhook = toRecord(globals.webhook);
  const candidates = [webhook.user_prompt, webhook.prompt, webhook.message, webhook.text, globals.user_prompt];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
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

function normalizeSecretRef(value: unknown): SecretReference | undefined {
  const record = toRecord(value);
  const secretId = typeof record.secretId === "string" ? record.secretId.trim() : "";
  return secretId ? { secretId } : undefined;
}

function buildProviderFromModelNode(node: WorkflowNode): LLMProviderConfig | undefined {
  const nodeConfig = toRecord(node.config);
  if (node.type === "llm_call") {
    return normalizeProvider(nodeConfig.provider);
  }

  if (node.type === "azure_openai_chat_model") {
    const endpoint = typeof nodeConfig.endpoint === "string" ? nodeConfig.endpoint.trim() : "";
    const deployment = typeof nodeConfig.deployment === "string" ? nodeConfig.deployment.trim() : "";
    if (!endpoint || !deployment) {
      return undefined;
    }

    const apiVersion = typeof nodeConfig.apiVersion === "string" && nodeConfig.apiVersion.trim()
      ? nodeConfig.apiVersion.trim()
      : "2024-10-21";

    return {
      providerId: "azure_openai",
      model: deployment,
      baseUrl: endpoint,
      secretRef: normalizeSecretRef(nodeConfig.secretRef),
      temperature:
        typeof nodeConfig.temperature === "number" && Number.isFinite(nodeConfig.temperature)
          ? nodeConfig.temperature
          : undefined,
      maxTokens:
        typeof nodeConfig.maxTokens === "number" && Number.isFinite(nodeConfig.maxTokens)
          ? Math.max(1, Math.floor(nodeConfig.maxTokens))
          : undefined,
      extra: {
        deployment,
        apiVersion
      }
    };
  }

  return undefined;
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

function looksLikeJson(input: string): boolean {
  const trimmed = input.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function parseTemplateValue(rendered: string): unknown {
  const trimmed = rendered.trim();
  if (!trimmed) {
    return rendered;
  }
  if (!looksLikeJson(trimmed)) {
    return rendered;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return rendered;
  }
}

function isErrorLikeOutput(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const asRecord = output as Record<string, unknown>;
  return typeof asRecord.error === "string" && asRecord.error.trim().length > 0;
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

function applyInputMapping(
  data: Record<string, unknown>,
  inputMapping: Record<string, string> | undefined
): Record<string, unknown> {
  if (!inputMapping || typeof inputMapping !== "object") {
    return data;
  }

  const remapped = { ...data };
  for (const [sourceKey, targetKey] of Object.entries(inputMapping)) {
    const src = String(sourceKey ?? "").trim();
    const tgt = String(targetKey ?? "").trim();
    if (!src || !tgt) {
      continue;
    }

    let value = remapped[src];
    if (value === undefined) {
      value = getValueByPath(remapped, src);
    }
    if (value !== undefined) {
      remapped[tgt] = value;
    }
  }
  return remapped;
}

function buildTemplateData(
  context: NodeRuntimeContext,
  nodeConfig?: Record<string, unknown>
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...context.globals,
    ...context.merged,
    vars: toRecord(context.globals.vars),
    parent_outputs: context.parentOutputs
  };

  const inputMapping = nodeConfig
    ? toRecord(nodeConfig.inputMapping) as Record<string, string>
    : undefined;
  const hasMapping = inputMapping && Object.keys(inputMapping).length > 0;

  return hasMapping ? applyInputMapping(base, inputMapping) : base;
}

function captureNodeInputSnapshot(
  globals: Record<string, unknown>,
  merged: Record<string, unknown>,
  parentOutputs: Record<string, unknown>
): unknown {
  return toJsonSafeValue({
    ...globals,
    ...merged,
    parent_outputs: parentOutputs
  });
}

function parsePathSegments(path: string): string[] {
  const input = String(path ?? "").trim();
  if (!input) {
    return [];
  }

  const segments: string[] = [];
  let current = "";
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (char === ".") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      index += 1;
      continue;
    }

    if (char === "[") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      index += 1;

      let bracketContent = "";
      let quote: "'" | '"' | null = null;
      while (index < input.length) {
        const inner = input[index];
        if (!quote && (inner === "'" || inner === '"')) {
          quote = inner;
          index += 1;
          continue;
        }
        if (quote && inner === quote) {
          quote = null;
          index += 1;
          continue;
        }
        if (!quote && inner === "]") {
          break;
        }
        bracketContent += inner;
        index += 1;
      }

      const normalizedBracket = bracketContent.trim();
      if (normalizedBracket) {
        segments.push(normalizedBracket);
      }

      if (index < input.length && input[index] === "]") {
        index += 1;
      }
      continue;
    }

    current += char;
    index += 1;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function normalizeLookupPath(path: string): string {
  const trimmed = String(path ?? "").trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    return trimmed.slice(2, -2).trim();
  }

  return trimmed;
}

function getValueByPath(input: Record<string, unknown>, path: string): unknown {
  const trimmedPath = normalizeLookupPath(path);
  if (!trimmedPath) {
    return undefined;
  }

  if (trimmedPath in input) {
    return input[trimmedPath];
  }

  const parts = parsePathSegments(trimmedPath);
  if (!parts.length) {
    return undefined;
  }

  let current: unknown = input;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) {
        return undefined;
      }
      const index = Number(part);
      current = current[index];
      continue;
    }

    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function branchPassthrough(templateData: Record<string, unknown>): Record<string, unknown> {
  const next = { ...templateData };
  delete next.parent_outputs;
  return next;
}

function normalizePdfFilename(value: string): string {
  const fallback = "workflow-output.pdf";
  const trimmed = typeof value === "string" ? value.trim() : "";
  const base = trimmed || fallback;
  const sanitized = base
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const withDefault = sanitized || fallback;
  const withExtension = withDefault.toLowerCase().endsWith(".pdf") ? withDefault : `${withDefault}.pdf`;
  return withExtension.slice(0, 120);
}

function decodeBufferLikeText(value: unknown): string | null {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.type === "Buffer" && Array.isArray(record.data)) {
      const bytes = record.data.filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255) as number[];
      if (bytes.length === record.data.length) {
        return Buffer.from(bytes).toString("utf8");
      }
    }
  }

  return null;
}

function toPdfSourceText(value: unknown): string {
  const decodedBufferText = decodeBufferLikeText(value);
  if (decodedBufferText !== null) {
    return decodedBufferText;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizePdfAscii(value: string): string {
  const punctuationMap: Array<[RegExp, string]> = [
    [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
    [/[\u201C\u201D\u201E\u201F\u2033]/g, "\""],
    [/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-"],
    [/\u2026/g, "..."],
    [/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " "],
    [/[\u2022\u2043\u00B7]/g, "*"],
    [/\u00D7/g, "x"],
    [/\u2192/g, "->"],
    [/\u2190/g, "<-"],
    [/\u2264/g, "<="],
    [/\u2265/g, ">="]
  ];

  let normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const [pattern, replacement] of punctuationMap) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

function escapePdfTextLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapPdfLines(text: string, maxLineLength = 92): string[] {
  const lines: string[] = [];
  const sourceLines = text.split("\n");

  for (const sourceLine of sourceLines) {
    let remaining = sourceLine;
    if (remaining.length === 0) {
      lines.push("");
      continue;
    }

    while (remaining.length > maxLineLength) {
      lines.push(remaining.slice(0, maxLineLength));
      remaining = remaining.slice(maxLineLength);
    }
    lines.push(remaining);
  }

  return lines.length ? lines : [""];
}

function createSimplePdfBuffer(text: string): Buffer {
  const normalized = sanitizePdfAscii(text);
  const wrappedLines = wrapPdfLines(normalized);
  const linesPerPage = 48;
  const pages: string[][] = [];

  for (let index = 0; index < wrappedLines.length; index += linesPerPage) {
    pages.push(wrappedLines.slice(index, index + linesPerPage));
  }
  if (!pages.length) {
    pages.push([""]);
  }

  const pageCount = pages.length;
  const firstPageObjectId = 3;
  const fontObjectId = firstPageObjectId + pageCount * 2;
  const objectBodies: string[] = new Array(fontObjectId);

  objectBodies[0] = "<< /Type /Catalog /Pages 2 0 R >>";

  const pageKids = pages
    .map((_, pageIndex) => `${firstPageObjectId + pageIndex * 2} 0 R`)
    .join(" ");
  objectBodies[1] = `<< /Type /Pages /Kids [ ${pageKids} ] /Count ${pageCount} >>`;

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageObjectId = firstPageObjectId + pageIndex * 2;
    const contentObjectId = pageObjectId + 1;
    const pageLines = pages[pageIndex] ?? [""];
    const streamLines = [
      "BT",
      "/F1 11 Tf",
      "50 760 Td",
      "14 TL"
    ];

    for (let lineIndex = 0; lineIndex < pageLines.length; lineIndex += 1) {
      const escaped = escapePdfTextLiteral(pageLines[lineIndex] ?? "");
      streamLines.push(`(${escaped}) Tj`);
      if (lineIndex < pageLines.length - 1) {
        streamLines.push("T*");
      }
    }
    streamLines.push("ET");

    const stream = streamLines.join("\n");
    const streamLength = Buffer.byteLength(stream, "ascii");

    objectBodies[pageObjectId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    objectBodies[contentObjectId - 1] =
      `<< /Length ${streamLength} >>\nstream\n${stream}\nendstream`;
  }

  objectBodies[fontObjectId - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let objectId = 1; objectId <= objectBodies.length; objectId += 1) {
    offsets[objectId] = Buffer.byteLength(pdf, "ascii");
    pdf += `${objectId} 0 obj\n${objectBodies[objectId - 1]}\nendobj\n`;
  }

  const startXref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objectBodies.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let objectId = 1; objectId <= objectBodies.length; objectId += 1) {
    const offset = String(offsets[objectId]).padStart(10, "0");
    pdf += `${offset} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objectBodies.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;

  return Buffer.from(pdf, "ascii");
}

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function extractBalancedJsonCandidates(text: string, maxCandidates = 40): string[] {
  const source = String(text ?? "");
  const openerToCloser: Record<string, string> = {
    "{": "}",
    "[": "]"
  };
  const closers = new Set(Object.values(openerToCloser));
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (let start = 0; start < source.length; start += 1) {
    const first = source[start];
    if (!(first in openerToCloser)) {
      continue;
    }

    const stack: string[] = [];
    let inString = false;
    let quote: "\"" | "'" | null = null;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === quote) {
          inString = false;
          quote = null;
        }
        continue;
      }

      if (char === "\"" || char === "'") {
        inString = true;
        quote = char;
        continue;
      }

      const expectedCloser = openerToCloser[char];
      if (expectedCloser) {
        stack.push(expectedCloser);
        continue;
      }

      if (!stack.length) {
        continue;
      }

      if (char === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) {
          const candidate = source.slice(start, index + 1).trim();
          if (candidate && !seen.has(candidate)) {
            seen.add(candidate);
            candidates.push(candidate);
            if (candidates.length >= maxCandidates) {
              return candidates;
            }
          }
          break;
        }
        continue;
      }

      if (closers.has(char)) {
        break;
      }
    }
  }

  return candidates;
}

function extractLikelyJsonFromText(text: string): string {
  const initial = extractJsonFromText(text);
  const trimmed = initial.trim();
  if (!trimmed) {
    return trimmed;
  }

  const startsAsJsonLike =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (startsAsJsonLike) {
    return trimmed;
  }

  const balanced = extractBalancedJsonCandidates(trimmed, 1)[0];
  return balanced ?? trimmed;
}

type OutputParserParsingMode = "strict" | "lenient" | "anything_goes";
type OutputParserParseStrategy =
  | "json_parse"
  | "double_encoded_json"
  | "balanced_json_extract"
  | "json_like_repair"
  | "yaml_key_value";

interface OutputParserParseAttempt {
  strategy: OutputParserParseStrategy;
  candidatePreview: string;
  ok: boolean;
  error?: string;
  warnings?: string[];
  confidence?: number;
}

interface OutputParserParseTrace {
  strictness: OutputParserParsingMode;
  strategy: OutputParserParseStrategy | "none";
  confidence: number;
  warnings: string[];
  candidateCount: number;
  attempts: OutputParserParseAttempt[];
}

type OutputParserParseOutcome =
  | {
      ok: true;
      parsed: unknown;
      trace: OutputParserParseTrace;
    }
  | {
      ok: false;
      error: string;
      trace: OutputParserParseTrace;
    };

function normalizeOutputParserParsingMode(value: unknown): OutputParserParsingMode {
  if (value === "lenient" || value === "anything_goes" || value === "strict") {
    return value;
  }
  return "strict";
}

function previewParserCandidate(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 180)}...`;
}

function addUniqueParserCandidate(target: string[], seen: Set<string>, candidate: string): void {
  const normalized = String(candidate ?? "").trim();
  if (!normalized || seen.has(normalized)) {
    return;
  }
  target.push(normalized);
  seen.add(normalized);
}

function buildJsonParserCandidates(text: string): string[] {
  const source = String(text ?? "");
  const trimmed = source.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();

  addUniqueParserCandidate(candidates, seen, trimmed);
  addUniqueParserCandidate(candidates, seen, extractJsonFromText(trimmed));
  const balancedFromSource = extractBalancedJsonCandidates(source, 40);
  for (const candidate of balancedFromSource) {
    addUniqueParserCandidate(candidates, seen, candidate);
  }
  const balancedFromLikely = extractBalancedJsonCandidates(extractLikelyJsonFromText(trimmed), 20);
  for (const candidate of balancedFromLikely) {
    addUniqueParserCandidate(candidates, seen, candidate);
  }

  return candidates.slice(0, 40);
}

function normalizeJsonLikeText(input: string): { text: string; warnings: string[] } {
  let current = String(input ?? "");
  const warnings: string[] = [];
  const apply = (next: string, warning: string) => {
    if (next !== current) {
      current = next;
      warnings.push(warning);
    }
  };

  apply(current.replace(/^\uFEFF/, ""), "removed_byte_order_mark");
  apply(current.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'"), "normalized_smart_quotes");
  apply(current.replace(/\bNone\b/g, "null"), "normalized_none_literal");
  apply(current.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false"), "normalized_python_booleans");
  apply(current.replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*:)/g, "$1\"$2\""), "quoted_single_quoted_keys");
  apply(
    current.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[,}\]])/g, ": \"$1\"$2"),
    "converted_single_quoted_string_values"
  );
  apply(
    current.replace(/([\[,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[,}\]])/g, "$1\"$2\"$3"),
    "converted_single_quoted_array_values"
  );
  apply(current.replace(/,\s*([}\]])/g, "$1"), "removed_trailing_commas");
  apply(current.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, "$1\"$2\"$3"), "quoted_unquoted_keys");

  return {
    text: current.trim(),
    warnings
  };
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "none") {
    return null;
  }
  if (lower === "true") {
    return true;
  }
  if (lower === "false") {
    return false;
  }

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  if (looksLikeJson(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function parseSimpleYamlObject(text: string): Record<string, unknown> | null {
  const source = String(text ?? "").trim();
  if (!source || source.startsWith("{") || source.startsWith("[")) {
    return null;
  }

  const lines = source
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !line.startsWith("- "));

  if (!lines.length) {
    return null;
  }

  const output: Record<string, unknown> = {};
  let parsedPairs = 0;

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const rawKey = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!rawKey) {
      continue;
    }

    const key =
      (rawKey.startsWith("\"") && rawKey.endsWith("\"")) || (rawKey.startsWith("'") && rawKey.endsWith("'"))
        ? rawKey.slice(1, -1)
        : rawKey;
    output[key] = parseYamlScalar(rawValue);
    parsedPairs += 1;
  }

  return parsedPairs > 0 ? output : null;
}

function tryParseJsonCandidate(
  candidate: string
): { ok: true; parsed: unknown; strategy: "json_parse" | "double_encoded_json" } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed === "string") {
      const nestedCandidate = extractLikelyJsonFromText(parsed);
      if (looksLikeJson(nestedCandidate)) {
        try {
          const reparsed = JSON.parse(nestedCandidate);
          return {
            ok: true,
            parsed: reparsed,
            strategy: "double_encoded_json"
          };
        } catch {
          return {
            ok: true,
            parsed,
            strategy: "json_parse"
          };
        }
      }
    }

    return {
      ok: true,
      parsed,
      strategy: "json_parse"
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "parse error"
    };
  }
}

function parseWithOutputParserStrategies(text: string, strictness: OutputParserParsingMode): OutputParserParseOutcome {
  const candidates = buildJsonParserCandidates(text);
  const attempts: OutputParserParseAttempt[] = [];

  const success = (
    strategy: OutputParserParseStrategy,
    parsed: unknown,
    confidence: number,
    warnings: string[],
    candidate: string
  ): OutputParserParseOutcome => ({
    ok: true,
    parsed,
    trace: {
      strictness,
      strategy,
      confidence,
      warnings,
      candidateCount: candidates.length,
      attempts: [
        ...attempts,
        {
          strategy,
          candidatePreview: previewParserCandidate(candidate),
          ok: true,
          confidence,
          warnings: warnings.length ? warnings : undefined
        }
      ]
    }
  });

  const fail = (strategy: OutputParserParseStrategy, error: string, candidate: string, warnings: string[] = []) => {
    attempts.push({
      strategy,
      candidatePreview: previewParserCandidate(candidate),
      ok: false,
      error,
      warnings: warnings.length ? warnings : undefined
    });
  };

  if (!candidates.length) {
    return {
      ok: false,
      error: "No parseable content found in parser input.",
      trace: {
        strictness,
        strategy: "none",
        confidence: 0,
        warnings: [],
        candidateCount: 0,
        attempts
      }
    };
  }

  for (const candidate of candidates) {
    const parsed = tryParseJsonCandidate(candidate);
    if (parsed.ok) {
      if (parsed.strategy === "double_encoded_json") {
        return success("double_encoded_json", parsed.parsed, 0.95, [], candidate);
      }
      return success("json_parse", parsed.parsed, 1, [], candidate);
    }
    fail("json_parse", parsed.error, candidate);
  }

  for (const candidate of candidates) {
    const balancedCandidates = extractBalancedJsonCandidates(candidate, 20).filter((balanced) => balanced !== candidate);
    for (const balanced of balancedCandidates) {
      const parsed = tryParseJsonCandidate(balanced);
      if (parsed.ok) {
        if (parsed.strategy === "double_encoded_json") {
          return success("double_encoded_json", parsed.parsed, 0.9, ["extracted_balanced_json"], balanced);
        }
        return success("balanced_json_extract", parsed.parsed, 0.88, [], balanced);
      }
      fail("balanced_json_extract", parsed.error, balanced);
    }
  }

  if (strictness !== "strict") {
    for (const candidate of candidates) {
      const repaired = normalizeJsonLikeText(candidate);
      if (!repaired.text || repaired.text === candidate) {
        continue;
      }

      const parsed = tryParseJsonCandidate(repaired.text);
      if (parsed.ok) {
        if (parsed.strategy === "double_encoded_json") {
          return success("double_encoded_json", parsed.parsed, 0.8, repaired.warnings, repaired.text);
        }
        return success("json_like_repair", parsed.parsed, 0.72, repaired.warnings, repaired.text);
      }
      fail("json_like_repair", parsed.error, repaired.text, repaired.warnings);
    }
  }

  if (strictness === "anything_goes") {
    for (const candidate of candidates) {
      const parsed = parseSimpleYamlObject(candidate);
      if (parsed) {
        return success("yaml_key_value", parsed, 0.55, ["parsed_as_simple_key_value"], candidate);
      }
      fail("yaml_key_value", "did not match simple key-value block format", candidate);
    }
  }

  const failedAttempts = attempts.filter((attempt) => !attempt.ok);
  const summary = failedAttempts
    .slice(-3)
    .map((attempt) => `${attempt.strategy}: ${attempt.error}`)
    .join(" | ");
  const errorMessage = summary || "No parser strategy succeeded.";

  return {
    ok: false,
    error: errorMessage,
    trace: {
      strictness,
      strategy: "none",
      confidence: 0,
      warnings: [],
      candidateCount: candidates.length,
      attempts
    }
  };
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

async function runLlmNode(input: {
  nodeId: string;
  provider: LLMProviderConfig;
  userPrompt: string;
  systemPrompt: string;
  dependencies: WorkflowExecutionDependencies;
}): Promise<Record<string, unknown>> {
  const messages = [] as Array<{ role: "system" | "user"; content: string }>;
  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
  }
  messages.push({ role: "user", content: input.userPrompt });

  const providerAdapter = input.dependencies.providerRegistry.get(input.provider.providerId);
  if (input.dependencies.onLLMDelta && providerAdapter.generateStream) {
    let streamedText = "";
    const toolCallById = new Map<string, { id: string; name: string; argumentsText: string }>();
    let llmDeltaIndex = 0;

    for await (const chunk of providerAdapter.generateStream(
      {
        provider: input.provider,
        messages
      },
      {
        resolveSecret: input.dependencies.resolveSecret
      }
    )) {
      if (chunk.type === "text_delta" && chunk.textDelta) {
        streamedText += chunk.textDelta;
        await input.dependencies.onLLMDelta({
          nodeId: input.nodeId,
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
      _provider: input.provider
    };
  }

  const response = await providerAdapter.generate(
    {
      provider: input.provider,
      messages
    },
    {
      resolveSecret: input.dependencies.resolveSecret
    }
  );

  return {
    text: response.content,
    answer: response.content,
    toolCalls: response.toolCalls,
    raw: response.raw,
    _provider: input.provider
  };
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
  const templateData = buildTemplateData(context, config);

  switch (node.type) {
    case "schedule_trigger": {
      return {
        trigger_type: context.globals.trigger_type ?? "manual",
        scheduled_at: context.globals.scheduled_at ?? nowIso(),
        schedule: {
          cronExpression: typeof config.cronExpression === "string" ? config.cronExpression : "",
          timezone: typeof config.timezone === "string" ? config.timezone : "UTC",
          active: config.active !== false
        }
      };
    }

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

    case "http_request": {
      const method = typeof config.method === "string" ? config.method.trim().toUpperCase() : "GET";
      const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
      const safeMethod = allowedMethods.has(method) ? method : "GET";

      const urlTemplate = typeof config.urlTemplate === "string" ? config.urlTemplate : "";
      const renderedUrl = renderTemplate(urlTemplate, templateData).trim();
      if (!renderedUrl) {
        throw new Error("HTTP Request node requires a non-empty rendered URL.");
      }

      const headersTemplate = typeof config.headersTemplate === "string" ? config.headersTemplate : "{}";
      const renderedHeaders = renderTemplate(headersTemplate, templateData);
      let headersPayload: Record<string, unknown> = {};
      try {
        headersPayload = toRecord(JSON.parse(renderedHeaders || "{}"));
      } catch {
        throw new Error("HTTP Request node headersTemplate must render valid JSON object.");
      }

      const requestHeaders = new Headers();
      for (const [key, value] of Object.entries(headersPayload)) {
        requestHeaders.set(key, String(value));
      }

      const secretRef = toRecord(config.secretRef);
      if (typeof secretRef.secretId === "string" && secretRef.secretId.trim()) {
        const secretValue = await dependencies.resolveSecret({ secretId: secretRef.secretId.trim() });
        if (!secretValue) {
          throw new Error("HTTP Request node secretRef is set but secret value could not be resolved.");
        }
        requestHeaders.set("Authorization", `Bearer ${secretValue}`);
      }

      const bodyTemplate = typeof config.bodyTemplate === "string" ? config.bodyTemplate : "";
      const renderedBody = renderTemplate(bodyTemplate, templateData);
      const timeoutMs =
        typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
          ? Math.floor(config.timeoutMs)
          : 15000;
      const responseType = config.responseType === "text" ? "text" : "json";

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const requestInit: RequestInit = {
          method: safeMethod,
          headers: requestHeaders,
          signal: controller.signal
        };

        if (safeMethod !== "GET" && safeMethod !== "DELETE" && renderedBody.trim()) {
          requestInit.body = renderedBody;
        }

        const response = await fetch(renderedUrl, requestInit);
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        let parsedBody: unknown = null;
        if (responseType === "text") {
          parsedBody = await response.text();
        } else {
          try {
            parsedBody = await response.json();
          } catch {
            parsedBody = await response.text();
          }
        }

        return {
          status: response.status,
          headers: responseHeaders,
          body: parsedBody,
          ok: response.ok
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`HTTP Request node timed out after ${timeoutMs}ms.`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    case "text_input": {
      const webhookPrompt = isWebhookTrigger(context.globals) ? resolveWebhookPrompt(context.globals) : undefined;
      const text =
        typeof webhookPrompt === "string"
          ? webhookPrompt
          : typeof config.text === "string"
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

    case "merge_node": {
      const mode =
        config.mode === "append" || config.mode === "combine_by_key" || config.mode === "choose_branch"
          ? config.mode
          : "append";
      const entries = Object.entries(context.parentOutputs);

      if (mode === "append") {
        const mergedOutput: Record<string, unknown> = {};
        for (const [parentId, parentOutput] of entries) {
          if (parentOutput && typeof parentOutput === "object" && !Array.isArray(parentOutput)) {
            Object.assign(mergedOutput, parentOutput as Record<string, unknown>);
          } else {
            mergedOutput[parentId] = parentOutput;
          }
        }
        return mergedOutput;
      }

      if (mode === "combine_by_key") {
        const combineKey = typeof config.combineKey === "string" ? config.combineKey.trim() : "";
        if (!combineKey) {
          throw new Error("Merge node combine_by_key mode requires a combineKey.");
        }

        const grouped: Record<string, unknown[]> = {};
        for (const [, parentOutput] of entries) {
          const candidates = Array.isArray(parentOutput) ? parentOutput : [parentOutput];
          for (const candidate of candidates) {
            const candidateRecord = toRecord(candidate);
            const keyValue = candidateRecord[combineKey];
            const groupKey = keyValue === undefined || keyValue === null ? "__undefined__" : String(keyValue);
            if (!grouped[groupKey]) {
              grouped[groupKey] = [];
            }
            grouped[groupKey].push(candidate);
          }
        }

        return grouped;
      }

      for (const [parentId, parentOutput] of entries) {
        if (parentOutput !== undefined && parentOutput !== null && !isErrorLikeOutput(parentOutput)) {
          if (parentOutput && typeof parentOutput === "object" && !Array.isArray(parentOutput)) {
            return {
              ...(parentOutput as Record<string, unknown>),
              _selectedParentId: parentId
            };
          }
          return {
            value: parentOutput,
            _selectedParentId: parentId
          };
        }
      }

      return {};
    }

    case "wait_node": {
      const requestedDelay =
        typeof config.delayMs === "number" && Number.isFinite(config.delayMs) && config.delayMs >= 0
          ? Math.floor(config.delayMs)
          : 1000;
      const maxDelay =
        typeof config.maxDelayMs === "number" && Number.isFinite(config.maxDelayMs) && config.maxDelayMs > 0
          ? Math.floor(config.maxDelayMs)
          : 30000;
      const clampedDelay = Math.min(requestedDelay, maxDelay);
      await sleep(clampedDelay);
      return mergeParentOutputs(context.parentOutputs);
    }

    case "set_node": {
      const assignments = Array.isArray(config.assignments) ? config.assignments.map((entry) => toRecord(entry)) : [];
      const output: Record<string, unknown> = {};

      for (const assignment of assignments) {
        const key = typeof assignment.key === "string" ? assignment.key.trim() : "";
        const valueTemplate = typeof assignment.valueTemplate === "string" ? assignment.valueTemplate : "";
        if (!key) {
          continue;
        }
        const rendered = renderTemplate(valueTemplate, templateData);
        output[key] = parseTemplateValue(rendered);
      }

      return output;
    }

    case "execute_workflow": {
      const workflowId = typeof config.workflowId === "string" ? config.workflowId.trim() : "";
      if (!workflowId) {
        throw new Error("Execute Workflow node requires a workflowId.");
      }

      if (!dependencies.loadWorkflow) {
        throw new Error("Execute Workflow node requires a loadWorkflow dependency.");
      }

      if (context.callStack.includes(workflowId)) {
        throw new Error(
          `Circular sub-workflow reference detected: ${[...context.callStack, workflowId].join(" -> ")}`
        );
      }

      const targetWorkflow = dependencies.loadWorkflow(workflowId);
      if (!targetWorkflow) {
        throw new Error(`Sub-workflow '${workflowId}' was not found.`);
      }

      const inputMapping = toRecord(config.inputMapping);
      const mappedInput: Record<string, unknown> = {};
      for (const [parentKey, childKeyValue] of Object.entries(inputMapping)) {
        const parentPath = String(parentKey ?? "").trim();
        const childKey = String(childKeyValue ?? "").trim();
        if (!parentPath || !childKey) {
          continue;
        }

        let mappedValue = templateData[parentPath];
        if (mappedValue === undefined) {
          mappedValue = getValueByPath(templateData, parentPath);
        }
        mappedInput[childKey] = mappedValue;
      }

      const childResult = await executeWorkflow(
        {
          workflow: targetWorkflow,
          input: mappedInput,
          triggerType: "sub_workflow",
          triggeredBy: context.workflow.id,
          callStack: [...context.callStack]
        },
        dependencies
      );

      if (childResult.status === "error") {
        throw new Error(childResult.error ?? `Sub-workflow '${workflowId}' execution failed.`);
      }

      if (childResult.status === "waiting_approval") {
        throw new Error(
          `Sub-workflow '${workflowId}' paused for approval. Waiting approvals are not supported inside Execute Workflow nodes.`
        );
      }

      return childResult.output;
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
      return runLlmNode({
        nodeId: node.id,
        provider,
        userPrompt,
        systemPrompt,
        dependencies
      });
    }

    case "azure_openai_chat_model": {
      const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
      const deployment = typeof config.deployment === "string" ? config.deployment.trim() : "";
      if (!endpoint || !deployment) {
        throw new Error("Azure OpenAI Chat Model requires endpoint and deployment.");
      }

      const promptKey = typeof config.promptKey === "string" ? config.promptKey : "prompt";
      const systemPromptKey = typeof config.systemPromptKey === "string" ? config.systemPromptKey : "system_prompt";
      const userPrompt = String(templateData[promptKey] ?? templateData.user_prompt ?? "");
      const systemPrompt = String(templateData[systemPromptKey] ?? "");
      const provider: LLMProviderConfig = {
        providerId: "azure_openai",
        model: deployment,
        baseUrl: endpoint,
        secretRef: normalizeSecretRef(config.secretRef),
        temperature: typeof config.temperature === "number" && Number.isFinite(config.temperature) ? config.temperature : undefined,
        maxTokens: typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens) ? Math.max(1, Math.floor(config.maxTokens)) : undefined,
        extra: {
          deployment,
          apiVersion:
            typeof config.apiVersion === "string" && config.apiVersion.trim()
              ? config.apiVersion.trim()
              : "2024-10-21"
        }
      };

      return runLlmNode({
        nodeId: node.id,
        provider,
        userPrompt,
        systemPrompt,
        dependencies
      });
    }

    case "connector_source": {
      const connectorId = String(config.connectorId ?? "");
      const connector = dependencies.connectorRegistry.get(connectorId);
      const connectorConfig = {
        ...toRecord(config.connectorConfig ?? config),
        ...(config.authSecretRef ? { secretRef: config.authSecretRef } : {}),
        ...(config.secretRef ? { secretRef: config.secretRef } : {})
      };
      const output = await connector.fetchData(connectorConfig, {
        resolveSecret: dependencies.resolveSecret
      });

      return {
        documents: output.documents,
        connectorRaw: output.raw
      };
    }

    case "google_drive_source": {
      const connector = dependencies.connectorRegistry.get("google-drive");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw
      };
    }

    case "azure_storage": {
      const connector = dependencies.connectorRegistry.get("azure-storage");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "azure_cosmos_db": {
      const connector = dependencies.connectorRegistry.get("azure-cosmos-db");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "azure_monitor_http": {
      const connector = dependencies.connectorRegistry.get("azure-monitor");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "azure_ai_search_vector_store": {
      const connector = dependencies.connectorRegistry.get("azure-ai-search");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "qdrant_vector_store": {
      const connector = dependencies.connectorRegistry.get("qdrant");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
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

    case "embeddings_azure_openai": {
      const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
      const deployment = typeof config.deployment === "string" ? config.deployment.trim() : "";
      if (!endpoint || !deployment) {
        throw new Error("Embeddings Azure OpenAI requires endpoint and deployment.");
      }

      const inputKey = typeof config.inputKey === "string" && config.inputKey.trim() ? config.inputKey.trim() : "user_prompt";
      const outputKey = typeof config.outputKey === "string" && config.outputKey.trim() ? config.outputKey.trim() : "embedding";
      const inputText = String(templateData[inputKey] ?? templateData.user_prompt ?? "");
      if (!inputText.trim()) {
        throw new Error("Embeddings Azure OpenAI requires non-empty input text.");
      }

      const secret = await dependencies.resolveSecret(normalizeSecretRef(config.secretRef));
      const apiKey = typeof secret === "string" ? secret.trim() : "";
      if (!apiKey) {
        throw new Error("Embeddings Azure OpenAI requires secretRef credential.");
      }

      const embedder = new AzureOpenAIEmbeddingAdapter({
        endpoint,
        deployment,
        apiVersion:
          typeof config.apiVersion === "string" && config.apiVersion.trim()
            ? config.apiVersion.trim()
            : "2024-10-21",
        apiKey
      });
      const vector = await embedder.embed(inputText);
      return {
        [outputKey]: vector,
        embedding: vector,
        model: deployment,
        dimensions: vector.length
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
      const vectorStoreConfig = toRecord(config.vectorStoreConfig);

      let embedder = dependencies.embeddingRegistry?.get(embedderId);
      if (!embedder) {
        if (embedderId === "token-embedder") embedder = new TokenEmbeddingAdapter();
        else if (embedderId === "openai-embedder") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.OPENAI_API_KEY;
           embedder = new OpenAIEmbeddingAdapter({ apiKey: apiKey || "", ...vectorStoreConfig });
        } else if (embedderId === "azure-openai-embedder") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.AZURE_OPENAI_API_KEY;
           const endpoint = typeof vectorStoreConfig.endpoint === "string" ? vectorStoreConfig.endpoint : process.env.AZURE_OPENAI_ENDPOINT;
           const deployment =
             typeof vectorStoreConfig.deployment === "string" && vectorStoreConfig.deployment.trim()
               ? vectorStoreConfig.deployment
               : typeof vectorStoreConfig.model === "string"
                 ? vectorStoreConfig.model
                 : "text-embedding-3-small";
           embedder = new AzureOpenAIEmbeddingAdapter({
             endpoint: endpoint || "",
             deployment,
             apiVersion: typeof vectorStoreConfig.apiVersion === "string" ? vectorStoreConfig.apiVersion : process.env.AZURE_OPENAI_API_VERSION,
             apiKey: apiKey || ""
           });
        }
        else throw new Error(`Unknown embedder ID: ${embedderId}`);
      }

      let store = dependencies.vectorStoreRegistry?.get(vectorStoreId);
      if (!store) {
         if (vectorStoreId === "in-memory-vector-store") store = new InMemoryVectorStoreAdapter();
         else if (vectorStoreId === "pinecone-vector-store") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.PINECONE_API_KEY;
           store = new PineconeVectorStoreAdapter({ apiKey: apiKey || "", indexName: typeof vectorStoreConfig.indexName === "string" ? vectorStoreConfig.indexName : "" });
         } else if (vectorStoreId === "pgvector-store") {
           const connRef = config.embeddingSecretRef;
           const connStr = typeof connRef === "object" && connRef ? await dependencies.resolveSecret(connRef as SecretReference) : process.env.DATABASE_URL;
           store = new PGVectorStoreAdapter({ connectionString: connStr || "", tableName: typeof vectorStoreConfig.tableName === "string" ? vectorStoreConfig.tableName as string : "vectors" });
         } else if (vectorStoreId === "azure-ai-search-vector-store") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.AZURE_AI_SEARCH_API_KEY;
           store = new AzureAiSearchVectorStoreAdapter({
             endpoint: typeof vectorStoreConfig.endpoint === "string" ? vectorStoreConfig.endpoint : process.env.AZURE_AI_SEARCH_ENDPOINT || "",
             indexName: typeof vectorStoreConfig.indexName === "string" ? vectorStoreConfig.indexName : "",
             apiVersion: typeof vectorStoreConfig.apiVersion === "string" ? vectorStoreConfig.apiVersion : undefined,
             vectorField: typeof vectorStoreConfig.vectorField === "string" ? vectorStoreConfig.vectorField : undefined,
             contentField: typeof vectorStoreConfig.contentField === "string" ? vectorStoreConfig.contentField : undefined,
             idField: typeof vectorStoreConfig.idField === "string" ? vectorStoreConfig.idField : undefined,
             metadataField: typeof vectorStoreConfig.metadataField === "string" ? vectorStoreConfig.metadataField : undefined,
             apiKey: apiKey || ""
           });
         } else if (vectorStoreId === "qdrant-vector-store") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey =
             typeof apiKeyRef === "object" && apiKeyRef
               ? await dependencies.resolveSecret(apiKeyRef as SecretReference)
               : process.env.QDRANT_API_KEY;
           const parsedFilter = (() => {
             const raw = vectorStoreConfig.filter;
             if (raw && typeof raw === "object" && !Array.isArray(raw)) {
               return raw as Record<string, unknown>;
             }
             if (typeof vectorStoreConfig.filterJson === "string" && vectorStoreConfig.filterJson.trim()) {
               try {
                 const parsed = JSON.parse(vectorStoreConfig.filterJson);
                 return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                   ? (parsed as Record<string, unknown>)
                   : undefined;
               } catch {
                 return undefined;
               }
             }
             return undefined;
           })();
           store = new QdrantVectorStoreAdapter({
             endpoint:
               typeof vectorStoreConfig.endpoint === "string"
                 ? vectorStoreConfig.endpoint
                 : process.env.QDRANT_ENDPOINT || "",
             collectionName:
               typeof vectorStoreConfig.collectionName === "string"
                 ? vectorStoreConfig.collectionName
                 : typeof vectorStoreConfig.collection === "string"
                   ? vectorStoreConfig.collection
                   : "",
             apiKey: apiKey || "",
             apiKeyHeaderName:
               typeof vectorStoreConfig.apiKeyHeaderName === "string"
                 ? vectorStoreConfig.apiKeyHeaderName
                 : undefined,
             contentField:
               typeof vectorStoreConfig.contentField === "string"
                 ? vectorStoreConfig.contentField
                 : undefined,
             metadataField:
               typeof vectorStoreConfig.metadataField === "string"
                 ? vectorStoreConfig.metadataField
                 : undefined,
             filter: parsedFilter
           });
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
        invocation_request: {
          server_id: serverId,
          tool_name: toolName,
          tool_args: args
        },
        tool_output: result.output,
        tool_name: toolName
      };
    }

    case "agent_orchestrator":
    case "supervisor_node": {
      const attachedByHandle = context.attachmentsBySource.get(node.id);
      const getAttachedNodes = (handle: AgentAttachmentHandle) => {
        const ids = attachedByHandle?.get(handle) ?? [];
        return ids
          .map((id) => context.nodeById.get(id))
          .filter((attached): attached is WorkflowNode => Boolean(attached));
      };

      const attachedModelNodes = getAttachedNodes("chat_model").filter(
        (attached) => attached.type === "llm_call" || attached.type === "azure_openai_chat_model"
      );
      const attachedModelNode = attachedModelNodes.length ? attachedModelNodes[attachedModelNodes.length - 1] : undefined;
      const provider = attachedModelNode ? buildProviderFromModelNode(attachedModelNode) : undefined;
      if (!provider) {
        throw new Error("Agent Orchestrator requires an attached Chat Model node on chat_model.");
      }

      const maxIterations = typeof config.maxIterations === "number" ? Math.max(1, Math.floor(config.maxIterations)) : 4;
      const toolCallingEnabled = config.toolCallingEnabled !== false;
      const toOptionalPositiveInteger = (value: unknown): number | undefined => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return undefined;
        }
        return Math.floor(parsed);
      };
      const toolOutputLimits = {
        messageMaxChars: toOptionalPositiveInteger(config.toolMessageMaxChars),
        payloadMaxDepth: toOptionalPositiveInteger(config.toolPayloadMaxDepth),
        payloadMaxObjectKeys: toOptionalPositiveInteger(config.toolPayloadMaxObjectKeys),
        payloadMaxArrayItems: toOptionalPositiveInteger(config.toolPayloadMaxArrayItems),
        payloadMaxStringChars: toOptionalPositiveInteger(config.toolPayloadMaxStringChars)
      };
      const hasCustomToolOutputLimits = Object.values(toolOutputLimits).some((value) => value !== undefined);

      const systemTemplate =
        typeof config.systemPromptTemplate === "string" ? config.systemPromptTemplate : "{{system_prompt}}";
      const userTemplate = typeof config.userPromptTemplate === "string" ? config.userPromptTemplate : "{{user_prompt}}";
      const sessionTemplate = typeof config.sessionIdTemplate === "string" ? config.sessionIdTemplate : "{{session_id}}";
      const systemPrompt = renderTemplate(systemTemplate, templateData);
      const userPrompt = renderTemplate(userTemplate, templateData);

      // --- Empty prompt guard ---
      if (!userPrompt.trim()) {
        const webhookData = toRecord(templateData.webhook);
        const fallbackUserPrompt =
          (typeof templateData.user_prompt === "string" && templateData.user_prompt.trim()) ||
          (typeof webhookData.user_prompt === "string" && (webhookData.user_prompt as string).trim()) ||
          (typeof webhookData.message === "string" && (webhookData.message as string).trim()) ||
          "";
        if (!fallbackUserPrompt) {
          throw WorkflowError.nodeConfig("Agent Orchestrator user prompt is empty after template rendering. Check your template variables or webhook payload.");
          throw new Error("Agent Orchestrator user prompt is empty after template rendering. Check your template variables or webhook payload.");
        }
      }
      const resolvedSessionId = renderTemplate(sessionTemplate, templateData).trim();
      const sessionId =
        resolvedSessionId || (typeof templateData.session_id === "string" ? String(templateData.session_id) : undefined);
      const modelMessages = [] as Array<{ role: "system" | "user"; content: string }>;
      if (systemPrompt.trim()) {
        modelMessages.push({ role: "system", content: systemPrompt });
      }
      modelMessages.push({ role: "user", content: userPrompt });

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
      const attachedToolNodes = getAttachedNodes("tool").filter((entry) => entry.type === "mcp_tool");
      for (const attached of attachedToolNodes) {
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

      const serverConfigs =
        attachedToolServerConfigs.length > 0
          ? mergeMCPServerConfigs([], attachedToolServerConfigs)
          : mergeMCPServerConfigs(inlineServerConfigs, attachedToolServerConfigs);
      const mcpExecutionContext = {
        resolveSecret: dependencies.resolveSecret,
        runtimeState: new Map<string, unknown>()
      };

      const resolvedTools = await resolveMCPTools(serverConfigs, dependencies.mcpRegistry, mcpExecutionContext);

      for (const attachedToolNode of attachedToolNodes) {
        const attachedConfig = toRecord(attachedToolNode.config);
        await context.recordAttachmentUsage?.({
          attachedNodeId: attachedToolNode.id,
          usedByNodeId: node.id,
          handle: "tool",
          input: {
            serverId: String(attachedConfig.serverId ?? ""),
            toolName: String(attachedConfig.toolName ?? "")
          },
          output: {
            resolvedTools: resolvedTools.resolved.length
          }
        });
      }

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
        const persistToolMessages = memoryConfig.persistToolMessages === true;
        memory = {
          namespace,
          maxMessages,
          persistToolMessages
        };
        await context.recordAttachmentUsage?.({
          attachedNodeId: attachedMemoryNode.id,
          usedByNodeId: node.id,
          handle: "memory",
          input: {
            sessionId
          },
          output: {
            namespace,
            maxMessages,
            persistToolMessages
          }
        });
      }

      const attachedWorkerNodes = getAttachedNodes("worker");
      const workerTools = attachedWorkerNodes.map(worker => {
        const workerConfig = toRecord(worker.config);
        const descriptionHint = typeof workerConfig.systemPromptTemplate === "string" ? workerConfig.systemPromptTemplate.slice(0, 100) : worker.name;
        return {
          serverId: `worker-${worker.id}`,
          name: `delegate_to_${worker.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
          description: `Delegate task to ${worker.name}. Hint: ${descriptionHint}`,
          inputSchema: {
            type: "object",
            properties: {
              task_prompt: { type: "string", description: "The explicit prompt, context, or task instructions to give this worker." }
            },
            required: ["task_prompt"]
          }
        };
      });

      const allToolsForModel = [
        ...resolvedTools.resolved.map((entry) => ({
          serverId: entry.serverId,
          name: entry.exposedName,
          description: entry.definition.description,
          inputSchema: entry.definition.inputSchema
        })),
        ...workerTools
      ];

      const modelRunStarted = Date.now();
      const modelRunStartedAt = nowIso();
      const agentState = await dependencies.agentRuntime.run(
        {
          provider,
          systemPrompt,
          userPrompt,
          maxIterations,
          toolCallingEnabled,
          tools: allToolsForModel,
          toolOutputLimits: hasCustomToolOutputLimits ? toolOutputLimits : undefined,
          sessionId,
          memory,
          bypassToolFiltering: attachedToolServerConfigs.length > 0
        },
        {
          tools: [
            ...resolvedTools.tools,
            ...workerTools.map(wt => ({ name: wt.name, description: wt.description, inputSchema: wt.inputSchema }))
          ],
          invokeTool: async (toolName, args) => {
             const matchingWorker = workerTools.find(wt => wt.name === toolName);
             if (matchingWorker) {
                const workerId = matchingWorker.serverId.replace("worker-", "");
                const workerNode = attachedWorkerNodes.find(wn => wn.id === workerId);
                if (!workerNode) throw new Error(`Worker node ${workerId} not found.`);
                
                const workerContext: NodeRuntimeContext = {
                   ...context,
                   globals: { ...context.globals, user_prompt: String(args.task_prompt ?? "") },
                   parentOutputs: { ...context.parentOutputs },
                   callStack: [...context.callStack, node.id]
                };
                
                const workerResult = await executeNode(workerNode, workerContext, dependencies);
                return workerResult;
             }
             return resolvedTools.invokeByExposedName(toolName, args);
          }
        },
        {
          providerRegistry: dependencies.providerRegistry,
          resolveSecret: dependencies.resolveSecret,
          memoryStore: dependencies.memoryStore,
          toolDataStore: dependencies.toolDataStore
        }
      );
      const modelRunCompletedAt = nowIso();
      if (attachedModelNode) {
        const lastStep = agentState.steps.at(-1);
        await context.recordAttachmentUsage?.({
          attachedNodeId: attachedModelNode.id,
          usedByNodeId: node.id,
          handle: "chat_model",
          startedAt: modelRunStartedAt,
          completedAt: modelRunCompletedAt,
          durationMs: Math.max(0, Date.now() - modelRunStarted),
          input: {
            provider,
            messages: modelMessages
          },
          output: {
            stopReason: agentState.stopReason,
            iterations: agentState.iterations,
            answer: agentState.finalAnswer,
            model_output: lastStep?.modelOutput ?? agentState.finalAnswer,
            requested_tool_calls: lastStep?.requestedTools.length ?? 0
          }
        });
      }

      return {
        answer: agentState.finalAnswer,
        iterations: agentState.iterations,
        stopReason: agentState.stopReason,
        steps: agentState.steps,
        messages: agentState.messages,
        _provider: provider
      };
    }

    case "output_parser": {
      const mode = typeof config.mode === "string" ? config.mode : "json_schema";
      const parsingMode = normalizeOutputParserParsingMode(config.parsingMode);
      const inputKey = typeof config.inputKey === "string" && config.inputKey ? config.inputKey : "answer";
      const resolvedInput =
        getValueByPath(templateData, inputKey) ??
        templateData[inputKey] ??
        templateData.text ??
        templateData.answer;
      const rawInput =
        typeof resolvedInput === "string"
          ? resolvedInput
          : resolvedInput === undefined || resolvedInput === null
            ? ""
            : JSON.stringify(resolvedInput);
      const maxRetries = typeof config.maxRetries === "number" && config.maxRetries > 0 ? Math.floor(config.maxRetries) : 2;

      if (!rawInput.trim()) {
        throw new Error(`Output Parser input is empty for key '${inputKey}'.`);
      }

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

      const validateJsonOutput = (
        text: string
      ): { ok: boolean; parsed?: unknown; error?: string; trace?: OutputParserParseTrace } => {
        const parsedResult = parseWithOutputParserStrategies(text, parsingMode);
        if (!parsedResult.ok) {
          return {
            ok: false,
            error: `Invalid JSON (${parsingMode}): ${parsedResult.error}`,
            trace: parsedResult.trace
          };
        }
        const parsed = parsedResult.parsed;

        if (mode === "auto_fix") {
          return { ok: true, parsed, trace: parsedResult.trace };
        }

        // json_schema mode: validate required fields and types
        if (schemaObj && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          const required = Array.isArray(schemaObj.required) ? schemaObj.required.map(String) : [];
          for (const field of required) {
            if (!(field in record)) {
              return { ok: false, parsed, error: `Missing required field: ${field}`, trace: parsedResult.trace };
            }
          }
          const properties = toRecord(schemaObj.properties);
          for (const [key, propSchema] of Object.entries(properties)) {
            if (!(key in record)) continue;
            const prop = toRecord(propSchema);
            if (typeof prop.type === "string" && record[key] !== undefined && record[key] !== null) {
              const actualType = typeof record[key];
              if (prop.type === "string" && actualType !== "string") {
                return { ok: false, parsed, error: `Field '${key}' should be string, got ${actualType}`, trace: parsedResult.trace };
              }
              if (prop.type === "number" && actualType !== "number") {
                return { ok: false, parsed, error: `Field '${key}' should be number, got ${actualType}`, trace: parsedResult.trace };
              }
              if (prop.type === "boolean" && actualType !== "boolean") {
                return { ok: false, parsed, error: `Field '${key}' should be boolean, got ${actualType}`, trace: parsedResult.trace };
              }
            }
            if (Array.isArray(prop.enum) && record[key] !== undefined) {
              if (!prop.enum.includes(record[key])) {
                return {
                  ok: false,
                  parsed,
                  error: `Field '${key}' value '${String(record[key])}' not in enum: ${prop.enum.join(", ")}`,
                  trace: parsedResult.trace
                };
              }
            }
          }
        }
        return { ok: true, parsed, trace: parsedResult.trace };
      };

      let result = validateJsonOutput(rawInput);
      let retries = 0;

      if (!result.ok) {
        // Find a provider to use for retry calls from templateData or upstream nodes.
        const upstreamProvider =
          normalizeProvider((templateData as Record<string, unknown>).__output_parser_provider) ??
          normalizeProvider((templateData as Record<string, unknown>)._provider);

        if (upstreamProvider) {
          const providerAdapter = dependencies.providerRegistry.get(upstreamProvider.providerId);
          for (let attempt = 0; attempt < maxRetries && !result.ok; attempt += 1) {
            const MAX_RETRY_PROMPT_RAW_INPUT_CHARS = 12_000;
            const truncatedRawInput =
              rawInput.length > MAX_RETRY_PROMPT_RAW_INPUT_CHARS
                ? `${rawInput.slice(0, MAX_RETRY_PROMPT_RAW_INPUT_CHARS)}...[truncated ${rawInput.length - MAX_RETRY_PROMPT_RAW_INPUT_CHARS} chars]`
                : rawInput;
            const correctionPrompt = mode === "json_schema" && schemaObj
              ? `Your previous output was invalid. Error: ${result.error}. Required schema: ${JSON.stringify(schemaObj)}. Original output: ${truncatedRawInput}. Please output ONLY valid JSON matching the schema, with no other text.`
              : `Your previous output was not valid JSON. Error: ${result.error}. Original output: ${truncatedRawInput}. Please output ONLY valid JSON with no other text.`;

            let retryResponse: Awaited<ReturnType<typeof providerAdapter.generate>>;
            try {
              retryResponse = await providerAdapter.generate(
                {
                  provider: upstreamProvider,
                  messages: [
                    { role: "system", content: "You are a JSON formatting assistant. Output ONLY valid JSON." },
                    { role: "user", content: correctionPrompt }
                  ]
                },
                { resolveSecret: dependencies.resolveSecret }
              );
            } catch (error) {
              // Graceful fallback: don't crash the workflow if the retry LLM call fails
              break; // Exit retry loop, use best heuristic result;
            }
            result = validateJsonOutput(retryResponse.content);
            retries += 1;
          }
        }
      }

      if (!result.ok) {
        if (parsingMode === "anything_goes") {
        return { parsed: null, raw: rawInput, retries, parserTrace: result.trace, warning: "Output parsing failed: " + result.error };
      }
      throw WorkflowError.parserError(`Output Parser failed after ${retries} retries: ${result.error}`);
      }

      return { parsed: result.parsed, raw: rawInput, retries, parserTrace: result.trace };
    }

    case "output_guardrail": {
      const checks = Array.isArray(config.checks)
        ? config.checks.map((value) => String(value)).filter(Boolean)
        : [];
      const onFail = config.onFail === "retry" ? "retry" : "error";
      const inputKey = typeof config.inputKey === "string" && config.inputKey ? config.inputKey : "answer";
      const guardrailInput =
        getValueByPath(templateData, inputKey) ??
        templateData[inputKey] ??
        templateData.answer ??
        templateData.text;
      let candidate =
        typeof guardrailInput === "string"
          ? guardrailInput
          : guardrailInput === undefined || guardrailInput === null
            ? ""
            : JSON.stringify(guardrailInput);
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
        ...branchPassthrough(templateData),
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
      let matchedCaseHandle = "default";
      for (const switchCase of cases) {
        if (String(switchCase.value).trim() === evaluated) {
          matchedLabel = switchCase.label;
          break;
        }
      }

      for (let index = 0; index < cases.length; index += 1) {
        const switchCase = cases[index];
        if (String(switchCase.value).trim() === evaluated) {
          matchedCaseHandle = `case_${index}`;
          break;
        }
      }
      return {
        ...branchPassthrough(templateData),
        matched: matchedLabel,
        evaluatedValue: evaluated,
        _branchHandle: matchedLabel,
        _branchHandleFallback: matchedCaseHandle
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

    case "pdf_output": {
      const inputKey = typeof config.inputKey === "string" && config.inputKey.trim() ? config.inputKey.trim() : "result";
      const textTemplate = typeof config.textTemplate === "string" ? config.textTemplate : "";
      const filenameTemplate =
        typeof config.filenameTemplate === "string" && config.filenameTemplate.trim()
          ? config.filenameTemplate
          : "workflow-output-{{session_id}}.pdf";
      const outputKey = typeof config.outputKey === "string" && config.outputKey.trim() ? config.outputKey.trim() : "pdf";

      const sourceValue = getValueByPath(templateData, inputKey);
      let sourceText = textTemplate.trim()
        ? renderTemplate(textTemplate, templateData)
        : toPdfSourceText(
            sourceValue ??
              templateData[inputKey] ??
              templateData.result ??
              templateData.answer ??
              templateData.text ??
              templateData.user_prompt ??
              templateData
          );

      const maxSourceLength = 50_000;
      if (sourceText.length > maxSourceLength) {
        sourceText =
          `${sourceText.slice(0, maxSourceLength)}\n\n[truncated: content exceeded ${maxSourceLength} characters]`;
      }

      const renderedFilename = renderTemplate(filenameTemplate, templateData);
      const filename = normalizePdfFilename(renderedFilename);
      const pdfBuffer = createSimplePdfBuffer(sourceText);
      const base64 = pdfBuffer.toString("base64");
      const downloadUrl = `data:application/pdf;base64,${base64}`;

      const payload = {
        filename,
        mimeType: "application/pdf",
        sizeBytes: pdfBuffer.byteLength,
        downloadUrl,
        base64
      };

      return {
        [outputKey]: payload,
        pdf: payload,
        result: downloadUrl
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

    case "webhook_response": {
      const statusCode =
        typeof config.statusCode === "number" && Number.isFinite(config.statusCode)
          ? Math.max(100, Math.min(599, Math.floor(config.statusCode)))
          : 200;
      const headersTemplate = typeof config.headersTemplate === "string" ? config.headersTemplate : "{}";
      const bodyTemplate = typeof config.bodyTemplate === "string" ? config.bodyTemplate : "{{result}}";

      const renderedHeaders = renderTemplate(headersTemplate, templateData);
      let headersRecord: Record<string, unknown> = {};
      try {
        headersRecord = toRecord(JSON.parse(renderedHeaders || "{}"));
      } catch {
        throw new Error("Webhook Response node headersTemplate must render valid JSON object.");
      }

      const normalizedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headersRecord)) {
        normalizedHeaders[key] = String(value);
      }

      const renderedBody = renderTemplate(bodyTemplate, templateData);
      const body = parseTemplateValue(renderedBody);

      return {
        __webhookResponse: {
          statusCode,
          headers: normalizedHeaders,
          body
        },
        result: body
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


const RETRYABLE_NODE_TYPES = new Set([
  "llm_call",
  "azure_openai_chat_model",
  "agent_orchestrator",
  "supervisor_node",
  "mcp_tool",
  "connector_source",
  "google_drive_source",
  "azure_storage",
  "azure_cosmos_db",
  "azure_monitor_http",
  "http_request",
  "rag_retrieve",
  "embeddings_azure_openai"
]);

function getRetryConfigForNode(node: WorkflowNode): RetryConfig | undefined {
  const config = toRecord(node.config);
  const explicit = getRetryConfig(config);
  if (explicit) return explicit;
  const retry = toRecord(config.retry);
  if (retry && retry.enabled === false) return undefined;
  if (RETRYABLE_NODE_TYPES.has(node.type)) {
    return {
      enabled: true,
      maxAttempts: 2,
      delayMs: node.type === "agent_orchestrator" || node.type === "supervisor_node" ? 3000 : 2000,
      backoffMultiplier: 2
    };
  }
  return undefined;
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
  const retry = getRetryConfigForNode(node);
  if (!retry) {
    return { output: await executeNode(node, context, dependencies), attempts: 1 };
  }

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const output = await executeNode(node, context, dependencies);
      return { output, attempts: attempt };
    } catch (error) {
      if (error instanceof WorkflowError) {
        lastError = error;
      } else {
        lastError = error instanceof Error ? error : new Error("Node execution failed");
      }
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

function collectNodeAndDescendants(
  nodeId: string,
  outgoingExecution: Map<string, string[]>,
  workflow: { edges: { source: string; target: string; sourceHandle?: string }[] }
): Set<string> {
  const nodes = new Set<string>([nodeId]);
  for (const descendant of collectDescendants(nodeId, outgoingExecution, workflow)) {
    nodes.add(descendant);
  }
  return nodes;
}

function collectReachableFromRoots(
  roots: Iterable<string>,
  outgoingExecution: Map<string, string[]>,
  workflow: { edges: { source: string; target: string; sourceHandle?: string }[] }
): Set<string> {
  const reachable = new Set<string>();
  for (const root of roots) {
    for (const nodeId of collectNodeAndDescendants(root, outgoingExecution, workflow)) {
      reachable.add(nodeId);
    }
  }
  return reachable;
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

  const callStack = request.callStack?.length ? [...request.callStack] : [];
  if (callStack.includes(workflow.id)) {
    return {
      workflowId: workflow.id,
      status: "error",
      startedAt,
      completedAt: nowIso(),
      executionId: request.executionId,
      nodeResults: [],
      error: `Circular workflow execution detected: ${[...callStack, workflow.id].join(" -> ")}`
    };
  }
  callStack.push(workflow.id);

  let nodeOrder =
    request.resumeState?.nodeOrder?.length ? request.resumeState.nodeOrder : validation.orderedNodeIds ?? sortWorkflowNodes(workflow);
  const graphIndexes = buildGraphIndexes(workflow);
  const explicitStartNodeId =
    !request.resumeState && typeof request.startNodeId === "string" && request.startNodeId.trim()
      ? request.startNodeId.trim()
      : undefined;
  const forceExecuteNodeIds = new Set<string>();

  if (explicitStartNodeId) {
    const startNode = graphIndexes.nodeById.get(explicitStartNodeId);
    if (!startNode) {
      return {
        workflowId: workflow.id,
        status: "error",
        startedAt,
        completedAt: nowIso(),
        executionId: request.executionId,
        nodeResults: [],
        error: `Start node '${explicitStartNodeId}' was not found in workflow '${workflow.id}'.`
      };
    }

    forceExecuteNodeIds.add(explicitStartNodeId);
    const executableNodeIds = new Set<string>(
      collectNodeAndDescendants(explicitStartNodeId, graphIndexes.outgoingExecution, workflow)
    );
    const queue = [...executableNodeIds];

    while (queue.length) {
      const nodeId = queue.shift()!;
      const attachments = graphIndexes.attachmentsBySource.get(nodeId);
      if (!attachments) {
        continue;
      }

      for (const targets of attachments.values()) {
        for (const targetNodeId of targets) {
          if (executableNodeIds.has(targetNodeId)) {
            continue;
          }
          executableNodeIds.add(targetNodeId);
          queue.push(targetNodeId);
        }
      }
    }

    nodeOrder = nodeOrder.filter((nodeId) => executableNodeIds.has(nodeId));
  }

  const globals: Record<string, unknown> = request.resumeState
    ? toRecord(request.resumeState.globals)
    : {
        ...(request.input ?? {}),
        ...(request.variables ?? {}),
        vars: toRecord(workflow.variables),
        webhook: request.webhookPayload ?? {},
        system_prompt:
          request.systemPrompt ??
          (typeof request.webhookPayload?.system_prompt === "string" ? request.webhookPayload.system_prompt : ""),
        user_prompt:
          request.userPrompt ??
          (typeof request.webhookPayload?.user_prompt === "string" ? request.webhookPayload.user_prompt : ""),
        session_id:
          request.sessionId ??
          (typeof request.webhookPayload?.session_id === "string" ? request.webhookPayload.session_id : undefined),
        trigger_type: request.triggerType ?? "manual",
        scheduled_at: request.triggerType === "cron" ? nowIso() : undefined
      };

  if (!request.resumeState) {
    globals.vars = toRecord(workflow.variables);
  } else if (!globals.vars || typeof globals.vars !== "object" || Array.isArray(globals.vars)) {
    globals.vars = toRecord(workflow.variables);
  }

  const nodeOutputs = request.resumeState
    ? deserializeNodeOutputs(toRecord(request.resumeState.nodeOutputs))
    : new Map<string, unknown>();
  const nodeResults: NodeExecutionResult[] = request.resumeState ? [...request.resumeState.nodeResults] : [];
  const attachmentOnlyResultIndexByNodeId = new Map<string, number>();
  const attachmentCompletionEventEmitted = new Set<string>();
  const attachmentUsageByNodeId = new Map<
    string,
    {
      attachedNodeId: string;
      usedByNodeId: string;
      handle: AgentAttachmentHandle;
      input?: unknown;
      output?: unknown;
      startedAt: string;
      completedAt: string;
      durationMs: number;
    }
  >();
  const toAttachmentConsumedResult = (
    usage: {
      attachedNodeId: string;
      usedByNodeId: string;
      handle: AgentAttachmentHandle;
      input?: unknown;
      output?: unknown;
      startedAt: string;
      completedAt: string;
      durationMs: number;
    }
  ): NodeExecutionResult => ({
    nodeId: usage.attachedNodeId,
    status: "success",
    startedAt: usage.startedAt,
    completedAt: usage.completedAt,
    durationMs: usage.durationMs,
    input: toJsonSafeValue(usage.input),
    output: {
      reason: "attachment_consumed_by_agent",
      message: "Node was consumed by an attached agent during execution.",
      handle: usage.handle,
      usedByNodeId: usage.usedByNodeId,
      details: toJsonSafeValue(usage.output)
    }
  });
  const recordAttachmentUsage = async (usage: {
    attachedNodeId: string;
    usedByNodeId: string;
    handle: AgentAttachmentHandle;
    input?: unknown;
    output?: unknown;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  }) => {
    const completedAt = usage.completedAt ?? nowIso();
    const startedAt = usage.startedAt ?? completedAt;
    const durationMs =
      typeof usage.durationMs === "number" && Number.isFinite(usage.durationMs) && usage.durationMs >= 0
        ? Math.floor(usage.durationMs)
        : 0;
    const normalized = {
      attachedNodeId: usage.attachedNodeId,
      usedByNodeId: usage.usedByNodeId,
      handle: usage.handle,
      input: usage.input,
      output: usage.output,
      startedAt,
      completedAt,
      durationMs
    };
    attachmentUsageByNodeId.set(usage.attachedNodeId, normalized);

    const existingIndex = attachmentOnlyResultIndexByNodeId.get(usage.attachedNodeId);
    if (existingIndex !== undefined) {
      nodeResults[existingIndex] = toAttachmentConsumedResult(normalized);
    }

    if (!attachmentCompletionEventEmitted.has(usage.attachedNodeId)) {
      const attachedNodeType = graphIndexes.nodeById.get(usage.attachedNodeId)?.type ?? "unknown";
      await dependencies.onNodeComplete?.({
        nodeId: usage.attachedNodeId,
        nodeType: attachedNodeType,
        status: "success",
        completedAt: normalized.completedAt,
        durationMs: normalized.durationMs,
        input: normalized.input,
        output: {
          reason: "attachment_consumed_by_agent",
          message: "Node was consumed by an attached agent during execution.",
          handle: normalized.handle,
          usedByNodeId: normalized.usedByNodeId,
          details: toJsonSafeValue(normalized.output)
        }
      });
      attachmentCompletionEventEmitted.add(usage.attachedNodeId);
    }
  };
  let finalOutput: unknown = request.resumeState?.finalOutput;
  let failedError: string | undefined;
  let hadContinuedErrors = request.resumeState?.hadContinuedErrors === true;
  let startIndex = request.resumeState?.nextNodeIndex ?? 0;

  // Branch-aware skip tracking:
  // When a branching node (if_node, switch_node, try_catch) runs, we add
  // all nodes on non-taken branches to this set.
  const skippedByBranch = new Set<string>(request.resumeState?.skippedByBranch ?? []);
  const loopInlineExecutedNodes = new Set<string>();

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
    const decisionInput = toJsonSafeValue({
      decision: request.approvalDecision.decision,
      actedBy: request.approvalDecision.actedBy,
      reason: request.approvalDecision.reason
    });

    if (request.approvalDecision.decision === "approve") {
      nodeOutputs.set(waitingNode.id, decisionPayload);
      nodeResults.push({
        nodeId: waitingNode.id,
        status: "success",
        startedAt: decidedAt,
        completedAt: decidedAt,
        durationMs: 0,
        input: decisionInput,
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
        input: decisionInput,
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
            const protectedNodes = collectReachableFromRoots(
              errorBranchTargets,
              graphIndexes.outgoingExecution,
              workflow
            );
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
                  for (const candidate of collectNodeAndDescendants(target, graphIndexes.outgoingExecution, workflow)) {
                    if (!protectedNodes.has(candidate)) {
                      skippedByBranch.add(candidate);
                    }
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

  // --- Execution timeout ---
  const executionTimeoutMs = typeof (request as unknown as Record<string, unknown>).executionTimeoutMs === "number" ? (request as unknown as Record<string, unknown>).executionTimeoutMs as number : 300000;
  const workflowWarnings: string[] = [];
  const retriedNodes: Array<{ nodeId: string; attempts: number; nodeType: string }> = [];
  const executionStartTime = Date.now();

  for (let index = startIndex; index < nodeOrder.length; index += 1) {

    // Check execution timeout
    const elapsedMs = Date.now() - executionStartTime;
    if (elapsedMs > executionTimeoutMs) {
      for (let remaining = index; remaining < nodeOrder.length; remaining += 1) {
        nodeResults.push({
          nodeId: nodeOrder[remaining],
          status: "skipped",
          startedAt: nowIso(),
          completedAt: nowIso(),
          durationMs: 0,
          output: { reason: "execution_timeout" }
        });
      }
      return {
        workflowId: workflow.id,
        status: "error" as const,
        startedAt,
        completedAt: nowIso(),
        executionId: request.executionId,
        nodeResults,
        error: `Workflow execution timed out after ${elapsedMs}ms (limit: ${executionTimeoutMs}ms)`,
        warnings: workflowWarnings,
        retriedNodes
      };
    }
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

    if (loopInlineExecutedNodes.has(node.id)) {
      continue;
    }

    const hasExecutionIncoming = (graphIndexes.incomingExecution.get(node.id)?.length ?? 0) > 0;
    const hasExecutionOutgoing = (graphIndexes.outgoingExecution.get(node.id)?.length ?? 0) > 0;
    const hasAttachmentIncoming = (graphIndexes.incomingAttachments.get(node.id)?.length ?? 0) > 0;
    const isAttachmentOnlyNode = hasAttachmentIncoming && !hasExecutionIncoming && !hasExecutionOutgoing;
    const isDisconnectedNode = !hasAttachmentIncoming && !hasExecutionIncoming && !hasExecutionOutgoing;

    if (isAttachmentOnlyNode && !forceExecuteNodeIds.has(node.id)) {
      const consumedUsage = attachmentUsageByNodeId.get(node.id);
      if (consumedUsage) {
        nodeResults.push(toAttachmentConsumedResult(consumedUsage));
        if (!attachmentCompletionEventEmitted.has(node.id)) {
          await dependencies.onNodeComplete?.({
            nodeId: node.id,
            nodeType: node.type,
            status: "success",
            completedAt: consumedUsage.completedAt,
            durationMs: consumedUsage.durationMs,
            input: toJsonSafeValue(consumedUsage.input),
            output: {
              reason: "attachment_consumed_by_agent",
              message: "Node was consumed by an attached agent during execution.",
              handle: consumedUsage.handle,
              usedByNodeId: consumedUsage.usedByNodeId,
              details: toJsonSafeValue(consumedUsage.output)
            }
          });
          attachmentCompletionEventEmitted.add(node.id);
        }
      } else {
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
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "skipped",
          completedAt: nowIso(),
          durationMs: 0,
          output: {
            reason: "attachment_only_node",
            message: "Node is attached to an agent port and is not part of the execution DAG."
          }
        });
      }
      attachmentOnlyResultIndexByNodeId.set(node.id, nodeResults.length - 1);
      continue;
    }

    if (isDisconnectedNode && !forceExecuteNodeIds.has(node.id)) {
      nodeResults.push({
        nodeId: node.id,
        status: "skipped",
        startedAt: nowIso(),
        completedAt: nowIso(),
        durationMs: 0,
        output: {
          reason: "disconnected_node",
          message: "Node is not connected to any execution edge and was not executed."
        }
      });
      await dependencies.onNodeComplete?.({
        nodeId: node.id,
        nodeType: node.type,
        status: "skipped",
        completedAt: nowIso(),
        durationMs: 0,
        output: {
          reason: "disconnected_node",
          message: "Node is not connected to any execution edge and was not executed."
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

    let nodeInput: unknown = null;
    try {
      const parentIds = graphIndexes.incomingExecution.get(node.id) ?? [];
      const parentOutputs: Record<string, unknown> = {};
      for (const parentId of parentIds) {
        if (nodeOutputs.has(parentId)) {
          parentOutputs[parentId] = nodeOutputs.get(parentId);
        }
      }

      const merged = mergeParentOutputs(parentOutputs);
      nodeInput = captureNodeInputSnapshot(globals, merged, parentOutputs);
      if (node.type === "loop_node") {
        const inputKey = typeof nodeConfig.inputKey === "string" ? nodeConfig.inputKey.trim() : "";
        const itemVariable =
          typeof nodeConfig.itemVariable === "string" && nodeConfig.itemVariable.trim()
            ? nodeConfig.itemVariable.trim()
            : "item";
        const maxIterations =
          typeof nodeConfig.maxIterations === "number" && Number.isFinite(nodeConfig.maxIterations) && nodeConfig.maxIterations > 0
            ? Math.floor(nodeConfig.maxIterations)
            : 100;
        const templateData: Record<string, unknown> = {
          ...globals,
          ...merged,
          parent_outputs: parentOutputs
        };
        let candidateItems = inputKey ? templateData[inputKey] : undefined;
        if (candidateItems === undefined && inputKey) {
          candidateItems = getValueByPath(templateData, inputKey);
        }
        const rawItems = Array.isArray(candidateItems) ? candidateItems : [candidateItems];
        const scopedItems = rawItems.slice(0, maxIterations);
        const downstreamNodeIds = graphIndexes.outgoingExecution.get(node.id) ?? [];
        const downstreamNodes = downstreamNodeIds
          .map((childId) => graphIndexes.nodeById.get(childId))
          .filter((child): child is WorkflowNode => Boolean(child));

        for (const child of downstreamNodes) {
          const childParents = graphIndexes.incomingExecution.get(child.id) ?? [];
          const isLoopScopedChild = childParents.length > 0 && childParents.every((parentId) => parentId === node.id);
          if (isLoopScopedChild) {
            loopInlineExecutedNodes.add(child.id);
          }
        }

        const loopItems: Array<{
          index: number;
          item: unknown;
          outputs: Record<string, unknown>;
        }> = [];

        for (let loopIndex = 0; loopIndex < scopedItems.length; loopIndex += 1) {
          const loopItem = scopedItems[loopIndex];
          const iterationGlobals: Record<string, unknown> = {
            ...globals,
            [itemVariable]: loopItem,
            _loop_index: loopIndex
          };
          const iterationOutputs: Record<string, unknown> = {};

          for (const childNode of downstreamNodes) {
            const childStarted = Date.now();
            const childStartedAt = nowIso();
            let childInput: unknown = null;
            await dependencies.onNodeStart?.({
              nodeId: childNode.id,
              nodeType: childNode.type,
              startedAt: childStartedAt
            });

            try {
              const childParentIds = graphIndexes.incomingExecution.get(childNode.id) ?? [];
              const childParentOutputs: Record<string, unknown> = {};
              for (const parentId of childParentIds) {
                if (parentId === node.id) {
                  childParentOutputs[parentId] = {
                    [itemVariable]: loopItem,
                    item: loopItem,
                    _loop_index: loopIndex
                  };
                  continue;
                }

                if (nodeOutputs.has(parentId)) {
                  childParentOutputs[parentId] = nodeOutputs.get(parentId);
                }
              }

              const childMerged = mergeParentOutputs(childParentOutputs);
              childMerged[itemVariable] = loopItem;
              childMerged._loop_index = loopIndex;
              childInput = captureNodeInputSnapshot(iterationGlobals, childMerged, childParentOutputs);
              const { output: childOutput, attempts: childAttempts } = await executeNodeWithRetry(
                childNode,
                {
                  globals: iterationGlobals,
                  merged: childMerged,
                  parentOutputs: childParentOutputs,
                  workflow,
                  nodeById: graphIndexes.nodeById,
                  attachmentsBySource: graphIndexes.attachmentsBySource,
                  callStack,
                  recordAttachmentUsage
                },
                dependencies
              );

              iterationOutputs[childNode.id] = childOutput;
              nodeOutputs.set(childNode.id, childOutput);
              if (childNode.type === "output") {
                finalOutput = childOutput;
              }
              nodeResults.push({
                nodeId: childNode.id,
                status: "success",
                startedAt: childStartedAt,
                completedAt: nowIso(),
                durationMs: Date.now() - childStarted,
                input: childInput,
                output: childOutput,
                attempts: childAttempts > 1 ? childAttempts : undefined
              });
              await dependencies.onNodeComplete?.({
                nodeId: childNode.id,
                nodeType: childNode.type,
                status: "success",
                completedAt: nowIso(),
                durationMs: Date.now() - childStarted,
                input: childInput,
                output: childOutput
              });
            } catch (childError) {
              const childErrorMessage = childError instanceof Error ? childError.message : "Loop iteration failed";
              nodeResults.push({
                nodeId: childNode.id,
                status: "error",
                startedAt: childStartedAt,
                completedAt: nowIso(),
                durationMs: Date.now() - childStarted,
                input: childInput,
                error: childErrorMessage
              });
              await dependencies.onNodeComplete?.({
                nodeId: childNode.id,
                nodeType: childNode.type,
                status: "error",
                completedAt: nowIso(),
                durationMs: Date.now() - childStarted,
                input: childInput,
                error: childErrorMessage
              });
              throw new Error(
                `Loop node '${node.id}' failed at iteration ${loopIndex} on child '${childNode.id}': ${childErrorMessage}`
              );
            }
          }

          loopItems.push({
            index: loopIndex,
            item: loopItem,
            outputs: iterationOutputs
          });
        }

        const output = {
          items: loopItems,
          count: loopItems.length
        };

        nodeOutputs.set(node.id, output);
        nodeResults.push({
          nodeId: node.id,
          status: "success",
          startedAt: startedAtNode,
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          input: nodeInput,
          output
        });
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "success",
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          input: nodeInput,
          output
        });
        continue;
      }

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
          input: nodeInput,
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
          input: nodeInput,
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
          attachmentsBySource: graphIndexes.attachmentsBySource,
          callStack,
          recordAttachmentUsage
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
        input: nodeInput,
        output,
        attempts: attempts > 1 ? attempts : undefined
      });
      await dependencies.onNodeComplete?.({
        nodeId: node.id,
        nodeType: node.type,
        status: "success",
        completedAt: nowIso(),
        durationMs: Date.now() - started,
        input: nodeInput,
        output
      });

      if (node.type === "output") {
        finalOutput = output;
      }

      // Handle branching: determine which branches to skip
      const outputRecord = toRecord(output);
      const activeBranch = typeof outputRecord._branchHandle === "string" ? outputRecord._branchHandle : undefined;
      const activeBranchFallback =
        typeof outputRecord._branchHandleFallback === "string" ? outputRecord._branchHandleFallback : undefined;

      if (activeBranch && branchTargets.has(node.id)) {
        const handleMap = branchTargets.get(node.id)!;
        const takenHandles = new Set<string>();
        if (activeBranch) {
          takenHandles.add(activeBranch);
        }
        if (activeBranchFallback) {
          takenHandles.add(activeBranchFallback);
        }
        const takenTargets = new Set<string>();
        for (const takenHandle of takenHandles) {
          for (const target of handleMap.get(takenHandle) ?? []) {
            takenTargets.add(target);
          }
        }
        const protectedNodes = collectReachableFromRoots(takenTargets, graphIndexes.outgoingExecution, workflow);

        for (const [handle, targets] of handleMap.entries()) {
          if (takenHandles.has(handle)) {
            continue; // This is the taken branch
          }
          // Mark all nodes on non-taken branches as skipped
          for (const target of targets) {
            for (const candidate of collectNodeAndDescendants(target, graphIndexes.outgoingExecution, workflow)) {
              if (!protectedNodes.has(candidate)) {
                skippedByBranch.add(candidate);
              }
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
            input: nodeInput,
            error: errorMessage
          });
          await dependencies.onNodeComplete?.({
            nodeId: node.id,
            nodeType: node.type,
            status: "error",
            completedAt: nowIso(),
            durationMs: Date.now() - started,
            input: nodeInput,
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
            input: nodeInput,
            error: errorMessage
          });
          await dependencies.onNodeComplete?.({
            nodeId: node.id,
            nodeType: node.type,
            status: "error",
            completedAt: nowIso(),
            durationMs: Date.now() - started,
            input: nodeInput,
            error: errorMessage
          });
          hadContinuedErrors = true;
          continue;
        }

        if (onError === "branch" && branchTargets.has(node.id)) {
          const handleMap = branchTargets.get(node.id)!;
          const errorBranchTargets = handleMap.get("error") ?? [];
          if (errorBranchTargets.length > 0) {
            const protectedNodes = collectReachableFromRoots(
              errorBranchTargets,
              graphIndexes.outgoingExecution,
              workflow
            );
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
                  for (const candidate of collectNodeAndDescendants(t, graphIndexes.outgoingExecution, workflow)) {
                    if (!protectedNodes.has(candidate)) {
                      skippedByBranch.add(candidate);
                    }
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
              input: nodeInput,
              error: errorMessage
            });
            await dependencies.onNodeComplete?.({
              nodeId: node.id,
              nodeType: node.type,
              status: "error",
              completedAt: nowIso(),
              durationMs: Date.now() - started,
              input: nodeInput,
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
          input: nodeInput,
          error: failedError
        });
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "error",
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          input: nodeInput,
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

