import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from "react";
import { NodeActivityList } from "./NodeActivityList";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance
} from "reactflow";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import { AGENT_ATTACHMENT_HANDLES, AGENT_ATTACHMENT_STYLES, type AgentAttachmentHandle } from "../lib/agent-attachments";
import {
  ORBIT,
  attachedNodeIds,
  computeAttachmentSlots,
  computeStages,
  findHubOf,
  isHubEntry,
  isHubType,
  orbitPositions,
  tidyLayout,
  type Point
} from "../lib/stages";
import { NodePalette, type PaletteDefinition, type PaletteSection } from "./NodePalette";
import { RunTape } from "./RunTape";
import { LiveElapsed } from "./WorkflowCanvasNode";
import type { LiveNodeResult } from "../lib/run-trace";
import { StageStrip, type StageStripNode } from "./StageStrip";
import type { PaletteCategoryIconKey } from "./node-icons";
import { ImportReportPanel, type ImportReportPanelProps } from "./ImportReportPanel";
import type { ImportChecklistNode } from "../lib/external-import";
import type { McpCanvasMarker, McpNavTarget } from "../lib/mcp-control-plane";

type DefinitionNode = PaletteDefinition;

type LogsTab = "logs" | "inputs";
type PanelTab = "tape" | "logs";

interface NodeDrawerContext {
  title: string;
  description: string;
  allowedTypes: string[];
  sourceNodeId?: string;
  sourceHandle?: AgentAttachmentHandle;
}

interface PaletteCategoryMeta {
  key: string;
  title: string;
  description: string;
  icon: PaletteCategoryIconKey;
  match: (node: DefinitionNode) => boolean;
}

const PALETTE_CATEGORIES: PaletteCategoryMeta[] = [
  {
    key: "trigger",
    title: "Triggers",
    description: "Start workflow runs from schedules, webhooks, forms, chat, files, or expose this workflow as an MCP tool that other agents call.",
    icon: "trigger",
    match: (node) =>
      [
        "schedule_trigger",
        "webhook_input",
        "text_input",
        "mcp_server_trigger",
        "form_trigger",
        "chat_trigger",
        "file_trigger",
        "rss_trigger",
        "sse_trigger",
        "manual_trigger",
        "error_trigger"
      ].includes(node.type)
  },
  {
    key: "ai",
    title: "AI",
    description: "Build agents, prompt pipelines, RAG retrieval and guardrails.",
    icon: "ai",
    match: (node) =>
      [
        "llm_call",
        "openai_chat_model",
        "anthropic_chat_model",
        "ollama_chat_model",
        "openai_compatible_chat_model",
        "ai_gateway_chat_model",
        "azure_openai_chat_model",
        "google_gemini_chat_model",
        "embeddings_azure_openai",
        "agent_orchestrator",
        "supervisor_node",
        "prompt_template",
        "rag_retrieve",
        "local_memory",
        "output_guardrail",
        "guard",
        "guard_protection",
        "output_parser",
        "basic_llm_chain",
        "qa_chain",
        "summarization_chain",
        "information_extractor",
        "text_classifier",
        "sentiment_analysis",
        "ai_transform"
      ].includes(node.type)
  },
  {
    key: "apps",
    title: "Action in an App",
    description: "Call connectors, MCP tools, or reusable sub-workflows.",
    icon: "app",
    match: (node) =>
      [
        "connector_source",
        "google_drive_source",
        "azure_storage",
        "azure_cosmos_db",
        "azure_monitor_http",
        "azure_ai_search_vector_store",
        "qdrant_vector_store",
        "mcp_tool",
        "http_request",
        "web_browse",
        "execute_workflow"
      ].includes(node.type)
  },
  {
    key: "transform",
    title: "Data Transformation",
    description: "Parse, validate, chunk, merge, and shape structured outputs.",
    icon: "transform",
    match: (node) => ["code_node", "python_code", "document_chunker", "input_validator", "set_node", "merge_node", "chart_node"].includes(node.type)
  },
  {
    key: "flow",
    title: "Flow",
    description: "Branch, merge, loop, wait, and handle fallback paths.",
    icon: "flow",
    match: (node) => ["if_node", "switch_node", "chat_intent_router", "try_catch", "loop_node", "wait_node"].includes(node.type)
  },
  {
    key: "human",
    title: "Human in the Loop",
    description: "Pause for human approvals before continuing execution.",
    icon: "human",
    match: (node) => node.type === "human_approval"
  },
  {
    key: "core",
    title: "Core",
    description: "Input/output primitives and base workflow utilities.",
    icon: "core",
    match: () => true
  }
];

interface WorkflowCanvasAreaProps {
  isLogsPanelCollapsed: boolean;
  canvasAndLogsStyle: CSSProperties;
  flowWrapperRef: RefObject<HTMLDivElement | null>;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  showNodeDrawer: boolean;
  nodeDrawerContext?: NodeDrawerContext | null;
  onCloseNodeDrawer: () => void;
  onOpenNodeDrawer: () => void;
  groupedDefinitions: Map<string, DefinitionNode[]>;
  onCreateNodeFromDefinition: (definition: DefinitionNode) => void;
  onOpenAgentAttachmentDrawer?: (sourceNodeId: string, sourceHandle: AgentAttachmentHandle) => void;
  nodes: Node<EditorNodeData>[];
  edges: Edge[];
  nodeTypes: NodeTypes;
  edgeTypes: EdgeTypes;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onDeleteEdge: (edgeId: string) => void;
  onInit: (instance: ReactFlowInstance) => void;
  onOpenNodeConfig: (nodeId: string) => void;
  reactFlowInstance: ReactFlowInstance | null;
  onClearCanvas: () => void;
  debugMode: boolean;
  onDebugModeChange: (next: boolean) => void;
  /** Kept for API compatibility; the primary Run action lives in the HUD. */
  onExecuteWorkflow: () => void;
  onExecuteWebhook: () => void;
  onCancelRun?: () => void;
  canCancelRun?: boolean;
  activeRunExecutionId?: string | null;
  busy: boolean;
  onLogsResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
  logsTab: LogsTab;
  onLogsTabChange: (tab: LogsTab) => void;
  onClearLogs: () => void;
  onToggleLogsPanel: () => void;
  executionResult: WorkflowExecutionResult | null;
  statusColors: Record<string, string>;
  systemPrompt: string;
  onSystemPromptChange: (value: string) => void;
  userPrompt: string;
  onUserPromptChange: (value: string) => void;
  sessionId: string;
  onSessionIdChange: (value: string) => void;
  /** Called right before Tidy rewrites node positions (e.g. to push an undo snapshot). */
  onBeforeTidy?: () => void;
  /** Post-import checklist; shown on the canvas while set. */
  importPanel?: ImportPanelBinding | null;
  /** Phase 10.3 — MCP server status and policy markers by node id, and where clicking one goes. */
  mcpMarkers?: Record<string, McpCanvasMarker>;
  onOpenMcpTarget?: (target: McpNavTarget) => void;
}

/** Everything the import checklist needs from the app; the canvas adds focus and Tidy. */
export type ImportPanelBinding = Omit<ImportReportPanelProps, "nodes" | "onFocusNode" | "onTidy">;

function stringifyPretty(value: unknown) {
  const MAX_PREVIEW_CHARS = 80_000;
  try {
    const raw = JSON.stringify(value, null, 2);
    if (raw.length <= MAX_PREVIEW_CHARS) {
      return raw;
    }
    const hidden = raw.length - MAX_PREVIEW_CHARS;
    return `${raw.slice(0, MAX_PREVIEW_CHARS)}\n...[truncated ${hidden} chars for UI safety]`;
  } catch {
    return String(value);
  }
}

function samePoint(a: Point | undefined, b: Point | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

export function WorkflowCanvasArea({
  isLogsPanelCollapsed,
  canvasAndLogsStyle,
  flowWrapperRef,
  onDrop,
  onDragOver,
  showNodeDrawer,
  nodeDrawerContext,
  onCloseNodeDrawer,
  onOpenNodeDrawer,
  groupedDefinitions,
  onCreateNodeFromDefinition,
  onOpenAgentAttachmentDrawer,
  nodes,
  edges,
  nodeTypes,
  edgeTypes,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onDeleteEdge,
  onInit,
  onOpenNodeConfig,
  reactFlowInstance,
  onClearCanvas,
  debugMode,
  onDebugModeChange,
  onExecuteWebhook,
  onCancelRun,
  canCancelRun = false,
  activeRunExecutionId,
  busy,
  onLogsResizeStart,
  logsTab,
  onLogsTabChange,
  onClearLogs,
  onToggleLogsPanel,
  executionResult,
  statusColors,
  onBeforeTidy,
  importPanel,
  mcpMarkers,
  onOpenMcpTarget
}: WorkflowCanvasAreaProps) {
  const [fileDragActive, setFileDragActive] = useState(false);
  const [expandedNodeLogIds, setExpandedNodeLogIds] = useState<string[]>([]);
  const [panelTab, setPanelTab] = useState<PanelTab>(logsTab === "logs" ? "tape" : "logs");
  const [showKey, setShowKey] = useState(false);

  // ---------------------------------------------------------------- palette
  const allDefinitions = useMemo(() => {
    const byType = new Map<string, DefinitionNode>();
    for (const items of groupedDefinitions.values()) {
      for (const item of items) {
        byType.set(item.type, item);
      }
    }
    return [...byType.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [groupedDefinitions]);

  const paletteSections = useMemo<PaletteSection[]>(() => {
    const seen = new Set<string>();
    return PALETTE_CATEGORIES.map((section) => {
      const items = allDefinitions.filter((node) => !seen.has(node.type) && section.match(node));
      for (const item of items) seen.add(item.type);
      return { key: section.key, title: section.title, description: section.description, icon: section.icon, items };
    }).filter((section) => section.items.length > 0);
  }, [allDefinitions]);

  const filteredDefinitions = useMemo(() => {
    if (!nodeDrawerContext) return null;
    const allowed = new Set(nodeDrawerContext.allowedTypes);
    return allDefinitions.filter((definition) => allowed.has(definition.type));
  }, [allDefinitions, nodeDrawerContext]);

  const handleAddNode = useCallback(
    (definition: DefinitionNode) => {
      onCreateNodeFromDefinition(definition);
      onCloseNodeDrawer();
    },
    [onCloseNodeDrawer, onCreateNodeFromDefinition]
  );

  useEffect(() => {
    if (!showNodeDrawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseNodeDrawer();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showNodeDrawer, onCloseNodeDrawer]);

  // ------------------------------------------------------- stages + orbits
  const slots = useMemo(() => computeAttachmentSlots(nodes, edges), [nodes, edges]);
  const attached = useMemo(() => attachedNodeIds(slots), [slots]);
  const stageInfo = useMemo(() => computeStages(nodes, edges), [nodes, edges]);
  const hubCount = useMemo(() => Object.values(slots).filter((entry) => isHubEntry(entry)).length, [slots]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const renderEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        data: {
          ...(edge.data ?? {}),
          onDeleteEdge
        }
      })),
    [edges, onDeleteEdge]
  );

  const renderNodes = useMemo(
    () =>
      nodes.map((node) => {
        const nodeType = node.data.nodeType;
        const hub = isHubType(nodeType);
        // Phase 12.1 — a Guard node carries protection providers like a hub carries its ports.
        const guardCarrier = nodeType === "guard";
        const attachment = attached.has(node.id) ? findHubOf(node.id, slots) : null;
        const mcpMarker = mcpMarkers?.[node.id];
        if (!hub && !guardCarrier && !attachment && !mcpMarker) {
          return node;
        }
        const data: EditorNodeData = { ...node.data };
        if (mcpMarker) {
          data.mcpMarker = mcpMarker;
          data.onOpenMcpTarget = onOpenMcpTarget;
        }
        if (hub || guardCarrier) {
          if (slots[node.id]) data.slots = slots[node.id];
          if (onOpenAgentAttachmentDrawer) {
            data.onOpenAgentAttachmentDrawer = (sourceHandle: AgentAttachmentHandle) => onOpenAgentAttachmentDrawer(node.id, sourceHandle);
          }
        }
        if (attachment) {
          data.attachedTo = attachment.hubId;
          data.attachedAs = attachment.port;
          const hubNode = nodeById.get(attachment.hubId);
          if (hubNode) {
            const carrierIsHub = isHubType(hubNode.data.nodeType);
            const carrierAttached = attached.has(hubNode.id);
            const carrierHalf = carrierIsHub
              ? { x: ORBIT.hubSize / 2, y: ORBIT.hubSize / 2 }
              : carrierAttached
                ? { x: ORBIT.satelliteSize / 2, y: ORBIT.satelliteSize / 2 }
                : { x: ORBIT.cardWidth / 2, y: ORBIT.cardHeight / 2 };
            const dx = node.position.x + ORBIT.satelliteSize / 2 - (hubNode.position.x + carrierHalf.x);
            const dy = node.position.y + ORBIT.satelliteSize / 2 - (hubNode.position.y + carrierHalf.y);
            // Guard and protection satellites sit on the diagonal next to the model slot:
            // their labels go sideways so they never stack on the model's label.
            const sideways = (attachment.port === "guard" || attachment.port === "protection") && Math.abs(dx) > ORBIT.satelliteSize / 2;
            data.labelSide = sideways ? (dx < 0 ? "left" : "right") : Math.abs(dy) >= Math.abs(dx) * 1.2 ? (dy < 0 ? "top" : "bottom") : dx < 0 ? "left" : "right";
          }
        }
        return {
          ...node,
          data,
          draggable: attachment ? false : node.draggable
        };
      }),
    [attached, mcpMarkers, nodeById, nodes, onOpenAgentAttachmentDrawer, onOpenMcpTarget, slots]
  );

  /** Position changes for every node attached (recursively) to `hubId`. */
  const orbitChangesFor = useCallback(
    (hubId: string, hubPosition: Point, dragging?: boolean): NodeChange[] => {
      const positions = orbitPositions(hubId, slots, hubPosition);
      return Object.entries(positions).map(([id, position]) => ({ type: "position", id, position, dragging }));
    },
    [slots]
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const extra: NodeChange[] = [];
      for (const change of changes) {
        if (change.type === "position" && change.position && slots[change.id] && !findHubOf(change.id, slots)) {
          extra.push(...orbitChangesFor(change.id, change.position, change.dragging));
        }
      }
      onNodesChange(extra.length ? [...changes, ...extra] : changes);
    },
    [onNodesChange, orbitChangesFor, slots]
  );

  // Snap attached nodes onto their orbit whenever the attachment set or a hub
  // position changes outside of a drag (new edge, import, undo, ...).
  useEffect(() => {
    const changes: NodeChange[] = [];
    for (const hubId of Object.keys(slots)) {
      if (findHubOf(hubId, slots)) continue; // worker hubs are positioned by their parent
      const hub = nodeById.get(hubId);
      if (!hub) continue;
      const positions = orbitPositions(hubId, slots, hub.position);
      for (const [id, position] of Object.entries(positions)) {
        const node = nodeById.get(id);
        if (node && !node.dragging && !samePoint(node.position, position)) {
          changes.push({ type: "position", id, position });
        }
      }
    }
    if (changes.length) onNodesChange(changes);
  }, [nodeById, onNodesChange, slots]);

  const applyTidy = useCallback(() => {
    if (nodes.length === 0) return;
    onBeforeTidy?.();
    const layout = tidyLayout(nodes, edges);
    const changes: NodeChange[] = Object.entries(layout)
      .filter(([id, position]) => !samePoint(nodeById.get(id)?.position, position))
      .map(([id, position]) => ({ type: "position", id, position }));
    if (changes.length) onNodesChange(changes);
    if (reactFlowInstance) {
      window.setTimeout(() => reactFlowInstance.fitView({ padding: 0.18, duration: 320 }), 30);
    }
  }, [edges, nodeById, nodes, onBeforeTidy, onNodesChange, reactFlowInstance]);

  // ------------------------------------------------------------ stage strip
  const stripStages = useMemo<StageStripNode[][]>(
    () =>
      stageInfo.stages.map((ids) =>
        ids
          .map((id) => nodeById.get(id))
          .filter((node): node is Node<EditorNodeData> => Boolean(node))
          .map((node) => ({ id: node.id, label: node.data.label, type: node.data.nodeType, status: node.data.executionStatus }))
      ),
    [nodeById, stageInfo.stages]
  );

  const activeStage = useMemo(() => {
    const selected = nodes.find((node) => node.selected);
    if (!selected) return null;
    const anchor = attached.has(selected.id) ? findHubOf(selected.id, slots)?.hubId ?? selected.id : selected.id;
    const depth = stageInfo.depth[anchor];
    return typeof depth === "number" ? depth : null;
  }, [attached, nodes, slots, stageInfo.depth]);

  const focusStage = useCallback(
    (_index: number, nodeIds: string[]) => {
      if (!reactFlowInstance) return;
      const ids = new Set(nodeIds);
      for (const id of nodeIds) {
        if (slots[id]) {
          const hub = nodeById.get(id);
          if (hub) for (const attachedId of Object.keys(orbitPositions(id, slots, hub.position))) ids.add(attachedId);
        }
      }
      reactFlowInstance.fitView({ nodes: [...ids].map((id) => ({ id })), padding: 0.35, duration: 320 });
    },
    [nodeById, reactFlowInstance, slots]
  );

  // ---------------------------------------------------------------- logs
  const nodeMetaById = useMemo(() => {
    const byId = new Map<string, { label: string; type: string }>();
    for (const node of nodes) {
      byId.set(node.id, { label: node.data.label, type: node.data.nodeType });
    }
    return byId;
  }, [nodes]);

  useEffect(() => {
    const initialOpenIds = (executionResult?.nodeResults ?? []).filter((result) => result.status === "error").map((result) => result.nodeId);
    setExpandedNodeLogIds(initialOpenIds);
  }, [executionResult?.executionId, executionResult?.completedAt, executionResult?.status]);

  const toggleNodeLogExpanded = (nodeId: string) => {
    setExpandedNodeLogIds((current) => (current.includes(nodeId) ? current.filter((value) => value !== nodeId) : [...current, nodeId]));
  };

  const expandAllNodeLogs = () => {
    setExpandedNodeLogIds((executionResult?.nodeResults ?? []).map((result) => result.nodeId));
  };

  const collapseAllNodeLogs = () => {
    setExpandedNodeLogIds([]);
  };

  const selectPanelTab = (tab: PanelTab) => {
    setPanelTab(tab);
    if (tab === "logs") onLogsTabChange("logs");
  };

  const selectNodeFromTape = useCallback(
    (nodeId: string) => {
      onNodesChange(nodes.map((node) => ({ type: "select", id: node.id, selected: node.id === nodeId })));
      reactFlowInstance?.fitView({ nodes: [{ id: nodeId }], padding: 1.2, duration: 280 });
    },
    [nodes, onNodesChange, reactFlowInstance]
  );

  const importPanelNodes = useMemo<ImportChecklistNode[]>(
    () => nodes.map((node) => ({ id: node.id, type: node.data.nodeType, label: node.data.label, config: node.data.config })),
    [nodes]
  );

  const paletteTitle = nodeDrawerContext?.title ?? "Add a node";
  const paletteSubtitle = nodeDrawerContext?.description ?? "Search or browse by category. Drag onto the canvas or press Enter.";

  const onStageDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.classList.contains("react-flow__pane")) {
      event.preventDefault();
      onOpenNodeDrawer();
    }
  };

  return (
    <div className="editor-layout">
      <section className={isLogsPanelCollapsed ? "canvas-and-logs logs-collapsed" : "canvas-and-logs"} style={canvasAndLogsStyle}>
        <div className="canvas-pane">
          <div
            className="canvas-stage"
            ref={flowWrapperRef}
            onDrop={(event) => {
              setFileDragActive(false);
              onDrop(event);
            }}
            onDragOver={(event) => {
              if (!fileDragActive && Array.from(event.dataTransfer.types).includes("Files")) setFileDragActive(true);
              onDragOver(event);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget as globalThis.Node | null;
              if (!next || !event.currentTarget.contains(next)) setFileDragActive(false);
            }}
            onDoubleClick={onStageDoubleClick}
          >
            {fileDragActive && (
              <div className="canvas-file-drop" aria-hidden="true">
                <div>
                  <strong>Drop to import</strong>
                  <span>L2M exports open directly. Exports from other builders get a conversion preview first.</span>
                </div>
              </div>
            )}
            {importPanel && (
              <ImportReportPanel {...importPanel} nodes={importPanelNodes} onFocusNode={selectNodeFromTape} onTidy={applyTidy} />
            )}
            {showNodeDrawer && (
              <div className="node-palette-overlay" onClick={onCloseNodeDrawer}>
                <NodePalette
                  title={paletteTitle}
                  subtitle={paletteSubtitle}
                  sections={paletteSections}
                  flatItems={filteredDefinitions}
                  emptyMessage={nodeDrawerContext ? "No compatible nodes are available for this port." : undefined}
                  onPick={handleAddNode}
                  onClose={onCloseNodeDrawer}
                  onTidy={nodeDrawerContext ? undefined : applyTidy}
                />
              </div>
            )}

            <ReactFlow
              nodes={renderNodes}
              edges={renderEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeDoubleClick={(event, edge) => {
                event.preventDefault();
                onDeleteEdge(edge.id);
              }}
              onEdgeContextMenu={(event, edge) => {
                event.preventDefault();
                onDeleteEdge(edge.id);
              }}
              onInit={onInit}
              onNodeDoubleClick={(_event, node) => onOpenNodeConfig(node.id)}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              zoomOnDoubleClick={false}
              multiSelectionKeyCode={["Shift", "Meta", "Control"]}
              selectionKeyCode={["Shift"]}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background id="workflow-dots" variant={BackgroundVariant.Dots} gap={24} size={1.4} className="canvas-dots" />
              <MiniMap
                pannable
                zoomable
                nodeStrokeWidth={0}
                nodeBorderRadius={6}
                nodeClassName={(n) => {
                  const data = n.data as EditorNodeData | undefined;
                  if (!data) return "wf-mini";
                  if (isHubType(data.nodeType)) return "wf-mini wf-mini-hub";
                  if (attached.has(n.id)) return "wf-mini wf-mini-satellite";
                  return `wf-mini${data.color ? ` wf-mini-${data.color}` : ""}`;
                }}
              />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>

            <div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools">
              {!showNodeDrawer && (
                <button type="button" className="canvas-tool canvas-tool-primary node-drawer-open-btn" onClick={onOpenNodeDrawer} title="Add node (double-click the canvas)">
                  <span aria-hidden="true">+</span> Add node
                </button>
              )}
              <button type="button" className="canvas-tool" onClick={applyTidy} disabled={nodes.length === 0} title="Lay out stages left to right">
                Tidy
              </button>
              <button type="button" className="canvas-tool" onClick={() => reactFlowInstance?.fitView({ padding: 0.18, duration: 240 })} title="Fit to view">
                Fit
              </button>
              <button type="button" className="canvas-tool canvas-tool-danger" onClick={onClearCanvas} disabled={nodes.length === 0} title="Remove every node and edge">
                Clear
              </button>
              <span className="canvas-toolbar-sep" aria-hidden="true" />
              <button type="button" className="canvas-tool canvas-tool-ghost" onClick={onExecuteWebhook} disabled={busy} title="Run through the webhook entry point">
                Webhook run
              </button>
              {canCancelRun && (
                <button type="button" className="canvas-tool canvas-tool-stop" onClick={onCancelRun} title={activeRunExecutionId ? `Stop run ${activeRunExecutionId}` : "Stop running workflow"}>
                  Stop run
                </button>
              )}
              <button
                type="button"
                className={`canvas-tool canvas-tool-toggle${debugMode ? " on" : ""}`}
                onClick={() => onDebugModeChange(!debugMode)}
                disabled={busy}
                aria-pressed={debugMode}
                aria-label={debugMode ? "Debug mode: ON" : "Debug mode: OFF"}
                title="Toggle debug mode (shows the run tape and logs panel)"
              >
                <span className="canvas-tool-toggle-dot" aria-hidden="true" />
                Debug
              </button>
            </div>

            {hubCount > 0 && (
              <div className={`canvas-key${showKey ? " open" : ""}`}>
                <button type="button" className="canvas-key-toggle" onClick={() => setShowKey((value) => !value)} aria-expanded={showKey} title="Attachment port colours">
                  {showKey ? "Hide key" : "Key"}
                </button>
                {showKey && (
                  <ul className="canvas-key-list" aria-label="Agent attachment ports">
                    {AGENT_ATTACHMENT_HANDLES.map((handle) => (
                      <li key={handle} className={`canvas-key-row canvas-key-${handle}`} title={AGENT_ATTACHMENT_STYLES[handle].description}>
                        <i aria-hidden="true" />
                        {AGENT_ATTACHMENT_STYLES[handle].label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <StageStrip stages={stripStages} activeStage={activeStage} onFocusStage={focusStage} />
        </div>

        {debugMode && (
          <>
            <div
              className={isLogsPanelCollapsed ? "logs-resize-handle disabled" : "logs-resize-handle"}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize logs panel"
              onMouseDown={onLogsResizeStart}
            />

            <div className="logs-pane">
              <div className="logs-header">
                <div className="logs-tabs" role="tablist" aria-label="Run panel">
                  <button role="tab" aria-selected={panelTab === "tape"} className={panelTab === "tape" ? "logs-tab active" : "logs-tab"} onClick={() => selectPanelTab("tape")}>
                    Run tape
                  </button>
                  <button role="tab" aria-selected={panelTab === "logs"} className={panelTab === "logs" ? "logs-tab active" : "logs-tab"} onClick={() => selectPanelTab("logs")}>
                    Logs
                  </button>
                </div>

                <div className="logs-header-actions">
                  <button className="icon-btn" onClick={onClearLogs} title="Clear logs" aria-label="Clear logs">
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
                  <button
                    className="icon-btn"
                    onClick={onToggleLogsPanel}
                    title={isLogsPanelCollapsed ? "Expand panel" : "Minimize panel"}
                    aria-label={isLogsPanelCollapsed ? "Expand panel" : "Minimize panel"}
                  >
                    {isLogsPanelCollapsed ? (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 10l4-4 4 4M8 14l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 8l4 4 4-4M8 16l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {!isLogsPanelCollapsed && (
                <div className="logs-body">
                  {panelTab === "tape" && <RunTape executionResult={executionResult} nodeMetaById={nodeMetaById} onSelectNode={selectNodeFromTape} />}

                  {panelTab === "logs" && !executionResult && (
                    <div className="logs-placeholder">No debug trace yet. Send a chat message or call a webhook endpoint.</div>
                  )}

                  {panelTab === "logs" && executionResult && (
                    <>
                      <div className="log-summary">
                        <span>
                          Status: <strong>{executionResult.status}</strong>
                        </span>
                        <span>Started: {new Date(executionResult.startedAt).toLocaleString()}</span>
                        <span>Completed: {new Date(executionResult.completedAt).toLocaleString()}</span>
                      </div>
                      <div className="node-log-toolbar">
                        <button className="mini-btn" onClick={expandAllNodeLogs}>
                          Expand all
                        </button>
                        <button className="mini-btn" onClick={collapseAllNodeLogs}>
                          Collapse all
                        </button>
                      </div>
                      <div className="node-status-list node-log-list">
                        {executionResult.nodeResults.map((result) => {
                          const meta = nodeMetaById.get(result.nodeId);
                          const isExpanded = expandedNodeLogIds.includes(result.nodeId);
                          const nodeLabel = meta?.label ?? result.nodeId;
                          const nodeResultRecord = result as unknown as { nodeType?: unknown };
                          const nodeType = typeof nodeResultRecord.nodeType === "string" ? String(nodeResultRecord.nodeType) : meta?.type;
                          const started = result.startedAt ? new Date(result.startedAt).toLocaleTimeString() : "—";
                          const completed = result.completedAt ? new Date(result.completedAt).toLocaleTimeString() : "—";
                          const liveText = result.status === "running" ? (result as LiveNodeResult).liveText : undefined;
                          const hasDetails = result.input !== undefined || result.output !== undefined || Boolean(result.error) || Boolean(liveText);

                          return (
                            <div key={result.nodeId} className={isExpanded ? "node-status-item expanded" : "node-status-item"}>
                              <button className="node-status-head" onClick={() => toggleNodeLogExpanded(result.nodeId)} aria-expanded={isExpanded}>
                                <div className="node-status-title-wrap">
                                  <strong className="node-status-title">{nodeLabel}</strong>
                                  <span className="node-status-subtitle">
                                    {result.nodeId}
                                    {nodeType ? ` · ${nodeType}` : ""}
                                  </span>
                                </div>
                                <div className="node-status-meta">
                                  {result.status === "running" ? (
                                    <LiveElapsed result={result as LiveNodeResult} />
                                  ) : result.durationMs !== undefined ? (
                                    <span>{result.durationMs}ms</span>
                                  ) : null}
                                  <strong className={`node-status-value node-status-${result.status}`} style={{ color: statusColors[result.status] }}>
                                    {result.status}
                                  </strong>
                                  <span className="node-status-chevron" aria-hidden="true">
                                    {isExpanded ? "▾" : "▸"}
                                  </span>
                                </div>
                              </button>

                              {isExpanded && (
                                <div className="node-log-details">
                                  <div className="node-log-time-grid">
                                    <span>
                                      Started: <strong>{started}</strong>
                                    </span>
                                    <span>
                                      Completed: <strong>{completed}</strong>
                                    </span>
                                  </div>

                                  {result.activity && result.activity.length > 0 && (
                                    <div className="node-log-section">
                                      <h4>Activity</h4>
                                      <NodeActivityList activity={result.activity} startedAt={result.startedAt} />
                                    </div>
                                  )}

                                  {result.input !== undefined && (
                                    <div className="node-log-section">
                                      <h4>Input</h4>
                                      <pre className="result-block">{stringifyPretty(result.input)}</pre>
                                    </div>
                                  )}

                                  {result.output !== undefined && (
                                    <div className="node-log-section">
                                      <h4>Output</h4>
                                      <pre className="result-block">{stringifyPretty(result.output)}</pre>
                                    </div>
                                  )}

                                  {liveText && (
                                    <div className="node-log-section">
                                      <h4>Streaming output</h4>
                                      <pre className="result-block">{liveText}</pre>
                                    </div>
                                  )}

                                  {result.error && (
                                    <div className="node-log-section">
                                      <h4>Error</h4>
                                      <pre className="result-block result-block-error">{result.error}</pre>
                                      {result.errorRemediation && <p className="insp-trace-remedy">{result.errorRemediation}</p>}
                                    </div>
                                  )}

                                  {!hasDetails && <div className="node-log-empty">No input/output payload captured for this node.</div>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <pre className="result-block">{stringifyPretty(executionResult.output ?? executionResult.error ?? "")}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
