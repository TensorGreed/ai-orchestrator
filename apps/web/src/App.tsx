
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
  type Node,
  type ReactFlowInstance
} from "reactflow";
import {
  WORKFLOW_SCHEMA_VERSION,
  nodeDefinitions,
  type Workflow,
  type WorkflowExecutionResult
} from "@ai-orchestrator/shared";
import {
  ApiError,
  createSecret,
  deleteWorkflow,
  executeWorkflow,
  executeWorkflowStream,
  fetchAuthMe,
  fetchExecutionById,
  fetchExecutions,
  fetchDefinitions,
  fetchSecrets,
  fetchWorkflow,
  fetchWorkflowVariables,
  fetchWorkflows,
  importWorkflow,
  loginUser,
  logoutUser,
  runWebhookStream,
  saveWorkflow,
  updateWorkflowVariables,
  type AuthUser,
  type ExecutionHistoryDetail,
  type SecretListItem,
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
import { WorkflowCanvasNode } from "./components/WorkflowCanvasNode";
import { NodeConfigModal, type NodeInputOption } from "./components/NodeConfigModal";
import { LeftMenuBar } from "./components/LeftMenuBar";
import { StudioHeader } from "./components/StudioHeader";
import { ExecutionHistoryPanel } from "./components/ExecutionHistoryPanel";
import { WorkflowCanvasArea } from "./components/WorkflowCanvasArea";
import { StudioProvider, useStudioContext } from "./contexts/StudioContext";

interface DefinitionNode {
  type: string;
  label: string;
  category: string;
  description: string;
  sampleConfig: Record<string, unknown>;
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
}

interface WorkflowVariableRow {
  id: string;
  key: string;
  value: string;
}

const statusColors: Record<string, string> = {
  success: "#18a35f",
  error: "#d64545",
  skipped: "#7f8797",
  running: "#d68f16",
  pending: "#5b7bd8",
  waiting_approval: "#a154f2"
};
const auxiliaryHandles = new Set(["chat_model", "memory", "tool", "worker"]);
const agentPrimaryInputNodeTypes = new Set<EditorNodeData["nodeType"]>(["webhook_input", "text_input", "user_prompt"]);
const WIP_WORKFLOW_STORAGE_KEY = "ai-orchestrator:wip-workflow";
const LAST_WORKFLOW_ID_STORAGE_KEY = "ai-orchestrator:last-workflow-id";
const DEBUG_MODE_STORAGE_KEY = "ai-orchestrator:debug-mode";
const DEFAULT_LOGS_PANEL_HEIGHT = 210;
const MIN_LOGS_PANEL_HEIGHT = 140;
const MAX_LOGS_PANEL_HEIGHT = 620;
type SecretProviderPreset =
  | "openai"
  | "anthropic"
  | "gemini"
  | "google_drive"
  | "webhook"
  | "openai_compatible"
  | "ollama"
  | "pinecone"
  | "postgres"
  | "custom";
const SECRET_PROVIDER_OPTIONS: Array<{ value: SecretProviderPreset; label: string }> = [
  { value: "openai", label: "OpenAI" },
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
  const nextNodeResult: WorkflowExecutionResult["nodeResults"][number] = {
    nodeId: event.nodeId,
    status: "running",
    startedAt: event.startedAt
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

function normalizeEditorExecutionStatus(value: unknown): EditorNodeData["executionStatus"] {
  if (value === "pending" || value === "running" || value === "success" || value === "error" || value === "skipped") {
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
    type: "bezier",
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
    .filter((nodeId) => !attachmentOnlyNodeIds.has(nodeId));

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

  const [definitions, setDefinitions] = useState<DefinitionNode[]>(nodeDefinitions as unknown as DefinitionNode[]);
  const [mcpServerDefinitions, setMcpServerDefinitions] = useState<MCPServerDefinition[]>([]);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secretBusy, setSecretBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretMessage, setSecretMessage] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<WorkflowExecutionResult | null>(null);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [executionsError, setExecutionsError] = useState<string | null>(null);

  const [systemPrompt, setSystemPrompt] = useState("You are a precise tool-using AI assistant.");
  const [userPrompt, setUserPrompt] = useState("What time is it in America/Toronto? Use tools when needed.");
  const [sessionId, setSessionId] = useState("session-local-dev");
  const [chatInput, setChatInput] = useState("");
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
  const [workflowVariableRows, setWorkflowVariableRows] = useState<WorkflowVariableRow[]>([]);
  const [variablesBusy, setVariablesBusy] = useState(false);

  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [showNodeDrawer, setShowNodeDrawer] = useState(false);
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
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const nodeTypes = useMemo(
    () => ({
      workflowNode: WorkflowCanvasNode
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
  const currentWorkflowExists = workflowList.some((item) => item.id === currentWorkflow.id);
  const canManageWorkflows = authUser?.role === "admin" || authUser?.role === "builder";
  const canManageSecrets = authUser?.role === "admin" || authUser?.role === "builder";

  useEffect(() => {
    setWorkflowVariableRows(workflowVariablesToRows(currentWorkflow.variables));
  }, [currentWorkflow.id, currentWorkflow.variables]);

  const filteredWorkflowItems = useMemo(() => {
    const query = dashboardFilter.trim().toLowerCase();
    if (!query) {
      return workflowList;
    }
    return workflowList.filter((workflow) => {
      return (
        workflow.name.toLowerCase().includes(query) ||
        workflow.id.toLowerCase().includes(query)
      );
    });
  }, [dashboardFilter, workflowList]);
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
    latestDebugExecutionIdRef.current = null;
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
    stopVisualRun();
  }, [isDebugMode, stopVisualRun]);

  useEffect(() => {
    if (!isDebugMode || !authUser || !currentWorkflowExists) {
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

    void syncLatestExecution();
    const timerId = window.setInterval(() => {
      void syncLatestExecution();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [authUser, busy, currentWorkflow.id, currentWorkflowExists, isDebugMode]);

  useEffect(() => {
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          executionStatus: executionStatuses.get(node.id) as EditorNodeData["executionStatus"]
        }
      }))
    );
  }, [executionStatuses, setNodes]);

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
  }, [editingNodeId, edges, nodes, setEdges, setNodes]);

  const refreshSecrets = useCallback(async () => {
    if (!canManageSecrets) {
      setSecrets([]);
      return [];
    }
    const items = await fetchSecrets();
    setSecrets(items);
    return items;
  }, [canManageSecrets]);

  const refreshExecutionHistory = useCallback(async () => {
    try {
      setExecutionsLoading(true);
      setExecutionsError(null);
      const payload = await fetchExecutions({ page: 1, pageSize: 40 });
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
  }, []);

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

  const readWipWorkflow = useCallback((): Workflow | null => {
    try {
      const raw = localStorage.getItem(WIP_WORKFLOW_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Workflow;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.id !== "string" ||
        !Array.isArray(parsed.nodes) ||
        !Array.isArray(parsed.edges)
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
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
      const [workflowItems, definitionPayload, secretItems, executionPayload] = await Promise.all([
        fetchWorkflows(),
        fetchDefinitions(),
        canManageSecrets ? fetchSecrets() : Promise.resolve([]),
        fetchExecutions({ page: 1, pageSize: 40 })
      ]);

      setWorkflowList(workflowItems);
      setDefinitions(definitionPayload.nodes);
      setMcpServerDefinitions(definitionPayload.mcpServers);
      setSecrets(secretItems);
      setExecutionHistoryItems(executionPayload.items);
      setExecutionHistoryTotal(executionPayload.total);

      const wipWorkflow = readWipWorkflow();
      if (wipWorkflow) {
        hydrateWorkflow(wipWorkflow);
        return;
      }

      if (workflowItems[0]) {
        const rememberedId = localStorage.getItem(LAST_WORKFLOW_ID_STORAGE_KEY);
        const chosenWorkflow =
          rememberedId && workflowItems.some((item) => item.id === rememberedId) ? rememberedId : workflowItems[0].id;
        const workflow = await fetchWorkflow(chosenWorkflow);
        hydrateWorkflow(workflow);
      }
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
  }, [canManageSecrets, hydrateWorkflow, readWipWorkflow]);

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
      localStorage.setItem(WIP_WORKFLOW_STORAGE_KEY, JSON.stringify(snapshot));
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
        const workflow = await fetchWorkflow(id);
        hydrateWorkflow(workflow);
        localStorage.setItem(LAST_WORKFLOW_ID_STORAGE_KEY, id);
      } catch (loadError) {
        handleApiError(loadError, "Failed to load workflow");
      }
    },
    [handleApiError, hydrateWorkflow]
  );

  const buildCurrentWorkflow = useCallback(() => {
    return editorToWorkflow(currentWorkflow, nodes as EditorNode[], edges as Edge[]);
  }, [currentWorkflow, edges, nodes]);

  const persistWorkflow = useCallback(async () => {
    const workflow = buildCurrentWorkflow();
    const saved = await saveWorkflow(workflow);
    const workflows = await fetchWorkflows();
    setWorkflowList(workflows);
    setCurrentWorkflow(saved);
    localStorage.setItem(LAST_WORKFLOW_ID_STORAGE_KEY, saved.id);
    localStorage.setItem(WIP_WORKFLOW_STORAGE_KEY, JSON.stringify(saved));
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
        localStorage.setItem(WIP_WORKFLOW_STORAGE_KEY, JSON.stringify(snapshot));
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

  const buildEditorExecutionPayload = useCallback(() => {
    const payload: {
      sessionId: string;
      system_prompt?: string;
      user_prompt?: string;
    } = {
      sessionId
    };

    if (!promptNodeSources.systemPromptFromNodes) {
      payload.system_prompt = systemPrompt;
    }

    if (!promptNodeSources.userPromptFromNodes) {
      payload.user_prompt = userPrompt;
    }

    return payload;
  }, [promptNodeSources.systemPromptFromNodes, promptNodeSources.userPromptFromNodes, sessionId, systemPrompt, userPrompt]);

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

  const handleExecute = useCallback(async () => {
    try {
      setBusy(true);
      setError(null);
      let initializedTrace = false;
      let initializedStatuses = false;
      const saved = await persistWorkflow();
      const result = await executeWorkflowStream(saved.id, buildEditorExecutionPayload(), {
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
      setBusy(false);
    }
  }, [
    currentWorkflow.id,
    buildEditorExecutionPayload,
    executeWorkflowStream,
    handleApiError,
    isDebugMode,
    persistWorkflow,
    refreshExecutionHistory,
  ]);

  const handleWebhookExecute = useCallback(async () => {
    try {
      setBusy(true);
      setError(null);
      startVisualRun();
      let initializedTrace = false;
      let initializedStatuses = false;
      const saved = await persistWorkflow();
      const result = await runWebhookStream({
        workflow_id: saved.id,
        ...buildWebhookExecutionPayload()
      }, {
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
      setBusy(false);
    }
  }, [
    currentWorkflow.id,
    buildWebhookExecutionPayload,
    handleApiError,
    isDebugMode,
    persistWorkflow,
    refreshExecutionHistory,
    runWebhookStream,
    startVisualRun,
    stopVisualRun,
  ]);

  const handleChatSend = useCallback(async () => {
    if (!chatInput.trim() || chatBusy) {
      return;
    }

    const message = chatInput.trim();
    setChatInput("");
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
        status: "done"
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

      const chatExecutionPayload: {
        user_prompt: string;
        system_prompt?: string;
        sessionId: string;
        session_id: string;
      } = {
        user_prompt: message,
        sessionId: sessionForWorkflow,
        session_id: sessionForWorkflow
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
        const workflows = await fetchWorkflows();
        setWorkflowList(workflows);
        hydrateWorkflow(imported);
        localStorage.setItem(LAST_WORKFLOW_ID_STORAGE_KEY, imported.id);
        localStorage.setItem(WIP_WORKFLOW_STORAGE_KEY, JSON.stringify(imported));
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
      const workflows = await fetchWorkflows();
      setWorkflowList(workflows);
      hydrateWorkflow(savedDraft);
      setActiveMode("editor");
      localStorage.setItem(LAST_WORKFLOW_ID_STORAGE_KEY, savedDraft.id);
      localStorage.setItem(WIP_WORKFLOW_STORAGE_KEY, JSON.stringify(savedDraft));
    } catch (createError) {
      handleApiError(createError, "Failed to create workflow");
    } finally {
      setBusy(false);
    }
  }, [canManageWorkflows, handleApiError, hydrateWorkflow, workflowList.length]);

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
        const workflows = await fetchWorkflows();
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
          }
        }
      } catch (deleteError) {
        handleApiError(deleteError, "Failed to delete workflow");
      } finally {
        setBusy(false);
      }
    },
    [canManageWorkflows, currentWorkflow.id, handleApiError, hydrateWorkflow, setEdges, setNodes, workflowList]
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

  const openNodeConfig = useCallback((nodeId: string) => {
    setEditingNodeId(nodeId);
  }, []);

  const saveNodeConfig = useCallback(
    (payload: { label: string; config: Record<string, unknown> }) => {
      if (!editingNodeId) {
        return;
      }

      const normalizedLabel = payload.label.trim();
      setNodes((existing) =>
        existing.map((node) =>
          node.id === editingNodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  label: normalizedLabel || node.data.label,
                  config: payload.config
                }
              }
            : node
        )
      );
      setEditingNodeId(null);
      setError(null);
    },
    [editingNodeId, setNodes]
  );

  const createNodeFromDefinition = useCallback(
    (definition: DefinitionNode, position?: { x: number; y: number }) => {
      const id = createNodeId(definition.type as EditorNodeData["nodeType"]);
      const fallbackPosition = reactFlowInstance
        ? reactFlowInstance.project({ x: window.innerWidth / 2 - 120, y: 180 })
        : { x: 160, y: 120 };

      const newNode: Node<EditorNodeData> = {
        id,
        type: "workflowNode",
        position: position ?? fallbackPosition,
        data: {
          label: definition.label,
          nodeType: definition.type as EditorNodeData["nodeType"],
          config: definition.sampleConfig ?? {}
        }
      };

      setNodes((existing) => [...existing, newNode]);
    },
    [reactFlowInstance, setNodes]
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
        chat_model: "llm_call",
        memory: "local_memory",
        tool: "mcp_tool",
        worker: ["agent_orchestrator", "supervisor_node"]
      };
      const expectedHandleByTargetType: Partial<Record<EditorNodeData["nodeType"], string>> = {
        llm_call: "chat_model",
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
  }, [setEdges, setNodes, stopVisualRun]);

  if (authChecking) {
    return <div className="loading-screen">Checking session...</div>;
  }

  if (!authUser) {
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
          <label>Email</label>
          <input
            type="email"
            value={loginEmail}
            onChange={(event) => setLoginEmail(event.target.value)}
            autoComplete="username"
            required
          />
          <label>Password</label>
          <input
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

  if (loading) {
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
        />

        <main className="main-content">
          {error && <div className="error-banner global-banner">{error}</div>}
          {secretMessage && <div className="info-banner global-banner">{secretMessage}</div>}

          {activeMode === "dashboard" && (
            <section className="dashboard-pane">
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
                  placeholder="Search by workflow name or ID"
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
                    ? "No workflows saved yet. Create one from this dashboard."
                    : "No workflows match your search."}
                </div>
              )}

              {filteredWorkflowItems.length > 0 && (
                <div className="dashboard-grid">
                  {filteredWorkflowItems.map((workflow) => (
                    <article key={workflow.id} className="dashboard-card">
                      <div className="dashboard-card-head">
                        <h3>{workflow.name}</h3>
                        <span className="mono-cell">{workflow.id.slice(0, 8)}</span>
                      </div>
                      <div className="dashboard-card-meta">
                        <span>Updated: {formatWhen(workflow.updatedAt)}</span>
                        <span>Version: {workflow.workflowVersion}</span>
                      </div>
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
                  ))}
                </div>
              )}
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
              onCloseNodeDrawer={() => setShowNodeDrawer(false)}
              onOpenNodeDrawer={() => setShowNodeDrawer(true)}
              groupedDefinitions={groupedDefinitions}
              onCreateNodeFromDefinition={(definition) => createNodeFromDefinition(definition)}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={(changes) => {
                onEdgesChange(changes);
                setEdges((current) => current.map((edge) => decorateEdge(edge, nodes as EditorNode[])));
              }}
              onConnect={onConnect}
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
                    <button className="execute-btn" onClick={handleExecute} disabled={busy}>
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
                            <button onClick={handleExecute} disabled={busy}>
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
              expandedExecutionIds={expandedExecutionIds}
              executionDetailById={executionDetailById}
              statusColors={statusColors}
              onRefresh={() => {
                void refreshExecutionHistory();
              }}
              onToggleRow={(executionId) => toggleExecutionRow(executionId)}
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
                <input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Ask something..."
                />
                <button type="submit" disabled={chatBusy || !chatInput.trim()}>
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
        </main>
      </div>

      {editingNode && (
        <NodeConfigModal
          node={editingNode}
          inputOptions={editingNodeInputOptions}
          executionResult={isDebugMode ? executionResult : null}
          showRuntimeInspection={isDebugMode}
          secrets={secrets}
          onRefreshSecrets={refreshSecrets}
          mcpServerDefinitions={mcpServerDefinitions}
          onClose={() => setEditingNodeId(null)}
          onSave={saveNodeConfig}
          onExecuteStep={() => {
            void handleExecute();
          }}
        />
      )}
    </div>
  );
}
