
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
  editorRunPrompts,
  nodeDefinitions,
  pickDefaultModelProvider,
  readsFilterRejected,
  repairNodeErrorConfig,
  withDefaultModelProvider,
  type Folder,
  type McpElicitationView,
  type Project,
  type ImportReport,
  type NodeExecutionResult,
  type Workflow,
  type WorkflowExecutionResult,
  type WorkflowListItem,
  type WorkflowValidationIssue
} from "@ai-orchestrator/shared";
import type { CatalogPaletteEntry, CatalogSourceSummary } from "@ai-orchestrator/shared";
import {
  ApiError,
  inBackground,
  notifySessionEnded,
  onSessionEnded,
  sessionEndMessage,
  sessionEndReasonOf,
  type SessionEndReason,
  type SessionInfo,
  cancelExecution,
  completeMfaLogin,
  createFolder,
  createProject,
  createSecret,
  setSecretSensitiveOutput,
  deleteWorkflowPin,
  deleteFolder,
  deleteProject,
  deleteWorkflow,
  duplicateWorkflow,
  fetchReleaseState,
  executeWorkflow,
  executeWorkflowStream,
  fetchAuthMe,
  mfaGateFromMe,
  setAuthChallengeHandlers,
  type MfaGate,
  fetchOidcLoginUrl,
  isSsoMfaLanding,
  SSO_MFA_CHALLENGE,
  stripSsoLandingParams,
  ssoErrorMessage,
  fetchExecutionById,
  fetchExecutions,
  fetchDefinitions,
  fetchIntegrationCatalog,
  fetchFolders,
  fetchProjects,
  fetchSecrets,
  fetchWorkflow,
  fetchWorkflowNodeIds,
  fetchWorkflowVariables,
  fetchWorkflows,
  importExternalWorkflow,
  importWorkflow,
  previewWorkflowImport,
  fetchWorkflowAccess,
  fetchWorkflowsSharedWithMe,
  fetchProjectSharedWorkflows,
  type ProjectSharedWorkflowItem,
  type SharedWorkflowItem,
  type WorkflowImportPreview,
  listApprovals,
  validateStoredWorkflow,
  isMfaChallenge,
  loginUser,
  logoutUser,
  moveWorkflow,
  replayExecution,
  retryExecution,
  runWebhookStream,
  saveWorkflow,
  useTemplate as instantiateTemplate,
  fetchWorkflowBuilderStatus,
  saveWorkflowPin,
  updateWorkflowVariables,
  type AuthUser,
  type ExecutionHistoryDetail,
  type McpReplayMode,
  type SecretListItem,
  type StreamExecutionStartedEvent
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
import { AGENT_ATTACHMENT_STYLES } from "./lib/agent-attachments";
import {
  buildExecutionErrorResult,
  buildStreamFailureResult,
  createPartialExecutionResult,
  createTraceStreamHandlers,
  pickStreamFailureMessage,
  tailPreview,
  currentActivity,
  describeActivity,
  traceStreamCallbacks,
  type LiveNodeResult,
  type TraceStreamHandlers
} from "./lib/run-trace";
import { ORBIT, attachedNodeIds, computeAttachmentSlots, orbitPositions } from "./lib/stages";
import { chooseSourceHandle, findFreePosition, insertPositionAfter, planInsertConnection } from "./lib/canvas-insert";
import { canvasRunPreview, hasTestData, loopPassResults } from "./lib/run-data";
import { isDirectLoopBodyNode, newNodeConfig } from "./lib/new-node-config";
import { copyWorkflowName, nextNewWorkflowName, workflowPickerLabels } from "./lib/workflow-names";
import {
  deleteTabWipWorkflow,
  preferTabWip,
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
import { AttachmentSpokeEdge, WorkflowCanvasEdge } from "./components/WorkflowCanvasEdge";
import {
  NodeInspector,
  buildNodeSlots,
  buildNodeTrace,
  type NodeInputOption,
  type NodeInspectorHandle
} from "./components/NodeConfigModal";
import { LeftMenuBar } from "./components/LeftMenuBar";
import { StudioHeader } from "./components/StudioHeader";
import { deriveRunStatus, isMcpMode, type StudioMode } from "./components/studio-layout-types";
import { ExecutionHistoryPanel } from "./components/ExecutionHistoryPanel";
import { RunPicker } from "./components/RunPicker";
import { McpElicitationForm } from "./components/McpElicitationForm";
import { SettingsPage } from "./components/SettingsPage";
import { KnowledgeBasePage } from "./components/KnowledgeBasePage";
import { McpServersPage } from "./components/McpServersPage";
import { McpOverviewPage } from "./components/McpOverviewPage";
import { McpMyConnectionsPage } from "./components/McpRuntimeSafety";
import { GuardSecurityPage } from "./components/GuardSecurityPage";
import { EvaluationsPage, type EvaluationsTab } from "./components/EvaluationsPage";
import { ReleasePill } from "./components/ReleaseControls";
import { workflowDeleteDenial } from "./lib/release";
import { ApprovalsPage } from "./components/ApprovalsPage";
import { McpToolsPage } from "./components/McpToolsPage";
import { McpChangesPage } from "./components/McpChangesPage";
import type { McpNavTarget } from "./lib/mcp-control-plane";
import { useMcpCanvasStatus } from "./lib/use-mcp-canvas-status";
import { TemplateGallery } from "./components/TemplateGallery";
import { WelcomeModal, isWelcomeDismissed, markWelcomeDismissed } from "./components/WelcomeModal";
import { HomeStarters } from "./components/HomeStarters";
import { AcceptInviteCard } from "./components/AcceptInviteCard";
import { IdleSessionWarning } from "./components/IdleSessionWarning";
import { INVITE_SIGNED_IN_NOTICE, inviteTokenFromLocation, stripInviteParam } from "./lib/user-invite";
import { WorkflowShareModal } from "./components/WorkflowShareModal";
import { WriteToolApprovalDialog } from "./components/WriteToolApprovalDialog";
import { SubjectRefsDialog } from "./components/SubjectRefsDialog";
import { ErrorWorkflowDialog } from "./components/ErrorWorkflowDialog";
import { WorkflowCardMenu } from "./components/WorkflowCardMenu";
import { WorkflowCanvasArea, type ImportPanelBinding } from "./components/WorkflowCanvasArea";
import { ExternalImportDialog, type ExternalImportSource } from "./components/ExternalImportDialog";
import { ImportConflictDialog, type ImportConflictChoice } from "./components/ImportConflictDialog";
import { editorAccess, mayUseEditorRunOptions, type WorkflowAccessView } from "./lib/editor-access";
import { useEditableWorkflows } from "./lib/editable-workflows";
import { SecretSaveWarnings } from "./components/SecretSaveWarnings";
import { DraftWarnings } from "./components/DraftWarnings";
import { WebhookTestPayloadDialog } from "./components/WebhookTestPayloadDialog";
import { WorkflowBuilderDialog } from "./components/WorkflowBuilderDialog";
import { apiErrorText, draftIssueShown } from "./lib/draft-validation";
import { canvasLabelBadge, type CanvasLabelBadge } from "./lib/taint-sources";
import {
  forgetImportReport,
  inspectImportText,
  recallImportReport,
  rememberImportReport,
  replaceSecretRefs
} from "./lib/external-import";
import { StudioProvider, useStudioContext } from "./contexts/StudioContext";
import { MfaGateCard } from "./components/MfaGateCard";
import { StepUpPrompt } from "./components/StepUpPrompt";
import { isPaletteDefinition, withAgentToolPresets } from "./lib/agent-tool-presets";
import { canUseIntegrationCatalog, catalogPresets } from "./lib/integration-catalog";
import { ApiCatalogDialog } from "./components/ApiCatalogDialog";
import { paletteKey } from "./components/NodePalette";
import { GraphHistory, movedNodeIds } from "./lib/graph-history";
import { AUXILIARY_HANDLES, CHAT_MODEL_NODE_TYPES, validateConnection } from "./lib/connection-rules";
import { BreakGlassBanner } from "./components/BreakGlassBanner";
import { BreakGlassConfirmCard } from "./components/BreakGlassConfirmCard";
import { breakGlassLinkFromHash, stripBreakGlassFragment, type BreakGlassLink } from "./lib/break-glass";

interface DefinitionNode {
  type: string;
  label: string;
  category: string;
  description: string;
  sampleConfig: Record<string, unknown>;
  /** Set when the node cannot run in this build: it is left out of the palette (stored workflows keep it). */
  unavailable?: string;
}

type AgentAttachmentHandle = "chat_model" | "memory" | "tool" | "worker" | "guard" | "protection";

/** The output a node added from the palette connects after, and where to put it when a connection was dropped. */
interface PaletteInsertSource {
  nodeId: string;
  handle: string | null;
  position?: { x: number; y: number };
}

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
  /**
   * Phase 9.4 — citations resolved by `extract_citations` from the
   * workflow output. Each citation maps a `[N]` marker in the answer
   * text to a retrieved document chunk; `ChatBubbleText` renders them
   * as clickable footnotes with hover previews.
   */
  citations?: ChatCitation[];
  /**
   * Phase: agent_clarify — populated when the agent paused and called
   * the built-in `agent_clarify` tool to ask the user a question. Lets
   * the bubble render with a "?" badge + reason hint, so users can tell
   * "the agent is waiting on you" apart from a finished answer. The
   * next user message resumes naturally via session memory continuity.
   */
  clarification?: {
    question: string;
    reason?: string;
  };
  /**
   * Phase 10.5 — questions MCP servers asked during this turn
   * (`elicitation/create`). A pending one renders as a form inside the
   * bubble; the run resumes once it is answered.
   */
  elicitations?: McpElicitationView[];
}

export interface ChatCitation {
  marker: string;
  index: number;
  chunkId?: string;
  sourceId?: string | null;
  knowledgeBaseId?: string;
  text: string;
  similarityScore?: number;
  rerankerScore?: number;
  retrievalMode?: string;
  startIndex: number;
  endIndex: number;
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
  /** Node fields the editor keeps but does not edit (errorConfig, ...). */
  nodeExtras?: Record<string, unknown>;
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
const auxiliaryHandles = AUXILIARY_HANDLES;
const chatModelNodeTypes = CHAT_MODEL_NODE_TYPES;
// LLM Call is offered too: its provider picker includes the built-in Echo model, which runs without a key.
const chatModelDrawerNodeTypes = chatModelNodeTypes;

function buildAgentAttachmentDrawerContext(sourceNodeId: string, sourceHandle: AgentAttachmentHandle): NodeDrawerContext {
  if (sourceHandle === "chat_model") {
    return {
      title: "Language Models",
      description: "Choose a chat model to attach to this AI Agent. LLM Call can use the built-in Echo model, no key needed.",
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

  if (sourceHandle === "guard") {
    return {
      title: "Content rules",
      description: "Attach a Content Rules node to check this agent's prompts, tool calls, tool results and final answer.",
      allowedTypes: ["guard"],
      sourceNodeId,
      sourceHandle
    };
  }

  if (sourceHandle === "protection") {
    return {
      title: "Protection",
      description: "Attach a protection provider for the sensitive data these content rules find.",
      allowedTypes: ["guard_protection"],
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
    description: "Choose a tool node to attach to this AI Agent: an MCP server, a built-in tool, or another workflow.",
    allowedTypes: ["mcp_tool", "workflow_tool"],
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

/** The workflow with its "Webhook run" test payload set (an empty payload removes it). */
function withTestWebhookPayload(workflow: Workflow, payload: Record<string, unknown>): Workflow {
  const { testWebhookPayload: _previous, ...settings } = workflow.settings ?? {};
  if (Object.keys(payload).length > 0) return { ...workflow, settings: { ...settings, testWebhookPayload: payload } };
  return workflow.settings ? { ...workflow, settings } : workflow;
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

/**
 * Phase 9.4 — chat bubble that turns `[N]` markers in the answer text into
 * clickable superscript links. Each link scrolls to / highlights the
 * corresponding entry in the citation footer below the bubble.
 *
 * The strategy is segment-based: walk the citations sorted by startIndex,
 * slice the answer into (text-before-marker, link, text-after-marker)
 * segments, and render each as either a plain string or a <sup> link.
 * Citations that share the same marker offset (rare but possible if the
 * regex overlapped) are deduped by `marker + startIndex`.
 */
function ChatBubbleWithCitations({ text, citations }: { text: string; citations: ChatCitation[] }) {
  const sorted = [...citations].sort((a, b) => a.startIndex - b.startIndex);
  const segments: Array<{ kind: "text"; value: string } | { kind: "cite"; citation: ChatCitation }> = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.startIndex < cursor) continue; // skip overlap
    if (c.startIndex > cursor) {
      segments.push({ kind: "text", value: text.slice(cursor, c.startIndex) });
    }
    segments.push({ kind: "cite", citation: c });
    cursor = c.endIndex;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", value: text.slice(cursor) });
  }

  return (
    <span className="chat-citation-text">
      {segments.map((seg, idx) =>
        seg.kind === "text" ? (
          <span key={idx}>{seg.value}</span>
        ) : (
          <a
            key={idx}
            href={`#citation-${seg.citation.index}`}
            className="chat-citation-marker"
            title={seg.citation.text.slice(0, 200)}
            onClick={(e) => {
              // Soft scroll within the chat pane rather than full anchor jump
              e.preventDefault();
              const el = document.getElementById(`citation-${seg.citation.index}`);
              el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
              el?.classList.add("chat-citation-flash");
              window.setTimeout(() => el?.classList.remove("chat-citation-flash"), 1200);
            }}
          >
            <sup>[{seg.citation.index}]</sup>
          </a>
        )
      )}
    </span>
  );
}

/**
 * Phase 9.4 — sources panel below an assistant bubble. Lists each unique
 * cited chunk with a preview, the score (similarity / reranker if present),
 * and the source ID. Multiple `[N]` markers that resolve to the same chunk
 * collapse to one footer entry.
 */
function CitationFooter({ citations }: { citations: ChatCitation[] }) {
  // Dedupe by chunkId (or index when chunkId missing) — preserve first-seen order
  const seen = new Set<string>();
  const unique: ChatCitation[] = [];
  for (const c of citations) {
    const key = c.chunkId ?? `idx:${c.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  return (
    <ol className="chat-citation-footer">
      {unique.map((c) => {
        const score = c.rerankerScore ?? c.similarityScore;
        return (
          <li key={c.chunkId ?? `cite-${c.index}`} id={`citation-${c.index}`} className="chat-citation-source">
            <div className="chat-citation-source-head">
              <span className="chat-citation-source-num">[{c.index}]</span>
              {c.sourceId && <code className="chat-citation-source-id">{c.sourceId}</code>}
              {c.retrievalMode && <span className="chat-citation-tag">{c.retrievalMode}</span>}
              {typeof score === "number" && <span className="chat-citation-score">score {score.toFixed(3)}</span>}
            </div>
            <div className="chat-citation-source-text">{c.text}</div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Phase 9.4 — find an `extract_citations` node output in a workflow's
 * nodeResults, if any. Returns the structured citations array so the
 * chat bubble can render `[N]` markers as clickable footnotes. Multiple
 * extract_citations nodes return the LAST one's citations (later in the
 * graph wins, matching workflow execution semantics).
 */
function findCitationsInExecution(result: WorkflowExecutionResult | null): ChatCitation[] | undefined {
  if (!result || !Array.isArray(result.nodeResults)) return undefined;
  let found: ChatCitation[] | undefined;
  for (const nr of result.nodeResults) {
    const out = (nr as { output?: unknown }).output;
    if (!out || typeof out !== "object") continue;
    const cits = (out as { citations?: unknown }).citations;
    if (Array.isArray(cits) && cits.length > 0 && cits.every((c) => c && typeof c === "object" && "marker" in (c as object))) {
      found = cits as ChatCitation[];
    }
  }
  return found;
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

function decorateEdge(edge: Edge, nodes: EditorNode[]): Edge {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);

  // Three categories: agent attachment (named handle), generic auxiliary
  // (aux* handles or implicit auxiliary targets), or normal execution.
  const attachmentHandle =
    edge.sourceHandle && auxiliaryHandles.has(edge.sourceHandle)
      ? edge.sourceHandle
      : edge.targetHandle && auxiliaryHandles.has(edge.targetHandle)
        ? edge.targetHandle
        : null;
  const attachmentStyle =
    attachmentHandle && attachmentHandle in AGENT_ATTACHMENT_STYLES
      ? AGENT_ATTACHMENT_STYLES[attachmentHandle as keyof typeof AGENT_ATTACHMENT_STYLES]
      : null;

  const isGenericAuxiliary =
    !attachmentStyle &&
    (edge.sourceHandle?.startsWith("aux") ||
      edge.targetHandle?.startsWith("aux") ||
      target?.data.nodeType === "mcp_tool" ||
      target?.data.nodeType === "connector_source" ||
      target?.data.nodeType === "google_drive_source");

  const isAuxiliary = Boolean(attachmentStyle) || Boolean(isGenericAuxiliary);
  // Colours are tokens so both themes resolve them (see src/styles/tokens.css).
  const isErrorOutputEdge = !isAuxiliary && edge.sourceHandle === "error";
  const stroke = attachmentStyle?.stroke ?? (isAuxiliary ? "var(--line-strong)" : isErrorOutputEdge ? "var(--err)" : "var(--edge)");

  // Workers represent recursive Supervisor delegation — give them a slightly
  // thicker line so the hierarchy reads even in dense graphs.
  const isWorkerEdge = attachmentHandle === "worker";

  // Create an explicit label. Attachment edges carry their port name so users
  // can distinguish chat_model / memory / tool / worker without hovering.
  let label: string | undefined = undefined;
  const labelBgStyle = { fill: "var(--bg-elev)", color: "var(--fg-muted)", border: "1px solid var(--line)" };
  const labelStyle = { fill: "var(--fg-muted)", fontWeight: 600, fontSize: 10 };

  if (attachmentStyle) {
    // Spokes carry their port in the stroke colour and the hub slot — no label.
    label = undefined;
  } else if (!isAuxiliary && edge.sourceHandle) {
    if (edge.sourceHandle === "true") label = "True";
    else if (edge.sourceHandle === "false") label = "False";
    else if (edge.sourceHandle === "success") label = "Try (Success)";
    else if (edge.sourceHandle === "error") label = source?.data.nodeType === "try_catch" ? "Catch (Error)" : "Error";
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
    // Attachment edges (chat_model / memory / tool / worker) are straight
    // spokes from the hub to the orbiting node; DAG edges stay bezier.
    type: attachmentStyle ? "attachmentSpoke" : "workflowBezier",
    animated: Boolean(isGenericAuxiliary),
    label,
    labelBgPadding: [8, 4],
    labelBgBorderRadius: 4,
    labelBgStyle,
    labelStyle,
    // Arrowhead colour comes from CSS (`.react-flow__arrowhead`), the marker
    // id cannot carry a CSS variable.
    markerEnd: attachmentStyle ? undefined : { type: MarkerType.ArrowClosed },
    style: {
      ...(edge.style ?? {}),
      stroke,
      strokeWidth: isWorkerEdge ? 2 : isAuxiliary ? 1.5 : 1.75,
      strokeDasharray: isWorkerEdge ? "6 5" : isGenericAuxiliary ? "6 6" : undefined
    },
    data: {
      ...(edge.data ?? {}),
      sourceType: source?.data.nodeType,
      targetType: target?.data.nodeType,
      attachmentHandle: attachmentHandle ?? undefined
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

const CANCEL_REQUESTED_MESSAGE = "Cancellation requested. Waiting for workflow to stop.";

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

/**
 * Canvas shortcuts (undo, delete, copy and paste, disable) do nothing while the user types, or while a modal layer
 * (such as the node inspector over the dimmed editor) is open: they would act on the canvas behind it.
 */
function isCanvasShortcutBlocked(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true;
  return typeof document !== "undefined" && document.querySelector('[aria-modal="true"]') !== null;
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

const MCP_MODE_BY_PAGE: Record<McpNavTarget["page"], StudioMode> = {
  overview: "mcp",
  servers: "mcp-servers",
  tools: "mcp-tools",
  policies: "mcp-policies",
  toolsets: "mcp-toolsets",
  clients: "mcp-clients",
  playground: "mcp-playground",
  changes: "mcp-changes"
};

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
  // Phase 13.2 — the session behind the cookie (undefined until known; null for API-key auth or an older API).
  const [authSession, setAuthSession] = useState<SessionInfo | null | undefined>(undefined);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  // Phase 13.2 — an SSO sign-in that needs the local TOTP step lands here with ?sso_mfa=totp (the challenge itself is in
  // an HttpOnly cookie), and goes straight to the verification code form.
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(() =>
    typeof window !== "undefined" && isSsoMfaLanding(window.location.search) ? SSO_MFA_CHALLENGE : null
  );
  const [mfaCode, setMfaCode] = useState("");
  // 13.2 — a session restricted by MFA_REQUIRED_ROLES: it can only set up (`enroll`) or verify (`verify`) MFA.
  const [mfaGate, setMfaGate] = useState<MfaGate | null>(null);
  useEffect(() => {
    setAuthChallengeHandlers({ onMfaGate: setMfaGate });
    return () => setAuthChallengeHandlers({ onMfaGate: undefined });
  }, []);
  // Phase 13.2 — set when the API has OIDC SSO on; the login card then offers "Sign in with SSO (OIDC)".
  const [oidcLoginUrl, setOidcLoginUrl] = useState<string | null>(null);
  // Phase 13.2 — a failed SSO login comes back as ?sso_error=<code>; show it once and drop it from the URL.
  const [ssoError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const code = new URLSearchParams(window.location.search).get("sso_error");
    return code ? ssoErrorMessage(code) : null;
  });
  // Roadmap 7.3 — an invite link (#invite=<token>) opens the accept form; the token leaves the address bar at once.
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    typeof window === "undefined" ? null : inviteTokenFromLocation(window.location.search, window.location.hash)
  );
  // 13.2 — a break-glass link (#break_glass=<token>) opens its confirm page; the token leaves the address bar at once.
  const [breakGlassLink, setBreakGlassLink] = useState<BreakGlassLink | null>(() =>
    typeof window === "undefined" ? null : breakGlassLinkFromHash(window.location.hash)
  );
  useEffect(() => {
    const cleaned = stripBreakGlassFragment(window.location.pathname, window.location.search, window.location.hash);
    if (cleaned !== null) window.history.replaceState(window.history.state, "", cleaned);
  }, []);
  useEffect(() => {
    const cleaned = stripInviteParam(window.location.pathname, window.location.search, window.location.hash);
    if (cleaned !== null) window.history.replaceState(window.history.state, "", cleaned);
  }, []);
  // A browser that is already signed in cannot accept an invite: say so instead of dropping the token without a word.
  useEffect(() => {
    if (!authUser || !inviteToken) return;
    setInviteToken(null);
    setInviteNotice(INVITE_SIGNED_IN_NOTICE);
  }, [authUser, inviteToken]);
  useEffect(() => {
    const cleaned = stripSsoLandingParams(window.location.pathname, window.location.search, window.location.hash);
    if (cleaned === null) return;
    window.history.replaceState(window.history.state, "", cleaned);
  }, []);
  const [showWelcome, setShowWelcome] = useState<boolean>(() => !isWelcomeDismissed());
  const [templateInitialCategory, setTemplateInitialCategory] = useState<string | undefined>(undefined);
  const [writeToolDialogOpen, setWriteToolDialogOpen] = useState(false);
  const [subjectRefsDialogOpen, setSubjectRefsDialogOpen] = useState(false);
  const [errorWorkflowDialogOpen, setErrorWorkflowDialogOpen] = useState(false);
  const [webhookPayloadDialogOpen, setWebhookPayloadDialogOpen] = useState(false);
  const [shareWorkflowTarget, setShareWorkflowTarget] = useState<{
    id: string;
    name: string;
    projectId: string;
  } | null>(null);

  const [definitions, setDefinitions] = useState<DefinitionNode[]>(nodeDefinitions as unknown as DefinitionNode[]);
  const [mcpServerDefinitions, setMcpServerDefinitions] = useState<MCPServerDefinition[]>([]);
  // Hosted model providers whose key the API server's environment sets (from /api/definitions, builders only).
  const [envModelProviders, setEnvModelProviders] = useState<string[]>([]);
  // "Describe it" (from /api/definitions; off until the server says it is on, and on older servers).
  const [workflowBuilderEnabled, setWorkflowBuilderEnabled] = useState(false);
  const [workflowBuilderOpen, setWorkflowBuilderOpen] = useState(false);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runningExecutionId, setRunningExecutionId] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretSensitiveOutput, setSecretSensitiveOutputFlag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [secretMessage, setSecretMessage] = useState<string | null>(null);
  const [secretWarnings, setSecretWarnings] = useState<string[]>([]);
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
  // Each workflow gets its own editor session, so one workflow's agent memory never feeds another's runs.
  const [sessionIdOverrides, setSessionIdOverrides] = useState<Record<string, string>>({});
  const sessionId = sessionIdOverrides[currentWorkflow.id] ?? `editor-${currentWorkflow.id}`;
  const setSessionId = useCallback(
    (next: string) => setSessionIdOverrides((current) => ({ ...current, [currentWorkflow.id]: next })),
    [currentWorkflow.id]
  );
  // Phase 10.8 — "Record MCP calls" for manual editor runs; off again on reload.
  const [recordMcp, setRecordMcp] = useState(false);
  // Phase 15.4 — reloads the editor's version pill after a save; the Evaluations tab the pill's "Set up a gate" opens.
  const [releaseRefreshKey, setReleaseRefreshKey] = useState(0);
  const [evaluationsTab, setEvaluationsTab] = useState<EvaluationsTab>("sets");
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
  // The integration catalog (registered MCP servers' tools, the project's APIs) as palette presets; builders only.
  const [integrationCatalog, setIntegrationCatalog] = useState<{ entries: CatalogPaletteEntry[]; sources: CatalogSourceSummary[] }>({ entries: [], sources: [] });
  const [showApiCatalog, setShowApiCatalog] = useState(false);
  const [nodeDrawerContext, setNodeDrawerContext] = useState<NodeDrawerContext | null>(null);
  // The output a node picked in the palette is connected after (its `+`, or a connection dropped on the canvas).
  const [paletteInsertSource, setPaletteInsertSource] = useState<PaletteInsertSource | null>(null);
  const [showShortcutsPanel, setShowShortcutsPanel] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
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
    return "dark";
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
  /** A past run picked from the Run data list; while set, the poller does not replace it. */
  const pickedExecutionIdRef = useRef<string | null>(null);
  const pickRequestRef = useRef(0);
  const currentWorkflowIdRef = useRef<string | null>(null);
  const latestExecutionResultRef = useRef<WorkflowExecutionResult | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [externalImportOpen, setExternalImportOpen] = useState(false);
  const [externalImportSource, setExternalImportSource] = useState<ExternalImportSource | null>(null);
  const [importReport, setImportReport] = useState<{ workflowId: string; report: ImportReport } | null>(null);
  const pasteCountRef = useRef(0);
  const didAttemptInitialWipRef = useRef(false);
  // The latest workflow load wins; a slower earlier fetch must not hydrate over it.
  const workflowLoadSeqRef = useRef(0);
  const pendingWorkflowLoadIdRef = useRef<string | null>(null);
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
      workflowBezier: WorkflowCanvasEdge,
      attachmentSpoke: AttachmentSpokeEdge
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

    const incoming = edges.filter((edge) => edge.target === editingNode.id);
    return incoming.map((edge) => {
      const sourceNode = nodes.find((node) => node.id === edge.source);
      const handles = incoming.filter((other) => other.source === edge.source).map((other) => other.sourceHandle ?? null);
      return {
        id: edge.source,
        label: sourceNode ? `${sourceNode.data.label} (${sourceNode.id})` : edge.source,
        rejectedItems: sourceNode
          ? readsFilterRejected({ type: sourceNode.data.nodeType, config: asRecord(sourceNode.data.config) ?? {} }, handles)
          : false
      };
    });
  }, [editingNode, edges, nodes]);

  // The editor's built-in prompts go only to workflows that read them, and not where a prompt node's text supplies one.
  const editorPrompts = useMemo(() => {
    return editorRunPrompts(nodes.map((node) => ({ type: node.data.nodeType, config: node.data.config })));
  }, [nodes]);

  // Every palette entry: the node definitions, the built-in tool presets and the integration catalog's presets.
  const paletteDefinitions = useMemo(
    () => [...withAgentToolPresets(definitions), ...(catalogPresets(integrationCatalog.entries) as DefinitionNode[])],
    [definitions, integrationCatalog.entries]
  );
  const groupedDefinitions = useMemo(() => {
    const grouped = new Map<string, DefinitionNode[]>();
    // Phase 6.4 — the built-in tools are MCP Tool presets in the palette.
    for (const definition of paletteDefinitions) {
      if (!isPaletteDefinition(definition)) continue;
      const list = grouped.get(definition.category) ?? [];
      list.push(definition);
      grouped.set(definition.category, list);
    }
    return grouped;
  }, [paletteDefinitions]);
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
  // Node labels and test data change rarely; key the maps on them so dragging a node does not rebuild every run preview.
  const nodeLabelSignature = nodes.map((node) => `${node.id}\u0000${node.data.label}`).join("\u0001");
  const nodeLabelById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.data.label] as const)),
    [nodeLabelSignature]
  );
  const testDataSignature = nodes
    .filter((node) => hasTestData(node.data.config))
    .map((node) => node.id)
    .join("\u0001");
  const nodesWithTestData = useMemo(() => new Set(testDataSignature ? testDataSignature.split("\u0001") : []), [testDataSignature]);
  const executionPreviewByNodeId = useMemo(() => {
    const map = new Map<string, NonNullable<EditorNodeData["executionPreview"]>>();
    if (!isDebugMode || !executionResult) {
      return map;
    }
    const labelFor = (nodeId: string) => nodeLabelById.get(nodeId) ?? nodeId;
    // A Loop body node has one result per pass; its card counts them all.
    const passesByNodeId = new Map<string, NodeExecutionResult[]>();
    for (const nodeResult of executionResult.nodeResults) {
      if (!passesByNodeId.has(nodeResult.nodeId)) passesByNodeId.set(nodeResult.nodeId, loopPassResults(executionResult.nodeResults, nodeResult.nodeId));
    }
    for (const nodeResult of executionResult.nodeResults) {
      const liveText = nodeResult.status === "running" ? (nodeResult as LiveNodeResult).liveText : undefined;
      const run = canvasRunPreview(nodeResult, labelFor, {
        hasOwnTestData: nodesWithTestData.has(nodeResult.nodeId),
        passes: passesByNodeId.get(nodeResult.nodeId)
      });
      map.set(nodeResult.nodeId, {
        meta: run.meta,
        input: run.input,
        usedBy: run.usedBy,
        pinned: run.pinned,
        now: nodeResult.status === "running" && nodeResult.activity?.length ? describeActivity(currentActivity(nodeResult)!) : undefined,
        live: liveText ? tailPreview(liveText) : undefined,
        output: run.output,
        error: nodeResult.error ? truncatePreview(nodeResult.error) : undefined,
        errorRemediation: nodeResult.errorRemediation ?? undefined
      });
    }
    return map;
  }, [executionResult, isDebugMode, nodeLabelById, nodesWithTestData]);

  // Browser start time of each running node, so its canvas card can tick an elapsed pill.
  const liveStartedAtByNodeId = useMemo(() => {
    const map = new Map<string, number>();
    if (!isDebugMode || !executionResult) return map;
    for (const nodeResult of executionResult.nodeResults) {
      const started = (nodeResult as LiveNodeResult).liveStartedAtMs;
      if (nodeResult.status === "running" && typeof started === "number") map.set(nodeResult.nodeId, started);
    }
    return map;
  }, [executionResult, isDebugMode]);

  // Phase 7.1 — extract per-node LLM telemetry (tokens + latency) from
  // each node's output._telemetry blob. Surfaced as pills on the canvas
  // card. Visible regardless of debug mode — token cost matters in prod
  // too, not just when debugging.
  // 12.2 — the last run's label badges (debug view only, like the other run overlays).
  const labelBadgeByNodeId = useMemo(() => {
    const map = new Map<string, CanvasLabelBadge>();
    if (!isDebugMode || !executionResult) return map;
    for (const nodeResult of executionResult.nodeResults) {
      const badge = canvasLabelBadge(nodeResult.labels, nodeResult.endorsement);
      if (badge) map.set(nodeResult.nodeId, badge);
    }
    return map;
  }, [executionResult, isDebugMode]);
  const telemetryByNodeId = useMemo(() => {
    const map = new Map<string, NonNullable<EditorNodeData["telemetry"]>>();
    if (!executionResult) return map;
    for (const nodeResult of executionResult.nodeResults) {
      const output = nodeResult.output;
      if (!output || typeof output !== "object" || Array.isArray(output)) continue;
      const tel = (output as Record<string, unknown>)._telemetry;
      if (!tel || typeof tel !== "object") continue;
      const t = tel as Record<string, unknown>;
      const usage = (t.usage && typeof t.usage === "object" ? t.usage : {}) as Record<string, unknown>;
      const entry: NonNullable<EditorNodeData["telemetry"]> = {};
      if (typeof t.providerId === "string") entry.providerId = t.providerId;
      if (typeof t.model === "string") entry.model = t.model;
      if (typeof t.latencyMs === "number") entry.latencyMs = t.latencyMs;
      if (typeof t.llmCallCount === "number") entry.llmCallCount = t.llmCallCount;
      if (typeof usage.inputTokens === "number") entry.inputTokens = usage.inputTokens as number;
      if (typeof usage.outputTokens === "number") entry.outputTokens = usage.outputTokens as number;
      if (typeof usage.totalTokens === "number") entry.totalTokens = usage.totalTokens as number;
      if (typeof usage.cachedInputTokens === "number") entry.cachedInputTokens = usage.cachedInputTokens as number;
      if (t.usageEstimated === true) entry.usageEstimated = true;
      if (Object.keys(entry).length > 0) map.set(nodeResult.nodeId, entry);
    }
    return map;
  }, [executionResult]);
  const pinnedNodeIds = useMemo(
    () => new Set(Object.keys(asRecord(currentWorkflow.pinnedData) ?? {})),
    [currentWorkflow.pinnedData]
  );
  // Ids a new node must not take: the workflow's nodes, its pinned data and the last run's nodes (a new node with the
  // id of a deleted one would show that node's pinned data or run result).
  const nodeIdsInUseRef = useRef<() => Set<string>>(() => new Set());
  // Node ids of the saved workflow's stored versions (loaded once per workflow when the editor opens it): a new node
  // never takes the id of a removed one that run history, approvals or replays still name.
  const savedVersionNodeIdsRef = useRef<{ workflowId: string; ids: ReadonlySet<string> } | null>(null);
  // Ids this editor session showed for the open workflow, so a node added, saved and deleted here is not reused either.
  const sessionNodeIdsRef = useRef<{ workflowId: string; ids: Set<string> }>({ workflowId: "", ids: new Set() });
  if (sessionNodeIdsRef.current.workflowId !== currentWorkflow.id) sessionNodeIdsRef.current = { workflowId: currentWorkflow.id, ids: new Set() };
  for (const node of nodes) sessionNodeIdsRef.current.ids.add(node.id);
  // Field names of the last run's data count as taken too: a parent's id is a key of its child's input next to the
  // fields, so a node named like a field (`order_id`) would hide that field from `{{order_id}}`.
  nodeIdsInUseRef.current = () => {
    const saved = savedVersionNodeIdsRef.current?.workflowId === currentWorkflow.id ? savedVersionNodeIdsRef.current.ids : [];
    const taken = new Set([...nodes.map((node) => node.id), ...pinnedNodeIds, ...saved, ...sessionNodeIdsRef.current.ids]);
    for (const result of executionResult?.nodeResults ?? []) {
      taken.add(result.nodeId);
      for (const value of [result.input, result.output]) {
        if (value && typeof value === "object" && !Array.isArray(value)) for (const key of Object.keys(value)) taken.add(key);
      }
    }
    return taken;
  };
  /** v78 — workflows shared with you, from any project (the dashboard lists them under "Shared with you"). */
  const [sharedWithMe, setSharedWithMe] = useState<SharedWorkflowItem[]>([]);
  /** Workflows other projects share to the active project ("Shared with this project"). */
  const [sharedWithProject, setSharedWithProject] = useState<ProjectSharedWorkflowItem[]>([]);
  /**
   * A workflow opened from a deep link (`?workflowId=`) that is not in the active project's lists: one you can read
   * through another project of yours. Cleared when you switch projects.
   */
  const [deepLinkedWorkflowId, setDeepLinkedWorkflowId] = useState<string | null>(null);
  /** Whether the deep link the page opened with has been resolved (opened, or answered "Workflow not found"). */
  const [deepLinkResolved, setDeepLinkResolved] = useState(false);
  const deepLinkStartedRef = useRef(false);
  /** True when you are a member of no project (strict isolation): the Home page offers the workflows shared with you. */
  const [inNoProject, setInNoProject] = useState(false);
  /** Set once the first project lists are in, so the deep link knows whether the workflow is already one of them. */
  const [listsLoadedOnce, setListsLoadedOnce] = useState(false);
  const activeProjectIdRef = useRef<string | null>(null);
  /** The project the workflow lists were last loaded for (so a project switch waits for that project's lists). */
  const [listsProjectId, setListsProjectId] = useState<string | null>(null);
  /**
   * Set when the person switches project in the picker. Until something else is opened, the editor then opens one of
   * that project's workflows, also in place of a workflow opened from a link or from "Shared with you": an explicit
   * choice of project wins. `seq` is the workflow-load sequence at the switch; any later open clears it.
   */
  const explicitProjectSwitchRef = useRef<{ projectId: string; seq: number } | null>(null);
  const switchProjectExplicitly = useCallback((id: string) => {
    explicitProjectSwitchRef.current = { projectId: id, seq: workflowLoadSeqRef.current };
    setActiveProjectId(id);
  }, []);
  /** Shows a project's workflow list unless the person has switched to another project since it was asked for. */
  const applyProjectWorkflowList = useCallback((projectId: string, workflows: WorkflowListItem[]) => {
    if (activeProjectIdRef.current !== null && activeProjectIdRef.current !== projectId) return;
    setWorkflowList(workflows);
    setListsProjectId(projectId);
  }, [setWorkflowList]);
  const currentWorkflowExists =
    workflowList.some((item) => item.id === currentWorkflow.id) ||
    sharedWithMe.some((item) => item.id === currentWorkflow.id) ||
    sharedWithProject.some((item) => item.id === currentWorkflow.id) ||
    deepLinkedWorkflowId === currentWorkflow.id;
  useEffect(() => {
    const workflowId = currentWorkflow.id;
    if (!currentWorkflowExists || savedVersionNodeIdsRef.current?.workflowId === workflowId) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => fetchWorkflowNodeIds(workflowId))
      .then((response) => {
        if (!cancelled) savedVersionNodeIdsRef.current = { workflowId, ids: new Set(response.nodeIds) };
      })
      // Without the list, new ids still avoid the workflow's nodes, pinned data and the last run.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentWorkflow.id, currentWorkflowExists]);
  const canManageWorkflows = authUser?.role === "admin" || authUser?.role === "builder";
  const canManageSecrets = authUser?.role === "admin" || authUser?.role === "builder";
  // What you may do with the open workflow: viewers and operators open it read-only; a builder may only view a
  // workflow shared with them (or in a project where their role is view-only). Asked for each saved workflow, also
  // for viewers: a workflow shared only with you lists only your own runs.
  const [workflowAccess, setWorkflowAccess] = useState<WorkflowAccessView | null>(null);
  useEffect(() => {
    if (!authUser || !currentWorkflowExists) {
      setWorkflowAccess(null);
      return;
    }
    let cancelled = false;
    fetchWorkflowAccess(currentWorkflow.id)
      .then((access) => {
        if (!cancelled) setWorkflowAccess(access);
      })
      .catch(() => {
        if (!cancelled) setWorkflowAccess(null);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser, currentWorkflow.id, currentWorkflowExists]);
  const openWorkflowAccess = workflowAccess && workflowAccess.workflowId === currentWorkflow.id ? workflowAccess : null;
  // The run list's replay controls run the draft: shown only for the workflows you may edit.
  const runListWorkflowIds = useMemo(() => executionHistoryItems.map((item) => item.workflowId), [executionHistoryItems]);
  const mayEditRunWorkflow = useEditableWorkflows(authUser?.role, authUser?.id, activeMode === "executions" ? runListWorkflowIds : []);
  const { editDisabledReason, runDisabledReason } = editorAccess(authUser?.role, openWorkflowAccess);
  // The editor's run options (pinned data, recording, one node or from a node): for someone who may edit this workflow.
  const editorRunOptions = mayUseEditorRunOptions(authUser?.role, openWorkflowAccess);
  // Workflow settings in the More actions menu are edits too: only for someone who may save this workflow.
  const canEditOpenWorkflow = canManageWorkflows && !editDisabledReason;

  // Whether "Describe it" is on: asked once per sign-in by someone who may build (older servers: off).
  useEffect(() => {
    if (!canManageWorkflows) {
      setWorkflowBuilderEnabled(false);
      return;
    }
    let cancelled = false;
    fetchWorkflowBuilderStatus()
      .then((status) => {
        if (!cancelled) setWorkflowBuilderEnabled(status.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setWorkflowBuilderEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManageWorkflows, authUser?.id]);
  // Phase 11.2 — pending approvals the user can decide, for the sidebar badge.
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [approvalFocusExecutionId, setApprovalFocusExecutionId] = useState<string | null>(null);

  useEffect(() => {
    if (!authUser) {
      setPendingApprovalCount(0);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      inBackground(() => listApprovals({ status: "pending" }))
        .then((response) => {
          if (!cancelled) setPendingApprovalCount(response.items.filter((item) => item.canDecide).length);
        })
        .catch(() => {
          /* The badge is a hint; the Approvals page shows the error. */
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authUser]);

  useEffect(() => {
    if (activeMode !== "approvals") setApprovalFocusExecutionId(null);
  }, [activeMode]);

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

  // One undo/redo history for every graph change (add, delete, move, connect, disconnect, Clear, paste, duplicate,
  // config edits, Tidy): each call site pushes the graph as it was just before its change. A drag is one step,
  // recorded when it ends and only when something moved.
  const historyRef = useRef(new GraphHistory<EditorNode, Edge>(HISTORY_STACK_LIMIT));
  const suppressHistoryRef = useRef(false);
  const dragStartSnapshotRef = useRef<{ nodes: EditorNode[]; edges: Edge[] } | null>(null);

  const pushHistorySnapshot = useCallback(() => {
    if (suppressHistoryRef.current) return;
    historyRef.current.push({ nodes: nodes as EditorNode[], edges: edges as Edge[] });
  }, [edges, nodes]);

  const restoreHistorySnapshot = useCallback(
    (snapshot: { nodes: EditorNode[]; edges: Edge[] } | null) => {
      if (!snapshot) return;
      suppressHistoryRef.current = true;
      // A snapshot holds the graph, not the run: each node keeps the run status, preview and telemetry it shows now.
      setNodes((current) => {
        const live = new Map(current.map((node) => [node.id, node.data as EditorNodeData]));
        return snapshot.nodes.map((node) => {
          const now = live.get(node.id);
          if (!now) return node;
          const { executionStatus, executionPreview, telemetry, liveStartedAtMs, pinned, labelBadge } = now;
          return { ...node, data: { ...node.data, executionStatus, executionPreview, telemetry, liveStartedAtMs, pinned, labelBadge } };
        });
      });
      setEdges(snapshot.edges);
      setTimeout(() => {
        suppressHistoryRef.current = false;
      }, 0);
    },
    [setEdges, setNodes]
  );

  const undo = useCallback(() => {
    restoreHistorySnapshot(historyRef.current.undo({ nodes: nodes as EditorNode[], edges: edges as Edge[] }));
  }, [edges, nodes, restoreHistorySnapshot]);

  const redo = useCallback(() => {
    restoreHistorySnapshot(historyRef.current.redo({ nodes: nodes as EditorNode[], edges: edges as Edge[] }));
  }, [edges, nodes, restoreHistorySnapshot]);

  // Undo never crosses into another workflow; reloading the same one (after a save) keeps its history.
  useEffect(() => {
    historyRef.current.clear();
    dragStartSnapshotRef.current = null;
  }, [currentWorkflow.id]);

  const handleNodeDragStart = useCallback(() => {
    if (dragStartSnapshotRef.current) return;
    dragStartSnapshotRef.current = cloneJson({ nodes: nodes as EditorNode[], edges: edges as Edge[] });
  }, [edges, nodes]);

  const handleNodeDragStop = useCallback((draggedNodes: Array<Pick<EditorNode, "id" | "position">>) => {
    const before = dragStartSnapshotRef.current;
    dragStartSnapshotRef.current = null;
    if (!before || suppressHistoryRef.current) return;
    // A node on an agent's port snaps back onto its orbit, so dragging one changes nothing.
    const attached = attachedNodeIds(computeAttachmentSlots(before.nodes, before.edges));
    const moved = movedNodeIds(before.nodes, draggedNodes).filter((id) => !attached.has(id));
    if (moved.length > 0) historyRef.current.push(before);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (activeMode !== "editor") return;
      if (isCanvasShortcutBlocked(event.target)) return;
      // A view-only workflow: undo, redo and duplicate would change a canvas that cannot be saved.
      if (editDisabledReason) return;

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
        const takenIds = nodeIdsInUseRef.current();
        const duplicates: Node<EditorNodeData>[] = selected.map((node) => {
          const newId = createNodeId(node.data.nodeType, node.data.label, takenIds);
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
              color: node.data.color,
              ...(node.data.nodeExtras ? { nodeExtras: cloneJson(node.data.nodeExtras) } : {})
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
  }, [activeMode, editDisabledReason, edges, nodes, pushHistorySnapshot, redo, setEdges, setNodes, undo]);

  useEffect(() => {
    latestDebugExecutionIdRef.current = null;
    setRunningExecutionId(null);
    pasteCountRef.current = 0;
  }, [currentWorkflow.id]);

  useEffect(() => {
    latestExecutionResultRef.current = executionResult;
  }, [executionResult]);

  useEffect(() => {
    currentWorkflowIdRef.current = currentWorkflow.id;
    pickedExecutionIdRef.current = null;
    pickRequestRef.current += 1;
  }, [currentWorkflow.id]);

  // What the saved workflow still lacks (a draft saves with unfinished node settings), for the editor's notice.
  // Dismissing hides the notice; the version pill still says when live triggers are paused.
  const [draftIssues, setDraftIssues] = useState<{
    workflowId: string;
    issues: WorkflowValidationIssue[];
    liveTriggersPaused: boolean;
    dismissed?: boolean;
  } | null>(null);
  // A workflow stored before error settings were checked can hold invalid values: runs ignore them, but a save (and so
  // the editor's Run) refuses them. One click strips them from every node, keeping each node's valid values.
  const removeInvalidErrorConfigs = useCallback(() => {
    pushHistorySnapshot();
    setNodes((current) =>
      current.map((node) => {
        const extras = (node.data as EditorNodeData).nodeExtras;
        const repair = repairNodeErrorConfig(extras?.errorConfig);
        if (!extras || repair.invalidFields.length === 0) return node;
        const { errorConfig: _invalid, ...rest } = extras;
        const nodeExtras = repair.errorConfig ? { ...rest, errorConfig: repair.errorConfig } : rest;
        const data = { ...(node.data as EditorNodeData) };
        if (Object.keys(nodeExtras).length > 0) data.nodeExtras = nodeExtras;
        else delete data.nodeExtras;
        return { ...node, data };
      })
    );
    setDraftIssues((current) =>
      current ? { ...current, issues: current.issues.filter((issue) => issue.code !== "invalid_error_config") } : current
    );
  }, [pushHistorySnapshot, setNodes]);
  // A publish or unpublish changes which version production runs, and so whether its live triggers are paused.
  const refreshLiveTriggersPaused = useCallback(() => {
    const workflowId = currentWorkflow.id;
    inBackground(() => validateStoredWorkflow(workflowId))
      .then((validation) => {
        setDraftIssues((current) =>
          current && current.workflowId === workflowId ? { ...current, liveTriggersPaused: validation.liveTriggersPaused === true } : current
        );
      })
      .catch(() => {
        // The pill keeps its last answer; the next save or open checks again.
      });
  }, [currentWorkflow.id]);
  const draftIssuesWorkflowIdRef = useRef<string | null>(null);
  useEffect(() => {
    setDraftIssues((current) => (current && current.workflowId !== currentWorkflow.id ? null : current));
    if (!authUser || !currentWorkflowExists) return;
    let cancelled = false;
    const workflowId = currentWorkflow.id;
    // On open only what stops a run is shown; after a save, notes (such as "no Output node") too.
    const afterSave = draftIssuesWorkflowIdRef.current === workflowId;
    draftIssuesWorkflowIdRef.current = workflowId;
    inBackground(() => validateStoredWorkflow(workflowId))
      .then((validation) => {
        if (cancelled) return;
        const issues = (validation.issues ?? []).filter((issue) => draftIssueShown(issue, afterSave));
        setDraftIssues({ workflowId, issues, liveTriggersPaused: validation.liveTriggersPaused === true });
      })
      .catch(() => {
        // The notice is a hint: without it the editor works as before, and a run still reports what is missing.
      });
    return () => {
      cancelled = true;
    };
    // A save gives the workflow a new updatedAt, so the notice follows each save.
  }, [authUser, currentWorkflow.id, currentWorkflow.updatedAt, currentWorkflowExists]);

  /** The workflow whose latest finished run was already offered to the canvas since it was opened (once per open). */
  const restoredRunWorkflowIdRef = useRef<string | null>(null);

  // Starting a run (or any other busy action) follows the newest data again.
  useEffect(() => {
    if (busy) {
      pickedExecutionIdRef.current = null;
      pickRequestRef.current += 1;
    }
  }, [busy]);

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
      // A run picked from the Run data list stays on the canvas until the user picks the latest or runs again.
      if (busy || chatBusy || pickedExecutionIdRef.current) {
        return;
      }

      try {
        const history = await inBackground(() =>
          fetchExecutions({
            page: 1,
            pageSize: 1,
            workflowId: currentWorkflow.id
          })
        );
        if (cancelled) {
          return;
        }

        const latest = history.items[0];
        // Opening a workflow shows its latest run once, finished or not; clearing the logs afterwards keeps them clear.
        const restoreOnOpen = restoredRunWorkflowIdRef.current !== currentWorkflow.id;
        restoredRunWorkflowIdRef.current = currentWorkflow.id;
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

        const canvasEmpty = !latestResult || latestResult.workflowId !== currentWorkflow.id;
        if (!sameExecution && !isInProgressStatus && !(restoreOnOpen && canvasEmpty)) {
          latestDebugExecutionIdRef.current = latest.id;
          return;
        }

        // New external execution detected (e.g., REST client / webhook call).
        // Reset previous debug trace immediately before loading full details.
        if (!sameExecution && isInProgressStatus) {
          setExecutionResult(
            createPartialExecutionResult(
              latest.workflowId || currentWorkflow.id,
              typeof latest.startedAt === "string" && latest.startedAt ? latest.startedAt : new Date().toISOString()
            )
          );
          setLiveNodeStatuses({});
          setLogsTab("logs");
        }

        const detail = await inBackground(() => fetchExecutionById(latest.id));
        if (cancelled || pickedExecutionIdRef.current) {
          return;
        }

        latestDebugExecutionIdRef.current = latest.id;
        const loaded = toWorkflowExecutionResult(detail);
        // Restoring a finished run on open: a run started (or picked) meanwhile wins over it.
        const restoring = !sameExecution && !isInProgressStatus;
        setExecutionResult((current) => (restoring && current && current.workflowId === currentWorkflowIdRef.current ? current : loaded));
      } catch {
        // Polling failures should not interrupt editor usage.
      }
    };

    // A just-opened workflow loads its latest run at once; later polls follow every two seconds.
    const firstPollTimerId = window.setTimeout(() => {
      void syncLatestExecution();
    }, restoredRunWorkflowIdRef.current === currentWorkflow.id ? 2000 : 0);
    const timerId = window.setInterval(() => {
      void syncLatestExecution();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearTimeout(firstPollTimerId);
      window.clearInterval(timerId);
    };
  }, [activeMode, authUser, busy, chatBusy, currentWorkflow.id, currentWorkflowExists, isDebugMode]);

  useEffect(() => {
    setNodes((currentNodes) => {
      let changed = false;
      const nextNodes = currentNodes.map((node) => {
        const executionStatus = executionStatuses.get(node.id) as EditorNodeData["executionStatus"];
        const executionPreview = executionPreviewByNodeId.get(node.id);
        const telemetry = telemetryByNodeId.get(node.id);
        const liveStartedAtMs = liveStartedAtByNodeId.get(node.id);
        const pinned = pinnedNodeIds.has(node.id);
        const labelBadge = labelBadgeByNodeId.get(node.id);
        if (
          node.data.labelBadge === labelBadge &&
          node.data.executionStatus === executionStatus &&
          node.data.liveStartedAtMs === liveStartedAtMs &&
          node.data.executionPreview === executionPreview &&
          node.data.telemetry === telemetry &&
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
            telemetry,
            liveStartedAtMs,
            pinned,
            labelBadge
          }
        };
      });
      return changed ? nextNodes : currentNodes;
    });
  }, [executionPreviewByNodeId, executionStatuses, labelBadgeByNodeId, liveStartedAtByNodeId, pinnedNodeIds, setNodes, telemetryByNodeId]);

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
      if (editDisabledReason) {
        return;
      }

      if (isCanvasShortcutBlocked(event.target)) {
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
  }, [activeMode, editDisabledReason, editingNodeId, edges, nodes, pushHistorySnapshot, setEdges, setNodes]);

  useEffect(() => {
    const handleCopyPaste = (event: KeyboardEvent) => {
      if (activeMode !== "editor") {
        return;
      }

      if (isCanvasShortcutBlocked(event.target)) {
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
            color: node.data.color,
            ...(node.data.nodeExtras ? { nodeExtras: cloneJson(node.data.nodeExtras) } : {})
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
        if (editDisabledReason) return;
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
        const takenIds = nodeIdsInUseRef.current();
        const newNodes: Node<EditorNodeData>[] = payload.nodes.map((entry) => {
          const newId = createNodeId(entry.nodeType, entry.label, takenIds);
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
              color: entry.color,
              ...(entry.nodeExtras && typeof entry.nodeExtras === "object" ? { nodeExtras: cloneJson(entry.nodeExtras) } : {})
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
  }, [activeMode, editDisabledReason, edges, nodes, pushHistorySnapshot, reactFlowInstance, setEdges, setNodes]);

  const handleDeleteEdgeById = useCallback(
    (edgeId: string) => {
      if (!edges.some((edge) => edge.id === edgeId)) return;
      pushHistorySnapshot();
      setEdges((currentEdges) => currentEdges.filter((edge) => edge.id !== edgeId));
      setError(null);
    },
    [edges, pushHistorySnapshot, setEdges]
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
      // Whatever opens a workflow (a run's Debug or Re-run, an import, a duplicate, a load) ends a pending project switch.
      explicitProjectSwitchRef.current = null;
      const editor = workflowToEditor(workflow);
      const decoratedEdges = editor.edges.map((edge) => decorateEdge(edge, editor.nodes as EditorNode[]));

      // The graph is replaced from the server: undo must not bring back the graph from before.
      historyRef.current.clear();
      dragStartSnapshotRef.current = null;
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
      const projectsRequest = fetchProjects().catch(() => null);
      const [workflowItems, projectPayload, folderPayload, sharedPayload, projectSharedPayload] = await Promise.all([
        fetchWorkflows({ projectId: activeProjectId }),
        projectsRequest,
        fetchFolders(activeProjectId).catch(() => ({ folders: [] })),
        fetchWorkflowsSharedWithMe().catch(() => ({ workflows: [] })),
        // Only for a project the person is in: someone whose access comes only from shares has none to ask about.
        projectsRequest.then((payload) =>
          payload && !payload.projects.some((project) => project.id === activeProjectId)
            ? { workflows: [] }
            : fetchProjectSharedWorkflows(activeProjectId).catch(() => ({ workflows: [] }))
        )
      ]);
      // A slower answer for a project the person has already left must not replace the lists of the one they chose.
      if (activeProjectIdRef.current !== null && activeProjectIdRef.current !== activeProjectId) return;

      const noProject = Boolean(projectPayload) && (projectPayload?.projects ?? []).length === 0;
      // Someone in no project has no project's workflows: what they can read is what is shared with them.
      setWorkflowList(noProject ? [] : workflowItems);
      setListsProjectId(activeProjectId);
      setSharedWithProject(noProject ? [] : projectSharedPayload.workflows);
      // A workflow listed as shared with this project is not listed again as shared with you.
      const projectSharedIds = new Set(projectSharedPayload.workflows.map((item) => item.id));
      setSharedWithMe(
        noProject
          ? sharedPayload.workflows
          : sharedPayload.workflows.filter((item) => item.projectId !== activeProjectId && !projectSharedIds.has(item.id))
      );
      setProjects(projectPayload?.projects ?? []);
      setInNoProject(noProject);
      setListsLoadedOnce(true);
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
  // A workflow opened from a link outside this project's lists does not follow a switch to another project.
  const deepLinkProjectRef = useRef(activeProjectId);
  useEffect(() => {
    if (deepLinkProjectRef.current === activeProjectId) return;
    deepLinkProjectRef.current = activeProjectId;
    setDeepLinkedWorkflowId(null);
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    const checkSession = async () => {
      try {
        const me = await fetchAuthMe();
        if (!cancelled) {
          setAuthSession(me.session ?? null);
          setAuthUser(me.user);
          setMfaGate(mfaGateFromMe(me));
          setAuthError(null);
        }
      } catch (sessionError) {
        if (!cancelled) {
          if (sessionError instanceof ApiError && sessionError.status === 401) {
            setAuthUser(null);
            if (ssoError) setAuthError(ssoError);
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
  }, [ssoError]);

  // Phase 13.2 — a 401 that says why the session ended returns to the sign-in screen with that reason.
  const handleSessionEnded = useCallback((reason: SessionEndReason) => {
    setAuthUser(null);
    setAuthError(sessionEndMessage(reason));
  }, []);

  useEffect(() => onSessionEnded(handleSessionEnded), [handleSessionEnded]);

  // After a sign-in (login, MFA, invite, SSO) the session details come from one background /me.
  useEffect(() => {
    if (!authUser) {
      setAuthSession(undefined);
      return;
    }
    if (authSession !== undefined) return;
    let cancelled = false;
    inBackground(() => fetchAuthMe())
      .then((result) => {
        if (!cancelled) setAuthSession(result.session ?? null);
      })
      .catch(() => {
        if (!cancelled) setAuthSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser, authSession]);

  useEffect(() => {
    if (authUser || authChecking) return;
    let cancelled = false;
    void fetchOidcLoginUrl().then((url) => {
      if (!cancelled) setOidcLoginUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [authUser, authChecking]);

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
        setEnvModelProviders(definitionPayload.envModelProviders ?? []);
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

  const catalogProjectId = activeProjectId || null;
  const canUseCatalog = canUseIntegrationCatalog(authUser?.role);
  // Only the latest load applies, so a slow answer for the previous project never fills this project's palette.
  const catalogRequestRef = useRef(0);
  const reloadIntegrationCatalog = useCallback(async () => {
    const request = ++catalogRequestRef.current;
    if (!canUseCatalog) {
      setIntegrationCatalog({ entries: [], sources: [] });
      return;
    }
    try {
      const response = await fetchIntegrationCatalog(catalogProjectId);
      if (request === catalogRequestRef.current) setIntegrationCatalog({ entries: response.entries, sources: response.sources });
    } catch {
      // The palette works without the catalog; the dialog shows its own errors.
      if (request === catalogRequestRef.current) setIntegrationCatalog({ entries: [], sources: [] });
    }
  }, [canUseCatalog, catalogProjectId]);

  // Loaded with the editor (and for each project), and again each time the palette opens, so a probe or a new API
  // shows up there.
  const catalogLoadedForRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!authUser || activeMode !== "editor") return;
    if (!showNodeDrawer && catalogLoadedForRef.current === catalogProjectId) return;
    catalogLoadedForRef.current = catalogProjectId;
    void reloadIntegrationCatalog();
  }, [authUser, activeMode, showNodeDrawer, catalogProjectId, reloadIntegrationCatalog]);

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
    // Wait for the signed-in user: on a reload the role is unknown until the session check returns.
    if (!authUser) return;
    if ((activeMode === "secrets" || isMcpMode(activeMode)) && !canManageSecrets) {
      setActiveMode("editor");
    }
  }, [activeMode, authUser, canManageSecrets]);

  // Phase 10.3 — links between MCP pages and from canvas markers carry a focus (server, rule, tool).
  const [mcpFocus, setMcpFocus] = useState<McpNavTarget | null>(null);
  const navigateMcp = useCallback(
    (target: McpNavTarget) => {
      setMcpFocus(target);
      setActiveMode(MCP_MODE_BY_PAGE[target.page]);
    },
    [setActiveMode]
  );
  // A focus belongs to the page it was opened for; leaving that page drops it.
  useEffect(() => {
    if (mcpFocus && MCP_MODE_BY_PAGE[mcpFocus.page] !== activeMode) setMcpFocus(null);
  }, [activeMode, mcpFocus]);
  const mcpCanvasMarkers = useMcpCanvasStatus(nodes, {
    projectId: currentWorkflow.projectId ?? activeProjectId,
    enabled: activeMode === "editor" && canManageSecrets
  });

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
      const message = sessionEndMessage(sessionEndReasonOf(apiError.payload)) ?? "Session expired. Sign in again.";
      setAuthUser(null);
      setAuthError(message);
      return message;
    }

    let message = apiError instanceof Error ? apiError.message : fallbackMessage;
    if (apiError instanceof ApiError) {
      // The issues the message does not already list (a save error names them itself).
      message = apiErrorText(message, apiError.payload);
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

  // Loads a past run of the open workflow onto the canvas (the stored record only); the workflow itself is untouched.
  const handlePickRun = useCallback(
    async (executionId: string, isLatest: boolean) => {
      const request = ++pickRequestRef.current;
      const workflowId = currentWorkflowIdRef.current;
      // The latest run lets the canvas follow new runs again; an older one holds it until the next run.
      pickedExecutionIdRef.current = isLatest ? null : executionId;
      try {
        setError(null);
        const detail = await fetchExecutionById(executionId);
        // A later pick, or a switch to another workflow, wins over this one.
        if (request !== pickRequestRef.current || detail.workflowId !== currentWorkflowIdRef.current || workflowId !== detail.workflowId) {
          return;
        }
        latestDebugExecutionIdRef.current = detail.id;
        setLiveNodeStatuses({});
        setExecutionResult(toWorkflowExecutionResult(detail));
      } catch (pickError) {
        handleApiError(pickError, "Failed to load that run");
      }
    },
    [handleApiError]
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

  // Phase 10.8 — run a recorded execution again, answering its MCP calls from
  // its cassette. Opens the result in the editor the way Retry does.
  const handleReplayCassette = useCallback(
    async (executionId: string, mode: McpReplayMode) => {
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
        const result = await replayExecution(executionId, { mode });
        setExecutionResult(result);
        if (result.executionId) {
          latestDebugExecutionIdRef.current = result.executionId;
        }
        void refreshExecutionHistory();
      } catch (replayError) {
        const message = handleApiError(replayError, "Failed to replay execution from its cassette");
        setExecutionResult(buildExecutionErrorResult(targetWorkflowId, message));
      } finally {
        setBusy(false);
      }
    },
    [currentWorkflow.id, handleApiError, hydrateWorkflow, refreshExecutionHistory]
  );

  // Phase 7.2 — replay an existing execution starting from a chosen node.
  // Loads the source execution's workflow, switches the editor into debug
  // mode, and triggers /execute with startNodeId + sourceExecutionId so the
  // server seeds upstream node outputs from the prior run.
  const handleReplayFromNode = useCallback(
    async (sourceExecutionId: string, nodeId: string) => {
      let targetWorkflowId = currentWorkflow.id;
      try {
        setBusy(true);
        setError(null);
        const detail = await fetchExecutionById(sourceExecutionId);
        targetWorkflowId = detail.workflowId;
        const workflow = await fetchWorkflow(detail.workflowId);
        hydrateWorkflow(workflow);
        setIsDebugMode(true);
        setLogsTab("logs");
        setActiveMode("editor");
        const result = await executeWorkflowStream(
          detail.workflowId,
          {
            sessionId,
            startNodeId: nodeId,
            sourceExecutionId,
            usePinnedData: true
          },
          {}
        );
        setExecutionResult(result);
        if (result.executionId) {
          latestDebugExecutionIdRef.current = result.executionId;
        }
        void refreshExecutionHistory();
      } catch (replayError) {
        const message = handleApiError(replayError, "Failed to replay from node");
        setExecutionResult(buildExecutionErrorResult(targetWorkflowId, message));
      } finally {
        setBusy(false);
      }
    },
    [currentWorkflow.id, handleApiError, hydrateWorkflow, refreshExecutionHistory, sessionId]
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
      setError((current) => current ?? CANCEL_REQUESTED_MESSAGE);
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

  // Phase: agent_clarify — attach the agent's clarifying question to the
  // assistant message so the bubble can render a "?" badge instead of a
  // plain answer.
  const setChatMessageClarification = useCallback(
    (workflowId: string, messageId: string, clarification: { question: string; reason?: string }) => {
      setChatMessagesByWorkflow((current) => {
        const nextMessages = (current[workflowId] ?? []).map((entry) =>
          entry.id === messageId ? { ...entry, clarification } : entry
        );
        return { ...current, [workflowId]: nextMessages };
      });
    },
    []
  );

  // Phase 10.5 — keep the server's questions on the assistant message; a
  // settled request replaces its pending entry.
  const upsertChatMessageElicitation = useCallback((workflowId: string, messageId: string, elicitation: McpElicitationView) => {
    setChatMessagesByWorkflow((current) => {
      const nextMessages = (current[workflowId] ?? []).map((entry) => {
        if (entry.id !== messageId) return entry;
        const existing = entry.elicitations ?? [];
        const index = existing.findIndex((item) => item.id === elicitation.id);
        const elicitations = index >= 0 ? existing.map((item, at) => (at === index ? elicitation : item)) : [...existing, elicitation];
        return { ...entry, elicitations };
      });
      return { ...current, [workflowId]: nextMessages };
    });
  }, []);

  // Phase 9.4 — attach extracted citations to the assistant message so the
  // chat bubble can render [N] markers as clickable footnotes.
  const setChatMessageCitations = useCallback((workflowId: string, messageId: string, citations: ChatCitation[]) => {
    setChatMessagesByWorkflow((current) => {
      const nextMessages = (current[workflowId] ?? []).map((entry) =>
        entry.id === messageId ? { ...entry, citations } : entry
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
      const seq = ++workflowLoadSeqRef.current;
      const isLatest = () => workflowLoadSeqRef.current === seq;
      try {
        const localWip = readWipWorkflow(id);
        if (localWip && localWip.nodes.length > 0) {
          pendingWorkflowLoadIdRef.current = null;
          hydrateWorkflow(localWip);
          return;
        }

        pendingWorkflowLoadIdRef.current = id;
        const workflow = await fetchWorkflow(id);
        if (!isLatest()) return;
        const chosen = preferTabWip(localWip, workflow);
        if (localWip && chosen !== localWip) {
          deleteTabWipWorkflow(id);
        }
        hydrateWorkflow(chosen);
      } catch (loadError) {
        if (!isLatest()) return;
        handleApiError(loadError, "Failed to load workflow");
      } finally {
        if (isLatest()) pendingWorkflowLoadIdRef.current = null;
      }
    },
    [handleApiError, hydrateWorkflow, readWipWorkflow]
  );

  const handleTemplateWorkflowCreated = useCallback(
    async (workflowId: string) => {
      try {
        const seq = ++workflowLoadSeqRef.current;
        pendingWorkflowLoadIdRef.current = workflowId;
        const workflow = await fetchWorkflow(workflowId).finally(() => {
          if (workflowLoadSeqRef.current === seq) pendingWorkflowLoadIdRef.current = null;
        });
        if (workflowLoadSeqRef.current !== seq) return;
        hydrateWorkflow(workflow);

        const targetProjectId = workflow.projectId || activeProjectId;
        if (targetProjectId !== activeProjectId) {
          setActiveProjectId(targetProjectId);
        }

        const workflows = await fetchWorkflows({ projectId: targetProjectId });
        setWorkflowList(workflows);
        setListsProjectId(targetProjectId);
        rememberTabWorkflowId(workflow.id);
        setError(null);
        setActiveMode("editor");
      } catch (templateError) {
        handleApiError(templateError, "Failed to load workflow created from template");
        throw templateError;
      }
    },
    [activeProjectId, handleApiError, hydrateWorkflow, setWorkflowList]
  );

  /** "Describe it": the draft is saved as a new workflow (a new id, never an existing one) and opened. */
  const handleCreateBuiltWorkflow = useCallback(
    async (workflow: Workflow) => {
      const saved = await saveWorkflow({ ...workflow, projectId: workflow.projectId ?? activeProjectId });
      // A slower load of another workflow must not replace the new one.
      workflowLoadSeqRef.current += 1;
      pendingWorkflowLoadIdRef.current = null;
      const workflows = await fetchWorkflows({ projectId: activeProjectId });
      applyProjectWorkflowList(activeProjectId, workflows);
      hydrateWorkflow(saved);
      storeLocalWipWorkflow(saved);
      rememberTabWorkflowId(saved.id);
      setWorkflowBuilderOpen(false);
      setError(null);
      setActiveMode("editor");
    },
    [activeProjectId, applyProjectWorkflowList, hydrateWorkflow, setActiveMode]
  );

  /** "Describe it" without a real model offers templates: one makes a new workflow, as in the gallery. */
  const handleBuilderTemplate = useCallback(
    async (templateId: string) => {
      const created = await instantiateTemplate(templateId);
      await handleTemplateWorkflowCreated(created.workflowId);
      setWorkflowBuilderOpen(false);
    },
    [handleTemplateWorkflowCreated]
  );

  const docsUrl = useMemo(() => {
    const fromEnv = (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim();
    if (fromEnv) return fromEnv;
    if (typeof window !== "undefined") {
      return `${window.location.protocol}//${window.location.hostname}:4173`;
    }
    return "http://localhost:4173";
  }, []);

  const handleWelcomeDismiss = useCallback(() => {
    markWelcomeDismissed();
    setShowWelcome(false);
  }, []);

  const handleWelcomeTryTemplate = useCallback(() => {
    setTemplateInitialCategory("Starters");
    setActiveMode("templates");
    handleWelcomeDismiss();
  }, [handleWelcomeDismiss, setActiveMode]);

  const handleWelcomeDescribe = useCallback(() => {
    handleWelcomeDismiss();
    setActiveMode("dashboard");
    setWorkflowBuilderOpen(true);
  }, [handleWelcomeDismiss, setActiveMode]);

  const handleWelcomeBuildAgent = useCallback(() => {
    setTemplateInitialCategory("Agents");
    setActiveMode("templates");
    handleWelcomeDismiss();
  }, [handleWelcomeDismiss, setActiveMode]);

  useEffect(() => {
    if (!authUser || loading) {
      return;
    }

    const modeNeedsWorkflow =
      activeMode === "editor" || activeMode === "variables" || activeMode === "chat" || activeMode === "evaluations";
    if (!modeNeedsWorkflow) {
      return;
    }

    // A deep link is resolved first: it decides what opens.
    if (!deepLinkResolved) {
      return;
    }

    // After an explicit project switch, the project's own workflow opens unless something was opened since.
    let afterProjectSwitch = false;
    const projectSwitch = explicitProjectSwitchRef.current;
    if (projectSwitch) {
      if (projectSwitch.seq !== workflowLoadSeqRef.current || projectSwitch.projectId !== activeProjectId) {
        explicitProjectSwitchRef.current = null;
      } else if (listsProjectId !== activeProjectId) {
        // The lists are still the previous project's: wait for this project's.
        return;
      } else {
        afterProjectSwitch = true;
      }
    }

    if (workflowList.length === 0) {
      if (afterProjectSwitch) explicitProjectSwitchRef.current = null;
      return;
    }

    if (afterProjectSwitch) {
      // Only one of the project's own workflows stays open; one shared with you or opened from a link gives way.
      if (workflowList.some((item) => item.id === currentWorkflow.id) || sharedWithProject.some((item) => item.id === currentWorkflow.id)) {
        explicitProjectSwitchRef.current = null;
        return;
      }
    } else if (currentWorkflowExists) {
      // A workflow shared with you (or with this project), or opened from a link, stays open.
      return;
    }

    // A new workflow not saved yet stays open.
    if (unsavedNewWorkflowRef.current?.id === currentWorkflow.id) {
      return;
    }

    // An explicit open (Home card, palette, MCP pages) is still fetching; it decides what shows.
    if (pendingWorkflowLoadIdRef.current) {
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
      // An empty tab copy goes through loadWorkflowById below, which checks it against the server.
      if (wipWorkflow && wipWorkflow.nodes.length > 0 && wipMatchesProject && workflowList.some((item) => item.id === wipWorkflow.id)) {
        explicitProjectSwitchRef.current = null;
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
    explicitProjectSwitchRef.current = null;
    void loadWorkflowById(chosenWorkflowId);
  }, [activeMode, activeProjectId, authUser, currentWorkflow.id, currentWorkflowExists, deepLinkResolved, hydrateWorkflow, listsProjectId, loadWorkflowById, loading, readWipWorkflow, sharedWithProject, workflowList]);

  /**
   * A deep link (`?workflowId=`) to a workflow outside the active project's list opens it when you can read it in any
   * way (another project of yours, a share to a project, a share with you), asked of its access answer. One you cannot
   * read gets the same "Workflow not found" as one that does not exist.
   */
  activeProjectIdRef.current = activeProjectId;
  useEffect(() => {
    if (!authUser || loading || !listsLoadedOnce || deepLinkStartedRef.current) return;
    deepLinkStartedRef.current = true;
    const linkedId = readStudioUrlState().workflowId;
    if (!linkedId || workflowList.some((item) => item.id === linkedId)) {
      setDeepLinkResolved(true);
      return;
    }
    pendingWorkflowLoadIdRef.current = linkedId;
    const seq = workflowLoadSeqRef.current;
    const projectAtStart = activeProjectId;
    // Opening something else or switching project while the answer is pending wins over the link.
    const overtaken = () => workflowLoadSeqRef.current !== seq || activeProjectIdRef.current !== projectAtStart;
    void (async () => {
      try {
        await fetchWorkflowAccess(linkedId);
        if (overtaken()) return;
        setDeepLinkedWorkflowId(linkedId);
        await loadWorkflowById(linkedId);
      } catch (linkError) {
        if (pendingWorkflowLoadIdRef.current === linkedId) pendingWorkflowLoadIdRef.current = null;
        if (overtaken()) return;
        // Missing and unreadable answer alike; anything else (a lapsed session, a server error) is reported as such.
        if (linkError instanceof ApiError && (linkError.status === 404 || linkError.status === 403)) {
          setError("Workflow not found");
        } else {
          handleApiError(linkError, "Failed to open the linked workflow");
        }
      } finally {
        // Overtaken by a project switch with nothing opened since: the link no longer holds the editor's choice.
        if (pendingWorkflowLoadIdRef.current === linkedId && workflowLoadSeqRef.current === seq) pendingWorkflowLoadIdRef.current = null;
        setDeepLinkResolved(true);
      }
    })();
  }, [activeProjectId, authUser, handleApiError, listsLoadedOnce, loading, loadWorkflowById, workflowList]);

  const buildCurrentWorkflow = useCallback(() => {
    return editorToWorkflow(currentWorkflow, nodes as EditorNode[], edges as Edge[]);
  }, [currentWorkflow, edges, nodes]);

  /**
   * The save in flight. Saves run one after another, and a save of the same content as the one in flight (Save
   * clicked while a new workflow's first-edit save runs, a run that saves first) joins it: each save is a version.
   */
  const saveInFlightRef = useRef<{ content: string; promise: Promise<Workflow> } | null>(null);

  const persistWorkflow = useCallback(async (adjust?: (workflow: Workflow) => Workflow) => {
    const built = buildCurrentWorkflow();
    const workflow = adjust ? adjust(built) : built;
    const { updatedAt: _updatedAt, ...comparable } = workflow;
    const content = JSON.stringify(comparable);
    const previous = saveInFlightRef.current;
    if (previous && previous.content === content) return await previous.promise;
    const promise = (async () => {
      if (previous) await previous.promise.catch(() => undefined);
      const saved = await saveWorkflow(workflow);
      const workflows = await fetchWorkflows({ projectId: activeProjectId });
      applyProjectWorkflowList(activeProjectId, workflows);
      setCurrentWorkflow(saved);
      storeLocalWipWorkflow(saved);
      // Phase 15.4 — a save is a new version: the version pill reloads.
      setReleaseRefreshKey((key) => key + 1);
      return saved;
    })();
    const entry = { content, promise };
    saveInFlightRef.current = entry;
    try {
      return await promise;
    } finally {
      if (saveInFlightRef.current === entry) saveInFlightRef.current = null;
    }
  }, [buildCurrentWorkflow]);

  /** Before a run: save the editor's changes, or, when you may run but not change the workflow, run it as saved. */
  const persistForRun = useCallback(
    async (adjust?: (workflow: Workflow) => Workflow) => (editDisabledReason && currentWorkflowExists ? currentWorkflow : await persistWorkflow(adjust)),
    [currentWorkflow, currentWorkflowExists, editDisabledReason, persistWorkflow]
  );

  // The pill opens Evaluations on Release gates once; the next visit starts on Golden sets.
  useEffect(() => {
    if (activeMode !== "evaluations") setEvaluationsTab("sets");
  }, [activeMode]);

  const handleSave = useCallback(async () => {
    if (editDisabledReason) {
      setError(editDisabledReason);
      return;
    }
    try {
      setBusy(true);
      setError(null);
      await persistWorkflow();
    } catch (saveError) {
      handleApiError(saveError, "Failed to save workflow");
    } finally {
      setBusy(false);
    }
  }, [editDisabledReason, handleApiError, persistWorkflow]);

  // The import checklist follows the workflow it belongs to, including across reloads.
  useEffect(() => {
    if (!currentWorkflowExists) {
      setImportReport(null);
      return;
    }
    setImportReport((current) => {
      if (current?.workflowId === currentWorkflow.id) return current;
      const stored = recallImportReport(currentWorkflow.id);
      return stored ? { workflowId: currentWorkflow.id, report: stored } : null;
    });
  }, [currentWorkflow.id, currentWorkflowExists]);

  const handleLinkImportedSecret = useCallback(
    (placeholderId: string, secretId: string) => {
      pushHistorySnapshot();
      setNodes((current) =>
        current.map((node) => {
          const config = replaceSecretRefs(node.data.config, placeholderId, secretId);
          return config === node.data.config ? node : { ...node, data: { ...node.data, config } };
        })
      );
    },
    [pushHistorySnapshot, setNodes]
  );

  const handleValidateImported = useCallback(async () => {
    const saved = await persistWorkflow();
    return validateStoredWorkflow(saved.id);
  }, [persistWorkflow]);

  const handleDismissImportReport = useCallback(() => {
    setImportReport((current) => {
      if (current) forgetImportReport(current.workflowId);
      return null;
    });
  }, []);

  const importVariableValues = useMemo(() => rowsToWorkflowVariables(workflowVariableRows), [workflowVariableRows]);

  const importPanelBinding = useMemo<ImportPanelBinding | null>(() => {
    if (!importReport || importReport.workflowId !== currentWorkflow.id) return null;
    return {
      report: importReport.report,
      variables: importVariableValues,
      secrets: secrets.map((secret) => ({ id: secret.id, name: secret.name, provider: secret.provider })),
      onLinkSecret: handleLinkImportedSecret,
      onOpenSecrets: canManageSecrets ? () => setActiveMode("secrets") : undefined,
      onOpenVariables: () => setActiveMode("variables"),
      onValidate: handleValidateImported,
      onDismiss: handleDismissImportReport
    };
  }, [
    canManageSecrets,
    currentWorkflow.id,
    handleDismissImportReport,
    handleLinkImportedSecret,
    handleValidateImported,
    importReport,
    importVariableValues,
    secrets,
    setActiveMode
  ]);

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
      nodeOutputsExecutionId?: string;
      system_prompt?: string;
      user_prompt?: string;
      record?: boolean;
    } = {
      sessionId
    };

    // Operators run the saved workflow with their input: pinned data, recording and partial runs are the editor's.
    const editorOptions = editorRunOptions;
    if (editorOptions) {
      payload.usePinnedData = true;
    }

    if (recordMcp && editorOptions) {
      payload.record = true;
    }

    if (typeof startNodeId === "string" && startNodeId.trim()) {
      payload.startNodeId = startNodeId.trim();
    }

    if (runMode === "single_node") {
      payload.runMode = "single_node";
      payload.nodeOutputs = extractNodeOutputsFromExecution(executionResult);
      // The run they come from, so the server treats them as that run's content (sensitive work stays marked).
      if (executionResult?.executionId) payload.nodeOutputsExecutionId = executionResult.executionId;
    }

    if (editorPrompts.sendSystemPrompt) {
      payload.system_prompt = systemPrompt;
    }

    if (editorPrompts.sendUserPrompt) {
      payload.user_prompt = userPrompt;
    }

    return payload;
  }, [editorRunOptions, executionResult, editorPrompts.sendSystemPrompt, editorPrompts.sendUserPrompt, recordMcp, sessionId, systemPrompt, userPrompt]);

  const buildWebhookExecutionPayload = useCallback(() => {
    const payload: {
      session_id: string;
      system_prompt?: string;
      user_prompt?: string;
    } = {
      session_id: sessionId
    };

    if (editorPrompts.sendSystemPrompt) {
      payload.system_prompt = systemPrompt;
    }

    if (editorPrompts.sendUserPrompt) {
      payload.user_prompt = userPrompt;
    }

    return payload;
  }, [editorPrompts.sendSystemPrompt, editorPrompts.sendUserPrompt, sessionId, systemPrompt, userPrompt]);

  const createRunTraceHandlers = useCallback(
    (workflowId: string) =>
      createTraceStreamHandlers({
        workflowId,
        enabled: isDebugMode,
        setExecutionResult,
        setLiveNodeStatuses,
        normalizeStatus: normalizeEditorExecutionStatus
      }),
    [isDebugMode]
  );

  // A broken stream reports the server's own error when it sent one, not the generic "no final result" text.
  const reportStreamFailure = useCallback(
    (streamFailure: unknown, fallbackMessage: string, trace: TraceStreamHandlers | null) => {
      const message = pickStreamFailureMessage(trace?.lastError() ?? null, handleApiError(streamFailure, fallbackMessage));
      setError(message);
      return message;
    },
    [handleApiError]
  );

  const handleExecute = useCallback(async (options?: { startNodeId?: string; runMode?: "workflow" | "single_node" }) => {
    let trace: TraceStreamHandlers | null = null;
    if (runDisabledReason) {
      setError(runDisabledReason);
      return;
    }
    // Running one node or from a node is the editor's; operators run the whole saved workflow.
    if ((options?.startNodeId || options?.runMode === "single_node") && !editorRunOptions) {
      setError("Running one node, or from a node, needs a builder role and edit access to this workflow. Run the whole workflow instead.");
      return;
    }
    try {
      setBusy(true);
      setRunningExecutionId(null);
      setError(null);
      const saved = await persistForRun();
      trace = createRunTraceHandlers(saved.id);
      const result = await executeWorkflowStream(saved.id, buildEditorExecutionPayload(options?.startNodeId, options?.runMode), {
        ...traceStreamCallbacks(trace, (event) => setError((current) => current ?? event.message)),
        onExecutionStarted: (event) => {
          handleStreamExecutionStarted(event);
        }
      });
      trace.dispose();
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
      trace?.dispose();
      const message = reportStreamFailure(execError, "Execution failed", trace);
      if (isDebugMode) {
        setExecutionResult((current) => buildStreamFailureResult(current, currentWorkflow.id, message));
        setLogsTab("logs");
        setActiveMode("editor");
      }
    } finally {
      // The run has ended, so a pending "waiting to stop" notice is stale.
      setError((current) => (current === CANCEL_REQUESTED_MESSAGE ? null : current));
      setLiveNodeStatuses({});
      setRunningExecutionId(null);
      setBusy(false);
    }
  }, [
    currentWorkflow.id,
    buildEditorExecutionPayload,
    createRunTraceHandlers,
    executeWorkflowStream,
    handleStreamExecutionStarted,
    reportStreamFailure,
    isDebugMode,
    persistForRun,
    refreshExecutionHistory,
    runDisabledReason,
    editorRunOptions,
  ]);

  const handleWebhookExecute = useCallback(async (testPayload: Record<string, unknown>) => {
    let trace: TraceStreamHandlers | null = null;
    try {
      setBusy(true);
      setRunningExecutionId(null);
      setError(null);
      startVisualRun();
      // The payload is kept in the workflow's settings, so the next "Webhook run" starts from it.
      const saved = await persistForRun((workflow) => withTestWebhookPayload(workflow, testPayload));
      trace = createRunTraceHandlers(saved.id);
      const result = await runWebhookStream({
        workflow_id: saved.id,
        ...buildWebhookExecutionPayload(),
        payload: testPayload
      }, {
        ...traceStreamCallbacks(trace, (event) => setError((current) => current ?? event.message)),
        onExecutionStarted: (event) => {
          handleStreamExecutionStarted(event);
        }
      });
      trace.dispose();
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
      trace?.dispose();
      const message = reportStreamFailure(execError, "Webhook execution failed", trace);
      if (isDebugMode) {
        setExecutionResult((current) => buildStreamFailureResult(current, currentWorkflow.id, message));
        setLogsTab("logs");
        setActiveMode("editor");
      }
    } finally {
      // The run has ended, so a pending "waiting to stop" notice is stale.
      setError((current) => (current === CANCEL_REQUESTED_MESSAGE ? null : current));
      stopVisualRun();
      setRunningExecutionId(null);
      setBusy(false);
    }
  }, [
    currentWorkflow.id,
    buildWebhookExecutionPayload,
    createRunTraceHandlers,
    handleStreamExecutionStarted,
    reportStreamFailure,
    isDebugMode,
    persistForRun,
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
    let trace: TraceStreamHandlers | null = null;
    let activeWorkflowId = currentWorkflow.id;

    let streamedAnyDelta = false;

    try {
      const savedWorkflow = await persistForRun();
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
      if (editorPrompts.sendSystemPrompt) {
        chatExecutionPayload.system_prompt = chatSystemPrompt;
      }

      const chatTrace = createRunTraceHandlers(workflowId);
      trace = chatTrace;
      const result = await executeWorkflowStream(
        workflowId,
        chatExecutionPayload,
        {
          ...traceStreamCallbacks(chatTrace, (event) => setChatError(event.message)),
          onNodeStart: (event) => {
            chatTrace.onNodeStart(event);
            setChatNodeTrace((current) => [...current, { nodeId: event.nodeId, status: "running", at: event.startedAt }].slice(-40));
          },
          onNodeComplete: (event) => {
            chatTrace.onNodeComplete(event);
            setChatNodeTrace((current) => [...current, { nodeId: event.nodeId, status: event.status, at: event.completedAt }].slice(-40));
          },
          onLlmDelta: (event) => {
            chatTrace.onLlmDelta(event);
            streamedAnyDelta = true;
            chatDeltaBufferRef.current += event.delta;
          },
          onElicitation: (event) => {
            if (activeAssistantMessageIdRef.current) {
              upsertChatMessageElicitation(workflowId, activeAssistantMessageIdRef.current, event.elicitation);
            }
          },
        }
      );
      chatTrace.dispose();

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
        // Phase 9.4 — surface citations from the extract_citations node.
        const citations = findCitationsInExecution(result);
        if (citations && citations.length > 0) {
          setChatMessageCitations(workflowId, activeAssistantMessageIdRef.current, citations);
        }
        // Phase: agent_clarify — when the agent paused to ask a question,
        // the workflow result carries a `clarification` field at the top
        // level. Render it as a "?" bubble so users see "the agent is
        // waiting on you" instead of treating the question as a final
        // answer. The user's NEXT chat message resumes naturally via
        // session memory — no special "resume" endpoint needed.
        const clarification = (result as { clarification?: { question: string; reason?: string } }).clarification;
        if (clarification && typeof clarification.question === "string") {
          setChatMessageClarification(workflowId, activeAssistantMessageIdRef.current, {
            question: clarification.question,
            ...(clarification.reason ? { reason: clarification.reason } : {})
          });
          // Also force the bubble text to be the question (in case the
          // workflow output wasn't already routed to the answer field).
          if (clarification.question.trim()) {
            setChatMessageText(workflowId, activeAssistantMessageIdRef.current, clarification.question);
          }
        }
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
      trace?.dispose();
      const messageText = reportStreamFailure(error, "Failed to stream chat response", trace);
      setChatError(messageText);
      if (isDebugMode) {
        setExecutionResult((current) => buildStreamFailureResult(current, activeWorkflowId, messageText));
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
    createRunTraceHandlers,
    reportStreamFailure,
    isDebugMode,
    persistForRun,
    editorPrompts.sendSystemPrompt,
    refreshExecutionHistory,
    setChatMessageStatus,
    setChatMessageCitations,
    setChatMessageClarification,
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

  /** An imported file whose id is a workflow you can see: import it as new (the default) or replace that one. */
  const [importConflict, setImportConflict] = useState<{
    content: string;
    fileName?: string;
    preview: WorkflowImportPreview & { existing: NonNullable<WorkflowImportPreview["existing"]> };
    error: string | null;
  } | null>(null);

  const commitNativeImport = useCallback(
    async (content: string, mode: "new" | "replace") => {
      const imported = await importWorkflow({ json: content, mode });
      const workflows = await fetchWorkflows({ projectId: activeProjectId });
      applyProjectWorkflowList(activeProjectId, workflows);
      hydrateWorkflow(imported);
      storeLocalWipWorkflow(imported);
      setActiveMode("editor");
    },
    [activeProjectId, applyProjectWorkflowList, hydrateWorkflow, setActiveMode]
  );

  const importNativeText = useCallback(
    async (content: string, fileName?: string) => {
      try {
        setBusy(true);
        setError(null);
        // A file whose id you can see asks first; anything else is imported as a new workflow.
        const preview = await previewWorkflowImport({ json: content });
        if (preview.existing) {
          setImportConflict({ content, fileName, preview: { ...preview, existing: preview.existing }, error: null });
          return;
        }
        await commitNativeImport(content, "new");
      } catch (importError) {
        handleApiError(importError, "Failed to import workflow");
      } finally {
        setBusy(false);
      }
    },
    [commitNativeImport, handleApiError]
  );

  const confirmImportConflict = useCallback(
    async (choice: ImportConflictChoice) => {
      if (!importConflict) return;
      try {
        setBusy(true);
        await commitNativeImport(importConflict.content, choice);
        setImportConflict(null);
      } catch (importError) {
        const message = importError instanceof Error ? importError.message : "Failed to import workflow";
        setImportConflict((current) => (current ? { ...current, error: message } : current));
      } finally {
        setBusy(false);
      }
    },
    [commitNativeImport, importConflict]
  );

  const openExternalImport = useCallback((source: ExternalImportSource | null = null) => {
    setExternalImportSource(source);
    setExternalImportOpen(true);
  }, []);

  /** Routes a JSON file: L2M exports import directly, other builders' exports get a preview first. */
  const importFromFile = useCallback(
    async (file: File) => {
      let content: string;
      try {
        content = await file.text();
      } catch (readError) {
        setError(`Could not read ${file.name}: ${readError instanceof Error ? readError.message : String(readError)}`);
        return;
      }
      if (!canManageWorkflows) {
        setError("You do not have permission to import workflows.");
        return;
      }
      if (inspectImportText(content).format === "external") {
        openExternalImport({ text: content, fileName: file.name });
        return;
      }
      await importNativeText(content, file.name);
    },
    [canManageWorkflows, importNativeText, openExternalImport]
  );

  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) await importFromFile(file);
    },
    [importFromFile]
  );

  const previewExternalImport = useCallback(
    (sourceText: string) => importExternalWorkflow({ sourceText, dryRun: true, projectId: activeProjectId || undefined }),
    [activeProjectId]
  );

  const commitExternalImport = useCallback(
    async (sourceText: string, name: string) => {
      const { workflow, report } = await importExternalWorkflow({ sourceText, name, projectId: activeProjectId || undefined });
      const workflows = await fetchWorkflows({ projectId: activeProjectId });
      applyProjectWorkflowList(activeProjectId, workflows);
      hydrateWorkflow(workflow);
      storeLocalWipWorkflow(workflow);
      rememberImportReport(workflow.id, report);
      setImportReport({ workflowId: workflow.id, report });
      setExternalImportOpen(false);
      setExternalImportSource(null);
      setActiveMode("editor");
    },
    [activeProjectId, applyProjectWorkflowList, hydrateWorkflow, setActiveMode]
  );

  const closeExternalImport = useCallback(() => {
    setExternalImportOpen(false);
    setExternalImportSource(null);
  }, []);

  const handleNativeFileInImportDialog = useCallback(
    (source: ExternalImportSource) => {
      closeExternalImport();
      void importNativeText(source.text, source.fileName);
    },
    [closeExternalImport, importNativeText]
  );

  /**
   * A workflow made with "New workflow" lives only in the editor until its first edit (or a save or run): then it is
   * saved. Opening another workflow first discards it, so abandoned clicks leave no empty workflows behind. An edit
   * that leaves the canvas empty (Clear) does not save it either: it saves once it has a node again, or on Save.
   */
  const unsavedNewWorkflowRef = useRef<{ id: string; baseline: string | null; saving: boolean } | null>(null);

  const handleCreateWorkflow = useCallback(() => {
    if (!canManageWorkflows) {
      setError("You do not have permission to create workflows.");
      return;
    }

    setError(null);
    const draft = createBlankWorkflow();
    const blankIds = new Set<string>();
    const userPromptNodeId = createNodeId("user_prompt", "User Prompt", blankIds);
    const outputNodeId = createNodeId("output", "Output", blankIds);
    const workflow: Workflow = {
      ...draft,
      // A name no workflow in the list has, so pickers never show two "Workflow N".
      name: nextNewWorkflowName(workflowList.map((item) => item.name)),
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
    };
    unsavedNewWorkflowRef.current = { id: workflow.id, baseline: null, saving: false };
    // Its first save shows every note, as any save does.
    draftIssuesWorkflowIdRef.current = workflow.id;
    // A slower load of another workflow must not replace the new one.
    workflowLoadSeqRef.current += 1;
    pendingWorkflowLoadIdRef.current = null;
    hydrateWorkflow(workflow);
    setActiveMode("editor");
  }, [canManageWorkflows, hydrateWorkflow, workflowList]);

  // The first edit of a new workflow saves it.
  useEffect(() => {
    const pending = unsavedNewWorkflowRef.current;
    if (!pending) return;
    if (pending.id !== currentWorkflow.id || currentWorkflowExists) {
      // Saved by a save or a run, or left for another workflow.
      unsavedNewWorkflowRef.current = null;
      return;
    }
    let signature: string;
    try {
      const snapshot = editorToWorkflow(currentWorkflow, nodes as EditorNode[], edges as Edge[]);
      signature = JSON.stringify({ name: snapshot.name, nodes: snapshot.nodes, edges: snapshot.edges });
    } catch {
      return;
    }
    if (pending.baseline === null) {
      pending.baseline = signature;
      return;
    }
    if (pending.saving || signature === pending.baseline) return;
    if (nodes.length === 0) return;
    pending.saving = true;
    persistWorkflow()
      .then(() => {
        if (unsavedNewWorkflowRef.current === pending) unsavedNewWorkflowRef.current = null;
      })
      .catch((saveError: unknown) => {
        // Tried again on the next edit; the error says why it did not save.
        pending.saving = false;
        pending.baseline = signature;
        handleApiError(saveError, "Failed to save workflow");
      });
  }, [currentWorkflow, currentWorkflowExists, edges, handleApiError, nodes, persistWorkflow]);

  const handleDuplicateWorkflow = useCallback(
    async (workflowId: string) => {
      if (!canManageWorkflows) {
        setError("You do not have permission to duplicate workflows.");
        return;
      }

      const source = workflowList.find((workflow) => workflow.id === workflowId);
      const suggestedName = copyWorkflowName(source?.name ?? "Workflow", workflowList.map((item) => item.name));
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
        applyProjectWorkflowList(activeProjectId, workflows);
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

      // The list does not know each workflow's gate: a non-admin hears an enforced gate's refusal before the confirm
      // (the server checks it too, and answers if the state cannot be read).
      if (authUser?.role !== "admin") {
        const release = await fetchReleaseState(workflowId).catch(() => null);
        const denial = workflowDeleteDenial(release?.state ?? null, false);
        if (denial) {
          setError(denial);
          return;
        }
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
        applyProjectWorkflowList(activeProjectId, workflows);

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
    [activeMode, activeProjectId, authUser?.role, canManageWorkflows, currentWorkflow.id, handleApiError, hydrateWorkflow, setEdges, setNodes, workflowList]
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
      if (!window.confirm(`Delete project '${target?.name ?? projectId}'? It must have no workflows, secrets, knowledge bases, MCP servers or eval datasets left; its variables, members and shares are removed. its members and shares are removed.`)) {
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
        applyProjectWorkflowList(activeProjectId, workflows);
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
        applyProjectWorkflowList(activeProjectId, workflows);
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
        const response = await saveWorkflowPin(saved.id, nodeId, nodeResult.output, executionResult?.executionId);
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

  const inspectorRef = useRef<NodeInspectorHandle | null>(null);
  const openNodeConfig = useCallback(
    (nodeId: string) => {
      const inspector = inspectorRef.current;
      if (editingNodeId && editingNodeId !== nodeId && inspector?.isDirty()) {
        // Ask before the open inspector's unsaved edits are replaced by another node.
        inspector.requestClose(() => setEditingNodeId(nodeId));
        return;
      }
      setEditingNodeId(nodeId);
    },
    [editingNodeId]
  );

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
      // A view-only workflow opens the node to look at; it is not duplicated, removed, disabled or recoloured.
      if (editDisabledReason && action.kind !== "edit") return;
      switch (action.kind) {
        case "edit":
          openNodeConfig(nodeId);
          return;
        case "duplicate": {
          pushHistorySnapshot();
          const src = soloSelectedNode;
          const newId = createNodeId(src.data.nodeType, src.data.label, nodeIdsInUseRef.current());
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
              color: src.data.color,
              ...(src.data.nodeExtras ? { nodeExtras: cloneJson(src.data.nodeExtras) } : {})
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
    [editDisabledReason, editingNodeId, openNodeConfig, pushHistorySnapshot, setEdges, setNodes, soloSelectedNode]
  );

  const saveNodeConfig = useCallback(
    (payload: {
      label: string;
      config: Record<string, unknown>;
      disabled?: boolean;
      color?: EditorNodeData["color"];
      nodeExtras?: Record<string, unknown>;
    }) => {
      if (!editingNodeId) {
        return;
      }

      const normalizedLabel = payload.label.trim();
      pushHistorySnapshot();
      setNodes((existing) =>
        existing.map((node) => {
          if (node.id !== editingNodeId) return node;
          const data: EditorNodeData = {
            ...node.data,
            label: normalizedLabel || node.data.label,
            config: payload.config,
            disabled: payload.disabled,
            color: payload.color
          };
          if (payload.nodeExtras) {
            if (Object.keys(payload.nodeExtras).length > 0) data.nodeExtras = payload.nodeExtras;
            else delete data.nodeExtras;
          }
          return { ...node, data };
        })
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

  /** Pans the canvas, keeping the zoom, so a node placed at `position` is in view. */
  const revealCanvasPosition = useCallback(
    (position: { x: number; y: number }) => {
      const bounds = flowWrapperRef.current?.getBoundingClientRect();
      if (!reactFlowInstance || !bounds || bounds.width === 0 || bounds.height === 0) return;
      const { x: panX, y: panY, zoom } = reactFlowInstance.getViewport();
      const left = position.x * zoom + panX;
      const top = position.y * zoom + panY;
      const right = left + ORBIT.cardWidth * zoom;
      const bottom = top + ORBIT.cardHeight * zoom;
      const margin = 24;
      if (left >= margin && top >= margin && right <= bounds.width - margin && bottom <= bounds.height - margin) return;
      reactFlowInstance.setCenter(position.x + ORBIT.cardWidth / 2, position.y + ORBIT.cardHeight / 2, { zoom, duration: 240 });
    },
    [reactFlowInstance]
  );

  /**
   * The node a new palette node connects after: the output whose `+` was used, else the one selected node (not a
   * node on an agent's port, not a sticky note). Null when there is none.
   */
  const resolveInsertSource = useCallback(
    (explicit: PaletteInsertSource | null): { node: EditorNode; handle: string | null; position?: { x: number; y: number } } | null => {
      const attached = attachedNodeIds(computeAttachmentSlots(nodes as EditorNode[], edges));
      if (explicit) {
        const node = (nodes as EditorNode[]).find((candidate) => candidate.id === explicit.nodeId);
        return node && !attached.has(node.id) ? { node, handle: explicit.handle, position: explicit.position } : null;
      }
      const selected = (nodes as EditorNode[]).filter((node) => node.selected);
      if (selected.length !== 1) return null;
      const node = selected[0]!;
      if (node.data.nodeType === "sticky_note") return null;
      if (attached.has(node.id)) return null;
      return { node, handle: chooseSourceHandle(node, edges) };
    },
    [edges, nodes]
  );

  const createNodeFromDefinition = useCallback(
    (
      definition: DefinitionNode,
      position?: { x: number; y: number },
      attachContext?: NodeDrawerContext | null,
      insertSource?: PaletteInsertSource | null
    ) => {
      const id = createNodeId(definition.type as EditorNodeData["nodeType"], definition.label, nodeIdsInUseRef.current());
      const bounds = flowWrapperRef.current?.getBoundingClientRect();
      const fallbackPosition = findFreePosition(
        reactFlowInstance
          ? reactFlowInstance.project({
              x: (bounds ? bounds.width : window.innerWidth) / 2 - ORBIT.cardWidth / 2,
              y: (bounds ? bounds.height : window.innerHeight) / 2 - ORBIT.cardHeight / 2
            })
          : { x: 160, y: 120 },
        nodes as EditorNode[]
      );
      const sourceNode = attachContext?.sourceNodeId
        ? nodes.find((node) => node.id === attachContext.sourceNodeId)
        : undefined;
      // Attached nodes are born on their orbit slot around the hub so the
      // canvas never shows them jumping into place.
      const attachmentPosition = (() => {
        if (!sourceNode || !attachContext?.sourceHandle) return undefined;
        const stub = { id, type: definition.type, position: sourceNode.position };
        const slots = computeAttachmentSlots(
          [...(nodes as EditorNode[]), stub],
          [...edges, { source: sourceNode.id, target: id, sourceHandle: attachContext.sourceHandle }]
        );
        return orbitPositions(sourceNode.id, slots, sourceNode.position)[id];
      })();

      // A step node (not an agent attachment, not a drop) goes after the selected node or the output whose `+` was used.
      const insertAfter = attachContext?.sourceHandle || (position && !insertSource) ? null : resolveInsertSource(insertSource ?? null);
      const insertPosition = insertAfter
        ? insertAfter.position ?? insertPositionAfter(insertAfter.node, insertAfter.handle, nodes as EditorNode[])
        : undefined;
      // The same rules as dragging a connection: a refused edge leaves the node placed but unconnected, with the notice.
      const connectPlan = insertAfter
        ? planInsertConnection(
            insertAfter.node,
            insertAfter.handle,
            { id, data: { nodeType: definition.type, label: definition.label } },
            nodes as EditorNode[],
            edges
          )
        : null;
      const connectAfter = insertAfter && connectPlan?.kind === "connect" ? { node: insertAfter.node, handle: connectPlan.sourceHandle } : null;

      const newNode: Node<EditorNodeData> = {
        id,
        type: definition.type === "sticky_note" ? "stickyNote" : "workflowNode",
        position: position ?? attachmentPosition ?? insertPosition ?? fallbackPosition,
        // A step node starts selected, so the next one added connects after it.
        selected: !attachContext?.sourceHandle,
        data: {
          label: definition.label,
          nodeType: definition.type as EditorNodeData["nodeType"],
          // A new model node starts on a configured provider (a server key, else a saved secret) or on Echo.
          config: withDefaultModelProvider(
            definition.type,
            newNodeConfig(definition.type, definition.sampleConfig, {
              afterLoopBodyNode: Boolean(connectAfter && isDirectLoopBodyNode(connectAfter.node.id, nodes as EditorNode[], edges))
            }),
            pickDefaultModelProvider({ envProviders: envModelProviders, secrets })
          )
        }
      };

      pushHistorySnapshot();
      setNodes((existing) => [
        ...(newNode.selected ? existing.map((node) => (node.selected ? { ...node, selected: false } : node)) : existing),
        newNode
      ]);
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
      } else if (connectAfter) {
        const edge = decorateEdge(
          {
            id: createEdgeId(connectAfter.node.id, id),
            source: connectAfter.node.id,
            target: id,
            sourceHandle: connectAfter.handle ?? undefined,
            targetHandle: undefined
          },
          [...(nodes as EditorNode[]), newNode as EditorNode]
        );
        setEdges((existing) => addEdge(edge, existing.map((candidate) => (candidate.selected ? { ...candidate, selected: false } : candidate))));
      }
      if (!attachContext?.sourceHandle) revealCanvasPosition(newNode.position);
      setError(connectPlan?.kind === "refused" ? connectPlan.message : null);
    },
    [edges, envModelProviders, nodes, pushHistorySnapshot, reactFlowInstance, resolveInsertSource, revealCanvasPosition, secrets, setEdges, setNodes]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      const source = connection.source;
      const target = connection.target;
      const verdict = validateConnection({ source, target, sourceHandle: connection.sourceHandle }, nodes as EditorNode[], edges);
      if (!verdict.ok) {
        setError(verdict.message);
        return;
      }
      const sourceHandle = verdict.sourceHandle ?? "";

      const alreadyConnected = edges.some(
        (edge) =>
          edge.source === source &&
          edge.target === target &&
          (edge.sourceHandle ?? null) === (sourceHandle || null) &&
          (edge.targetHandle ?? null) === (connection.targetHandle ?? null)
      );
      if (!alreadyConnected) pushHistorySnapshot();
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
    [edges, nodes, pushHistorySnapshot, setEdges]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData("application/reactflow");
      const droppedFile = event.dataTransfer.files?.[0];
      if (!nodeType && droppedFile) {
        if (droppedFile.name.toLowerCase().endsWith(".json") || droppedFile.type === "application/json") {
          void importFromFile(droppedFile);
        } else {
          setError("Drop a workflow exported as a .json file to import it.");
        }
        return;
      }
      if (!nodeType || !reactFlowInstance || !flowWrapperRef.current) {
        return;
      }

      const definition = paletteDefinitions.find((item) => paletteKey(item) === nodeType);
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
    [createNodeFromDefinition, paletteDefinitions, importFromFile, reactFlowInstance]
  );

  const handleToggleSecretSensitive = useCallback(
    async (secretId: string, sensitiveOutput: boolean) => {
      setSecretBusy(true);
      try {
        await setSecretSensitiveOutput(secretId, sensitiveOutput);
        await refreshSecrets();
        setSecretMessage(sensitiveOutput ? "Secret marked sensitive output." : "Sensitive output flag cleared.");
      } catch (toggleError) {
        handleApiError(toggleError, "Failed to change the sensitive output flag");
      } finally {
        setSecretBusy(false);
      }
    },
    [handleApiError, refreshSecrets]
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
      setSecretWarnings([]);
      // Saved in the project the Secrets page is showing.
      const created = await createSecret({
        name: secretName.trim(),
        provider: secretPayload.provider,
        value: secretPayload.value,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
        ...(secretSensitiveOutput ? { sensitiveOutput: true } : {})
      });
      setSecretWarnings(created.warnings ?? []);
      setSecretSensitiveOutputFlag(false);
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
    activeProjectId,
    handleApiError,
    refreshSecrets,
    secretSensitiveOutput,
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
        setMfaGate(result.mfaEnrollmentRequired ? "enroll" : null);
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
    setMfaGate(null);
    setWorkflowList([]);
    setListsProjectId(null);
    explicitProjectSwitchRef.current = null;
    setDeepLinkedWorkflowId(null);
    setInNoProject(false);
    setSharedWithMe([]);
    setSharedWithProject([]);
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

  if (breakGlassLink) {
    return (
      <BreakGlassConfirmCard
        link={breakGlassLink}
        // A fresh load picks up the new session everywhere (the banner, projects, settings).
        onSignedIn={() => window.location.assign(import.meta.env.BASE_URL)}
        onDismiss={() => setBreakGlassLink(null)}
      />
    );
  }

  if (!authUser) {
    if (mfaChallengeId) {
      return (
        <div className="auth-shell">
          <form className="auth-card" onSubmit={handleCompleteMfa}>
            <div className="auth-brand">
              <img src={`${import.meta.env.BASE_URL}lsquarem-logo.svg`} alt="L2M logo" className="auth-brand-logo" />
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
            <button className="auth-submit" type="submit" disabled={authBusy || !mfaCode.trim()}>
              {authBusy ? "Verifying..." : "Verify"}
            </button>
            <button
              type="button"
              className="auth-link-btn"
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
    if (inviteToken) {
      return (
        <AcceptInviteCard
          token={inviteToken}
          onSignedIn={(user) => {
            setInviteToken(null);
            setAuthError(null);
            setError(null);
            setAuthUser(user);
          }}
          onMfaChallenge={(challengeId) => {
            setInviteToken(null);
            setMfaChallengeId(challengeId);
          }}
          onDismiss={() => setInviteToken(null)}
        />
      );
    }
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={handleLogin}>
          <div className="auth-brand">
            <img src={`${import.meta.env.BASE_URL}lsquarem-logo.svg`} alt="L2M logo" className="auth-brand-logo" />
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
          <button className="auth-submit" type="submit" disabled={authBusy}>
            {authBusy ? "Signing in..." : "Sign in"}
          </button>
          {oidcLoginUrl && (
            <>
              <div className="auth-divider" aria-hidden="true">
                <span>or</span>
              </div>
              <a className="auth-sso-btn" href={oidcLoginUrl}>
                Sign in with SSO (OIDC)
              </a>
            </>
          )}
        </form>
      </div>
    );
  }

  if (mfaGate) {
    return (
      <MfaGateCard
        gate={mfaGate}
        email={authUser.email}
        // The studio's first loads were refused while restricted: start again with the unrestricted session.
        onDone={() => window.location.reload()}
        onSignOut={() => {
          void handleLogout();
        }}
      />
    );
  }

  if (loading && workflowList.length === 0) {
    return <div className="loading-screen">Loading L²M...</div>;
  }

  return (
    <div className="studio-shell">
      <IdleSessionWarning session={authSession} onSessionRefreshed={setAuthSession} onSignedOut={(reason) => notifySessionEnded(reason)} />
      <StepUpPrompt />
      <WelcomeModal
        open={showWelcome}
        docsUrl={docsUrl}
        onTryTemplate={handleWelcomeTryTemplate}
        onBuildAgent={handleWelcomeBuildAgent}
        onDescribe={canManageWorkflows && !inNoProject && workflowBuilderEnabled ? handleWelcomeDescribe : undefined}
        onDismiss={handleWelcomeDismiss}
      />
      <LeftMenuBar
        activeMode={activeMode}
        canManageSecrets={canManageSecrets}
        onModeChange={setActiveMode}
        projects={projects}
        activeProjectId={activeProjectId}
        onChangeActiveProject={switchProjectExplicitly}
        // Only people who may create projects (builders and admins) are offered "New project".
        onCreateProject={
          canManageWorkflows
            ? () => {
                void handleCreateProject();
              }
            : undefined
        }
        drawerOpen={navDrawerOpen}
        onDrawerOpenChange={setNavDrawerOpen}
        badges={{ approvals: pendingApprovalCount }}
      />

      <div className="studio-main">
        <BreakGlassBanner />
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
          saveDisabledReason={editDisabledReason}
          runDisabledReason={runDisabledReason}
          onExport={handleExport}
          onImportClick={() => importFileRef.current?.click()}
          onImportFileChange={handleImportFile}
          onImportExternal={canManageWorkflows ? () => openExternalImport() : undefined}
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
          onChangeActiveProject={switchProjectExplicitly}
          onCreateProject={
            canManageWorkflows
              ? () => {
                  void handleCreateProject();
                }
              : undefined
          }
          runStatus={deriveRunStatus(busy, executionResult)}
          releaseControl={
            currentWorkflowExists ? (
              <ReleasePill
                workflowId={currentWorkflow.id}
                refreshKey={releaseRefreshKey}
                canPublish={canManageWorkflows}
                isAdmin={authUser.role === "admin"}
                livePaused={draftIssues?.workflowId === currentWorkflow.id && draftIssues.liveTriggersPaused}
                onReleaseChanged={refreshLiveTriggersPaused}
                onOpenGates={() => {
                  setEvaluationsTab("gates");
                  setActiveMode("evaluations");
                }}
              />
            ) : undefined
          }
          onRun={() => {
            void handleExecute();
          }}
          onShare={
            currentWorkflowExists
              ? () =>
                  setShareWorkflowTarget({
                    id: currentWorkflow.id,
                    name: currentWorkflow.name,
                    projectId: currentWorkflow.projectId ?? activeProjectId
                  })
              : undefined
          }
          noWriteTools={Boolean(currentWorkflow.settings?.noWriteTools)}
          onToggleNoWriteTools={
            canEditOpenWorkflow
              ? () =>
                  setCurrentWorkflow((current) => {
                    const { noWriteTools, ...rest } = current.settings ?? {};
                    const settings = noWriteTools ? rest : { ...rest, noWriteTools: true };
                    return { ...current, settings };
                  })
              : undefined
          }
          strictTemplates={currentWorkflow.settings?.strictTemplates === true}
          onToggleStrictTemplates={
            canEditOpenWorkflow
              ? () =>
                  setCurrentWorkflow((current) => {
                    const { strictTemplates, ...rest } = current.settings ?? {};
                    const settings = strictTemplates ? rest : { ...rest, strictTemplates: true };
                    return { ...current, settings };
                  })
              : undefined
          }
          writeToolApproval={currentWorkflow.settings?.writeToolApproval?.enabled === true}
          onEditWriteToolApproval={canEditOpenWorkflow ? () => setWriteToolDialogOpen(true) : undefined}
          subjectRefsSet={(currentWorkflow.settings?.dataProtection?.subjectRefs?.length ?? 0) > 0}
          onEditSubjectRefs={canEditOpenWorkflow ? () => setSubjectRefsDialogOpen(true) : undefined}
          errorWorkflowSet={Boolean(currentWorkflow.settings?.errorWorkflowId)}
          onEditErrorWorkflow={canEditOpenWorkflow ? () => setErrorWorkflowDialogOpen(true) : undefined}
          recordMcp={recordMcp}
          onToggleRecordMcp={canManageWorkflows ? () => setRecordMcp((value) => !value) : undefined}
          docsUrl={docsUrl}
          navDrawerOpen={navDrawerOpen}
          onToggleNavDrawer={() => setNavDrawerOpen((open) => !open)}
        />

        <main className="main-content">
          {inviteNotice && (
            <div className="error-banner global-banner" role="status">
              {inviteNotice}{" "}
              <button type="button" className="auth-link-btn" onClick={() => setInviteNotice(null)}>
                Dismiss
              </button>
            </div>
          )}
          {error && <div className="error-banner global-banner">{error}</div>}
          {activeMode === "editor" && draftIssues && !draftIssues.dismissed && draftIssues.workflowId === currentWorkflow.id ? (
            <DraftWarnings
              issues={draftIssues.issues}
              liveTriggersPaused={draftIssues.liveTriggersPaused}
              nodeLabel={(nodeId) => (nodes as EditorNode[]).find((node) => node.id === nodeId)?.data.label}
              onSelectNode={openNodeConfig}
              onRemoveInvalidErrorConfig={removeInvalidErrorConfigs}
              onDismiss={() => setDraftIssues((current) => (current ? { ...current, dismissed: true } : current))}
            />
          ) : null}
          {secretMessage && <div className="info-banner global-banner">{secretMessage}</div>}

          {activeMode === "dashboard" && (
            <section className="dashboard-pane page-pane">
              <header className="page-head">
                <div className="page-head-copy">
                  <h2 className="page-title">Workflows</h2>
                  <p className="page-sub">
                    {inNoProject ? (
                      <span className="page-project">You are not a member of any project yet</span>
                    ) : (
                      <>
                        <span className="page-project">{activeProject?.name ?? "Default Project"}</span>
                        {activeProject?.description && <span className="page-sub-sep">· {activeProject.description}</span>}
                        <span className="page-sub-sep">
                          · {workflowList.length} workflow{workflowList.length === 1 ? "" : "s"}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <div className="page-actions">
                  {canManageWorkflows && activeProjectId !== DEFAULT_PROJECT_ID && (
                    <button
                      className="pg-btn ghost danger"
                      onClick={() => void handleDeleteProject(activeProjectId)}
                      disabled={busy}
                    >
                      Delete project
                    </button>
                  )}
                  <button className="pg-btn" onClick={() => void loadData()} disabled={busy}>
                    Refresh
                  </button>
                  {canManageWorkflows && !inNoProject && (
                    <button className="pg-btn" onClick={() => openExternalImport()} disabled={busy} title="Bring a workflow exported from another builder">
                      Import…
                    </button>
                  )}
                  {canManageWorkflows && !inNoProject && workflowBuilderEnabled && (
                    <button
                      className="pg-btn"
                      onClick={() => setWorkflowBuilderOpen(true)}
                      disabled={busy}
                      title="Say what it should do and review a draft before it is saved"
                    >
                      Describe it…
                    </button>
                  )}
                  {!inNoProject && (
                    <button
                      className="pg-btn primary"
                      onClick={() => handleCreateWorkflow()}
                      disabled={busy || !canManageWorkflows}
                    >
                      New workflow
                    </button>
                  )}
                </div>
              </header>

              {canManageWorkflows && !inNoProject && (
                <HomeStarters
                  projectId={activeProjectId}
                  onWorkflowCreated={handleTemplateWorkflowCreated}
                  onBrowseStarters={() => {
                    setTemplateInitialCategory("Starters");
                    setActiveMode("templates");
                  }}
                />
              )}

              <div className="dashboard-toolbar" style={inNoProject ? { display: "none" } : undefined}>
                <label className="page-search">
                  <span className="page-search-icon" aria-hidden="true">
                    ⌕
                  </span>
                  <input
                    className="dashboard-search"
                    value={dashboardFilter}
                    onChange={(event) => setDashboardFilter(event.target.value)}
                    placeholder="Search by name, id or tag…"
                    aria-label="Search workflows"
                  />
                </label>
                <div className="folder-strip" role="group" aria-label="Folders">
                  <button
                    type="button"
                    className={`folder-row${activeFolderFilter === undefined ? " active" : ""}`}
                    aria-pressed={activeFolderFilter === undefined}
                    onClick={() => setActiveFolderFilter(undefined)}
                  >
                    <span>All</span>
                    <span className="folder-row-count">{workflowList.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`folder-row${activeFolderFilter === null ? " active" : ""}`}
                    aria-pressed={activeFolderFilter === null}
                    onClick={() => setActiveFolderFilter(null)}
                  >
                    <span>Unfiled</span>
                    <span className="folder-row-count">{workflowList.filter((w) => !w.folderId).length}</span>
                  </button>
                  {folders.map((folder) => (
                    <span key={folder.id} className="folder-row-wrap">
                      <button
                        type="button"
                        className={`folder-row${activeFolderFilter === folder.id ? " active" : ""}`}
                        aria-pressed={activeFolderFilter === folder.id}
                        onClick={() => setActiveFolderFilter(folder.id)}
                      >
                        <span>{folder.name}</span>
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
                    </span>
                  ))}
                  {canManageWorkflows && (
                    <button
                      type="button"
                      className="folder-row folder-row-add"
                      onClick={() => void handleCreateFolder()}
                      disabled={busy}
                      title="New folder in this project"
                    >
                      + Folder
                    </button>
                  )}
                </div>
              </div>

              {!inNoProject && availableTags.length > 0 && (
                <div className="tag-filter-row" role="group" aria-label="Filter by tag">
                  <button
                    type="button"
                    className={`tag-chip${activeTagFilter === null ? " active" : ""}`}
                    aria-pressed={activeTagFilter === null}
                    onClick={() => setActiveTagFilter(null)}
                  >
                    All tags
                  </button>
                  {availableTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`tag-chip${activeTagFilter === tag ? " active" : ""}`}
                      aria-pressed={activeTagFilter === tag}
                      onClick={() => setActiveTagFilter(tag === activeTagFilter ? null : tag)}
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              )}

              {inNoProject && (
                <div className="page-empty" role="status">
                  {sharedWithMe.length > 0
                    ? "Workflows shared with you are listed below. Ask a project admin to add you to a project to work in one."
                    : "Nothing is shared with you yet. Ask a project admin to add you to a project or to share a workflow with you."}
                </div>
              )}

              {!inNoProject && filteredWorkflowItems.length === 0 && (
                <div className="page-empty">
                  {workflowList.length === 0
                    ? canManageWorkflows
                      ? "No workflows in this project yet. Use a starter above, or click New workflow."
                      : "No workflows in this project yet."
                    : "No workflows match your filters."}
                </div>
              )}

              {filteredWorkflowItems.length > 0 && (
                <div className="dashboard-grid">
                  {filteredWorkflowItems.map((workflow) => {
                    const folderName = workflow.folderId
                      ? folders.find((f) => f.id === workflow.folderId)?.name
                      : null;
                    const openIn = (mode: "editor" | "chat") => {
                      void loadWorkflowById(workflow.id);
                      setActiveMode(mode);
                    };
                    const menuActions = [
                      { id: "chat", label: "Chat", onSelect: () => openIn("chat") },
                      {
                        id: "execute",
                        label: "Execute",
                        disabled: busy,
                        onSelect: () => {
                          void handleExecuteSavedWorkflow(workflow.id);
                        }
                      },
                      ...(canManageWorkflows
                        ? [
                            {
                              id: "tags",
                              label: "Tags",
                              disabled: busy,
                              onSelect: () => void handleWorkflowEditTags(workflow.id)
                            },
                            {
                              id: "folder",
                              label: "Folder",
                              disabled: busy,
                              onSelect: () => void handleWorkflowAssignFolder(workflow.id)
                            }
                          ]
                        : []),
                      ...(canManageWorkflows && projects.length > 1
                        ? [
                            {
                              id: "project",
                              label: "Move to project",
                              disabled: busy,
                              onSelect: () => void handleWorkflowAssignProject(workflow.id)
                            },
                            {
                              id: "share",
                              label: "Share",
                              disabled: busy,
                              onSelect: () =>
                                setShareWorkflowTarget({
                                  id: workflow.id,
                                  name: workflow.name,
                                  projectId: workflow.projectId ?? activeProjectId
                                })
                            }
                          ]
                        : []),
                      ...(canManageWorkflows
                        ? [
                            {
                              id: "duplicate",
                              label: "Duplicate",
                              disabled: busy,
                              onSelect: () => {
                                void handleDuplicateWorkflow(workflow.id);
                              }
                            },
                            {
                              id: "delete",
                              label: "Delete",
                              danger: true,
                              disabled: busy,
                              onSelect: () => {
                                void handleDeleteWorkflow(workflow.id);
                              }
                            }
                          ]
                        : [])
                    ];
                    return (
                      <article key={workflow.id} className="dashboard-card">
                        <div className="dashboard-card-head">
                          <h3 className="dashboard-card-name">{workflow.name}</h3>
                          <WorkflowCardMenu label={`More actions for ${workflow.name}`} actions={menuActions} />
                        </div>
                        <div className="dashboard-card-id">
                          <span className="mono-cell">{workflow.id.slice(0, 8)}</span>
                          <span className="mono-cell">v{workflow.workflowVersion}</span>
                          {folderName && <span className="dashboard-card-folder">{folderName}</span>}
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
                        <div className="dashboard-card-foot">
                          <span className="dashboard-card-meta">Updated {formatWhen(workflow.updatedAt)}</span>
                          <button type="button" className="pg-btn primary small" onClick={() => openIn("editor")}>
                            Open
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}

              {sharedWithProject.length > 0 && (
                <section className="shared-with-me" aria-labelledby="shared-with-project-title">
                  <h3 id="shared-with-project-title" className="shared-with-me-title">
                    Shared with this project
                  </h3>
                  <ul className="shared-with-me-list">
                    {sharedWithProject.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="shared-with-me-item"
                          onClick={() => {
                            void loadWorkflowById(item.id);
                            setActiveMode("editor");
                          }}
                        >
                          <span className="shared-with-me-name">{item.name}</span>
                          <span className="settings-chip">{item.effectiveAccess === "execute" ? "Can view and run" : "Can view"}</span>
                          <span className="settings-muted">
                            from {projects.find((project) => project.id === item.ownerProjectId)?.name ?? item.ownerProjectId}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {sharedWithMe.length > 0 && (
                <section className="shared-with-me" aria-labelledby="shared-with-me-title">
                  <h3 id="shared-with-me-title" className="shared-with-me-title">
                    Shared with you
                  </h3>
                  <ul className="shared-with-me-list">
                    {sharedWithMe.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="shared-with-me-item"
                          onClick={() => {
                            void loadWorkflowById(item.id);
                            setActiveMode("editor");
                          }}
                        >
                          <span className="shared-with-me-name">{item.name}</span>
                          <span className="settings-chip">{item.effectiveAccess === "execute" ? "Can view and run" : "Can view"}</span>
                          <span className="settings-muted">{projects.find((project) => project.id === item.projectId)?.name ?? item.projectId}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </section>
          )}

          {activeMode === "editor" && showApiCatalog && (
            <ApiCatalogDialog
              projectId={catalogProjectId}
              sources={integrationCatalog.sources}
              canRefreshMcp={authUser?.role === "admin"}
              onChanged={reloadIntegrationCatalog}
              onClose={() => setShowApiCatalog(false)}
            />
          )}
          {activeMode === "editor" && (
            <WorkflowCanvasArea
              paletteFooter={
                canUseCatalog ? (
                  <>
                    <button
                      type="button"
                      className="pg-btn ghost small"
                      onClick={() => {
                        setShowNodeDrawer(false);
                        setNodeDrawerContext(null);
                        setPaletteInsertSource(null);
                        setShowApiCatalog(true);
                      }}
                    >
                      Add an API…
                    </button>
                  </>
                ) : undefined
              }
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
                setPaletteInsertSource(null);
              }}
              onOpenNodeDrawer={() => {
                if (editDisabledReason) return;
                setNodeDrawerContext(null);
                setPaletteInsertSource(null);
                setShowNodeDrawer(true);
              }}
              onInsertFromHandle={(nodeId, handle, position) => {
                if (editDisabledReason) return;
                setNodeDrawerContext(null);
                setPaletteInsertSource({ nodeId, handle, position });
                setShowNodeDrawer(true);
              }}
              insertAfterLabel={nodeDrawerContext ? null : resolveInsertSource(paletteInsertSource)?.node.data.label ?? null}
              groupedDefinitions={groupedDefinitions}
              onCreateNodeFromDefinition={(definition) =>
                createNodeFromDefinition(definition, undefined, nodeDrawerContext, nodeDrawerContext ? null : paletteInsertSource)
              }
              onOpenAgentAttachmentDrawer={handleOpenAgentAttachmentDrawer}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStart={handleNodeDragStart}
              onNodeDragStop={handleNodeDragStop}
              onEdgesChange={(changes) => {
                if (changes.some((change) => change.type === "remove")) pushHistorySnapshot();
                onEdgesChange(changes);
                setEdges((current) => current.map((edge) => decorateEdge(edge, nodes as EditorNode[])));
              }}
              onConnect={onConnect}
              onDeleteEdge={handleDeleteEdgeById}
              onInit={setReactFlowInstance}
              onOpenNodeConfig={openNodeConfig}
              reactFlowInstance={reactFlowInstance}
              editDisabledReason={editDisabledReason}
              runDisabledReason={runDisabledReason}
              onDescribeWorkflow={canEditOpenWorkflow && workflowBuilderEnabled ? () => setWorkflowBuilderOpen(true) : undefined}
              onClearCanvas={() => {
                if (editDisabledReason) return;
                if (nodes.length === 0 && edges.length === 0) return;
                const count = nodes.length;
                const confirmed = window.confirm(
                  `Remove ${count === 1 ? "the 1 node" : `all ${count} nodes`} and their connections from the canvas? You can undo this with Ctrl+Z.`
                );
                if (!confirmed) return;
                pushHistorySnapshot();
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
              onExecuteWebhook={() => setWebhookPayloadDialogOpen(true)}
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
              onBeforeTidy={pushHistorySnapshot}
              importPanel={importPanelBinding}
              mcpMarkers={mcpCanvasMarkers}
              onOpenMcpTarget={navigateMcp}
              runPicker={
                <RunPicker
                  workflowId={currentWorkflow.id}
                  enabled={currentWorkflowExists}
                  current={
                    executionResult && executionResult.workflowId === currentWorkflow.id
                      ? { executionId: executionResult.executionId, startedAt: executionResult.startedAt, status: executionResult.status }
                      : null
                  }
                  busy={busy}
                  ownRunsOnly={Boolean(workflowAccess?.workflowId === currentWorkflow.id && workflowAccess.ownRunsOnly)}
                  onPick={(executionId, isLatest) => void handlePickRun(executionId, isLatest)}
                />
              }
            />
          )}

          {activeMode === "variables" && (
            <section className="variables-pane page-pane">
              <header className="page-head">
                <div className="page-head-copy">
                  <h2 className="page-title">Variables</h2>
                  <p className="page-sub">
                    Reusable key/value pairs for <strong>{currentWorkflow.name}</strong>, available in templates as{" "}
                    <code className="mono-cell">{`{{vars.KEY}}`}</code>.
                  </p>
                </div>
                <div className="page-actions">
                  <button className="pg-btn" onClick={handleAddVariableRow} disabled={!canManageWorkflows}>
                    + Add variable
                  </button>
                  <button
                    className="pg-btn primary"
                    onClick={() => void handleSaveVariables()}
                    disabled={!canManageWorkflows || variablesBusy || !currentWorkflowExists}
                  >
                    {variablesBusy ? "Saving…" : "Save variables"}
                  </button>
                </div>
              </header>

              {!currentWorkflowExists && (
                <div className="page-empty">Save this workflow first from the editor, then return here to manage variables.</div>
              )}

              {currentWorkflowExists && workflowVariableRows.length === 0 && (
                <div className="page-empty">No variables yet. Add your first variable to start templating.</div>
              )}

              {currentWorkflowExists && workflowVariableRows.length > 0 && (
                <div className="variables-grid">
                  <div className="variable-row variable-row-head" aria-hidden="true">
                    <span>Key</span>
                    <span>Value</span>
                    <span />
                  </div>
                  {workflowVariableRows.map((row) => (
                    <div key={row.id} className="variable-row">
                      <label className="sr-only" htmlFor={`var-key-${row.id}`}>
                        Key
                      </label>
                      <input
                        id={`var-key-${row.id}`}
                        className="variable-key"
                        value={row.key}
                        onChange={(event) => handleUpdateVariableRow(row.id, "key", event.target.value)}
                        placeholder="API_BASE_URL"
                        disabled={!canManageWorkflows}
                      />
                      <label className="sr-only" htmlFor={`var-value-${row.id}`}>
                        Value
                      </label>
                      <textarea
                        id={`var-value-${row.id}`}
                        className="variable-value"
                        value={row.value}
                        onChange={(event) => handleUpdateVariableRow(row.id, "value", event.target.value)}
                        rows={2}
                        placeholder="https://example.com"
                        disabled={!canManageWorkflows}
                      />
                      <button
                        type="button"
                        className="pg-btn ghost danger small"
                        onClick={() => handleRemoveVariableRow(row.id)}
                        disabled={!canManageWorkflows}
                        aria-label={`Remove variable ${row.key || "row"}`}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
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
              onReplayFromNode={(executionId, nodeId) => handleReplayFromNode(executionId, nodeId)}
              onCancelExecution={(executionId) => handleCancelExecution(executionId)}
              onReplayCassette={canManageWorkflows ? (executionId, mode) => handleReplayCassette(executionId, mode) : undefined}
              canDeleteCassettes={authUser?.role === "admin"}
              canManageGoldenRuns={canManageWorkflows}
              mayEditWorkflow={mayEditRunWorkflow}
              onReviewApproval={(executionId) => {
                setApprovalFocusExecutionId(executionId);
                setActiveMode("approvals");
              }}
            />
          )}

          {activeMode === "chat" && (
            <section className="chat-pane page-pane">
              <header className="page-head chat-pane-header">
                <div className="page-head-copy">
                  <h2 className="page-title">Chat</h2>
                  <p className="page-sub">
                    Streaming assistant bound to <strong>{currentWorkflow.name}</strong>
                  </p>
                </div>
                <div className="chat-session-chip">
                  <span>Session</span>
                  <code className="mono-cell">{currentChatSessionId || "initializing…"}</code>
                </div>
              </header>

              <div className="chat-stream-shell">
                <div className="chat-history" ref={chatHistoryRef}>
                  {currentChatMessages.length === 0 && (
                    <div className="page-empty">Start a conversation. Responses stream token-by-token from the workflow LLM nodes.</div>
                  )}

                  {currentChatMessages.map((entry) => {
                    const isClarify = entry.role === "assistant" && Boolean(entry.clarification);
                    return (
                      <div
                        key={entry.id}
                        className={
                          entry.role === "user"
                            ? "chat-bubble chat-bubble-user"
                            : isClarify
                              ? "chat-bubble chat-bubble-assistant chat-bubble-clarify"
                              : "chat-bubble chat-bubble-assistant"
                        }
                      >
                        <div className="chat-bubble-label">
                          {entry.role === "user" ? "You" : isClarify ? (
                            <span><span className="chat-clarify-badge" aria-label="agent is asking">?</span> Assistant is asking</span>
                          ) : "Assistant"}
                        </div>
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
                          ) : entry.role === "assistant" && entry.citations && entry.citations.length > 0 ? (
                            <ChatBubbleWithCitations text={entry.text} citations={entry.citations} />
                          ) : (
                            entry.text || (entry.status === "streaming" ? "…" : "")
                          )}
                        </div>
                        {isClarify && entry.clarification?.reason && (
                          <div className="chat-clarify-reason">{entry.clarification.reason}</div>
                        )}
                        {entry.role === "assistant" && entry.elicitations && entry.elicitations.length > 0 && (
                          <div className="chat-elicitations">
                            {entry.elicitations.map((elicitation) => (
                              <McpElicitationForm
                                key={elicitation.id}
                                elicitation={elicitation}
                                compact
                                onAnswered={(settled) => upsertChatMessageElicitation(currentWorkflow.id, entry.id, settled)}
                              />
                            ))}
                          </div>
                        )}
                        {entry.role === "assistant" && entry.citations && entry.citations.length > 0 && (
                          <CitationFooter citations={entry.citations} />
                        )}
                      </div>
                    );
                  })}
                </div>

                <aside className="chat-side-trace" aria-label="Node trace">
                  <h4>Node trace</h4>
                  {!isDebugMode && <div className="page-hint">Enable Debug mode in the editor to see the live node trace.</div>}
                  {isDebugMode && chatNodeTrace.length === 0 && <div className="page-hint">Waiting for execution events.</div>}
                  {isDebugMode &&
                    chatNodeTrace.map((trace, index) => (
                      <div key={`${trace.nodeId}-${trace.at}-${index}`} className="chat-trace-item">
                        <span className="mono-cell">{trace.nodeId}</span>
                        <span className="status-pill" data-status={trace.status}>
                          {trace.status}
                        </span>
                      </div>
                    ))}
                </aside>
              </div>

              <form className="chat-input-row" onSubmit={handleChatSubmit}>
                <textarea
                  className="chat-system-prompt"
                  value={chatSystemPrompt}
                  onChange={(event) => setChatSystemPrompt(event.target.value)}
                  rows={2}
                  aria-label="Fallback system prompt"
                  placeholder="Fallback system prompt (used when no System Prompt node sets one)"
                />
                {chatPendingImages.length > 0 && (
                  <div className="chat-pending-images">
                    {chatPendingImages.map((img, idx) => (
                      <div key={idx} className="chat-pending-image-thumb">
                        <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                        <button
                          type="button"
                          aria-label="Remove attached image"
                          onClick={() => setChatPendingImages((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="chat-composer">
                  <input
                    className="chat-message-input"
                    aria-label="Message"
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
                    placeholder={chatPendingImages.length > 0 ? `${chatPendingImages.length} image(s) attached — type your message…` : "Ask something…"}
                  />
                  <button
                    type="submit"
                    className="pg-btn primary"
                    disabled={chatBusy || (!chatInput.trim() && chatPendingImages.length === 0)}
                  >
                    {chatBusy ? "Streaming…" : "Send"}
                  </button>
                </div>
              </form>
              {chatError && <div className="error-banner">{chatError}</div>}
            </section>
          )}

          {activeMode === "evaluations" && authUser && (
            <EvaluationsPage
              key={evaluationsTab}
              initialTab={evaluationsTab}
              currentWorkflowId={currentWorkflowExists ? currentWorkflow.id : undefined}
              workflows={workflowList}
              activeProjectId={activeProjectId}
              role={authUser.role}
              onOpenSettings={() => setActiveMode("settings")}
              onOpenRun={(executionId) => {
                setActiveMode("executions");
                if (!expandedExecutionIds.includes(executionId)) void toggleExecutionRow(executionId);
              }}
            />
          )}

          {activeMode === "knowledge" && (
            <KnowledgeBasePage
              isAdmin={authUser?.role === "admin"}
              activeProjectId={activeProjectId}
            />
          )}

          {activeMode === "mcp" && <McpOverviewPage onNavigate={navigateMcp} />}

          {activeMode === "connections" && <McpMyConnectionsPage />}

          {activeMode === "approvals" && authUser && (
            <ApprovalsPage
              focusExecutionId={approvalFocusExecutionId}
              onPendingCountChange={setPendingApprovalCount}
              onOpenRun={(executionId) => {
                setActiveMode("executions");
                if (!expandedExecutionIds.includes(executionId)) void toggleExecutionRow(executionId);
              }}
            />
          )}

          {activeMode === "security" && authUser && (
            <GuardSecurityPage
              projects={projects}
              workflows={workflowList}
              activeProjectId={activeProjectId}
              role={authUser.role}
              onOpenRun={(executionId) => {
                setActiveMode("executions");
                if (!expandedExecutionIds.includes(executionId)) void toggleExecutionRow(executionId);
              }}
            />
          )}

          {(activeMode === "mcp-servers" ||
            activeMode === "mcp-policies" ||
            activeMode === "mcp-toolsets" ||
            activeMode === "mcp-clients" ||
            activeMode === "mcp-ai-routes" ||
            activeMode === "mcp-playground") && (
            <McpServersPage
              key={activeMode}
              view={
                activeMode === "mcp-policies"
                  ? "policies"
                  : activeMode === "mcp-toolsets"
                    ? "toolsets"
                    : activeMode === "mcp-clients"
                      ? "clients"
                      : activeMode === "mcp-ai-routes"
                        ? "ai-routes"
                        : activeMode === "mcp-playground"
                          ? "playground"
                          : "servers"
              }
              focusServerId={mcpFocus?.page === "servers" ? mcpFocus.serverId : null}
              focusPolicyId={mcpFocus?.page === "policies" ? mcpFocus.policyId : null}
              isAdmin={authUser?.role === "admin"}
              canBuild={authUser?.role === "admin" || authUser?.role === "builder"}
              currentUserId={authUser?.id}
              activeProjectId={activeProjectId}
            />
          )}

          {activeMode === "mcp-tools" && (
            <McpToolsPage
              key={mcpFocus?.page === "tools" ? `${mcpFocus.serverId ?? ""}:${mcpFocus.toolName ?? ""}` : "tools"}
              activeProjectId={activeProjectId}
              focus={mcpFocus?.page === "tools" ? mcpFocus : null}
              onNavigate={navigateMcp}
              onOpenWorkflow={(workflowId) => {
                void loadWorkflowById(workflowId).then(() => setActiveMode("editor"));
              }}
            />
          )}

          {activeMode === "mcp-changes" && (
            <McpChangesPage
              isAdmin={authUser?.role === "admin"}
              activeProjectId={activeProjectId}
              initialServerId={mcpFocus?.page === "changes" ? mcpFocus.serverId : null}
              onNavigate={navigateMcp}
            />
          )}

          {activeMode === "templates" && (
            <TemplateGallery
              onWorkflowCreated={handleTemplateWorkflowCreated}
              initialCategory={templateInitialCategory}
              projectId={inNoProject ? undefined : activeProjectId}
            />
          )}

          {activeMode === "secrets" && (
            <section className="secrets-page page-pane">
              <header className="page-head">
                <div className="page-head-copy">
                  <h2 className="page-title">Secrets</h2>
                  <p className="page-sub">
                    Stored encrypted server-side and referenced by id in node configs. Values are never shown again.
                  </p>
                </div>
                <div className="page-actions">
                  <button className="pg-btn" onClick={() => void refreshSecrets()} disabled={secretBusy || busy}>
                    Refresh
                  </button>
                  <button className="pg-btn ghost" onClick={() => setActiveMode("editor")}>
                    Back to editor
                  </button>
                </div>
              </header>

              <div className="secrets-grid">
                <article className="secrets-card pg-card">
                  <h3 className="pg-card-title">Create secret</h3>
                  <label htmlFor="secret-name">Name</label>
                  <input id="secret-name" value={secretName} onChange={(event) => setSecretName(event.target.value)} />
                  <label htmlFor="secret-provider">Provider</label>
                  <select
                    id="secret-provider"
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
                      <label htmlFor="secret-custom-provider">Custom provider name</label>
                      <input
                        id="secret-custom-provider"
                        value={secretCustomProvider}
                        onChange={(event) => setSecretCustomProvider(event.target.value)}
                        placeholder="my-provider"
                      />
                    </>
                  )}

                  {secretProvider === "google_drive" ? (
                    <>
                      <label htmlFor="secret-google-mode">Google auth mode</label>
                      <select
                        id="secret-google-mode"
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
                          <label htmlFor="secret-google-token">Google Drive access token</label>
                          <input
                            id="secret-google-token"
                            type="password"
                            autoComplete="off"
                            value={secretGoogleAccessToken}
                            onChange={(event) => setSecretGoogleAccessToken(event.target.value)}
                            placeholder="ya29..."
                          />
                        </>
                      ) : (
                        <>
                          <label htmlFor="secret-google-sa">Google service account JSON</label>
                          <textarea
                            id="secret-google-sa"
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
                      <label htmlFor="secret-connection">Connection string</label>
                      <input
                        id="secret-connection"
                        type="password"
                        autoComplete="off"
                        value={secretConnectionString}
                        onChange={(event) => setSecretConnectionString(event.target.value)}
                        placeholder="postgresql://user:pass@host:5432/db"
                      />
                    </>
                  ) : (
                    <>
                      <label htmlFor="secret-value">
                        {secretProvider === "webhook"
                          ? "Shared secret / token"
                          : secretProvider === "custom"
                            ? "Secret value"
                            : "API key / token"}
                      </label>
                      <input
                        id="secret-value"
                        type="password"
                        autoComplete="off"
                        value={secretGenericValue}
                        onChange={(event) => setSecretGenericValue(event.target.value)}
                      />
                    </>
                  )}
                  <label className="secret-sensitive-toggle">
                    <input
                      type="checkbox"
                      checked={secretSensitiveOutput}
                      onChange={(event) => setSecretSensitiveOutputFlag(event.target.checked)}
                    />
                    <span>
                      Sensitive output
                      <small className="kb-subtle"> Nodes that use this secret produce sensitive data (for content rules). Only an admin can clear it later.</small>
                    </span>
                  </label>
                  <div className="page-actions">
                    <button className="pg-btn primary" onClick={handleCreateSecret} disabled={secretBusy || busy}>
                      {secretBusy ? "Creating…" : "Create secret"}
                    </button>
                  </div>
                  <SecretSaveWarnings warnings={secretWarnings} />
                </article>

                <article className="secrets-card pg-card">
                  <div className="secrets-card-header">
                    <h3 className="pg-card-title">Saved secrets</h3>
                    <span className="pg-count">{secrets.length}</span>
                  </div>
                  {secrets.length === 0 && <div className="page-empty compact">No secrets yet.</div>}
                  <div className="secret-list">
                    {secrets.map((secret) => (
                      <div key={secret.id} className="secret-item">
                        <div className="secret-item-copy">
                          <strong>{secret.name}</strong>
                          <span className="pg-pill">{secret.provider}</span>
                          {secret.sensitiveOutput && (
                            <span className="data-label-chip is-sensitive" title="Nodes that use this secret produce sensitive output">
                              sensitive output
                            </span>
                          )}
                          <code className="mono-cell">{secret.id}</code>
                        </div>
                        <div className="secret-item-actions">
                          {(!secret.sensitiveOutput || authUser?.role === "admin") && (
                            <button
                              type="button"
                              className="pg-btn small ghost"
                              disabled={secretBusy}
                              onClick={() => void handleToggleSecretSensitive(secret.id, !secret.sensitiveOutput)}
                            >
                              {secret.sensitiveOutput ? "Clear sensitive" : "Mark sensitive"}
                            </button>
                          )}
                          <button type="button" className="pg-btn small" onClick={() => void copySecretId(secret.id)}>
                            Copy id
                          </button>
                          <button
                            type="button"
                            className="pg-btn small ghost"
                            onClick={() => {
                              setActiveMode("editor");
                              setSecretMessage("Open an LLM/Agent node and pick this secret in Provider settings.");
                            }}
                          >
                            Use in node
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              </div>

              <p className="page-hint secrets-hint">
                To attach a secret to an LLM or agent node: open the Editor, select the node and choose the secret in the
                Provider section of the inspector.
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

      {importConflict ? (
        <ImportConflictDialog
          fileName={importConflict.fileName}
          importedName={importConflict.preview.workflow.name.replace(/ \(imported\)$/, "")}
          existing={importConflict.preview.existing}
          diff={importConflict.preview.diff}
          canReplace={importConflict.preview.canReplace !== false}
          busy={busy}
          error={importConflict.error}
          onConfirm={(choice) => void confirmImportConflict(choice)}
          onClose={() => setImportConflict(null)}
        />
      ) : null}

      <ExternalImportDialog
        open={externalImportOpen}
        initialSource={externalImportSource}
        projectName={activeProject?.name}
        onPreview={previewExternalImport}
        onImport={commitExternalImport}
        onNativeFile={handleNativeFileInImportDialog}
        onClose={closeExternalImport}
      />

      {writeToolDialogOpen && (
        <WriteToolApprovalDialog
          workflowId={currentWorkflow.id}
          projectId={currentWorkflow.projectId ?? activeProjectId}
          settings={currentWorkflow.settings?.writeToolApproval}
          onChange={(writeToolApproval) => setCurrentWorkflow((current) => ({ ...current, settings: { ...(current.settings ?? {}), writeToolApproval } }))}
          onClose={() => setWriteToolDialogOpen(false)}
        />
      )}

      {subjectRefsDialogOpen && (
        <SubjectRefsDialog
          workflowId={currentWorkflow.id}
          subjectRefs={currentWorkflow.settings?.dataProtection?.subjectRefs}
          onChange={(subjectRefs) =>
            setCurrentWorkflow((current) => {
              const { dataProtection: _previous, ...rest } = current.settings ?? {};
              return { ...current, settings: subjectRefs.length > 0 ? { ...rest, dataProtection: { subjectRefs } } : rest };
            })
          }
          onClose={() => setSubjectRefsDialogOpen(false)}
        />
      )}

      {workflowBuilderOpen && canManageWorkflows && (
        <WorkflowBuilderDialog
          defaultModel={pickDefaultModelProvider({ envProviders: envModelProviders, secrets })}
          secrets={secrets}
          projectId={activeProjectId}
          userId={authUser?.id}
          onCreate={handleCreateBuiltWorkflow}
          onUseTemplate={handleBuilderTemplate}
          onClose={() => setWorkflowBuilderOpen(false)}
        />
      )}

      {webhookPayloadDialogOpen && (
        <WebhookTestPayloadDialog
          payload={currentWorkflow.settings?.testWebhookPayload}
          busy={busy}
          onRun={(payload) => {
            setWebhookPayloadDialogOpen(false);
            void handleWebhookExecute(payload);
          }}
          onClose={() => setWebhookPayloadDialogOpen(false)}
        />
      )}

      {errorWorkflowDialogOpen && (
        <ErrorWorkflowDialog
          workflowId={currentWorkflow.id}
          errorWorkflowId={currentWorkflow.settings?.errorWorkflowId}
          workflows={workflowList}
          onChange={(errorWorkflowId) =>
            setCurrentWorkflow((current) => {
              const { errorWorkflowId: _previous, ...rest } = current.settings ?? {};
              return { ...current, settings: errorWorkflowId ? { ...rest, errorWorkflowId } : rest };
            })
          }
          onClose={() => setErrorWorkflowDialogOpen(false)}
        />
      )}

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
        <RadialActionRing node={soloSelectedNode} center={radialCenter} onAction={onRadialAction} readOnly={Boolean(editDisabledReason)} />
      )}
      {editingNode && (
        <NodeInspector
          controlRef={inspectorRef}
          node={editingNode}
          trace={buildNodeTrace(editingNode.id, executionResult, executionStatuses, telemetryByNodeId)}
          slots={buildNodeSlots(editingNode.id, nodes, edges)}
          onAttach={(handle) => {
            // The node palette opens on the canvas, under the inspector's layer: close the inspector first (unsaved
            // edits are confirmed), then open the palette for this agent's port.
            const agentId = editingNode.id;
            const openPalette = () => {
              setEditingNodeId(null);
              handleOpenAgentAttachmentDrawer(agentId, handle);
            };
            if (inspectorRef.current) inspectorRef.current.requestClose(openPalette);
            else openPalette();
          }}
          inputOptions={editingNodeInputOptions}
          executionResult={isDebugMode ? executionResult : null}
          nodeLabels={nodeLabelById}
          onNavigateNode={openNodeConfig}
          workflowContext={{
            id: currentWorkflow.id,
            name: currentWorkflow.name,
            vars: currentWorkflow.variables,
            strictTemplates: currentWorkflow.settings?.strictTemplates === true,
            projectId: currentWorkflow.projectId ?? activeProjectId
          }}
          pinnedData={currentWorkflow.pinnedData}
          showRuntimeInspection={isDebugMode}
          secrets={secrets}
          onRefreshSecrets={refreshSecrets}
          mcpServerDefinitions={mcpServerDefinitions}
          onClose={() => setEditingNodeId(null)}
          onSave={saveNodeConfig}
          readOnlyReason={editDisabledReason}
          onExecuteStep={() => {
            void handleExecute({ startNodeId: editingNode.id, runMode: "single_node" });
          }}
          onPinNodeOutput={handlePinNodeOutput}
          onUnpinNodeOutput={handleUnpinNodeOutput}
          canSetTriggerTrust={authUser?.role === "admin"}
        />
      )}
      <KeyboardShortcutsPanel open={showShortcutsPanel} onClose={() => setShowShortcutsPanel(false)} />
    </div>
  );
}
