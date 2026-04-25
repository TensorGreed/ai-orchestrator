
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  MarkerType,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeTypes,
  type Node,
  type ReactFlowInstance
} from "reactflow";
import {
  DEFAULT_PROJECT_ID,
  WORKFLOW_SCHEMA_VERSION,
  nodeDefinitions,
  type Folder,
  type Project,
  type Workflow,
  type WorkflowExecutionResult
} from "@ai-orchestrator/shared";
import {
  ApiError,
  cancelExecution,
  completeMfaLogin,
  createFolder,
  createProject,
  createSecret,
  deleteWorkflowPin,
  deleteFolder,
  deleteProject,
  deleteWorkflow,
  duplicateWorkflow,
  executeWorkflow,
  executeWorkflowStream,
  fetchAuthMe,
  fetchExecutionById,
  fetchExecutions,
  fetchDefinitions,
  fetchFolders,
  fetchProjects,
  fetchSecrets,
  fetchWorkflow,
  fetchWorkflowVariables,
  fetchWorkflows,
  importWorkflow,
  isMfaChallenge,
  loginUser,
  logoutUser,
  moveWorkflow,
  retryExecution,
  runWebhookStream,
  saveWorkflow,
  saveWorkflowPin,
  updateWorkflowVariables,
  type AuthUser,
  type ExecutionHistoryDetail,
  type SecretListItem,
  type StreamExecutionStartedEvent,
  type StreamNodeCompleteEvent,
  type StreamNodeStartEvent
} from "./lib/api";
import {
  createBlankWorkflow,
  createEdgeId,
  createNodeId,
  editorToWorkflow,
  workflowToEditor,
  type EditorNode,
  type EditorNodeData
} from "./lib/workflow";
import {
  deleteTabWipWorkflow,
  readLegacyLocalWipWorkflow,
  readRememberedTabProjectId,
  readRememberedTabWorkflowId,
  readStudioUrlState,
  readTabWipWorkflow,
  rememberTabProjectId,
  rememberTabWorkflowId,
  replaceStudioUrlState,
  storeTabWipWorkflow
} from "./lib/studio-session";
import { WorkflowCanvasNode } from "./components/WorkflowCanvasNode";
import { StickyNoteNode } from "./components/StickyNoteNode";
import { KeyboardShortcutsPanel } from "./components/KeyboardShortcutsPanel";
import { RadialActionRing, type RadialAction } from "./components/RadialActionRing";
import { WorkflowCanvasEdge } from "./components/WorkflowCanvasEdge";
import { NodeConfigModal, type NodeInputOption } from "./components/NodeConfigModal";
import { LeftMenuBar } from "./components/LeftMenuBar";
import { StudioHeader } from "./components/StudioHeader";
import { ExecutionHistoryPanel } from "./components/ExecutionHistoryPanel";
import { SettingsPage } from "./components/SettingsPage";
import { TemplateGallery } from "./components/TemplateGallery";
import { WorkflowShareModal } from "./components/WorkflowShareModal";
import { WorkflowCanvasArea } from "./components/WorkflowCanvasArea";
import { StudioProvider, useStudioContext } from "./contexts/StudioContext";

interface DefinitionNode {
  type: string;
  label: string;
  category: string;
  description: string;
  sampleConfig: Record<string, unknown>;
}

type AgentAttachmentHandle = "chat_model" | "memory" | "tool" | "worker";

interface NodeDrawerContext {
  title: string;
  description: string;
  allowedTypes: string[];
  sourceNodeId?: string;
  sourceHandle?: AgentAttachmentHandle;
}

interface MCPServerDefinition {
  id: string;
  label: string;
  description: string;
}

type LogsTab = "logs" | "inputs";

interface ChatMessageEntry {
  id: string;
  role: "assistant" | "user";
  text: string;
  status?: "streaming" | "done" | "error";
  images?: Array<{ data: string; mimeType: string }>;
}

interface WorkflowVariableRow {
  id: string;
  key: string;
  value: string;
}

interface ExecutionHistoryFilters {
  status: string;
  workflowId: string;
  startedFrom: string;
  startedTo: string;
}

interface NodeClipboardNodePayload {
  sourceId: string;
  nodeType: EditorNodeData["nodeType"];
  label: string;
  config: Record<string, unknown>;
  relativePosition: { x: number; y: number };
  disabled?: boolean;
  color?: EditorNodeData["color"];
}

interface NodeClipboardEdgePayload {
  sourceId: string;
  targetId: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

interface NodeClipboardPayload {
  version: 1;
  copiedAt: string;
  nodes: NodeClipboardNodePayload[];
  edges: NodeClipboardEdgePayload[];
}

const statusColors: Record<string, string> = {
  success: "#18a35f",
  error: "#d64545",
  skipped: "#7f8797",
  running: "#d68f16",
  pending: "#5b7bd8",
  waiting_approval: "#a154f2",
  canceled: "#8a5a44"
};
const auxiliaryHandles = new Set(["chat_model", "memory", "tool", "worker"]);
const chatModelNodeTypes: EditorNodeData["nodeType"][] = [
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model",
  "llm_call"
];
const chatModelDrawerNodeTypes = chatModelNodeTypes.filter((type) => type !== "llm_call");
const agentPrimaryInputNodeTypes = new Set<EditorNodeData["nodeType"]>(["webhook_input", "text_input", "user_prompt"]);

function buildAgentAttachmentDrawerContext(sourceNodeId: string, sourceHandle: AgentAttachmentHandle): NodeDrawerContext {
  if (sourceHandle === "chat_model") {
    return {
      title: "Language Models",
      description: "Choose a chat model to attach to this AI Agent.",
      allowedTypes: chatModelDrawerNodeTypes,
      sourceNodeId,
      sourceHandle
    };
  }

  if (sourceHandle === "memory") {
    return {
      title: "Memory",
      description: "Choose memory storage for this AI Agent.",
      allowedTypes: ["local_memory"],
      sourceNodeId,
      sourceHandle
    };
  }

  if (sourceHandle === "worker") {
    return {
      title: "Workers",
      description: "Choose a worker agent to attach to this supervisor.",
      allowedTypes: ["agent_orchestrator", "supervisor_node"],
      sourceNodeId,
      sourceHandle
    };
  }

  return {
    title: "Tools",
    description: "Choose a tool node to attach to this AI Agent.",
    allowedTypes: ["mcp_tool"],
    sourceNodeId,
    sourceHandle
  };
}

const DEBUG_MODE_STORAGE_KEY = "ai-orchestrator:debug-mode";
const NODE_CLIPBOARD_STORAGE_KEY = "ai-orchestrator:node-clipboard";
const MAX_LOCAL_WIP_CHARS = 1_000_000;
const NODE_PASTE_OFFSET_PX = 28;
const THEME_STORAGE_KEY = "ai-orchestrator:theme";
const HISTORY_STACK_LIMIT = 50;
const DEFAULT_LOGS_PANEL_HEIGHT = 210;
const MIN_LOGS_PANEL_HEIGHT = 140;
const MAX_LOGS_PANEL_HEIGHT = 620;
type SecretProviderPreset =
  | "openai"
  | "anthropic"
  | "gemini"
  | "azure_openai"
  | "azure_storage"
  | "azure_cosmos_db"
  | "azure_monitor"
  | "azure_ai_search"
  | "qdrant"
  | "google_drive"
  | "webhook"
  | "openai_compatible"
  | "ollama"
  | "pinecone"
  | "postgres"
  | "custom";
const SECRET_PROVIDER_OPTIONS: Array<{ value: SecretProviderPreset; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "azure_storage", label: "Azure Storage" },
  { value: "azure_cosmos_db", label: "Azure Cosmos DB" },
  { value: "azure_monitor", label: "Microsoft Azure Monitor" },
  { value: "azure_ai_search", label: "Azure AI Search" },
  { value: "qdrant", label: "Qdrant" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
  { value: "google_drive", label: "Google Drive" },
  { value: "webhook", label: "Webhook Secret" },
  { value: "openai_compatible", label: "OpenAI Compatible" },
  { value: "ollama", label: "Ollama" },
  { value: "pinecone", label: "Pinecone" },
  { value: "postgres", label: "Postgres / PGVector" },
  { value: "custom", label: "Custom" }
];

function buildSecretPayload(input: {
  provider: string;
  customProvider: string;
  genericValue: string;
  connectionString: string;
  googleAuthMode: "access_token" | "service_account_json";
  googleAccessToken: string;
  googleServiceAccountJson: string;
}): { provider?: string; value?: string; error?: string } {
  const provider = input.provider.trim();
  if (!provider) {
    return { error: "Provider is required." };
  }

  if (provider === "custom") {
    const customProvider = input.customProvider.trim();
    const customValue = input.genericValue.trim();
    if (!customProvider) {
      return { error: "Custom provider name is required." };
    }
    if (!customValue) {
      return { error: "Secret value is required." };
    }
    return {
      provider: customProvider,
      value: customValue
    };
  }

  if (provider === "google_drive") {
    if (input.googleAuthMode === "access_token") {
      const token = input.googleAccessToken.trim();
      if (!token) {
        return { error: "Google Drive access token is required." };
      }
      return { provider, value: token };
    }

    const rawJson = input.googleServiceAccountJson.trim();
    if (!rawJson) {
      return { error: "Google Drive service account JSON is required." };
    }

    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      if (typeof parsed.client_email !== "string" || !parsed.client_email.trim()) {
        return { error: "Google service account JSON must include client_email." };
      }
      if (typeof parsed.private_key !== "string" || !parsed.private_key.trim()) {
        return { error: "Google service account JSON must include private_key." };
      }
      return {
        provider,
        value: JSON.stringify(parsed)
      };
    } catch {
      return { error: "Google service account must be valid JSON." };
    }
  }

  if (provider === "postgres") {
    const connectionString = input.connectionString.trim();
    if (!connectionString) {
      return { error: "Connection string is required." };
    }
    return { provider, value: connectionString };
  }

  const genericValue = input.genericValue.trim();
  if (!genericValue) {
    return { error: "Secret value is required." };
  }
  return {
    provider,
    value: genericValue
  };
}

function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function storeLocalWipWorkflow(workflow: Workflow): void {
  storeTabWipWorkflow(workflow, MAX_LOCAL_WIP_CHARS);
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1000) {
    return `${value}ms`;
  }
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 2)}s`;
}

function formatWhen(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString();
}

function dateTimeLocalToIso(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getValidationMessages(payload?: Record<string, unknown>): string[] {
  const validation = asRecord(payload?.validation);
  const issues = validation?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }

  return issues
    .map((issue) => {
      const issueRecord = asRecord(issue);
      return issueRecord && typeof issueRecord.message === "string" ? issueRecord.message : "";
    })
    .filter((message) => message.length > 0);
}

function buildExecutionErrorResult(workflowId: string, message: string): WorkflowExecutionResult {
  const now = new Date().toISOString();
  return {
    workflowId,
    status: "error",
    startedAt: now,
    completedAt: now,
    nodeResults: [],
    error: message
  };
}

function toWorkflowExecutionResult(detail: ExecutionHistoryDetail): WorkflowExecutionResult {
  return {
    workflowId: detail.workflowId,
    status: detail.status as WorkflowExecutionResult["status"],
    startedAt: detail.startedAt,
    completedAt: detail.completedAt ?? detail.startedAt,
    executionId: detail.id,
    customData: asRecord(detail.customData) ?? undefined,
    nodeResults: Array.isArray(detail.nodeResults) ? (detail.nodeResults as WorkflowExecutionResult["nodeResults"]) : [],
    output: detail.output,
    error: detail.error ?? undefined
  };
}

function createPartialExecutionResult(workflowId: string, at: string): WorkflowExecutionResult {
  return {
    workflowId,
    status: "partial",
    startedAt: at,
    completedAt: at,
    nodeResults: []
  };
}

function upsertNodeResult(
  nodeResults: WorkflowExecutionResult["nodeResults"],
  next: WorkflowExecutionResult["nodeResults"][number]
): WorkflowExecutionResult["nodeResults"] {
  const existingIndex = nodeResults.findIndex((entry) => entry.nodeId === next.nodeId);
  if (existingIndex < 0) {
    return [...nodeResults, next];
  }
  const updated = [...nodeResults];
  updated[existingIndex] = {
    ...updated[existingIndex],
    ...next
  };
  return updated;
}

function applyNodeStartToExecutionResult(
  current: WorkflowExecutionResult,
  event: StreamNodeStartEvent
): WorkflowExecutionResult {
  const existing = current.nodeResults.find((entry) => entry.nodeId === event.nodeId);
  const nextNodeResult: WorkflowExecutionResult["nodeResults"][number] = {
    nodeId: event.nodeId,
    status: "running",
    startedAt: existing?.startedAt ?? event.startedAt,
    input: event.input ?? existing?.input,
    output: existing?.output,
    error: existing?.error
  };

  return {
    ...current,
    status: "partial",
    completedAt: event.startedAt,
    nodeResults: upsertNodeResult(current.nodeResults, nextNodeResult)
  };
}

function applyNodeCompleteToExecutionResult(
  current: WorkflowExecutionResult,
  event: StreamNodeCompleteEvent
): WorkflowExecutionResult {
  const existing = current.nodeResults.find((entry) => entry.nodeId === event.nodeId);
  const nextNodeResult: WorkflowExecutionResult["nodeResults"][number] = {
    nodeId: event.nodeId,
    status: event.status as WorkflowExecutionResult["nodeResults"][number]["status"],
    startedAt: existing?.startedAt ?? event.completedAt,
    completedAt: event.completedAt,
    durationMs: event.durationMs,
    input: event.input ?? existing?.input,
    output: event.output ?? existing?.output,
    error: event.error
  };

  return {
    ...current,
    status: "partial",
    completedAt: event.completedAt,
    nodeResults: upsertNodeResult(current.nodeResults, nextNodeResult)
  };
}

function createChatSessionId(workflowId: string): string {
  const sanitized = workflowId.trim() || "workflow";
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `chat-${sanitized}-${crypto.randomUUID()}`;
  }
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `chat-${sanitized}-${Date.now().toString(36)}-${randomPart}`;
}

function createVariableRowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `var-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function workflowVariablesToRows(variables: Record<string, string> | undefined): WorkflowVariableRow[] {
  if (!variables) {
    return [];
  }

  return Object.entries(variables).map(([key, value]) => ({
    id: createVariableRowId(),
    key,
    value
  }));
}

function rowsToWorkflowVariables(rows: WorkflowVariableRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const normalizedKey = row.key.trim();
    if (!normalizedKey) {
      continue;
    }
    result[normalizedKey] = row.value;
  }
  return result;
}

function decodeBufferLikeText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "Buffer" || !Array.isArray(record.data)) {
    return null;
  }
  const bytes = record.data.filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255) as number[];
  if (bytes.length !== record.data.length) {
    return null;
  }
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function extractAssistantText(value: unknown): string {
  const decodedRoot = decodeBufferLikeText(value);
  if (decodedRoot !== null) {
    return decodedRoot;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidates = [record.result, record.answer, record.text, record.content];
    for (const candidate of candidates) {
      const decoded = decodeBufferLikeText(candidate);
      if (decoded !== null) {
        return decoded;
      }
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
  }

  if (value === undefined || value === null) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isPdfDataUrl(value: string): boolean {
  return /^data:application\/pdf;base64,/i.test(value.trim());
}

function getNodeStatusMap(result: WorkflowExecutionResult | null) {
  const map = new Map<string, string>();
  if (!result) {
    return map;
  }

  for (const nodeResult of result.nodeResults) {
    map.set(nodeResult.nodeId, nodeResult.status);
  }
  return map;
}

function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function summarizePreviewValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).slice(0, 4);
    return keys.length ? `{ ${keys.join(", ")} }` : "{}";
  }
  return String(value);
}

function truncatePreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function extractNodeOutputsFromExecution(result: WorkflowExecutionResult | null): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const nodeResult of result?.nodeResults ?? []) {
    if (nodeResult.output !== undefined) {
      outputs[nodeResult.nodeId] = nodeResult.output;
    }
  }
  return outputs;
}

function normalizeEditorExecutionStatus(value: unknown): EditorNodeData["executionStatus"] {
  if (
    value === "pending" ||
    value === "running" ||
    value === "success" ||
    value === "error" ||
    value === "skipped" ||
    value === "canceled"
  ) {
    return value;
  }
  return undefined;
}

function hasConfiguredNodeText(node: EditorNode): boolean {
  const config = node.data.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return false;
  }

  const text = (config as Record<string, unknown>).text;
  return typeof text === "string" && text.trim().length > 0;
}

function decorateEdge(edge: Edge, nodes: EditorNode[]): Edge {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  const isAuxiliary =
    edge.sourceHandle?.startsWith("aux") ||
    edge.targetHandle?.startsWith("aux") ||
    (edge.sourceHandle ? auxiliaryHandles.has(edge.sourceHandle) : false) ||
    (edge.targetHandle ? auxiliaryHandles.has(edge.targetHandle) : false) ||
    target?.data.nodeType === "mcp_tool" ||
    target?.data.nodeType === "connector_source" ||
    target?.data.nodeType === "google_drive_source";

  const stroke = isAuxiliary ? "#a7bccc" : "#4f6881";
  
  // Create an explicit label for structural branches
  let label: string | undefined = undefined;
  if (!isAuxiliary && edge.sourceHandle) {
    if (edge.sourceHandle === "true") label = "True";
    else if (edge.sourceHandle === "false") label = "False";
    else if (edge.sourceHandle === "success") label = "Try (Success)";
    else if (edge.sourceHandle === "error") label = "Catch (Error)";
    else if (edge.sourceHandle === "default") label = "Default";
    else if (source?.data.nodeType === "chat_intent_router") {
      const routerLabels: Record<string, string> = {
        report: "Report",
        code: "Code",
        message: "Message",
        missing_context: "Missing Context"
      };
      label = routerLabels[edge.sourceHandle] ?? edge.sourceHandle;
    }
    else if (edge.sourceHandle.startsWith("case_")) {
      const caseIdx = parseInt(edge.sourceHandle.split("_")[1] ?? "0", 10);
      const nodeConfig = source?.data.config;
      if (nodeConfig && Array.isArray(nodeConfig.cases)) {
         const c = nodeConfig.cases[caseIdx] as any;
         if (typeof c === "string") {
            label = c;
         } else if (c && typeof c === "object") {
            label = c.label || c.value || `Case ${caseIdx + 1}`;
         } else {
            label = `Case ${caseIdx + 1}`;
         }
      } else {
         label = `Case ${caseIdx + 1}`;
      }
    } else if (source?.data.nodeType === "switch_node") {
      label = edge.sourceHandle;
    }
  }

  return {
    ...edge,
    type: "workflowBezier",
    animated: Boolean(isAuxiliary),
    label,
    labelBgPadding: [8, 4],
    labelBgBorderRadius: 4,
    labelBgStyle: { fill: "#f3faf9", color: "#2f5a67", border: "1px solid #cde3e2" },
    labelStyle: { fill: "#2f5a67", fontWeight: 600, fontSize: 10 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: stroke
    },
    style: {
      ...(edge.style ?? {}),
      stroke,
      strokeWidth: isAuxiliary ? 1.5 : 2,
      strokeDasharray: isAuxiliary ? "6 6" : undefined
    },
    data: {
      ...(edge.data ?? {}),
      sourceType: source?.data.nodeType,
      targetType: target?.data.nodeType
    }
  };
}

function isExecutionEdgeForVisual(edge: Edge): boolean {
  return !(
    (edge.sourceHandle && auxiliaryHandles.has(edge.sourceHandle)) ||
    (edge.targetHandle && auxiliaryHandles.has(edge.targetHandle)) ||
    edge.sourceHandle?.startsWith("aux") ||
    edge.targetHandle?.startsWith("aux")
  );
}

export default function App() {
  return (
    <StudioProvider>
      <StudioApp />
    </StudioProvider>
  );
}

function computeExecutionOrderForVisual(nodes: EditorNode[], edges: Edge[]): string[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const incomingExecution = new Map<string, number>();
  const outgoingExecution = new Map<string, string[]>();
  const incomingAttachment = new Map<string, number>();
  const outgoingExecutionCount = new Map<string, number>();

  for (const node of nodes) {
    incomingExecution.set(node.id, 0);
    outgoingExecution.set(node.id, []);
    incomingAttachment.set(node.id, 0);
    outgoingExecutionCount.set(node.id, 0);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      continue;
    }

    if (!isExecutionEdgeForVisual(edge)) {
      incomingAttachment.set(edge.target, (incomingAttachment.get(edge.target) ?? 0) + 1);
      continue;
    }

    incomingExecution.set(edge.target, (incomingExecution.get(edge.target) ?? 0) + 1);
    outgoingExecutionCount.set(edge.source, (outgoingExecutionCount.get(edge.source) ?? 0) + 1);
    const currentTargets = outgoingExecution.get(edge.source) ?? [];
    currentTargets.push(edge.target);
    outgoingExecution.set(edge.source, currentTargets);
  }

  const attachmentOnlyNodeIds = new Set(
    nodes
      .filter((node) => {
        const incomingAttach = incomingAttachment.get(node.id) ?? 0;
        const incomingExec = incomingExecution.get(node.id) ?? 0;
        const outgoingExec = outgoingExecutionCount.get(node.id) ?? 0;
        return incomingAttach > 0 && incomingExec === 0 && outgoingExec === 0;
      })
      .map((node) => node.id)
  );

  const filteredNodeIds = nodes
    .map((node) => node.id)
    .filter((nodeId) => !attachmentOnlyNodeIds.has(nodeId))
    .filter((nodeId) => {
      const incomingExec = incomingExecution.get(nodeId) ?? 0;
      const outgoingExec = outgoingExecutionCount.get(nodeId) ?? 0;
      return incomingExec > 0 || outgoingExec > 0;
    });

  const filteredSet = new Set(filteredNodeIds);
  const filteredInDegree = new Map<string, number>();
  const filteredOutgoing = new Map<string, string[]>();
  for (const nodeId of filteredNodeIds) {
    filteredInDegree.set(nodeId, 0);
    filteredOutgoing.set(nodeId, []);
  }

  for (const edge of edges) {
    if (!isExecutionEdgeForVisual(edge) || !filteredSet.has(edge.source) || !filteredSet.has(edge.target)) {
      continue;
    }

    filteredInDegree.set(edge.target, (filteredInDegree.get(edge.target) ?? 0) + 1);
    const targets = filteredOutgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    filteredOutgoing.set(edge.source, targets);
  }

  const queue = filteredNodeIds.filter((nodeId) => (filteredInDegree.get(nodeId) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    order.push(nodeId);
    for (const targetId of filteredOutgoing.get(nodeId) ?? []) {
      const nextDegree = (filteredInDegree.get(targetId) ?? 0) - 1;
      filteredInDegree.set(targetId, nextDegree);
      if (nextDegree === 0) {
        queue.push(targetId);
      }
    }
  }

  if (order.length !== filteredNodeIds.length) {
    return filteredNodeIds;
  }

  return order;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }

  return Boolean(target.closest(".node-modal-shell"));
}

function StudioApp() {
  const {
    workflowList,
    setWorkflowList,
    currentWorkflow,
    setCurrentWorkflow,
    activeMode,
    setActiveMode,
    executionHistoryItems,
    setExecutionHistoryItems,
    executionHistoryTotal,
    setExecutionHistoryTotal,
    expandedExecutionIds,
    setExpandedExecutionIds,
    executionDetailById,
    setExecutionDetailById
  } = useStudioContext();

  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [shareWorkflowTarget, setShareWorkflowTarget] = useState<{
    id: string;
    name: string;
    projectId: string;
  } | null>(null);

  const [definitions, setDefinitions] = useState<DefinitionNode[]>(nodeDefinitions as unknown as DefinitionNode[]);
  const [mcpServerDefinitions, setMcpServerDefinitions] = useState<MCPServerDefinition[]>([]);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runningExecutionId, setRunningExecutionId] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretMessage, setSecretMessage] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<WorkflowExecutionResult | null>(null);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [executionsError, setExecutionsError] = useState<string | null>(null);
  const [executionHistoryFilters, setExecutionHistoryFilters] = useState<ExecutionHistoryFilters>({
    status: "",
    workflowId: "",
    startedFrom: "",
    startedTo: ""
  });

  const [systemPrompt, setSystemPrompt] = useState("You are a precise tool-using AI assistant.");
  const [userPrompt, setUserPrompt] = useState("What time is it in America/Toronto? Use tools when needed.");
  const [sessionId, setSessionId] = useState("session-local-dev");
  const [chatInput, setChatInput] = useState("");
  const [chatPendingImages, setChatPendingImages] = useState<Array<{ data: string; mimeType: string }>>([]);
  const [chatSystemPrompt, setChatSystemPrompt] = useState("You are a precise tool-using AI assistant.");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatMessagesByWorkflow, setChatMessagesByWorkflow] = useState<Record<string, ChatMessageEntry[]>>({});
  const [chatSessionsByWorkflow, setChatSessionsByWorkflow] = useState<Record<string, string>>({});
  const [chatNodeTrace, setChatNodeTrace] = useState<Array<{ nodeId: string; status: string; at: string }>>([]);

  const [secretName, setSecretName] = useState("Default LLM Key");
  const [secretProvider, setSecretProvider] = useState<SecretProviderPreset>("openai");
  const [secretCustomProvider, setSecretCustomProvider] = useState("");
  const [secretGenericValue, setSecretGenericValue] = useState("");
  const [secretConnectionString, setSecretConnectionString] = useState("");
  const [secretGoogleAuthMode, setSecretGoogleAuthMode] = useState<"access_token" | "service_account_json">("access_token");
  const [secretGoogleAccessToken, setSecretGoogleAccessToken] = useState("");
  const [secretGoogleServiceAccountJson, setSecretGoogleServiceAccountJson] = useState("");
  const [dashboardFilter, setDashboardFilter] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    const urlState = readStudioUrlState();
    return urlState.projectId ?? readRememberedTabProjectId() ?? DEFAULT_PROJECT_ID;
  });
  // null = "No folder (root)", undefined = "All folders"
  const [activeFolderFilter, setActiveFolderFilter] = useState<string | null | undefined>(undefined);
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [workflowVariableRows, setWorkflowVariableRows] = useState<WorkflowVariableRow[]>([]);
  const [variablesBusy, setVariablesBusy] = useState(false);

  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [showNodeDrawer, setShowNodeDrawer] = useState(false);
  const [nodeDrawerContext, setNodeDrawerContext] = useState<NodeDrawerContext | null>(null);
  const [showShortcutsPanel, setShowShortcutsPanel] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark") return "dark";
      if (stored === "light") return "light";
      if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
        return "dark";
      }
    } catch {
      /* ignore */
    }
    return "light";
  });
  const [isDebugMode, setIsDebugMode] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(DEBUG_MODE_STORAGE_KEY);
      if (stored === "1") {
        return true;
      }
      if (stored === "0") {
        return false;
      }
    } catch {
      // localStorage can fail in private mode.
    }
    return true;
  });
  const [logsTab, setLogsTab] = useState<LogsTab>("logs");
  const [isLogsPanelCollapsed, setIsLogsPanelCollapsed] = useState(false);
  const [logsPanelHeight, setLogsPanelHeight] = useState(DEFAULT_LOGS_PANEL_HEIGHT);
  const [visualRunOrder, setVisualRunOrder] = useState<string[]>([]);
  const [visualRunActiveIndex, setVisualRunActiveIndex] = useState<number | null>(null);
  const [liveNodeStatuses, setLiveNodeStatuses] = useState<Record<string, NonNullable<EditorNodeData["executionStatus"]>>>({});

  const flowWrapperRef = useRef<HTMLDivElement>(null);
  const chatHistoryRef = useRef<HTMLDivElement>(null);
  const chatDeltaBufferRef = useRef("");
  const chatDeltaIntervalRef = useRef<number | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const logsResizeAbortRef = useRef<AbortController | null>(null);
  const latestDebugExecutionIdRef = useRef<string | null>(null);
  const latestExecutionResultRef = useRef<WorkflowExecutionResult | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const pasteCountRef = useRef(0);
  const didAttemptInitialWipRef = useRef(false);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const nodeTypes = useMemo(
    () => ({
      workflowNode: WorkflowCanvasNode,
      stickyNote: StickyNoteNode
    }),
    []
  );
  const edgeTypes = useMemo<EdgeTypes>(
    () => ({
      workflowBezier: WorkflowCanvasEdge
    }),
    []
  );

  const editingNode = useMemo(
    () => nodes.find((node) => node.id === editingNodeId) ?? null,
    [editingNodeId, nodes]
  );

  const editingNodeInputOptions = useMemo<NodeInputOption[]>(() => {
    if (!editingNode) {
      return [];
    }

    return edges
      .filter((edge) => edge.target === editingNode.id)
      .map((edge) => {
        const sourceNode = nodes.find((node) => node.id === edge.source);
        return {
          id: edge.source,
          label: sourceNode ? `${sourceNode.data.label} (${sourceNode.id})` : edge.source
        };
      });
  }, [editingNode, edges, nodes]);

  const promptNodeSources = useMemo(
    () => ({
      userPromptFromNodes: nodes.some(
        (node) =>
          (node.data.nodeType === "text_input" || node.data.nodeType === "user_prompt") &&
          hasConfiguredNodeText(node as EditorNode)
      ),
      systemPromptFromNodes: nodes.some(
        (node) => node.data.nodeType === "system_prompt" && hasConfiguredNodeText(node as EditorNode)
      )
    }),
    [nodes]
  );

  const groupedDefinitions = useMemo(() => {
    const grouped = new Map<string, DefinitionNode[]>();
    for (const definition of definitions) {
      const list = grouped.get(definition.category) ?? [];
      list.push(definition);
      grouped.set(definition.category, list);
    }
    return grouped;
  }, [definitions]);
  const currentChatMessages = chatMessagesByWorkflow[currentWorkflow.id] ?? [];
  const currentChatSessionId = chatSessionsByWorkflow[currentWorkflow.id] ?? "";

  const executionStatuses = useMemo(() => {
    if (!isDebugMode) {
      return new Map<string, string>();
    }

    const combined = getNodeStatusMap(executionResult);
    for (const [nodeId, status] of Object.entries(liveNodeStatuses)) {
      if (!combined.has(nodeId)) {
        combined.set(nodeId, status);
      }
    }
    return combined;
  }, [executionResult, isDebugMode, liveNodeStatuses]);
  const executionPreviewByNodeId = useMemo(() => {
    const map = new Map<string, NonNullable<EditorNodeData["executionPreview"]>>();
    if (!isDebugMode || !executionResult) {
      return map;
    }
    for (const nodeResult of executionResult.nodeResults) {
      map.set(nodeResult.nodeId, {
        input: nodeResult.input !== undefined ? truncatePreview(summarizePreviewValue(nodeResult.input)) : undefined,
        output: nodeResult.output !== undefined ? truncatePreview(summarizePreviewValue(nodeResult.output)) : undefined,
        error: nodeResult.error ? truncatePreview(nodeResult.error) : undefined
      });
    }
    return map;
  }, [executionResult, isDebugMode]);
  const pinnedNodeIds = useMemo(
    () => new Set(Object.keys(asRecord(currentWorkflow.pinnedData) ?? {})),
    [currentWorkflow.pinnedData]
  );
  const currentWorkflowExists = workflowList.some((item) => item.id === currentWorkflow.id);
  const canManageWorkflows = authUser?.role === "admin" || authUser?.role === "builder";
  const canManageSecrets = authUser?.role === "admin" || authUser?.role === "builder";

  useEffect(() => {
    setWorkflowVariableRows(workflowVariablesToRows(currentWorkflow.variables));
  }, [currentWorkflow.id, currentWorkflow.variables]);

  const filteredWorkflowItems = useMemo(() => {
    const query = dashboardFilter.trim().toLowerCase();
    return workflowList.filter((workflow) => {
      if (query) {
        const matchesName = workflow.name.toLowerCase().includes(query);
        const matchesId = workflow.id.toLowerCase().includes(query);
        const matchesTag = (workflow.tags ?? []).some((tag) => tag.toLowerCase().includes(query));
        if (!matchesName && !matchesId && !matchesTag) return false;
      }
      if (activeFolderFilter === null) {
        if (workflow.folderId) return false;
      } else if (typeof activeFolderFilter === "string") {
        if (workflow.folderId !== activeFolderFilter) return false;
      }
      if (activeTagFilter) {
        if (!(workflow.tags ?? []).some((tag) => tag.toLowerCase() === activeTagFilter.toLowerCase())) return false;
      }
      return true;
    });
  }, [activeFolderFilter, activeTagFilter, dashboardFilter, workflowList]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const w of workflowList) {
      for (const tag of w.tags ?? []) {
        if (tag && tag.trim()) set.add(tag.trim());
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [workflowList]);

  const projectById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const activeProject = projectById.get(activeProjectId) ?? null;
  const canvasAndLogsStyle = useMemo(
    () => ({
      gridTemplateRows: !isDebugMode
        ? "minmax(280px, 1fr)"
        : isLogsPanelCollapsed
          ? "minmax(280px, 1fr) 0px 46px"
          : `minmax(280px, 1fr) 8px ${logsPanelHeight}px`
    }),
    [isDebugMode, isLogsPanelCollapsed, logsPanelHeight]
  );

  const startVisualRun = useCallback(() => {
    const order = computeExecutionOrderForVisual(nodes as EditorNode[], edges as Edge[]);
    if (!order.length) {
      setVisualRunOrder([]);
      setVisualRunActiveIndex(null);
      return;
    }
    setVisualRunOrder(order);
    setVisualRunActiveIndex(0);
  }, [edges, nodes]);

  const stopVisualRun = useCallback(() => {
    setVisualRunOrder([]);
    setVisualRunActiveIndex(null);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DEBUG_MODE_STORAGE_KEY, isDebugMode ? "1" : "0");
    } catch {
      // localStorage may fail in private mode.
    }
  }, [isDebugMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Undo/redo history stack. Snapshot is (nodes, edges) pairs. We push on
  // meaningful mutations (add/delete/duplicate/paste/config-update) via
  // pushHistorySnapshot() from callsites; positional drag changes are NOT
  // pushed on every frame (too noisy) — they're pushed once per drag end.
  const historyStackRef = useRef<Array<{ nodes: EditorNode[]; edges: Edge[] }>>([]);
  const redoStackRef = useRef<Array<{ nodes: EditorNode[]; edges: Edge[] }>>([]);
  const suppressHistoryRef = useRef(false);

  const pushHistorySnapshot = useCallback(() => {
    if (suppressHistoryRef.current) return;
    historyStackRef.current.push({
      nodes: cloneJson(nodes as EditorNode[]),
      edges: cloneJson(edges as Edge[])
    });
    if (historyStackRef.current.length > HISTORY_STACK_LIMIT) {
      historyStackRef.current.shift();
    }
    redoStackRef.current = [];
  }, [edges, nodes]);

  const undo = useCallback(() => {
    const prev = historyStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push({
      nodes: cloneJson(nodes as EditorNode[]),
      edges: cloneJson(edges as Edge[])
    });
    suppressHistoryRef.current = true;
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setTimeout(() => {
      suppressHistoryRef.current = false;
    }, 0);
  }, [edges, nodes, setEdges, setNodes]);

  const redo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    historyStackRef.current.push({
      nodes: cloneJson(nodes as EditorNode[]),
      edges: cloneJson(edges as Edge[])
    });
    suppressHistoryRef.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    setTimeout(() => {
      suppressHistoryRef.current = false;
    }, 0);
  }, [edges, nodes, setEdges, setNodes]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (activeMode !== "editor") return;
      if (isTypingTarget(event.target)) return;

      const isModifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      // Undo / Redo
      if (isModifier && key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if ((isModifier && key === "z" && event.shiftKey) || (isModifier && key === "y")) {
        event.preventDefault();
        redo();
        return;
      }

      // Duplicate selected nodes (Ctrl+D / Cmd+D)
      if (isModifier && key === "d") {
        const selected = nodes.filter((node) => node.selected);
        if (selected.length === 0) return;
        event.preventDefault();
        pushHistorySnapshot();
        const idMap = new Map<string, string>();
        const duplicates: Node<EditorNodeData>[] = selected.map((node) => {
          const newId = createNodeId(node.data.nodeType);
          idMap.set(node.id, newId);
          return {
            ...node,
            id: newId,
            selected: true,
            position: { x: node.position.x + 40, y: node.position.y + 40 },
            data: {
              label: node.data.label,
              nodeType: node.data.nodeType,
              config: cloneJson(node.data.config ?? {}),
              disabled: node.data.disabled,
              color: node.data.color
            }
          };
        });
        const selectedIds = new Set(selected.map((n) => n.id));
        const duplicateEdges: Edge[] = edges
          .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
          .map((edge) => {
            const source = idMap.get(edge.source);
            const target = idMap.get(edge.target);
            if (!source || !target) return null;
            const candidate: Edge = {
              id: createEdgeId(source, target),
              source,
              target,
              sourceHandle: edge.sourceHandle ?? undefined,
              targetHandle: edge.targetHandle ?? undefined,
              label: typeof edge.label === "string" ? edge.label : undefined
            };
            return decorateEdge(candidate, [...(nodes as EditorNode[]), ...(duplicates as EditorNode[])]);
          })
          .filter((edge): edge is Edge => Boolean(edge));
        setNodes((current) => [
          ...current.map((node) => ({ ...node, selected: false })),
          ...duplicates
        ]);
        setEdges((current) => [
          ...current.map((edge) => ({ ...edge, selected: false })),
          ...duplicateEdges
        ]);
        return;
      }

      // Toggle disable on selected nodes (D without modifier)
      if (!isModifier && !event.shiftKey && !event.altKey && key === "e") {
        const selected = nodes.filter((node) => node.selected);
        if (selected.length === 0) return;
        event.preventDefault();
        pushHistorySnapshot();
        const targetDisabled = !selected.every((n) => n.data.disabled);
        setNodes((current) =>
          current.map((node) =>
            node.selected ? { ...node, data: { ...node.data, disabled: targetDisabled } } : node
          )
        );
        return;
      }

      // Open shortcuts panel with "?" or Ctrl+/
      if ((key === "?" && event.shiftKey) || (isModifier && key === "/")) {
        event.preventDefault();
        setShowShortcutsPanel(true);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeMode, edges, nodes, pushHistorySnapshot, redo, setEdges, setNodes, undo]);

  useEffect(() => {
    latestDebugExecutionIdRef.current = null;
    setRunningExecutionId(null);
    pasteCountRef.current = 0;
  }, [currentWorkflow.id]);

  useEffect(() => {
    latestExecutionResultRef.current = executionResult;
  }, [executionResult]);

  useEffect(() => {
    if (isDebugMode) {
      return;
    }
    setExecutionResult(null);
    setLiveNodeStatuses({});
    setChatNodeTrace([]);
    setRunningExecutionId(null);
    stopVisualRun();
  }, [isDebugMode, stopVisualRun]);

  useEffect(() => {
    if (activeMode !== "editor" || !isDebugMode || !authUser || !currentWorkflowExists) {
      return;
    }

    let cancelled = false;
    const syncLatestExecution = async () => {
      if (busy) {
        return;
      }

      try {
        const history = await fetchExecutions({
          page: 1,
          pageSize: 1,
          workflowId: currentWorkflow.id
        });
        if (cancelled) {
          return;
        }

        const latest = history.items[0];
        if (!latest) {
          return;
        }

        const isInProgressExecutionStatus = (status: unknown) =>
          status === "running" || status === "partial" || status === "waiting_approval";

        const sameExecution = latestDebugExecutionIdRef.current === latest.id;
        const isInProgressStatus = isInProgressExecutionStatus(latest.status);
        const latestResult = latestExecutionResultRef.current;
        const currentTrackedStatus =
          latestResult?.executionId === latest.id ? latestResult.status : null;
        const shouldRefreshSameExecution =
          isInProgressStatus || isInProgressExecutionStatus(currentTrackedStatus);
        if (sameExecution && !shouldRefreshSameExecution) {
          return;
        }

        if (!sameExecution && !isInProgressStatus) {
          latestDebugExecutionIdRef.current = latest.id;
          return;
        }

        // New external execution detected (e.g., REST client / webhook call).
        // Reset previous debug trace immediately before loading full details.
        if (!sameExecution) {
          setExecutionResult(
            createPartialExecutionResult(
              latest.workflowId || currentWorkflow.id,
              typeof latest.startedAt === "string" && latest.startedAt ? latest.startedAt : new Date().toISOString()
            )
          );
          setLiveNodeStatuses({});
          setLogsTab("logs");
        }

        const detail = await fetchExecutionById(latest.id);
        if (cancelled) {
          return;
        }

        latestDebugExecutionIdRef.current = latest.id;
        setExecutionResult(toWorkflowExecutionResult(detail));
      } catch {
        // Polling failures should not interrupt editor usage.
      }
    };

    const firstPollTimerId = window.setTimeout(() => {
      void syncLatestExecution();
    }, 2000);
    const timerId = window.setInterval(() => {
      void syncLatestExecution();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearTimeout(firstPollTimerId);
      window.clearInterval(timerId);
    };
  }, [activeMode, authUser, busy, currentWorkflow.id, currentWorkflowExists, isDebugMode]);

  useEffect(() => {
    setNodes((currentNodes) => {
      let changed = false;
      const nextNodes = currentNodes.map((node) => {
        const executionStatus = executionStatuses.get(node.id) as EditorNodeData["executionStatus"];
        const executionPreview = executionPreviewByNodeId.get(node.id);
        const pinned = pinnedNodeIds.has(node.id);
        if (
          node.data.executionStatus === executionStatus &&
          node.data.executionPreview === executionPreview &&
          node.data.pinned === pinned
        ) {
          return node;
        }
        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            executionStatus,
            executionPreview,
            pinned
          }
        };
      });
      return changed ? nextNodes : currentNodes;
    });
  }, [executionPreviewByNodeId, executionStatuses, pinnedNodeIds, setNodes]);

  useEffect(() => {
    setEdges((currentEdges) => currentEdges.map((edge) => decorateEdge(edge, nodes as EditorNode[])));
  }, [nodes, setEdges]);

  useEffect(() => {
    if (visualRunActiveIndex === null || visualRunOrder.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setVisualRunActiveIndex((current) => {
        if (current === null) {
          return current;
        }
        return Math.min(current + 1, visualRunOrder.length - 1);
      });
    }, 850);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [visualRunActiveIndex, visualRunOrder.length]);

  useEffect(() => {
    if (!editingNodeId) {
      return;
    }

    const stillExists = nodes.some((node) => node.id === editingNodeId);
    if (!stillExists) {
      setEditingNodeId(null);
    }
  }, [editingNodeId, nodes]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeMode !== "editor") {
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      const selectedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
      const selectedEdgeIds = new Set(edges.filter((edge) => edge.selected).map((edge) => edge.id));
      if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) {
        return;
      }

      event.preventDefault();
      pushHistorySnapshot();
      setNodes((currentNodes) => currentNodes.filter((node) => !selectedNodeIds.has(node.id)));
      setEdges((currentEdges) =>
        currentEdges.filter(
          (edge) =>
            !selectedEdgeIds.has(edge.id) && !selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target)
        )
      );

      if (editingNodeId && selectedNodeIds.has(editingNodeId)) {
        setEditingNodeId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeMode, editingNodeId, edges, nodes, pushHistorySnapshot, setEdges, setNodes]);

  useEffect(() => {
    const handleCopyPaste = (event: KeyboardEvent) => {
      if (activeMode !== "editor") {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const isModifierPressed = event.ctrlKey || event.metaKey;
      if (!isModifierPressed || (key !== "c" && key !== "v")) {
        return;
      }

      if (key === "c") {
        const selectedNodes = nodes.filter((node) => node.selected);
        if (selectedNodes.length === 0) {
          return;
        }

        event.preventDefault();
        const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
        const minX = Math.min(...selectedNodes.map((node) => node.position.x));
        const minY = Math.min(...selectedNodes.map((node) => node.position.y));

        const payload: NodeClipboardPayload = {
          version: 1,
          copiedAt: new Date().toISOString(),
          nodes: selectedNodes.map((node) => ({
            sourceId: node.id,
            nodeType: node.data.nodeType,
            label: node.data.label,
            config: cloneJson(node.data.config ?? {}),
            relativePosition: {
              x: node.position.x - minX,
              y: node.position.y - minY
            },
            disabled: node.data.disabled,
            color: node.data.color
          })),
          edges: edges
            .filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target))
            .map((edge) => ({
              sourceId: edge.source,
              targetId: edge.target,
              sourceHandle: edge.sourceHandle ?? undefined,
              targetHandle: edge.targetHandle ?? undefined,
              label: typeof edge.label === "string" ? edge.label : undefined
            }))
        };

        try {
          localStorage.setItem(NODE_CLIPBOARD_STORAGE_KEY, JSON.stringify(payload));
          setError(null);
        } catch {
          setError("Failed to copy node selection.");
        }
        return;
      }

      if (key === "v") {
        let raw: string | null = null;
        try {
          raw = localStorage.getItem(NODE_CLIPBOARD_STORAGE_KEY);
        } catch {
          raw = null;
        }
        if (!raw) {
          return;
        }

        let payload: NodeClipboardPayload | null = null;
        try {
          payload = JSON.parse(raw) as NodeClipboardPayload;
        } catch {
          payload = null;
        }
        if (!payload || payload.version !== 1 || !Array.isArray(payload.nodes) || payload.nodes.length === 0) {
          return;
        }

        event.preventDefault();
        pushHistorySnapshot();

        const bounds = flowWrapperRef.current?.getBoundingClientRect();
        const canvasCenter = reactFlowInstance
          ? reactFlowInstance.project({
              x: bounds ? bounds.width / 2 : window.innerWidth / 2,
              y: bounds ? bounds.height / 2 : window.innerHeight / 2
            })
          : { x: 180, y: 160 };
        const offset = pasteCountRef.current * NODE_PASTE_OFFSET_PX;
        pasteCountRef.current += 1;

        const idMap = new Map<string, string>();
        const newNodes: Node<EditorNodeData>[] = payload.nodes.map((entry) => {
          const newId = createNodeId(entry.nodeType);
          idMap.set(entry.sourceId, newId);
          return {
            id: newId,
            type: entry.nodeType === "sticky_note" ? "stickyNote" : "workflowNode",
            position: {
              x: canvasCenter.x + entry.relativePosition.x + offset,
              y: canvasCenter.y + entry.relativePosition.y + offset
            },
            selected: true,
            data: {
              label: entry.label,
              nodeType: entry.nodeType,
              config: cloneJson(entry.config ?? {}),
              disabled: entry.disabled,
              color: entry.color
            }
          };
        });

        const newEdges: Edge[] = payload.edges
          .map((entry) => {
            const source = idMap.get(entry.sourceId);
            const target = idMap.get(entry.targetId);
            if (!source || !target) {
              return null;
            }
            const candidate: Edge = {
              id: createEdgeId(source, target),
              source,
              target,
              sourceHandle: entry.sourceHandle,
              targetHandle: entry.targetHandle,
              label: entry.label
            };
            return decorateEdge(candidate, [...(nodes as EditorNode[]), ...(newNodes as EditorNode[])]);
          })
          .filter((edge): edge is Edge => Boolean(edge));

        setNodes((current) => [
          ...current.map((node) => ({ ...node, selected: false })),
          ...newNodes
        ]);
        setEdges((current) => [
          ...current.map((edge) => ({ ...edge, selected: false })),
          ...newEdges
        ]);
        setError(null);
      }
    };

    window.addEventListener("keydown", handleCopyPaste);
    return () => {
      window.removeEventListener("keydown", handleCopyPaste);
    };
  }, [activeMode, edges, nodes, pushHistorySnapshot, reactFlowInstance, setEdges, setNodes]);

  const handleDeleteEdgeById = useCallback(
    (edgeId: string) => {
      setEdges((currentEdges) => currentEdges.filter((edge) => edge.id !== edgeId));
      setError(null);
    },
    [setEdges]
  );

  const refreshSecrets = useCallback(async () => {
    if (!canManageSecrets) {
      setSecrets([]);
      return [];
    }
    const items = await fetchSecrets({ projectId: activeProjectId });
    setSecrets(items);
    return items;
  }, [activeProjectId, canManageSecrets]);

  const refreshExecutionHistory = useCallback(async () => {
    try {
      setExecutionsLoading(true);
      setExecutionsError(null);
      const payload = await fetchExecutions({
        page: 1,
        pageSize: 40,
        status: executionHistoryFilters.status || undefined,
        workflowId: executionHistoryFilters.workflowId || undefined,
        startedFrom: dateTimeLocalToIso(executionHistoryFilters.startedFrom),
        startedTo: dateTimeLocalToIso(executionHistoryFilters.startedTo)
      });
      setExecutionHistoryItems(payload.items);
      setExecutionHistoryTotal(payload.total);
    } catch (historyError) {
      if (historyError instanceof ApiError && historyError.status === 401) {
        setAuthUser(null);
        setAuthError("Session expired. Sign in again.");
      } else {
        setExecutionsError(historyError instanceof Error ? historyError.message : "Failed to load executions");
      }
    } finally {
      setExecutionsLoading(false);
    }
  }, [executionHistoryFilters]);

  const toggleExecutionRow = useCallback(async (executionId: string) => {
    const isExpanded = expandedExecutionIds.includes(executionId);
    setExpandedExecutionIds((current) =>
      current.includes(executionId) ? current.filter((value) => value !== executionId) : [...current, executionId]
    );

    if (isExpanded || executionDetailById[executionId]) {
      return;
    }

    try {
      const detail = await fetchExecutionById(executionId);
      setExecutionDetailById((current) => ({
        ...current,
        [executionId]: detail
      }));
    } catch (detailError) {
      setExecutionsError(detailError instanceof Error ? detailError.message : "Failed to load execution detail");
    }
  }, [executionDetailById, expandedExecutionIds]);

  const readWipWorkflow = useCallback((workflowId: string): Workflow | null => {
    const sessionWip = readTabWipWorkflow(workflowId, MAX_LOCAL_WIP_CHARS);
    if (sessionWip) {
      return sessionWip;
    }

    const legacyWip = readLegacyLocalWipWorkflow(MAX_LOCAL_WIP_CHARS);
    return legacyWip?.id === workflowId ? legacyWip : null;
  }, []);

  const hydrateWorkflow = useCallback(
    (workflow: Workflow) => {
      const editor = workflowToEditor(workflow);
      const decoratedEdges = editor.edges.map((edge) => decorateEdge(edge, editor.nodes as EditorNode[]));

      setCurrentWorkflow(workflow);
      setNodes(editor.nodes as EditorNode[]);
      setEdges(decoratedEdges);
      setExecutionResult(null);
      setVisualRunOrder([]);
      setVisualRunActiveIndex(null);
      setEditingNodeId(null);
    },
    [setEdges, setNodes]
  );

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [workflowItems, projectPayload, folderPayload] = await Promise.all([
        fetchWorkflows({ projectId: activeProjectId }),
        fetchProjects().catch(() => ({ projects: [] })),
        fetchFolders(activeProjectId).catch(() => ({ folders: [] }))
      ]);

      setWorkflowList(workflowItems);
      setProjects(projectPayload.projects ?? []);
      setFolders(folderPayload.folders ?? []);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        setAuthUser(null);
        setAuthError("Session expired. Sign in again.");
      } else {
        setError(loadError instanceof Error ? loadError.message : "Failed to load app data");
      }
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, setWorkflowList]);

  // Persist the active project id so switching survives a refresh without leaking across tabs.
  useEffect(() => {
    rememberTabProjectId(activeProjectId);
  }, [activeProjectId]);

  useEffect(() => {
    if (!currentWorkflowExists) {
      return;
    }
    rememberTabWorkflowId(currentWorkflow.id);
  }, [currentWorkflow.id, currentWorkflowExists]);

  useEffect(() => {
    if (!authUser) {
      return;
    }

    const existingUrlState = readStudioUrlState();
    replaceStudioUrlState({
      workflowId: currentWorkflowExists ? currentWorkflow.id : existingUrlState.workflowId,
      projectId: activeProjectId,
      mode: activeMode
    });
  }, [activeMode, activeProjectId, authUser, currentWorkflow.id, currentWorkflowExists]);

  // Reset folder/tag selection when switching project.
  useEffect(() => {
    setActiveFolderFilter(undefined);
    setActiveTagFilter(null);
    didAttemptInitialWipRef.current = false;
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    const checkSession = async () => {
      try {
        const { user } = await fetchAuthMe();
        if (!cancelled) {
          setAuthUser(user);
          setAuthError(null);
        }
      } catch (sessionError) {
        if (!cancelled) {
          if (sessionError instanceof ApiError && sessionError.status === 401) {
            setAuthUser(null);
          } else {
            setAuthError(sessionError instanceof Error ? sessionError.message : "Unable to verify session");
          }
        }
      } finally {
        if (!cancelled) {
          setAuthChecking(false);
        }
      }
    };

    void checkSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authUser) {
      return;
    }
    void loadData();
  }, [authUser, loadData]);

  useEffect(() => {
    if (!authUser || activeMode !== "editor") {
      return;
    }

    let cancelled = false;
    const loadDefinitions = async () => {
      try {
        const definitionPayload = await fetchDefinitions();
        if (cancelled) {
          return;
        }
        setDefinitions(definitionPayload.nodes);
        setMcpServerDefinitions(definitionPayload.mcpServers);
      } catch (definitionError) {
        if (cancelled) {
          return;
        }
        if (definitionError instanceof ApiError && definitionError.status === 401) {
          setAuthUser(null);
          setAuthError("Session expired. Sign in again.");
        }
      }
    };

    void loadDefinitions();
    return () => {
      cancelled = true;
    };
  }, [activeMode, authUser]);

  useEffect(() => {
    if (!authUser || !canManageSecrets) {
      setSecrets([]);
      return;
    }
    if (activeMode !== "editor" && activeMode !== "secrets") {
      return;
    }

    let cancelled = false;
    const loadSecrets = async () => {
      try {
        const items = await fetchSecrets({ projectId: activeProjectId });
        if (!cancelled) {
          setSecrets(items);
        }
      } catch (secretError) {
        if (cancelled) {
          return;
        }
        if (secretError instanceof ApiError && secretError.status === 401) {
          setAuthUser(null);
          setAuthError("Session expired. Sign in again.");
        }
      }
    };

    void loadSecrets();
    return () => {
      cancelled = true;
    };
  }, [activeMode, activeProjectId, authUser, canManageSecrets]);

  useEffect(() => {
    if (activeMode === "secrets" && !canManageSecrets) {
      setActiveMode("editor");
    }
  }, [activeMode, canManageSecrets]);

  useEffect(() => {
    if (activeMode !== "executions" || !authUser) {
      return;
    }
    void refreshExecutionHistory();
  }, [activeMode, authUser, refreshExecutionHistory]);

  useEffect(() => {
    setChatSessionsByWorkflow((current) => {
      if (current[currentWorkflow.id]) {
        return current;
      }
      return {
        ...current,
        [currentWorkflow.id]: createChatSessionId(currentWorkflow.id)
      };
    });
  }, [currentWorkflow.id]);

  useEffect(() => {
    if (!chatHistoryRef.current) {
      return;
    }
    chatHistoryRef.current.scrollTo({
      top: chatHistoryRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [currentChatMessages]);

  useEffect(() => {
    return () => {
      if (chatDeltaIntervalRef.current !== null) {
        window.clearInterval(chatDeltaIntervalRef.current);
        chatDeltaIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (loading || !authUser) {
      return;
    }

    try {
      const snapshot = editorToWorkflow(currentWorkflow, nodes as EditorNode[], edges as Edge[]);
      storeLocalWipWorkflow(snapshot);
    } catch {
      // localStorage may fail in private mode or quota edge cases.
    }
  }, [authUser, currentWorkflow, edges, loading, nodes]);

  const handleApiError = useCallback((apiError: unknown, fallbackMessage: string): string => {
    if (apiError instanceof ApiError && apiError.status === 401) {
      setAuthUser(null);
      setAuthError("Session expired. Sign in again.");
      return "Session expired. Sign in again.";
    }

    let message = apiError instanceof Error ? apiError.message : fallbackMessage;
    if (apiError instanceof ApiError) {
      const validationMessages = getValidationMessages(apiError.payload);
      if (validationMessages.length) {
        message = `${message}: ${validationMessages.join("; ")}`;
      }
    }

    setError(message);
    return message;
  }, []);

  const handleDebugExecution = useCallback(
    async (executionId: string) => {
      try {
        setBusy(true);
        setError(null);
        const detail = await fetchExecutionById(executionId);
        const workflow = await fetchWorkflow(detail.workflowId);
        hydrateWorkflow(workflow);
        setExecutionResult(toWorkflowExecutionResult(detail));
        latestDebugExecutionIdRef.current = detail.id;
        setIsDebugMode(true);
        setLogsTab("logs");
        setActiveMode("editor");
      } catch (debugError) {
        handleApiError(debugError, "Failed to load execution into editor");
      } finally {
        setBusy(false);
      }
    },
    [handleApiError, hydrateWorkflow]
  );

  const handleRerunExecution = useCallback(
    async (executionId: string) => {
      let targetWorkflowId = currentWorkflow.id;
      try {
        setBusy(true);
        setError(null);
        const detail = await fetchExecutionById(executionId);
        targetWorkflowId = detail.workflowId;
        const workflow = await fetchWorkflow(detail.workflowId);
        hydrateWorkflow(workflow);
        setIsDebugMode(true);
        setLogsTab("logs");
        setActiveMode("editor");
        const result = await retryExecution(detail.id);
        setExecutionResult(result);
        if (result.executionId) {
          latestDebugExecutionIdRef.current = result.executionId;
        }
        void refreshExecutionHistory();
      } catch (rerunError) {
        const message = handleApiError(rerunError, "Failed to re-run execution");
        setExecutionResult(buildExecutionErrorResult(targetWorkflowId, message));
      } finally {
        setBusy(false);
      }
    },
    [currentWorkflow.id, handleApiError, hydrateWorkflow, refreshExecutionHistory]
  );

  const handleCancelExecution = useCallback(
    async (executionId: string) => {
      try {
        setExecutionsError(null);
        await cancelExecution(executionId);
        setExecutionDetailById((current) => {
          const existing = current[executionId];
          if (!existing) return current;
          return {
            ...current,
            [executionId]: {
              ...existing,
              status: "canceled",
              completedAt: new Date().toISOString(),
              error: existing.error ?? "Execution canceled"
            }
          };
        });
        await refreshExecutionHistory();
      } catch (cancelError) {
        setExecutionsError(cancelError instanceof Error ? cancelError.message : "Failed to cancel execution");
      }
    },
    [refreshExecutionHistory, setExecutionDetailById]
  );

  const handleStreamExecutionStarted = useCallback((event: StreamExecutionStartedEvent) => {
    if (!event.executionId) {
      return;
    }
    latestDebugExecutionIdRef.current = event.executionId;
    setRunningExecutionId(event.executionId);
    setExecutionResult((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        executionId: current.executionId ?? event.executionId
      };
    });
  }, []);

  const handleCancelActiveRun = useCallback(async () => {
    const executionId = runningExecutionId ?? latestDebugExecutionIdRef.current;
    if (!executionId) {
      setError("No active execution is registered yet.");
      return;
    }
    try {
      await cancelExecution(executionId);
      setError((current) => current ?? "Cancellation requested. Waiting for workflow to stop.");
      void refreshExecutionHistory();
    } catch (cancelError) {
      handleApiError(cancelError, "Failed to stop active workflow");
    }
  }, [handleApiError, refreshExecutionHistory, runningExecutionId]);

  useEffect(() => {
    let cancelled = false;
    if (activeMode !== "variables" || !authUser || !currentWorkflowExists) {
      return () => {
        cancelled = true;
      };
    }

    const loadWorkflowVariables = async () => {
      try {
        const response = await fetchWorkflowVariables(currentWorkflow.id);
        if (cancelled) {
          return;
        }

        setCurrentWorkflow((current) =>
          current.id === response.workflowId
            ? {
                ...current,
                variables: response.variables
              }
            : current
        );
        setWorkflowVariableRows(workflowVariablesToRows(response.variables));
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        handleApiError(loadError, "Failed to load workflow variables");
      }
    };

    void loadWorkflowVariables();
    return () => {
      cancelled = true;
    };
  }, [activeMode, authUser, currentWorkflow.id, currentWorkflowExists, handleApiError]);

  const appendChatMessage = useCallback(
    (workflowId: string, message: ChatMessageEntry) => {
      setChatMessagesByWorkflow((current) => ({
        ...current,
        [workflowId]: [...(current[workflowId] ?? []), message]
      }));
    },
    []
  );

  const updateChatMessageText = useCallback((workflowId: string, messageId: string, deltaText: string, status?: ChatMessageEntry["status"]) => {
    setChatMessagesByWorkflow((current) => {
      const nextMessages = (current[workflowId] ?? []).map((entry) =>
        entry.id === messageId
          ? {
              ...entry,
              text: `${entry.text}${deltaText}`,
              status: status ?? entry.status
            }
          : entry
      );
      return {
        ...current,
        [workflowId]: nextMessages
      };
    });
  }, []);

  const setChatMessageText = useCallback((workflowId: string, messageId: string, text: string, status?: ChatMessageEntry["status"]) => {
    setChatMessagesByWorkflow((current) => {
      const nextMessages = (current[workflowId] ?? []).map((entry) =>
        entry.id === messageId
          ? {
              ...entry,
              text,
              status: status ?? entry.status
            }
          : entry
      );
      return {
        ...current,
        [workflowId]: nextMessages
      };
    });
  }, []);

  const setChatMessageStatus = useCallback((workflowId: string, messageId: string, status: ChatMessageEntry["status"]) => {
    setChatMessagesByWorkflow((current) => {
      const nextMessages = (current[workflowId] ?? []).map((entry) =>
        entry.id === messageId
          ? {
              ...entry,
              status
            }
          : entry
      );
      return {
        ...current,
        [workflowId]: nextMessages
      };
    });
  }, []);

  const stopChatDeltaFlusher = useCallback(() => {
    if (chatDeltaIntervalRef.current !== null) {
      window.clearInterval(chatDeltaIntervalRef.current);
      chatDeltaIntervalRef.current = null;
    }
  }, []);

  const startChatDeltaFlusher = useCallback(
    (workflowId: string) => {
      if (chatDeltaIntervalRef.current !== null) {
        return;
      }

      chatDeltaIntervalRef.current = window.setInterval(() => {
        const targetMessageId = activeAssistantMessageIdRef.current;
        if (!targetMessageId) {
          return;
        }

        if (!chatDeltaBufferRef.current.length) {
          return;
        }

        const nextChunk = chatDeltaBufferRef.current.slice(0, 5);
        chatDeltaBufferRef.current = chatDeltaBufferRef.current.slice(nextChunk.length);
        updateChatMessageText(workflowId, targetMessageId, nextChunk);

        if (!chatDeltaBufferRef.current.length && !chatBusy) {
          stopChatDeltaFlusher();
        }
      }, 18);
    },
    [chatBusy, stopChatDeltaFlusher, updateChatMessageText]
  );

  const loadWorkflowById = useCallback(
    async (id: string) => {
      try {
        const localWip = readWipWorkflow(id);
        if (localWip) {
          hydrateWorkflow(localWip);
          return;
        }

        const workflow = await fetchWorkflow(id);
        hydrateWorkflow(workflow);
      } catch (loadError) {
        handleApiError(loadError, "Failed to load workflow");
      }
    },
    [handleApiError, hydrateWorkflow, readWipWorkflow]
  );

  useEffect(() => {
    if (!authUser || loading) {
      return;
    }

    const modeNeedsWorkflow =
      activeMode === "editor" || activeMode === "variables" || activeMode === "chat" || activeMode === "evaluations";
    if (!modeNeedsWorkflow) {
      return;
    }

    if (workflowList.length === 0) {
      return;
    }

    const currentExists = workflowList.some((item) => item.id === currentWorkflow.id);
    if (currentExists) {
      return;
    }

    if (!didAttemptInitialWipRef.current) {
      didAttemptInitialWipRef.current = true;
      const urlState = readStudioUrlState();
      const preferredWorkflowId =
        urlState.workflowId && workflowList.some((item) => item.id === urlState.workflowId)
          ? urlState.workflowId
          : readRememberedTabWorkflowId();
      const wipWorkflow = preferredWorkflowId ? readWipWorkflow(preferredWorkflowId) : null;
      const wipMatchesProject = !wipWorkflow?.projectId || wipWorkflow.projectId === activeProjectId;
      if (wipWorkflow && wipMatchesProject && workflowList.some((item) => item.id === wipWorkflow.id)) {
        hydrateWorkflow(wipWorkflow);
        return;
      }
    }

    const urlState = readStudioUrlState();
    const rememberedId = readRememberedTabWorkflowId();
    const chosenWorkflowId =
      urlState.workflowId && workflowList.some((item) => item.id === urlState.workflowId)
        ? urlState.workflowId
        : rememberedId && workflowList.some((item) => item.id === rememberedId)
          ? rememberedId
          : workflowList[0]!.id;
    void loadWorkflowById(chosenWorkflowId);
  }, [activeMode, activeProjectId, authUser, currentWorkflow.id, hydrateWorkflow, loadWorkflowById, loading, readWipWorkflow, workflowList]);

  const buildCurrentWorkflow = useCallback(() => {
    return editorToWorkflow(currentWorkflow, nodes as EditorNode[], edges as Edge[]);
  }, [currentWorkflow, edges, nodes]);

  const persistWorkflow = useCallback(async () => {
    const workflow = buildCurrentWorkflow();
    const saved = await saveWorkflow(workflow);
    const workflows = await fetchWorkflows({ projectId: activeProjectId });
    setWorkflowList(workflows);
    setCurrentWorkflow(saved);
    storeLocalWipWorkflow(saved);
    return saved;
  }, [buildCurrentWorkflow]);

  const handleSave = useCallback(async () => {
    try {
      setBusy(true);
      setError(null);
      await persistWorkflow();
    } catch (saveError) {
      handleApiError(saveError, "Failed to save workflow");
    } finally {
      setBusy(false);
    }
  }, [handleApiError, persistWorkflow]);

  const handleAddVariableRow = useCallback(() => {
    setWorkflowVariableRows((current) => [
      ...current,
      {
        id: createVariableRowId(),
        key: "",
        value: ""
      }
    ]);
  }, []);

  const handleRemoveVariableRow = useCallback((rowId: string) => {
    setWorkflowVariableRows((current) => current.filter((row) => row.id !== rowId));
  }, []);

  const handleUpdateVariableRow = useCallback((rowId: string, field: "key" | "value", value: string) => {
    setWorkflowVariableRows((current) =>
      current.map((row) =>
        row.id === rowId
          ? {
              ...row,
              [field]: value
            }
          : row
      )
    );
  }, []);

  const handleSaveVariables = useCallback(async () => {
    if (!currentWorkflowExists) {
      setError("Save the workflow first before managing variables.");
      return;
    }
    if (!canManageWorkflows) {
      setError("You do not have permission to update workflow variables.");
      return;
    }

    try {
      setVariablesBusy(true);
      setError(null);
      const nextVariables = rowsToWorkflowVariables(workflowVariableRows);
      const response = await updateWorkflowVariables(currentWorkflow.id, nextVariables);

      setCurrentWorkflow((current) =>
        current.id === response.workflowId
          ? {
              ...current,
              variables: response.variables
            }
          : current
      );
      setWorkflowVariableRows(workflowVariablesToRows(response.variables));

      try {
        const snapshot = editorToWorkflow(
          {
            ...currentWorkflow,
            variables: response.variables
          },
          nodes as EditorNode[],
          edges as Edge[]
        );
        storeLocalWipWorkflow(snapshot);
      } catch {
        // localStorage can fail in private mode or due quota limits.
      }
    } catch (saveError) {
      handleApiError(saveError, "Failed to save workflow variables");
    } finally {
      setVariablesBusy(false);
    }
  }, [
    canManageWorkflows,
    currentWorkflow,
    currentWorkflow.id,
    currentWorkflowExists,
    edges,
    handleApiError,
    nodes,
    workflowVariableRows
  ]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      const isSaveShortcut = event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey);
      if (!isSaveShortcut) {
        return;
      }

      event.preventDefault();
      if (event.repeat || !authUser || loading || busy) {
        return;
      }

      void handleSave();
    };

    window.addEventListener("keydown", handleSaveShortcut);
    return () => {
      window.removeEventListener("keydown", handleSaveShortcut);
    };
  }, [authUser, busy, handleSave, loading]);

  useEffect(() => {
    const handleEscapeToCloseNodeConfig = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !editingNodeId) {
        return;
      }

      event.preventDefault();
      setEditingNodeId(null);
    };

    window.addEventListener("keydown", handleEscapeToCloseNodeConfig);
    return () => {
      window.removeEventListener("keydown", handleEscapeToCloseNodeConfig);
    };
  }, [editingNodeId]);

  const handleLogsResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isLogsPanelCollapsed) {
        return;
      }

      event.preventDefault();
      const startY = event.clientY;
      const startHeight = logsPanelHeight;
      logsResizeAbortRef.current?.abort();
      const controller = new AbortController();
      logsResizeAbortRef.current = controller;
      document.body.classList.add("resizing-logs");
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startY - moveEvent.clientY;
        const viewportBoundedMax = Math.max(
          MIN_LOGS_PANEL_HEIGHT,
          Math.min(MAX_LOGS_PANEL_HEIGHT, Math.floor(window.innerHeight * 0.75))
        );
        const nextHeight = Math.max(MIN_LOGS_PANEL_HEIGHT, Math.min(viewportBoundedMax, startHeight + delta));
        setLogsPanelHeight(nextHeight);
      };

      const handleMouseUp = () => {
        controller.abort();
        if (logsResizeAbortRef.current === controller) {
          logsResizeAbortRef.current = null;
        }
        document.body.classList.remove("resizing-logs");
      };

      window.addEventListener("mousemove", handleMouseMove, { signal: controller.signal });
      window.addEventListener("mouseup", handleMouseUp, { signal: controller.signal });
    },
    [isLogsPanelCollapsed, logsPanelHeight]
  );

  useEffect(() => {
    return () => {
      logsResizeAbortRef.current?.abort();
      logsResizeAbortRef.current = null;
      document.body.classList.remove("resizing-logs");
    };
  }, []);

  const buildEditorExecutionPayload = useCallback((startNodeId?: string, runMode: "workflow" | "single_node" = "workflow") => {
    const payload: {
      sessionId: string;
      startNodeId?: string;
      runMode?: "workflow" | "single_node";
      usePinnedData?: boolean;
      nodeOutputs?: Record<string, unknown>;
      system_prompt?: string;
      user_prompt?: string;
    } = {
      sessionId,
      usePinnedData: true
    };

    if (typeof startNodeId === "string" && startNodeId.trim()) {
      payload.startNodeId = startNodeId.trim();
    }

    if (runMode === "single_node") {
      payload.runMode = "single_node";
      payload.nodeOutputs = extractNodeOutputsFromExecution(executionResult);
    }

    if (!promptNodeSources.systemPromptFromNodes) {
      payload.system_prompt = systemPrompt;
    }

    if (!promptNodeSources.userPromptFromNodes) {
      payload.user_prompt = userPrompt;
    }

    return payload;
  }, [executionResult, promptNodeSources.systemPromptFromNodes, promptNodeSources.userPromptFromNodes, sessionId, systemPrompt, userPrompt]);

  const buildWebhookExecutionPayload = useCallback(() => {
    const payload: {
      session_id: string;
      system_prompt?: string;
      user_prompt?: string;
    } = {
      session_id: sessionId
    };

    if (!promptNodeSources.systemPromptFromNodes) {
      payload.system_prompt = systemPrompt;
    }

    if (!promptNodeSources.userPromptFromNodes) {
      payload.user_prompt = userPrompt;
    }

    return payload;
  }, [promptNodeSources.systemPromptFromNodes, promptNodeSources.userPromptFromNodes, sessionId, systemPrompt, userPrompt]);

  const handleExecute = useCallback(async (options?: { startNodeId?: string; runMode?: "workflow" | "single_node" }) => {
    try {
      setBusy(true);
      setRunningExecutionId(null);
      setError(null);
      let initializedTrace = false;
      let initializedStatuses = false;
      const saved = await persistWorkflow();
      const result = await executeWorkflowStream(saved.id, buildEditorExecutionPayload(options?.startNodeId, options?.runMode), {
        onExecutionStarted: (event) => {
          handleStreamExecutionStarted(event);
        },
        onNodeStart: (event) => {
          if (!isDebugMode) {
            return;
          }
          setExecutionResult((current) => {
            const base = initializedTrace ? (current ?? createPartialExecutionResult(saved.id, event.startedAt)) : createPartialExecutionResult(saved.id, event.startedAt);
            initializedTrace = true;
            return applyNodeStartToExecutionResult(base, event);
          });
          setLiveNodeStatuses((current) => {
            if (!initializedStatuses) {
              initializedStatuses = true;
              return { [event.nodeId]: "running" };
            }
            return {
              ...current,
              [event.nodeId]: "running"
            };
          });
        },
        onNodeComplete: (event) => {
          if (!isDebugMode) {
            return;
          }
          setExecutionResult((current) => {
            const base = initializedTrace ? (current ?? createPartialExecutionResult(saved.id, event.completedAt)) : createPartialExecutionResult(saved.id, event.completedAt);
            initializedTrace = true;
            return applyNodeCompleteToExecutionResult(base, event);
          });
          const normalizedStatus = normalizeEditorExecutionStatus(event.status);
          if (!normalizedStatus) {
            return;
          }
          setLiveNodeStatuses((current) => {
            if (!initializedStatuses) {
              initializedStatuses = true;
              return { [event.nodeId]: normalizedStatus };
            }
            return {
              ...current,
              [event.nodeId]: normalizedStatus
            };
          });
        },
        onError: (event) => {
          setError((current) => current ?? event.message);
        }
      });
      if (isDebugMode) {
        setExecutionResult(result);
        setLogsTab("logs");
        setActiveMode("editor");
        if (result.executionId) {
          latestDebugExecutionIdRef.current = result.executionId;
        }
      }
      void refreshExecutionHistory();
    } catch (execError) {
      const message = handleApiError(execError, "Execution failed");
      if (isDebugMode) {
        setExecutionResult(buildExecutionErrorResult(currentWorkflow.id, message));
        setLogsTab("logs");
        setActiveMode("editor");
      }
    } finally {
      setLiveNodeStatuses({});
      setRunningExecutionId(null);
      setBusy(false);
    }
  }, [
    currentWorkflow.id,
    buildEditorExecutionPayload,
    executeWorkflowStream,
    handleStreamExecutionStarted,
    handleApiError,
    isDebugMode,
    persistWorkflow,
    refreshExecutionHistory,
  ]);

  const handleWebhookExecute = useCallback(async () => {
    try {
      setBusy(true);
      setRunningExecutionId(null);
      setError(null);
      startVisualRun();
      let initializedTrace = false;
      let initializedStatuses = false;
      const saved = await persistWorkflow();
      const result = await runWebhookStream({
        workflow_id: saved.id,
        ...buildWebhookExecutionPayload()
      }, {
        onExecutionStarted: (event) => {
          handleStreamExecutionStarted(event);
        },
        onNodeStart: (event) => {
          if (!isDebugMode) {
            return;
          }
          setExecutionResult((current) => {
            const base = initializedTrace ? (current ?? createPartialExecutionResult(saved.id, event.startedAt)) : createPartialExecutionResult(saved.id, event.startedAt);
            initializedTrace = true;
            return applyNodeStartToExecutionResult(base, event);
          });
          setLiveNodeStatuses((current) => {
            if (!initializedStatuses) {
              initializedStatuses = true;
              return { [event.nodeId]: "running" };
            }
            return {
              ...current,
              [event.nodeId]: "running"
            };
          });
        },
        onNodeComplete: (event) => {
          if (!isDebugMode) {
            return;
          }
          setExecutionResult((current) => {
            const base = initializedTrace ? (current ?? createPartialExecutionResult(saved.id, event.completedAt)) : createPartialExecutionResult(saved.id, event.completedAt);
            initializedTrace = true;
            return applyNodeCompleteToExecutionResult(base, event);
          });
          const normalizedStatus = normalizeEditorExecutionStatus(event.status);
          if (!normalizedStatus) {
            return;
          }
          setLiveNodeStatuses((current) => {
            if (!initializedStatuses) {
              initializedStatuses = true;
              return { [event.nodeId]: normalizedStatus };
            }
            return {
              ...current,
              [event.nodeId]: normalizedStatus
            };
          });
        },
        onError: (event) => {
          setError((current) => current ?? event.message);
        }
      });
      if (isDebugMode) {
        setExecutionResult(result);
        setLogsTab("logs");
        setActiveMode("editor");
        if (result.executionId) {
          latestDebugExecutionIdRef.current = result.executionId;
        }
      }
      void refreshExecutionHistory();
    } catch (execError) {
      const message = handleApiError(execError, "Webhook execution failed");
      if (isDebugMode) {
        setExecutionResult(buildExecutionErrorResult(currentWorkflow.id, message));
        setLogsTab("logs");
        setActiveMode("editor");
      }
    } finally {
      stopVisualRun();
      setRunningExecutionId(null);
      setBusy(false);
    }
  }, [
    currentWorkflow.id,
    buildWebhookExecutionPayload,
    handleStreamExecutionStarted,
    handleApiError,
    isDebugMode,
    persistWorkflow,
    refreshExecutionHistory,
    runWebhookStream,
    startVisualRun,
    stopVisualRun,
  ]);

  const handleChatSend = useCallback(async () => {
    if ((!chatInput.trim() && chatPendingImages.length === 0) || chatBusy) {
      return;
    }

    const message = chatInput.trim() || "(image attached)";
    setChatInput("");
    const pendingImages = [...chatPendingImages];
    setChatPendingImages([]);
    setChatBusy(true);
    setChatError(null);
    setChatNodeTrace([]);
    let initializedTrace = false;
    let initializedStatuses = false;
    let activeWorkflowId = currentWorkflow.id;

    let streamedAnyDelta = false;

    try {
      const savedWorkflow = await persistWorkflow();
      const workflowId = savedWorkflow.id;
      activeWorkflowId = workflowId;
      const sessionForWorkflow = chatSessionsByWorkflow[workflowId] ?? createChatSessionId(workflowId);
      setChatSessionsByWorkflow((current) =>
        current[workflowId]
          ? current
          : {
              ...current,
              [workflowId]: sessionForWorkflow
            }
      );

      appendChatMessage(workflowId, {
        id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        text: message,
        status: "done",
        images: pendingImages.length > 0 ? pendingImages : undefined
      });

      const assistantMessageId = `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      appendChatMessage(workflowId, {
        id: assistantMessageId,
        role: "assistant",
        text: "",
        status: "streaming"
      });

      activeAssistantMessageIdRef.current = assistantMessageId;
      chatDeltaBufferRef.current = "";
      startChatDeltaFlusher(workflowId);

      const chatExecutionPayload: Record<string, unknown> = {
        user_prompt: message,
        sessionId: sessionForWorkflow,
        session_id: sessionForWorkflow,
        ...(pendingImages.length > 0 ? { images: pendingImages } : {})
      };
      if (!promptNodeSources.systemPromptFromNodes) {
        chatExecutionPayload.system_prompt = chatSystemPrompt;
      }

      const result = await executeWorkflowStream(
        workflowId,
        chatExecutionPayload,
        {
          onNodeStart: (event) => {
            if (isDebugMode) {
              setExecutionResult((current) => {
                const base = initializedTrace
                  ? (current ?? createPartialExecutionResult(workflowId, event.startedAt))
                  : createPartialExecutionResult(workflowId, event.startedAt);
                initializedTrace = true;
                return applyNodeStartToExecutionResult(base, event);
              });
              setLiveNodeStatuses((current) => ({
                ...(initializedStatuses ? current : {}),
                [event.nodeId]: "running"
              }));
              initializedStatuses = true;
            }
            setChatNodeTrace((current) => [...current, { nodeId: event.nodeId, status: "running", at: event.startedAt }].slice(-40));
          },
          onNodeComplete: (event) => {
            if (isDebugMode) {
              setExecutionResult((current) => {
                const base = initializedTrace
                  ? (current ?? createPartialExecutionResult(workflowId, event.completedAt))
                  : createPartialExecutionResult(workflowId, event.completedAt);
                initializedTrace = true;
                return applyNodeCompleteToExecutionResult(base, event);
              });
              const normalizedStatus = normalizeEditorExecutionStatus(event.status);
              if (normalizedStatus) {
                setLiveNodeStatuses((current) => ({
                  ...(initializedStatuses ? current : {}),
                  [event.nodeId]: normalizedStatus
                }));
                initializedStatuses = true;
              }
            }
            setChatNodeTrace((current) => [...current, { nodeId: event.nodeId, status: event.status, at: event.completedAt }].slice(-40));
          },
          onLlmDelta: (event) => {
            streamedAnyDelta = true;
            chatDeltaBufferRef.current += event.delta;
          },
          onError: (event) => {
            setChatError(event.message);
          }
        }
      );

      if (chatDeltaBufferRef.current.length && activeAssistantMessageIdRef.current) {
        updateChatMessageText(workflowId, activeAssistantMessageIdRef.current, chatDeltaBufferRef.current);
        chatDeltaBufferRef.current = "";
      }

      const finalWorkflowAnswer = result.status === "error" ? "" : extractAssistantText(result.output ?? "");
      if (finalWorkflowAnswer && activeAssistantMessageIdRef.current) {
        setChatMessageText(workflowId, activeAssistantMessageIdRef.current, finalWorkflowAnswer);
      } else if (!streamedAnyDelta) {
        const fallbackAnswer = extractAssistantText(result.output ?? result.error ?? "");
        if (fallbackAnswer && activeAssistantMessageIdRef.current) {
          setChatMessageText(workflowId, activeAssistantMessageIdRef.current, fallbackAnswer);
        }
      }

      if (activeAssistantMessageIdRef.current) {
        setChatMessageStatus(
          workflowId,
          activeAssistantMessageIdRef.current,
          result.status === "error" ? "error" : "done"
        );
      }

      if (result.status === "error") {
        setChatError(result.error ?? "Workflow execution failed");
      }
      if (isDebugMode) {
        setExecutionResult(result);
        setLogsTab("logs");
        if (result.executionId) {
          latestDebugExecutionIdRef.current = result.executionId;
        }
      }
      void refreshExecutionHistory();
    } catch (error) {
      const messageText = handleApiError(error, "Failed to stream chat response");
      setChatError(messageText);
      if (isDebugMode) {
        setExecutionResult(buildExecutionErrorResult(activeWorkflowId, messageText));
        setLogsTab("logs");
      }
      if (activeAssistantMessageIdRef.current) {
        setChatMessageStatus(activeWorkflowId, activeAssistantMessageIdRef.current, "error");
      } else {
        appendChatMessage(activeWorkflowId, {
          id: `assistant-error-${Date.now().toString(36)}`,
          role: "assistant",
          text: messageText,
          status: "error"
        });
      }
    } finally {
      if (chatDeltaBufferRef.current.length && activeAssistantMessageIdRef.current) {
        updateChatMessageText(activeWorkflowId, activeAssistantMessageIdRef.current, chatDeltaBufferRef.current);
        chatDeltaBufferRef.current = "";
      }
      stopChatDeltaFlusher();
      activeAssistantMessageIdRef.current = null;
      setChatBusy(false);
    }
  }, [
    appendChatMessage,
    chatBusy,
    chatInput,
    chatPendingImages,
    chatSessionsByWorkflow,
    chatSystemPrompt,
    currentWorkflow.id,
    handleApiError,
    isDebugMode,
    persistWorkflow,
    promptNodeSources.systemPromptFromNodes,
    refreshExecutionHistory,
    setChatMessageStatus,
    startChatDeltaFlusher,
    stopChatDeltaFlusher,
    setChatMessageText,
    updateChatMessageText
  ]);

  const handleChatSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void handleChatSend();
    },
    [handleChatSend]
  );

  const handleExport = useCallback(() => {
    const workflow = buildCurrentWorkflow();
    const payload = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowVersion: workflow.workflowVersion,
      workflow,
      exportedAt: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${workflow.name.replace(/\s+/g, "-").toLowerCase() || "workflow"}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }, [buildCurrentWorkflow]);

  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        setBusy(true);
        setError(null);
        const content = await file.text();
        const imported = await importWorkflow({ json: content });
        const workflows = await fetchWorkflows({ projectId: activeProjectId });
        setWorkflowList(workflows);
        hydrateWorkflow(imported);
        storeLocalWipWorkflow(imported);
      } catch (importError) {
        handleApiError(importError, "Failed to import workflow");
      } finally {
        setBusy(false);
        event.target.value = "";
      }
    },
    [handleApiError, hydrateWorkflow]
  );

  const handleCreateWorkflow = useCallback(async () => {
    if (!canManageWorkflows) {
      setError("You do not have permission to create workflows.");
      return;
    }

    try {
      setBusy(true);
      setError(null);
      const draft = createBlankWorkflow();
      const userPromptNodeId = createNodeId("user_prompt");
      const outputNodeId = createNodeId("output");
      const savedDraft = await saveWorkflow({
        ...draft,
        name: `Workflow ${workflowList.length + 1}`,
        nodes: [
          {
            id: userPromptNodeId,
            type: "user_prompt",
            name: "User Prompt",
            position: { x: 140, y: 180 },
            config: {
              text: "What should I help with?"
            }
          },
          {
            id: outputNodeId,
            type: "output",
            name: "Output",
            position: { x: 420, y: 180 },
            config: {
              responseTemplate: "{{user_prompt}}",
              outputKey: "result"
            }
          }
        ],
        edges: [
          {
            id: createEdgeId(userPromptNodeId, outputNodeId),
            source: userPromptNodeId,
            target: outputNodeId
          }
        ]
      });
      const workflows = await fetchWorkflows({ projectId: activeProjectId });
      setWorkflowList(workflows);
      hydrateWorkflow(savedDraft);
      setActiveMode("editor");
      storeLocalWipWorkflow(savedDraft);
    } catch (createError) {
      handleApiError(createError, "Failed to create workflow");
    } finally {
      setBusy(false);
    }
  }, [canManageWorkflows, handleApiError, hydrateWorkflow, workflowList.length]);

  const handleDuplicateWorkflow = useCallback(
    async (workflowId: string) => {
      if (!canManageWorkflows) {
        setError("You do not have permission to duplicate workflows.");
        return;
      }

      const source = workflowList.find((workflow) => workflow.id === workflowId);
      const suggestedName = source ? `${source.name} Copy` : "Workflow Copy";
      const requestedName = window.prompt("Name for duplicated workflow", suggestedName);
      if (requestedName === null) {
        return;
      }

      const duplicateName = requestedName.trim();
      if (!duplicateName) {
        setError("Workflow name is required.");
        return;
      }

      try {
        setBusy(true);
        setError(null);
        const duplicated = await duplicateWorkflow(workflowId, { name: duplicateName });
        const workflows = await fetchWorkflows({ projectId: activeProjectId });
        setWorkflowList(workflows);
        hydrateWorkflow(duplicated);
        setActiveMode("editor");
        storeLocalWipWorkflow(duplicated);
      } catch (duplicateError) {
        handleApiError(duplicateError, "Failed to duplicate workflow");
      } finally {
        setBusy(false);
      }
    },
    [canManageWorkflows, handleApiError, hydrateWorkflow, setWorkflowList, workflowList]
  );

  const handleDeleteWorkflow = useCallback(
    async (workflowId: string) => {
      if (!canManageWorkflows) {
        setError("You do not have permission to delete workflows.");
        return;
      }

      const candidate = workflowList.find((workflow) => workflow.id === workflowId);
      const confirmed = window.confirm(`Delete workflow '${candidate?.name ?? workflowId}'? This cannot be undone.`);
      if (!confirmed) {
        return;
      }

      try {
        setBusy(true);
        setError(null);
        await deleteWorkflow(workflowId);
        deleteTabWipWorkflow(workflowId);
        const workflows = await fetchWorkflows({ projectId: activeProjectId });
        setWorkflowList(workflows);

        if (currentWorkflow.id === workflowId) {
          const fallback = workflows[0];
          if (fallback) {
            const workflow = await fetchWorkflow(fallback.id);
            hydrateWorkflow(workflow);
          } else {
            const blank = createBlankWorkflow();
            setCurrentWorkflow(blank);
            setNodes([]);
            setEdges([]);
            replaceStudioUrlState({
              workflowId: null,
              projectId: activeProjectId,
              mode: activeMode
            });
          }
        }
      } catch (deleteError) {
        handleApiError(deleteError, "Failed to delete workflow");
      } finally {
        setBusy(false);
      }
    },
    [activeMode, activeProjectId, canManageWorkflows, currentWorkflow.id, handleApiError, hydrateWorkflow, setEdges, setNodes, workflowList]
  );

  // --- Phase 4.2: project/folder/tag handlers --------------------------------

  const handleCreateProject = useCallback(async () => {
    const name = window.prompt("Project name?");
    if (!name || !name.trim()) return;
    try {
      setBusy(true);
      const project = await createProject({ name: name.trim() });
      const payload = await fetchProjects();
      setProjects(payload.projects);
      setActiveProjectId(project.id);
    } catch (error) {
      handleApiError(error, "Failed to create project");
    } finally {
      setBusy(false);
    }
  }, [handleApiError]);

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      if (projectId === DEFAULT_PROJECT_ID) {
        setError("The default project cannot be deleted.");
        return;
      }
      const target = projectById.get(projectId);
      if (!window.confirm(`Delete project '${target?.name ?? projectId}'? Its workflows/secrets move back to the default project.`)) {
        return;
      }
      try {
        setBusy(true);
        await deleteProject(projectId);
        const payload = await fetchProjects();
        setProjects(payload.projects);
        if (activeProjectId === projectId) setActiveProjectId(DEFAULT_PROJECT_ID);
      } catch (error) {
        handleApiError(error, "Failed to delete project");
      } finally {
        setBusy(false);
      }
    },
    [activeProjectId, handleApiError, projectById]
  );

  const handleCreateFolder = useCallback(async () => {
    const name = window.prompt("Folder name?");
    if (!name || !name.trim()) return;
    try {
      setBusy(true);
      await createFolder({ name: name.trim(), projectId: activeProjectId });
      const payload = await fetchFolders(activeProjectId);
      setFolders(payload.folders);
    } catch (error) {
      handleApiError(error, "Failed to create folder");
    } finally {
      setBusy(false);
    }
  }, [activeProjectId, handleApiError]);

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      const target = folders.find((f) => f.id === folderId);
      if (!window.confirm(`Delete folder '${target?.name ?? folderId}'? Workflows inside will be moved out (not deleted).`)) {
        return;
      }
      try {
        setBusy(true);
        await deleteFolder(folderId);
        const [folderPayload, workflows] = await Promise.all([
          fetchFolders(activeProjectId),
          fetchWorkflows({ projectId: activeProjectId })
        ]);
        setFolders(folderPayload.folders);
        setWorkflowList(workflows);
        if (activeFolderFilter === folderId) setActiveFolderFilter(undefined);
      } catch (error) {
        handleApiError(error, "Failed to delete folder");
      } finally {
        setBusy(false);
      }
    },
    [activeFolderFilter, activeProjectId, folders, handleApiError]
  );

  const handleMoveWorkflow = useCallback(
    async (
      workflowId: string,
      patch: { projectId?: string; folderId?: string | null; tags?: string[] }
    ) => {
      try {
        setBusy(true);
        await moveWorkflow(workflowId, patch);
        const workflows = await fetchWorkflows({ projectId: activeProjectId });
        setWorkflowList(workflows);
      } catch (error) {
        handleApiError(error, "Failed to move workflow");
      } finally {
        setBusy(false);
      }
    },
    [activeProjectId, handleApiError]
  );

  const handleWorkflowEditTags = useCallback(
    async (workflowId: string) => {
      const workflow = workflowList.find((w) => w.id === workflowId);
      if (!workflow) return;
      const current = (workflow.tags ?? []).join(", ");
      const next = window.prompt("Tags (comma-separated):", current);
      if (next === null) return;
      const tags = next
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await handleMoveWorkflow(workflowId, { tags });
    },
    [handleMoveWorkflow, workflowList]
  );

  const handleWorkflowAssignFolder = useCallback(
    async (workflowId: string) => {
      if (folders.length === 0) {
        setError("No folders in this project yet. Create one first.");
        return;
      }
      const options = [{ id: "", name: "(no folder / root)" }, ...folders.map((f) => ({ id: f.id, name: f.name }))];
      const menu = options.map((o, i) => `${i}. ${o.name}`).join("\n");
      const raw = window.prompt(`Move to folder — enter number:\n${menu}`);
      if (raw === null) return;
      const idx = Number(raw.trim());
      if (!Number.isFinite(idx) || idx < 0 || idx >= options.length) return;
      const choice = options[idx];
      if (!choice) return;
      await handleMoveWorkflow(workflowId, { folderId: choice.id ? choice.id : null });
    },
    [folders, handleMoveWorkflow]
  );

  const handleWorkflowAssignProject = useCallback(
    async (workflowId: string) => {
      if (projects.length <= 1) {
        setError("Create another project first to move workflows between projects.");
        return;
      }
      const menu = projects.map((p, i) => `${i}. ${p.name}`).join("\n");
      const raw = window.prompt(`Move to project — enter number:\n${menu}`);
      if (raw === null) return;
      const idx = Number(raw.trim());
      if (!Number.isFinite(idx) || idx < 0 || idx >= projects.length) return;
      const project = projects[idx];
      if (!project) return;
      await handleMoveWorkflow(workflowId, { projectId: project.id, folderId: null });
    },
    [handleMoveWorkflow, projects]
  );

  const handleExecuteSavedWorkflow = useCallback(
    async (workflowId: string) => {
      try {
        setBusy(true);
        setError(null);
        const result = await executeWorkflow(workflowId, buildEditorExecutionPayload());
        setExecutionResult(result);
        if (result.executionId) {
          latestDebugExecutionIdRef.current = result.executionId;
        }
        setLogsTab("logs");
        setActiveMode("executions");
        void refreshExecutionHistory();
      } catch (executionError) {
        const message = handleApiError(executionError, "Execution failed");
        setExecutionResult(buildExecutionErrorResult(workflowId, message));
      } finally {
        setBusy(false);
      }
    },
    [buildEditorExecutionPayload, handleApiError, refreshExecutionHistory]
  );

  const handlePinNodeOutput = useCallback(
    async (nodeId: string) => {
      const nodeResult = executionResult?.nodeResults.find((entry) => entry.nodeId === nodeId);
      if (!nodeResult || nodeResult.output === undefined) {
        setError("Execute the node before pinning its output.");
        return;
      }

      try {
        setBusy(true);
        setError(null);
        const saved = currentWorkflowExists ? currentWorkflow : await persistWorkflow();
        const response = await saveWorkflowPin(saved.id, nodeId, nodeResult.output);
        setCurrentWorkflow((current) =>
          current.id === saved.id
            ? {
                ...current,
                pinnedData: response.pinnedData
              }
            : current
        );
        storeLocalWipWorkflow({
          ...buildCurrentWorkflow(),
          pinnedData: response.pinnedData
        });
      } catch (pinError) {
        handleApiError(pinError, "Failed to pin node output");
      } finally {
        setBusy(false);
      }
    },
    [buildCurrentWorkflow, currentWorkflow, currentWorkflowExists, executionResult, handleApiError, persistWorkflow, setCurrentWorkflow]
  );

  const handleUnpinNodeOutput = useCallback(
    async (nodeId: string) => {
      try {
        setBusy(true);
        setError(null);
        const saved = currentWorkflowExists ? currentWorkflow : await persistWorkflow();
        const response = await deleteWorkflowPin(saved.id, nodeId);
        setCurrentWorkflow((current) =>
          current.id === saved.id
            ? {
                ...current,
                pinnedData: response.pinnedData
              }
            : current
        );
        storeLocalWipWorkflow({
          ...buildCurrentWorkflow(),
          pinnedData: response.pinnedData
        });
      } catch (pinError) {
        handleApiError(pinError, "Failed to remove pinned node output");
      } finally {
        setBusy(false);
      }
    },
    [buildCurrentWorkflow, currentWorkflow, currentWorkflowExists, handleApiError, persistWorkflow, setCurrentWorkflow]
  );

  const openNodeConfig = useCallback((nodeId: string) => {
    setEditingNodeId(nodeId);
  }, []);

  // --- Radial action ring (Phase 4.1 / L2M distinct UI) ------------------------
  const soloSelectedNode = useMemo(() => {
    const selected = nodes.filter((node) => node.selected);
    if (selected.length !== 1) return null;
    const only = selected[0]!;
    if (only.data.nodeType === "sticky_note") return null;
    if (editingNodeId === only.id) return null;
    return only;
  }, [editingNodeId, nodes]);

  const [radialCenter, setRadialCenter] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!soloSelectedNode) {
      setRadialCenter(null);
      return;
    }
    const compute = () => {
      if (typeof document === "undefined") return;
      const domNode = document.querySelector(`.react-flow__node[data-id="${soloSelectedNode.id}"]`);
      if (!(domNode instanceof HTMLElement)) {
        setRadialCenter(null);
        return;
      }
      const rect = domNode.getBoundingClientRect();
      setRadialCenter({ x: rect.right - 8, y: rect.top + rect.height / 2 });
    };
    compute();
    window.addEventListener("resize", compute);
    const wrapperEl = flowWrapperRef.current;
    wrapperEl?.addEventListener("scroll", compute);
    // Pan/zoom doesn't fire scroll on the wrapper — poll lightly while selected.
    const interval = window.setInterval(compute, 120);
    return () => {
      window.removeEventListener("resize", compute);
      wrapperEl?.removeEventListener("scroll", compute);
      window.clearInterval(interval);
    };
  }, [soloSelectedNode]);

  const onRadialAction = useCallback(
    (action: RadialAction) => {
      if (!soloSelectedNode) return;
      const nodeId = soloSelectedNode.id;
      switch (action.kind) {
        case "edit":
          openNodeConfig(nodeId);
          return;
        case "duplicate": {
          pushHistorySnapshot();
          const src = soloSelectedNode;
          const newId = createNodeId(src.data.nodeType);
          const duplicate: Node<EditorNodeData> = {
            ...src,
            id: newId,
            selected: true,
            position: { x: src.position.x + 40, y: src.position.y + 40 },
            data: {
              label: src.data.label,
              nodeType: src.data.nodeType,
              config: cloneJson(src.data.config ?? {}),
              disabled: src.data.disabled,
              color: src.data.color
            }
          };
          setNodes((current) => [
            ...current.map((node) => ({ ...node, selected: false })),
            duplicate
          ]);
          return;
        }
        case "toggleDisabled": {
          pushHistorySnapshot();
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId
                ? { ...node, data: { ...node.data, disabled: !node.data.disabled } }
                : node
            )
          );
          return;
        }
        case "setColor": {
          pushHistorySnapshot();
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId ? { ...node, data: { ...node.data, color: action.color } } : node
            )
          );
          return;
        }
        case "delete": {
          pushHistorySnapshot();
          setNodes((current) => current.filter((node) => node.id !== nodeId));
          setEdges((current) =>
            current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
          );
          if (editingNodeId === nodeId) setEditingNodeId(null);
          return;
        }
      }
    },
    [editingNodeId, openNodeConfig, pushHistorySnapshot, setEdges, setNodes, soloSelectedNode]
  );

  const saveNodeConfig = useCallback(
    (payload: {
      label: string;
      config: Record<string, unknown>;
      disabled?: boolean;
      color?: EditorNodeData["color"];
    }) => {
      if (!editingNodeId) {
        return;
      }

      const normalizedLabel = payload.label.trim();
      pushHistorySnapshot();
      setNodes((existing) =>
        existing.map((node) =>
          node.id === editingNodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  label: normalizedLabel || node.data.label,
                  config: payload.config,
                  disabled: payload.disabled,
                  color: payload.color
                }
              }
            : node
        )
      );
      setEditingNodeId(null);
      setError(null);
    },
    [editingNodeId, pushHistorySnapshot, setNodes]
  );

  const handleOpenAgentAttachmentDrawer = useCallback((sourceNodeId: string, sourceHandle: AgentAttachmentHandle) => {
    setNodeDrawerContext(buildAgentAttachmentDrawerContext(sourceNodeId, sourceHandle));
    setShowNodeDrawer(true);
  }, []);

  const createNodeFromDefinition = useCallback(
    (definition: DefinitionNode, position?: { x: number; y: number }, attachContext?: NodeDrawerContext | null) => {
      const id = createNodeId(definition.type as EditorNodeData["nodeType"]);
      const fallbackPosition = reactFlowInstance
        ? reactFlowInstance.project({ x: window.innerWidth / 2 - 120, y: 180 })
        : { x: 160, y: 120 };
      const sourceNode = attachContext?.sourceNodeId
        ? nodes.find((node) => node.id === attachContext.sourceNodeId)
        : undefined;
      const attachmentPosition = sourceNode
        ? {
            x: sourceNode.position.x + 310,
            y:
              sourceNode.position.y +
              (attachContext?.sourceHandle === "chat_model"
                ? 92
                : attachContext?.sourceHandle === "memory"
                  ? 172
                  : attachContext?.sourceHandle === "worker"
                    ? 252
                    : 212)
          }
        : undefined;

      const newNode: Node<EditorNodeData> = {
        id,
        type: definition.type === "sticky_note" ? "stickyNote" : "workflowNode",
        position: position ?? attachmentPosition ?? fallbackPosition,
        data: {
          label: definition.label,
          nodeType: definition.type as EditorNodeData["nodeType"],
          config: definition.sampleConfig ?? {}
        }
      };

      pushHistorySnapshot();
      setNodes((existing) => [...existing, newNode]);
      if (attachContext?.sourceNodeId && attachContext.sourceHandle) {
        const edgeNodes = [...(nodes as EditorNode[]), newNode as EditorNode];
        const edge = decorateEdge(
          {
            id: createEdgeId(attachContext.sourceNodeId, id),
            source: attachContext.sourceNodeId,
            target: id,
            sourceHandle: attachContext.sourceHandle,
            targetHandle: undefined
          },
          edgeNodes
        );
        setEdges((existing) => {
          const shouldReplaceExisting =
            attachContext.sourceHandle === "chat_model" || attachContext.sourceHandle === "memory";
          const baseEdges = shouldReplaceExisting
            ? existing.filter(
                (candidate) =>
                  candidate.source !== attachContext.sourceNodeId ||
                  candidate.sourceHandle !== attachContext.sourceHandle
              )
            : existing;
          return addEdge(edge, baseEdges);
        });
      }
      setError(null);
    },
    [nodes, pushHistorySnapshot, reactFlowInstance, setEdges, setNodes]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      const source = connection.source;
      const target = connection.target;
      const sourceNode = nodes.find((node) => node.id === source);
      const targetNode = nodes.find((node) => node.id === target);
      const expectedTargetType: Record<string, EditorNodeData["nodeType"] | EditorNodeData["nodeType"][]> = {
        chat_model: chatModelNodeTypes,
        memory: "local_memory",
        tool: "mcp_tool",
        worker: ["agent_orchestrator", "supervisor_node"]
      };
      const expectedHandleByTargetType: Partial<Record<EditorNodeData["nodeType"], string>> = {
        llm_call: "chat_model",
        openai_chat_model: "chat_model",
        anthropic_chat_model: "chat_model",
        ollama_chat_model: "chat_model",
        openai_compatible_chat_model: "chat_model",
        ai_gateway_chat_model: "chat_model",
        azure_openai_chat_model: "chat_model",
        google_gemini_chat_model: "chat_model",
        local_memory: "memory",
        mcp_tool: "tool"
      };

      let sourceHandle = connection.sourceHandle ?? "";
      if ((sourceNode?.data.nodeType === "agent_orchestrator" || sourceNode?.data.nodeType === "supervisor_node") && !sourceHandle && targetNode) {
        const inferred = expectedHandleByTargetType[targetNode.data.nodeType];
        if (inferred) {
          sourceHandle = inferred;
        } else if (targetNode.data.nodeType === "agent_orchestrator" || targetNode.data.nodeType === "supervisor_node") {
          sourceHandle = "worker";
        }
      }

      if ((targetNode?.data.nodeType === "agent_orchestrator" || targetNode?.data.nodeType === "supervisor_node") && sourceNode) {
        const requiredHandle = expectedHandleByTargetType[sourceNode.data.nodeType];
        if (requiredHandle) {
          setError(
            `Attach '${sourceNode.data.label}' from the Agent '${requiredHandle}' port (drag edge from Agent to node).`
          );
          return;
        }
      }

      const isAgentAttachmentHandle = auxiliaryHandles.has(sourceHandle);

      if (isAgentAttachmentHandle) {
        if (sourceNode?.data.nodeType !== "agent_orchestrator" && sourceNode?.data.nodeType !== "supervisor_node") {
          setError("chat_model/memory/tool/worker handles can only be used from an Agent Orchestrator or Supervisor node.");
          return;
        }

        const requiredType = expectedTargetType[sourceHandle];
        if (requiredType) {
          const typeMatches = Array.isArray(requiredType) 
            ? requiredType.includes(targetNode?.data.nodeType as any)
            : targetNode?.data.nodeType === requiredType;
            
          if (!typeMatches) {
            setError(`Invalid attachment. '${sourceHandle}' must connect to a '${Array.isArray(requiredType) ? requiredType.join(" or ") : requiredType}' node.`);
            return;
          }
        }
      }

      if (!isAgentAttachmentHandle && targetNode?.data.nodeType === "agent_orchestrator" && sourceNode) {
        const incomingPrimaryInputTypes = new Set<EditorNodeData["nodeType"]>();

        for (const edge of edges) {
          const existingIsAttachment = edge.sourceHandle ? auxiliaryHandles.has(edge.sourceHandle) : false;
          if (existingIsAttachment || edge.target !== target) {
            continue;
          }
          const existingSourceNode = nodes.find((node) => node.id === edge.source);
          const existingSourceType = existingSourceNode?.data.nodeType;
          if (existingSourceType && agentPrimaryInputNodeTypes.has(existingSourceType)) {
            incomingPrimaryInputTypes.add(existingSourceType);
          }
        }

        if (agentPrimaryInputNodeTypes.has(sourceNode.data.nodeType)) {
          incomingPrimaryInputTypes.add(sourceNode.data.nodeType);
        }

        if (incomingPrimaryInputTypes.size > 1) {
          setError(
            `Agent can only use one primary input type. Found: ${[...incomingPrimaryInputTypes].sort().join(", ")}.`
          );
          return;
        }
      }

      setEdges((existing) => {
        const edge = decorateEdge(
          {
            ...connection,
            sourceHandle: sourceHandle || undefined,
            source,
            target,
            id: createEdgeId(source, target)
          },
          nodes as EditorNode[]
        );

        return addEdge(edge, existing);
      });
      setError(null);
    },
    [edges, nodes, setEdges]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData("application/reactflow");
      if (!nodeType || !reactFlowInstance || !flowWrapperRef.current) {
        return;
      }

      const definition = definitions.find((item) => item.type === nodeType);
      if (!definition) {
        return;
      }

      const bounds = flowWrapperRef.current.getBoundingClientRect();
      const position = reactFlowInstance.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      });

      createNodeFromDefinition(definition, position);
    },
    [createNodeFromDefinition, definitions, reactFlowInstance]
  );

  const handleCreateSecret = useCallback(async () => {
    if (!secretName.trim()) {
      setError("Secret name is required.");
      return;
    }

    const secretPayload = buildSecretPayload({
      provider: secretProvider,
      customProvider: secretCustomProvider,
      genericValue: secretGenericValue,
      connectionString: secretConnectionString,
      googleAuthMode: secretGoogleAuthMode,
      googleAccessToken: secretGoogleAccessToken,
      googleServiceAccountJson: secretGoogleServiceAccountJson
    });
    if (secretPayload.error || !secretPayload.provider || !secretPayload.value) {
      setError(secretPayload.error ?? "Invalid secret payload.");
      return;
    }

    try {
      setSecretBusy(true);
      setError(null);
      setSecretMessage(null);
      await createSecret({
        name: secretName.trim(),
        provider: secretPayload.provider,
        value: secretPayload.value
      });
      await refreshSecrets();
      setSecretGenericValue("");
      setSecretConnectionString("");
      setSecretGoogleAccessToken("");
      setSecretGoogleServiceAccountJson("");
      setSecretMessage("Secret created.");
    } catch (createError) {
      handleApiError(createError, "Failed to create secret");
    } finally {
      setSecretBusy(false);
    }
  }, [
    handleApiError,
    refreshSecrets,
    secretConnectionString,
    secretCustomProvider,
    secretGenericValue,
    secretGoogleAccessToken,
    secretGoogleAuthMode,
    secretGoogleServiceAccountJson,
    secretName,
    secretProvider
  ]);

  const copySecretId = useCallback(async (secretId: string) => {
    try {
      await navigator.clipboard.writeText(secretId);
      setSecretMessage(`Copied ${secretId}`);
    } catch {
      setError("Failed to copy secret id to clipboard");
    }
  }, []);

  const handleLogin = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      try {
        setAuthBusy(true);
        setAuthError(null);
        const result = await loginUser({
          email: loginEmail.trim(),
          password: loginPassword
        });
        if (isMfaChallenge(result)) {
          setMfaChallengeId(result.mfaChallenge);
          setLoginPassword("");
          return;
        }
        setAuthUser(result.user);
        setError(null);
        setLoginPassword("");
      } catch (loginError) {
        setAuthError(loginError instanceof Error ? loginError.message : "Login failed");
      } finally {
        setAuthBusy(false);
      }
    },
    [loginEmail, loginPassword]
  );

  const handleCompleteMfa = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!mfaChallengeId) return;
      try {
        setAuthBusy(true);
        setAuthError(null);
        const result = await completeMfaLogin({ challenge: mfaChallengeId, code: mfaCode.trim() });
        setAuthUser(result.user);
        setMfaChallengeId(null);
        setMfaCode("");
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : "MFA verification failed");
      } finally {
        setAuthBusy(false);
      }
    },
    [mfaChallengeId, mfaCode]
  );

  const handleLogout = useCallback(async () => {
    try {
      await logoutUser();
    } catch {
      // Ignore logout API failures and clear local app state.
    }

    setAuthUser(null);
    setWorkflowList([]);
    setCurrentWorkflow(createBlankWorkflow());
    setDefinitions(nodeDefinitions as unknown as DefinitionNode[]);
    setMcpServerDefinitions([]);
    setSecrets([]);
    setExecutionResult(null);
    setExecutionHistoryItems([]);
    setExecutionHistoryTotal(0);
    setExecutionDetailById({});
    setExpandedExecutionIds([]);
    setExecutionsError(null);
    stopVisualRun();
    setNodes([]);
    setEdges([]);
    setEditingNodeId(null);
    setActiveMode("dashboard");
    setLoading(false);
    setError(null);
    setSecretMessage(null);
    setWorkflowVariableRows([]);
    setVariablesBusy(false);
    replaceStudioUrlState({ workflowId: null, projectId: null, mode: null });
  }, [setEdges, setNodes, stopVisualRun]);

  if (authChecking) {
    return <div className="loading-screen">Checking session...</div>;
  }

  if (!authUser) {
    if (mfaChallengeId) {
      return (
        <div className="auth-shell">
          <form className="auth-card" onSubmit={handleCompleteMfa}>
            <div className="auth-brand">
              <img src="/lsquarem-logo.svg" alt="L2M logo" className="auth-brand-logo" />
              <h1>
                L<sup>2</sup>M
              </h1>
            </div>
            <p>Enter the 6-digit code from your authenticator app (or a backup code).</p>
            {authError && <div className="error-banner">{authError}</div>}
            <label htmlFor="mfa-verification-code">Verification code</label>
            <input
              id="mfa-verification-code"
              type="text"
              inputMode="numeric"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              autoFocus
              required
              autoComplete="one-time-code"
            />
            <button className="execute-btn" type="submit" disabled={authBusy || !mfaCode.trim()}>
              {authBusy ? "Verifying..." : "Verify"}
            </button>
            <button
              type="button"
              className="header-btn ghost"
              onClick={() => {
                setMfaChallengeId(null);
                setMfaCode("");
                setAuthError(null);
              }}
            >
              Cancel
            </button>
          </form>
        </div>
      );
    }
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={handleLogin}>
          <div className="auth-brand">
            <img src="/lsquarem-logo.svg" alt="L2M logo" className="auth-brand-logo" />
            <h1>
              L<sup>2</sup>M
            </h1>
          </div>
          <p>Sign in to view, edit, and run workflows.</p>
          {authError && <div className="error-banner">{authError}</div>}
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            value={loginEmail}
            onChange={(event) => setLoginEmail(event.target.value)}
            autoComplete="username"
            required
          />
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
          <button className="execute-btn" type="submit" disabled={authBusy}>
            {authBusy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  if (loading && workflowList.length === 0) {
    return <div className="loading-screen">Loading L²M...</div>;
  }

  return (
    <div className="studio-shell">
      <LeftMenuBar
        activeMode={activeMode}
        canManageSecrets={canManageSecrets}
        onModeChange={setActiveMode}
      />

      <div className="studio-main">
        <StudioHeader
          activeMode={activeMode}
          canManageSecrets={canManageSecrets}
          currentWorkflowName={currentWorkflow.name}
          currentWorkflowId={currentWorkflow.id}
          currentWorkflowExists={currentWorkflowExists}
          workflowList={workflowList}
          authUser={authUser}
          busy={busy}
          secretBusy={secretBusy}
          importFileRef={importFileRef}
          onWorkflowNameChange={(name) =>
            setCurrentWorkflow((current) => ({
              ...current,
              name
            }))
          }
          onLoadWorkflowById={(id) => {
            void loadWorkflowById(id);
          }}
          onModeChange={setActiveMode}
          onSave={handleSave}
          onExport={handleExport}
          onImportClick={() => importFileRef.current?.click()}
          onImportFileChange={handleImportFile}
          onRefreshSecrets={() => {
            void refreshSecrets();
          }}
          onLogout={() => {
            void handleLogout();
          }}
          theme={theme}
          onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          onOpenShortcuts={() => setShowShortcutsPanel(true)}
          projects={projects}
          activeProjectId={activeProjectId}
          onChangeActiveProject={(id) => setActiveProjectId(id)}
          onCreateProject={() => {
            void handleCreateProject();
          }}
        />

        <main className="main-content">
          {error && <div className="error-banner global-banner">{error}</div>}
          {secretMessage && <div className="info-banner global-banner">{secretMessage}</div>}

          {activeMode === "dashboard" && (
            <section className="dashboard-pane has-sidebar">
              <aside className="dashboard-sidebar">
                <div className="dashboard-sidebar-section">
                  <div className="dashboard-sidebar-heading">
                    <h4>Project</h4>
                  </div>
                  <div className="dashboard-sidebar-project">
                    <strong>{activeProject?.name ?? "Default Project"}</strong>
                    {activeProject?.description && <p className="muted">{activeProject.description}</p>}
                  </div>
                  {canManageWorkflows && activeProjectId !== DEFAULT_PROJECT_ID && (
                    <button
                      className="header-btn danger text-only"
                      onClick={() => void handleDeleteProject(activeProjectId)}
                      disabled={busy}
                    >
                      Delete project
                    </button>
                  )}
                </div>

                <div className="dashboard-sidebar-section">
                  <div className="dashboard-sidebar-heading">
                    <h4>Folders</h4>
                    {canManageWorkflows && (
                      <button
                        className="mini-btn"
                        onClick={() => void handleCreateFolder()}
                        disabled={busy}
                        title="New folder in this project"
                      >
                        +
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`folder-row${activeFolderFilter === undefined ? " active" : ""}`}
                    onClick={() => setActiveFolderFilter(undefined)}
                  >
                    <span>All workflows</span>
                    <span className="folder-row-count">{workflowList.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`folder-row${activeFolderFilter === null ? " active" : ""}`}
                    onClick={() => setActiveFolderFilter(null)}
                  >
                    <span>Unfiled</span>
                    <span className="folder-row-count">
                      {workflowList.filter((w) => !w.folderId).length}
                    </span>
                  </button>
                  {folders.map((folder) => (
                    <div key={folder.id} className="folder-row-wrap">
                      <button
                        type="button"
                        className={`folder-row${activeFolderFilter === folder.id ? " active" : ""}`}
                        onClick={() => setActiveFolderFilter(folder.id)}
                      >
                        <span>📁 {folder.name}</span>
                        <span className="folder-row-count">
                          {workflowList.filter((w) => w.folderId === folder.id).length}
                        </span>
                      </button>
                      {canManageWorkflows && (
                        <button
                          type="button"
                          className="folder-row-delete"
                          title="Delete folder"
                          aria-label={`Delete folder ${folder.name}`}
                          onClick={() => void handleDeleteFolder(folder.id)}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {availableTags.length > 0 && (
                  <div className="dashboard-sidebar-section">
                    <div className="dashboard-sidebar-heading">
                      <h4>Tags</h4>
                    </div>
                    <div className="tag-filter-row">
                      <button
                        type="button"
                        className={`tag-chip${activeTagFilter === null ? " active" : ""}`}
                        onClick={() => setActiveTagFilter(null)}
                      >
                        All
                      </button>
                      {availableTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className={`tag-chip${activeTagFilter === tag ? " active" : ""}`}
                          onClick={() => setActiveTagFilter(tag === activeTagFilter ? null : tag)}
                        >
                          #{tag}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </aside>

              <div className="dashboard-main">
                <div className="dashboard-header-row">
                  <div>
                    <h2>Workflow Dashboard</h2>
                    <p className="muted">Manage saved workflows, reopen them later, and execute any workflow on demand.</p>
                  </div>
                  <div className="dashboard-actions">
                    <button className="header-btn" onClick={() => void loadData()} disabled={busy}>
                      Refresh
                    </button>
                  </div>
                </div>

                <div className="dashboard-toolbar">
                  <input
                    className="dashboard-search"
                    value={dashboardFilter}
                    onChange={(event) => setDashboardFilter(event.target.value)}
                    placeholder="Search by name, ID, or tag…"
                  />
                  <div className="dashboard-create-controls">
                    <button className="header-btn" onClick={() => void handleCreateWorkflow()} disabled={busy || !canManageWorkflows}>
                      {busy ? "Creating..." : "New Workflow"}
                    </button>
                  </div>
                </div>

                {filteredWorkflowItems.length === 0 && (
                  <div className="logs-placeholder">
                    {workflowList.length === 0
                      ? "No workflows in this project yet. Create one from this dashboard."
                      : "No workflows match your filters."}
                  </div>
                )}

                {filteredWorkflowItems.length > 0 && (
                  <div className="dashboard-grid">
                    {filteredWorkflowItems.map((workflow) => {
                      const folderName = workflow.folderId
                        ? folders.find((f) => f.id === workflow.folderId)?.name
                        : null;
                      return (
                        <article key={workflow.id} className="dashboard-card">
                          <div className="dashboard-card-head">
                            <h3>{workflow.name}</h3>
                            <span className="mono-cell">{workflow.id.slice(0, 8)}</span>
                          </div>
                          <div className="dashboard-card-meta">
                            <span>Updated: {formatWhen(workflow.updatedAt)}</span>
                            <span>Version: {workflow.workflowVersion}</span>
                            {folderName && <span>📁 {folderName}</span>}
                          </div>
                          {workflow.tags && workflow.tags.length > 0 && (
                            <div className="dashboard-card-tags">
                              {workflow.tags.map((tag) => (
                                <span key={tag} className="tag-chip small">
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="dashboard-card-actions">
                            <button
                              className="header-btn"
                              onClick={() => {
                                void loadWorkflowById(workflow.id);
                                setActiveMode("editor");
                              }}
                            >
                              Open Editor
                            </button>
                            <button
                              className="header-btn"
                              onClick={() => {
                                void loadWorkflowById(workflow.id);
                                setActiveMode("chat");
                              }}
                            >
                              Open Chat
                            </button>
                            <button
                              className="header-btn"
                              onClick={() => {
                                void handleExecuteSavedWorkflow(workflow.id);
                              }}
                              disabled={busy}
                            >
                              Execute
                            </button>
                            {canManageWorkflows && (
                              <button
                                className="header-btn"
                                onClick={() => void handleWorkflowEditTags(workflow.id)}
                                disabled={busy}
                                title="Edit tags"
                              >
                                Tags
                              </button>
                            )}
                            {canManageWorkflows && (
                              <button
                                className="header-btn"
                                onClick={() => void handleWorkflowAssignFolder(workflow.id)}
                                disabled={busy}
                                title="Move to folder"
                              >
                                Folder
                              </button>
                            )}
                            {canManageWorkflows && projects.length > 1 && (
                              <button
                                className="header-btn"
                                onClick={() => void handleWorkflowAssignProject(workflow.id)}
                                disabled={busy}
                                title="Move to another project"
                              >
                                Project
                              </button>
                            )}
                            {canManageWorkflows && projects.length > 1 && (
                              <button
                                className="header-btn"
                                onClick={() =>
                                  setShareWorkflowTarget({
                                    id: workflow.id,
                                    name: workflow.name,
                                    projectId: workflow.projectId ?? activeProjectId
                                  })
                                }
                                disabled={busy}
                                title="Share with other projects"
                              >
                                Share
                              </button>
                            )}
                            {canManageWorkflows && (
                              <button
                                className="header-btn"
                                onClick={() => {
                                  void handleDuplicateWorkflow(workflow.id);
                                }}
                                disabled={busy}
                              >
                                Duplicate
                              </button>
                            )}
                            {canManageWorkflows && (
                              <button
                                className="header-btn danger"
                                onClick={() => {
                                  void handleDeleteWorkflow(workflow.id);
                                }}
                                disabled={busy}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}

          {activeMode === "editor" && (
            <WorkflowCanvasArea
              isLogsPanelCollapsed={isLogsPanelCollapsed}
              canvasAndLogsStyle={canvasAndLogsStyle}
              flowWrapperRef={flowWrapperRef}
              onDrop={onDrop}
              onDragOver={(event) => event.preventDefault()}
              showNodeDrawer={showNodeDrawer}
              nodeDrawerContext={nodeDrawerContext}
              onCloseNodeDrawer={() => {
                setShowNodeDrawer(false);
                setNodeDrawerContext(null);
              }}
              onOpenNodeDrawer={() => {
                setNodeDrawerContext(null);
                setShowNodeDrawer(true);
              }}
              groupedDefinitions={groupedDefinitions}
              onCreateNodeFromDefinition={(definition) => createNodeFromDefinition(definition, undefined, nodeDrawerContext)}
              onOpenAgentAttachmentDrawer={handleOpenAgentAttachmentDrawer}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={(changes) => {
                onEdgesChange(changes);
                setEdges((current) => current.map((edge) => decorateEdge(edge, nodes as EditorNode[])));
              }}
              onConnect={onConnect}
              onDeleteEdge={handleDeleteEdgeById}
              onInit={setReactFlowInstance}
              onOpenNodeConfig={openNodeConfig}
              reactFlowInstance={reactFlowInstance}
              onClearCanvas={() => {
                setNodes([]);
                setEdges([]);
                setExecutionResult(null);
                setEditingNodeId(null);
              }}
              debugMode={isDebugMode}
              onDebugModeChange={setIsDebugMode}
              onExecuteWorkflow={() => {
                void handleExecute();
              }}
              onExecuteWebhook={() => {
                void handleWebhookExecute();
              }}
              onCancelRun={() => {
                void handleCancelActiveRun();
              }}
              canCancelRun={busy && Boolean(runningExecutionId)}
              activeRunExecutionId={runningExecutionId}
              busy={busy}
              onLogsResizeStart={handleLogsResizeStart}
              logsTab={logsTab}
              onLogsTabChange={setLogsTab}
              onClearLogs={() => setExecutionResult(null)}
              onToggleLogsPanel={() => setIsLogsPanelCollapsed((value) => !value)}
              executionResult={executionResult}
              statusColors={statusColors}
              systemPrompt={systemPrompt}
              onSystemPromptChange={setSystemPrompt}
              userPrompt={userPrompt}
              onUserPromptChange={setUserPrompt}
              sessionId={sessionId}
              onSessionIdChange={setSessionId}
            />
          )}

          {activeMode === "variables" && (
            <section className="variables-pane">
              <div className="variables-pane-header">
                <div>
                  <h2>Workflow Variables</h2>
                  <p className="muted">
                    Define reusable key/value pairs available in templates as <code>{`{{vars.KEY}}`}</code>.
                  </p>
                </div>
                <div className="variables-pane-actions">
                  <button className="header-btn" onClick={handleAddVariableRow} disabled={!canManageWorkflows}>
                    Add Variable
                  </button>
                  <button
                    className="header-btn"
                    onClick={() => void handleSaveVariables()}
                    disabled={!canManageWorkflows || variablesBusy || !currentWorkflowExists}
                  >
                    {variablesBusy ? "Saving..." : "Save Variables"}
                  </button>
                </div>
              </div>

              {!currentWorkflowExists && (
                <div className="logs-placeholder">
                  Save this workflow first from Editor, then return here to manage variables.
                </div>
              )}

              {currentWorkflowExists && workflowVariableRows.length === 0 && (
                <div className="logs-placeholder">No variables yet. Add your first variable to start templating.</div>
              )}

              {currentWorkflowExists && workflowVariableRows.length > 0 && (
                <div className="variables-grid">
                  {workflowVariableRows.map((row) => (
                    <div key={row.id} className="variable-row">
                      <label>Key</label>
                      <input
                        value={row.key}
                        onChange={(event) => handleUpdateVariableRow(row.id, "key", event.target.value)}
                        placeholder="API_BASE_URL"
                        disabled={!canManageWorkflows}
                      />
                      <label>Value</label>
                      <textarea
                        value={row.value}
                        onChange={(event) => handleUpdateVariableRow(row.id, "value", event.target.value)}
                        rows={2}
                        placeholder="https://example.com"
                        disabled={!canManageWorkflows}
                      />
                      <button
                        className="header-btn danger"
                        onClick={() => handleRemoveVariableRow(row.id)}
                        disabled={!canManageWorkflows}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {false && activeMode === "editor" && (
            <div className="editor-layout">
              <section
                className={isLogsPanelCollapsed ? "canvas-and-logs logs-collapsed" : "canvas-and-logs"}
                style={canvasAndLogsStyle}
              >
                <div className="canvas-pane" ref={flowWrapperRef} onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
                  {showNodeDrawer && (
                    <div className="node-drawer">
                      <div className="node-drawer-header-row">
                        <div className="node-drawer-header">Node Library</div>
                        <button
                          className="node-drawer-close-btn"
                          onClick={() => setShowNodeDrawer(false)}
                          title="Close node library"
                          aria-label="Close node library"
                        >
                          ×
                        </button>
                      </div>
                      {[...groupedDefinitions.entries()].map(([category, items]) => (
                        <div key={category} className="node-category">
                          <div className="node-category-title">{category}</div>
                          <div className="node-list">
                            {items.map((item) => (
                              <button
                                key={item.type}
                                className="node-chip"
                                draggable
                                onDragStart={(event) => {
                                  event.dataTransfer.setData("application/reactflow", item.type);
                                  event.dataTransfer.effectAllowed = "move";
                                }}
                                onClick={() => createNodeFromDefinition(item)}
                                title={item.description}
                              >
                                <span>{item.label}</span>
                                <small>{item.type}</small>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={(changes) => {
                      onEdgesChange(changes);
                      setEdges((current) => current.map((edge) => decorateEdge(edge, nodes as EditorNode[])));
                    }}
                    onConnect={onConnect}
                    onInit={setReactFlowInstance}
                    onNodeDoubleClick={(_event, node) => openNodeConfig(node.id)}
                    fitView
                  >
                    <Background variant={BackgroundVariant.Dots} color="#d5dae3" gap={20} size={1} />
                  </ReactFlow>

                  <div className="canvas-controls-left">
                    <button onClick={() => reactFlowInstance?.fitView()}>Fit</button>
                    <button onClick={() => reactFlowInstance?.zoomIn()}>+</button>
                    <button onClick={() => reactFlowInstance?.zoomOut()}>-</button>
                    <button
                      onClick={() => {
                        setNodes([]);
                        setEdges([]);
                        setExecutionResult(null);
                        setEditingNodeId(null);
                      }}
                    >
                      Clear
                    </button>
                  </div>

                  {!showNodeDrawer && (
                    <button
                      className="node-drawer-open-btn"
                      onClick={() => setShowNodeDrawer(true)}
                      title="Open node library"
                      aria-label="Open node library"
                    >
                      +
                    </button>
                  )}

                  <div className="execute-strip">
                    <button className="execute-btn" onClick={() => void handleExecute()} disabled={busy}>
                      Execute workflow
                    </button>
                    <button className="execute-btn secondary" onClick={handleWebhookExecute} disabled={busy}>
                      Webhook run
                    </button>
                  </div>
                </div>

                <div
                  className={isLogsPanelCollapsed ? "logs-resize-handle disabled" : "logs-resize-handle"}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize logs panel"
                  onMouseDown={handleLogsResizeStart}
                />

                <div className="logs-pane">
                  <div className="logs-header">
                    <div className="logs-tabs">
                      <button className={logsTab === "logs" ? "logs-tab active" : "logs-tab"} onClick={() => setLogsTab("logs")}>
                        Logs
                      </button>
                      <button className={logsTab === "inputs" ? "logs-tab active" : "logs-tab"} onClick={() => setLogsTab("inputs")}>
                        Run Inputs
                      </button>
                    </div>

                    <div className="logs-header-actions">
                      {logsTab === "logs" ? (
                        <button
                          className="icon-btn"
                          onClick={() => setExecutionResult(null)}
                          title="Clear logs"
                          aria-label="Clear logs"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M6 7h12M9 7V5h6v2m-7 3v8m4-8v8m4-8v8M7 7l1 13h8l1-13"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      ) : (
                        <span className="muted">Used by Execute and Webhook run.</span>
                      )}
                      <button
                        className="icon-btn"
                        onClick={() => setIsLogsPanelCollapsed((value) => !value)}
                        title={isLogsPanelCollapsed ? "Expand panel" : "Minimize panel"}
                        aria-label={isLogsPanelCollapsed ? "Expand panel" : "Minimize panel"}
                      >
                        {isLogsPanelCollapsed ? (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M8 10l4-4 4 4M8 14l4 4 4-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M8 8l4 4 4-4M8 16l4-4 4 4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  {!isLogsPanelCollapsed && (
                    <div className="logs-body">
                      {logsTab === "inputs" && (
                        <div className="run-inputs-panel">
                          <label>System prompt</label>
                          <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={3} />
                          <label>User prompt</label>
                          <textarea value={userPrompt} onChange={(event) => setUserPrompt(event.target.value)} rows={3} />
                          <label>Session id</label>
                          <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
                          <div className="row-actions">
                            <button onClick={() => void handleExecute()} disabled={busy}>
                              Execute workflow
                            </button>
                            <button onClick={handleWebhookExecute} disabled={busy}>
                              Webhook run
                            </button>
                          </div>
                        </div>
                      )}

                      {logsTab === "logs" && !executionResult && (
                        <div className="logs-placeholder">Nothing to display yet. Execute the workflow to see logs.</div>
                      )}

                      {logsTab === "logs" && executionResult && (
                        <>
                          <div className="log-summary">
                            <span>
                              Status: <strong>{executionResult!.status}</strong>
                            </span>
                            <span>Started: {new Date(executionResult!.startedAt).toLocaleString()}</span>
                            <span>Completed: {new Date(executionResult!.completedAt).toLocaleString()}</span>
                          </div>
                          <div className="node-status-list">
                            {executionResult!.nodeResults.map((result) => (
                              <div key={result.nodeId} className="node-status-item">
                                <span>{result.nodeId}</span>
                                <strong style={{ color: statusColors[result.status] ?? "#657087" }}>{result.status}</strong>
                              </div>
                            ))}
                          </div>
                          <pre className="result-block">{stringifyPretty(executionResult!.output ?? executionResult!.error ?? "")}</pre>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}

          {activeMode === "executions" && (
            <ExecutionHistoryPanel
              executionHistoryTotal={executionHistoryTotal}
              executionsLoading={executionsLoading}
              executionsError={executionsError}
              executionHistoryItems={executionHistoryItems}
              workflowList={workflowList}
              filters={executionHistoryFilters}
              expandedExecutionIds={expandedExecutionIds}
              executionDetailById={executionDetailById}
              statusColors={statusColors}
              onFiltersChange={setExecutionHistoryFilters}
              onRefresh={() => {
                void refreshExecutionHistory();
              }}
              onToggleRow={(executionId) => toggleExecutionRow(executionId)}
              onDebugExecution={(executionId) => handleDebugExecution(executionId)}
              onRerunExecution={(executionId) => handleRerunExecution(executionId)}
              onCancelExecution={(executionId) => handleCancelExecution(executionId)}
            />
          )}

          {false && activeMode === "executions" && (
            <section className="executions-pane">
              <div className="executions-header-row">
                <div>
                  <h2>Runs</h2>
                  <p className="muted">Execution history and node-level traces ({executionHistoryTotal} total)</p>
                </div>
                <button className="header-btn" onClick={() => void refreshExecutionHistory()} disabled={executionsLoading}>
                  {executionsLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              {executionsError && <div className="error-banner">{executionsError}</div>}

              {!executionsLoading && executionHistoryItems.length === 0 && (
                <div className="logs-placeholder">No executions yet. Run a workflow from the editor to populate history.</div>
              )}

              {executionHistoryItems.length > 0 && (
                <div className="executions-table-wrap">
                  <table className="executions-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Workflow</th>
                        <th>Status</th>
                        <th>Trigger</th>
                        <th>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {executionHistoryItems.map((item) => {
                        const expanded = expandedExecutionIds.includes(item.id);
                        const detail = executionDetailById[item.id];
                        const nodeResults = Array.isArray(detail?.nodeResults) ? detail?.nodeResults : [];

                        return [
                          <tr
                            key={`${item.id}-summary`}
                            className={expanded ? "execution-row expanded" : "execution-row"}
                            onClick={() => {
                              void toggleExecutionRow(item.id);
                            }}
                          >
                            <td className="mono-cell">{item.id.slice(0, 8)}</td>
                            <td>{item.workflowName ?? item.workflowId}</td>
                            <td>
                              <strong style={{ color: statusColors[item.status] ?? "#657087" }}>{item.status}</strong>
                            </td>
                            <td>{item.triggerType ?? "unknown"}</td>
                            <td>{formatDuration(item.durationMs)}</td>
                          </tr>,
                          expanded ? (
                            <tr key={`${item.id}-detail`} className="execution-detail-row">
                              <td colSpan={5}>
                                {!detail && <div className="muted">Loading full trace...</div>}
                                {detail && (
                                  <div className="execution-trace">
                                    <div className="execution-trace-grid">
                                      {nodeResults.length === 0 && <div className="muted">No node-by-node trace available.</div>}
                                      {nodeResults.map((entry, index) => {
                                        const trace = asRecord(entry);
                                        const nodeId =
                                          typeof trace?.nodeId === "string" ? trace.nodeId : `node-${index + 1}`;
                                        const status =
                                          typeof trace?.status === "string" ? trace.status : "unknown";
                                        const durationMs =
                                          typeof trace?.durationMs === "number" ? trace.durationMs : null;
                                        const errorMessage =
                                          typeof trace?.error === "string" ? trace.error : "";

                                        return (
                                          <div key={`${item.id}-${nodeId}-${index}`} className="execution-trace-item">
                                            <span>{nodeId}</span>
                                            <strong style={{ color: statusColors[status] ?? "#657087" }}>{status}</strong>
                                            <span>{formatDuration(durationMs)}</span>
                                            {errorMessage && <span className="trace-error">{errorMessage}</span>}
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <pre className="result-block">{stringifyPretty(detail.output ?? detail.error ?? detail)}</pre>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ) : null
                        ];
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {activeMode === "chat" && (
            <section className="chat-pane">
              <div className="chat-pane-header">
                <div>
                  <h2>Chat</h2>
                  <p className="muted">
                    Streaming assistant bound to <strong>{currentWorkflow.name}</strong>
                  </p>
                </div>
                <div className="chat-session-chip">
                  <span>Session</span>
                  <code>{currentChatSessionId || "initializing..."}</code>
                </div>
              </div>

              <div className="chat-stream-shell">
                <div className="chat-history" ref={chatHistoryRef}>
                  {currentChatMessages.length === 0 && (
                    <div className="logs-placeholder">Start a conversation. Responses stream token-by-token from the workflow LLM nodes.</div>
                  )}

                  {currentChatMessages.map((entry) => (
                    <div
                      key={entry.id}
                      className={entry.role === "user" ? "chat-bubble chat-bubble-user" : "chat-bubble chat-bubble-assistant"}
                    >
                      <div className="chat-bubble-label">{entry.role === "user" ? "You" : "Assistant"}</div>
                      <div className="chat-bubble-text">
                        {entry.images && entry.images.length > 0 && (
                          <div className="chat-images">
                            {entry.images.map((img, idx) => (
                              <img key={idx} src={`data:${img.mimeType};base64,${img.data}`} alt="" className="chat-image" />
                            ))}
                          </div>
                        )}
                        {entry.role === "assistant" && entry.text && isPdfDataUrl(entry.text) ? (
                          <a href={entry.text} download="workflow-output.pdf" target="_blank" rel="noreferrer">
                            Download PDF
                          </a>
                        ) : (
                          entry.text || (entry.status === "streaming" ? "..." : "")
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="chat-side-trace">
                  <h4>Node Trace</h4>
                  {!isDebugMode && <div className="muted">Enable Debug mode in Editor to see live node trace.</div>}
                  {isDebugMode && chatNodeTrace.length === 0 && <div className="muted">Waiting for execution events.</div>}
                  {isDebugMode &&
                    chatNodeTrace.map((trace, index) => (
                      <div key={`${trace.nodeId}-${trace.at}-${index}`} className="chat-trace-item">
                        <span>{trace.nodeId}</span>
                        <strong style={{ color: statusColors[trace.status] ?? "#657087" }}>{trace.status}</strong>
                      </div>
                    ))}
                </div>
              </div>

              <form className="chat-input-row" onSubmit={handleChatSubmit}>
                <textarea
                  value={chatSystemPrompt}
                  onChange={(event) => setChatSystemPrompt(event.target.value)}
                  rows={2}
                  placeholder="Fallback system prompt (used when no System Prompt node sets one)"
                />
                {chatPendingImages.length > 0 && (
                  <div className="chat-pending-images">
                    {chatPendingImages.map((img, idx) => (
                      <div key={idx} className="chat-pending-image-thumb">
                        <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                        <button type="button" onClick={() => setChatPendingImages((prev) => prev.filter((_, i) => i !== idx))}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onPaste={(event) => {
                    const items = event.clipboardData?.items;
                    if (!items) return;
                    for (let i = 0; i < items.length; i++) {
                      const item = items[i];
                      if (item.type.startsWith("image/")) {
                        event.preventDefault();
                        const file = item.getAsFile();
                        if (!file) continue;
                        const reader = new FileReader();
                        reader.onload = () => {
                          const result = reader.result as string;
                          const base64 = result.split(",")[1] ?? "";
                          setChatPendingImages((prev) => [...prev, { data: base64, mimeType: item.type }]);
                        };
                        reader.readAsDataURL(file);
                      }
                    }
                  }}
                  placeholder={chatPendingImages.length > 0 ? `${chatPendingImages.length} image(s) attached — type your message...` : "Ask something..."}
                />
                <button type="submit" disabled={chatBusy || (!chatInput.trim() && chatPendingImages.length === 0)}>
                  {chatBusy ? "Streaming..." : "Send"}
                </button>
              </form>
              {chatError && <div className="error-banner">{chatError}</div>}
            </section>
          )}

          {activeMode === "evaluations" && (
            <section className="placeholder-pane">
              <h2>Evaluations</h2>
              <p>Evaluation dashboards are out of scope for V1. Use Editor and Executions for runtime validation.</p>
            </section>
          )}

          {activeMode === "templates" && (
            <TemplateGallery
              onWorkflowCreated={(workflowId) => {
                void loadWorkflowById(workflowId);
                setActiveMode("editor");
              }}
            />
          )}

          {activeMode === "secrets" && (
            <section className="secrets-page">
              <div className="secrets-page-header">
                <div>
                  <h2>Secrets</h2>
                  <p>Secrets are stored encrypted server-side and referenced by secret ID in node configs.</p>
                </div>
                <button className="header-btn" onClick={() => setActiveMode("editor")}>
                  Back to Editor
                </button>
              </div>

              <div className="secrets-grid">
                <article className="secrets-card">
                  <h3>Create Secret</h3>
                  <label>Name</label>
                  <input value={secretName} onChange={(event) => setSecretName(event.target.value)} />
                  <label>Provider</label>
                  <select
                    value={secretProvider}
                    onChange={(event) => setSecretProvider(event.target.value as SecretProviderPreset)}
                  >
                    {SECRET_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>

                  {secretProvider === "custom" && (
                    <>
                      <label>Custom Provider Name</label>
                      <input
                        value={secretCustomProvider}
                        onChange={(event) => setSecretCustomProvider(event.target.value)}
                        placeholder="my-provider"
                      />
                    </>
                  )}

                  {secretProvider === "google_drive" ? (
                    <>
                      <label>Google Auth Mode</label>
                      <select
                        value={secretGoogleAuthMode}
                        onChange={(event) =>
                          setSecretGoogleAuthMode(event.target.value as "access_token" | "service_account_json")
                        }
                      >
                        <option value="access_token">Access Token</option>
                        <option value="service_account_json">Service Account JSON</option>
                      </select>

                      {secretGoogleAuthMode === "access_token" ? (
                        <>
                          <label>Google Drive Access Token</label>
                          <input
                            type="password"
                            value={secretGoogleAccessToken}
                            onChange={(event) => setSecretGoogleAccessToken(event.target.value)}
                            placeholder="ya29..."
                          />
                        </>
                      ) : (
                        <>
                          <label>Google Service Account JSON</label>
                          <textarea
                            rows={7}
                            value={secretGoogleServiceAccountJson}
                            onChange={(event) => setSecretGoogleServiceAccountJson(event.target.value)}
                            placeholder='{"type":"service_account","client_email":"...","private_key":"..."}'
                          />
                        </>
                      )}
                    </>
                  ) : secretProvider === "postgres" ? (
                    <>
                      <label>Connection String</label>
                      <input
                        type="password"
                        value={secretConnectionString}
                        onChange={(event) => setSecretConnectionString(event.target.value)}
                        placeholder="postgresql://user:pass@host:5432/db"
                      />
                    </>
                  ) : (
                    <>
                      <label>
                        {secretProvider === "webhook"
                          ? "Shared Secret / Token"
                          : secretProvider === "custom"
                            ? "Secret Value"
                            : "API Key / Token"}
                      </label>
                      <input
                        type="password"
                        value={secretGenericValue}
                        onChange={(event) => setSecretGenericValue(event.target.value)}
                      />
                    </>
                  )}
                  <div className="row-actions">
                    <button onClick={handleCreateSecret} disabled={secretBusy || busy}>
                      Create
                    </button>
                    <button onClick={() => void refreshSecrets()} disabled={secretBusy || busy}>
                      Refresh
                    </button>
                  </div>
                </article>

                <article className="secrets-card">
                  <div className="secrets-card-header">
                    <h3>Saved Secrets</h3>
                    <span>{secrets.length}</span>
                  </div>
                  <div className="secret-list">
                    {secrets.map((secret) => (
                      <div key={secret.id} className="secret-item">
                        <strong>{secret.name}</strong>
                        <small>{secret.provider}</small>
                        <code>{secret.id}</code>
                        <div className="row-actions">
                          <button onClick={() => void copySecretId(secret.id)}>Copy ID</button>
                          <button
                            onClick={() => {
                              setActiveMode("editor");
                              setSecretMessage("Open an LLM/Agent node and pick this secret in Provider settings.");
                            }}
                          >
                            Use in Node
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              </div>

              <p className="muted secrets-hint">
                To attach a secret to an LLM or AI Agent node: go to Editor, double-click the node, then choose the secret in
                the Provider section.
              </p>
            </section>
          )}

          {activeMode === "settings" && (
            <SettingsPage
              authUser={authUser}
              projects={projects}
              activeProjectId={activeProjectId}
            />
          )}
        </main>
      </div>

      {shareWorkflowTarget && (
        <WorkflowShareModal
          workflowId={shareWorkflowTarget.id}
          workflowName={shareWorkflowTarget.name}
          owningProjectId={shareWorkflowTarget.projectId}
          projects={projects}
          onClose={() => setShareWorkflowTarget(null)}
        />
      )}

      {soloSelectedNode && radialCenter && (
        <RadialActionRing node={soloSelectedNode} center={radialCenter} onAction={onRadialAction} />
      )}
      {editingNode && (
        <NodeConfigModal
          node={editingNode}
          inputOptions={editingNodeInputOptions}
          executionResult={isDebugMode ? executionResult : null}
          workflowContext={{
            id: currentWorkflow.id,
            name: currentWorkflow.name,
            vars: currentWorkflow.variables
          }}
          pinnedData={currentWorkflow.pinnedData}
          showRuntimeInspection={isDebugMode}
          secrets={secrets}
          onRefreshSecrets={refreshSecrets}
          mcpServerDefinitions={mcpServerDefinitions}
          onClose={() => setEditingNodeId(null)}
          onSave={saveNodeConfig}
          onExecuteStep={() => {
            void handleExecute({ startNodeId: editingNode.id, runMode: "single_node" });
          }}
          onPinNodeOutput={handlePinNodeOutput}
          onUnpinNodeOutput={handleUnpinNodeOutput}
        />
      )}
      <KeyboardShortcutsPanel open={showShortcutsPanel} onClose={() => setShowShortcutsPanel(false)} />
    </div>
  );
}
