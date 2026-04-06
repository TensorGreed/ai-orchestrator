import { useEffect, useMemo, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance
} from "reactflow";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import { NodeTypeIcon, PaletteIcon, type PaletteCategoryIconKey } from "./node-icons";

interface DefinitionNode {
  type: string;
  label: string;
  category: string;
  description: string;
  sampleConfig: Record<string, unknown>;
}

type LogsTab = "logs" | "inputs";

interface PaletteCategoryMeta {
  key: string;
  title: string;
  description: string;
  icon: PaletteCategoryIconKey;
  match: (node: DefinitionNode) => boolean;
}

const PALETTE_CATEGORIES: PaletteCategoryMeta[] = [
  {
    key: "ai",
    title: "AI",
    description: "Build agents, prompt pipelines, RAG retrieval and guardrails.",
    icon: "ai",
    match: (node) =>
      [
        "llm_call",
        "agent_orchestrator",
        "prompt_template",
        "rag_retrieve",
        "local_memory",
        "output_guardrail",
        "output_parser"
      ].includes(node.type)
  },
  {
    key: "apps",
    title: "Action in an App",
    description: "Call connectors, MCP tools, or reusable sub-workflows.",
    icon: "app",
    match: (node) =>
      ["connector_source", "google_drive_source", "mcp_tool", "http_request", "execute_workflow"].includes(
        node.type
      )
  },
  {
    key: "transform",
    title: "Data Transformation",
    description: "Parse, validate, chunk, merge, and shape structured outputs.",
    icon: "transform",
    match: (node) =>
      ["code_node", "document_chunker", "input_validator", "output_parser", "set_node", "merge_node"].includes(
        node.type
      )
  },
  {
    key: "flow",
    title: "Flow",
    description: "Branch, merge, loop, wait, and handle fallback paths.",
    icon: "flow",
    match: (node) => ["if_node", "switch_node", "try_catch", "loop_node", "merge_node", "wait_node", "execute_workflow"].includes(node.type)
  },
  {
    key: "core",
    title: "Core",
    description: "Input/output primitives and base workflow utilities.",
    icon: "core",
    match: (node) =>
      [
        "webhook_input",
        "text_input",
        "system_prompt",
        "user_prompt",
        "output",
        "webhook_response",
        "wait_node",
        "code_node",
        "schedule_trigger"
      ].includes(node.type)
  },
  {
    key: "human",
    title: "Human in the Loop",
    description: "Pause for human approvals before continuing execution.",
    icon: "human",
    match: (node) => node.type === "human_approval"
  },
  {
    key: "trigger",
    title: "Triggers",
    description: "Start workflow runs from schedules or external webhook calls.",
    icon: "trigger",
    match: (node) => ["schedule_trigger", "webhook_input", "text_input"].includes(node.type)
  }
];


interface WorkflowCanvasAreaProps {
  isLogsPanelCollapsed: boolean;
  canvasAndLogsStyle: CSSProperties;
  flowWrapperRef: RefObject<HTMLDivElement | null>;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  showNodeDrawer: boolean;
  onCloseNodeDrawer: () => void;
  onOpenNodeDrawer: () => void;
  groupedDefinitions: Map<string, DefinitionNode[]>;
  onCreateNodeFromDefinition: (definition: DefinitionNode) => void;
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
}

function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function WorkflowCanvasArea({
  isLogsPanelCollapsed,
  canvasAndLogsStyle,
  flowWrapperRef,
  onDrop,
  onDragOver,
  showNodeDrawer,
  onCloseNodeDrawer,
  onOpenNodeDrawer,
  groupedDefinitions,
  onCreateNodeFromDefinition,
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
  busy,
  onLogsResizeStart,
  logsTab,
  onLogsTabChange,
  onClearLogs,
  onToggleLogsPanel,
  executionResult,
  statusColors,
  systemPrompt,
  onSystemPromptChange,
  userPrompt,
  onUserPromptChange,
  sessionId,
  onSessionIdChange
}: WorkflowCanvasAreaProps) {
  const [paletteSearch, setPaletteSearch] = useState("");
  const [activePaletteCategory, setActivePaletteCategory] = useState<string | null>(null);

  const allDefinitions = useMemo(() => {
    const byType = new Map<string, DefinitionNode>();
    for (const items of groupedDefinitions.values()) {
      for (const item of items) {
        byType.set(item.type, item);
      }
    }
    return [...byType.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [groupedDefinitions]);

  const paletteSections = useMemo(
    () =>
      PALETTE_CATEGORIES.map((section) => ({
        ...section,
        items: allDefinitions.filter((node) => section.match(node))
      })).filter((section) => section.items.length > 0),
    [allDefinitions]
  );

  const activeSection = useMemo(
    () => paletteSections.find((section) => section.key === activePaletteCategory) ?? null,
    [activePaletteCategory, paletteSections]
  );

  const searchResults = useMemo(() => {
    const query = paletteSearch.trim().toLowerCase();
    if (!query) {
      return [];
    }
    return allDefinitions.filter((node) => {
      return (
        node.label.toLowerCase().includes(query) ||
        node.type.toLowerCase().includes(query) ||
        node.description.toLowerCase().includes(query)
      );
    });
  }, [allDefinitions, paletteSearch]);

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

  const handleAddNode = (definition: DefinitionNode) => {
    onCreateNodeFromDefinition(definition);
    onCloseNodeDrawer();
    setPaletteSearch("");
    setActivePaletteCategory(null);
  };

  useEffect(() => {
    if (!showNodeDrawer) {
      setPaletteSearch("");
      setActivePaletteCategory(null);
      return;
    }

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

  return (
    <div className="editor-layout">
      <section className={isLogsPanelCollapsed ? "canvas-and-logs logs-collapsed" : "canvas-and-logs"} style={canvasAndLogsStyle}>
        <div className="canvas-pane" ref={flowWrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
          {showNodeDrawer && (
            <div className="node-palette-overlay" onClick={onCloseNodeDrawer}>
              <aside
                className="node-palette"
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                <div className="node-palette-header">
                  <div className="node-palette-heading-row">
                    {activeSection ? (
                      <button
                        className="node-palette-back-btn"
                        onClick={() => setActivePaletteCategory(null)}
                        title="Back to categories"
                        aria-label="Back to categories"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="m14 6-6 6 6 6"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    ) : null}
                    <div>
                      <h3>{activeSection ? activeSection.title : "What happens next?"}</h3>
                      <p>{activeSection ? `Select a ${activeSection.title} node to add` : "Pick a category or search directly"}</p>
                    </div>
                    <button
                      className="node-palette-close-btn"
                      onClick={onCloseNodeDrawer}
                      title="Close node library"
                      aria-label="Close node library"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="m7 7 10 10M17 7 7 17"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>

                  <label className="node-palette-search">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
                      <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                    <input
                      placeholder="Search nodes..."
                      value={paletteSearch}
                      onChange={(event) => setPaletteSearch(event.target.value)}
                      autoFocus
                    />
                  </label>
                </div>

                <div className="node-palette-body">
                  {paletteSearch.trim() ? (
                    <div className="node-palette-list">
                      {searchResults.length === 0 && (
                        <div className="node-palette-empty">No nodes match "{paletteSearch.trim()}".</div>
                      )}
                      {searchResults.map((item) => {
                        const parentSection = paletteSections.find((section) => section.match(item));
                        return (
                          <button
                            key={item.type}
                            className="node-palette-node-row"
                            draggable
                            onDragStart={(event) => {
                              event.dataTransfer.setData("application/reactflow", item.type);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            onClick={() => handleAddNode(item)}
                            title={item.description}
                          >
                            <span className="node-palette-icon-wrap">
                              <NodeTypeIcon nodeType={item.type} fallbackIcon={parentSection?.icon ?? "core"} />
                            </span>
                            <span className="node-palette-row-copy">
                              <strong>{item.label}</strong>
                              <small>{item.description || item.type}</small>
                            </span>
                            <span className="node-palette-row-arrow" aria-hidden="true">
                              +
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : activeSection ? (
                    <div className="node-palette-list">
                      {activeSection.items.map((item) => (
                        <button
                          key={item.type}
                          className="node-palette-node-row"
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData("application/reactflow", item.type);
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          onClick={() => handleAddNode(item)}
                          title={item.description}
                        >
                          <span className="node-palette-icon-wrap">
                            <NodeTypeIcon nodeType={item.type} fallbackIcon={activeSection.icon} />
                          </span>
                          <span className="node-palette-row-copy">
                            <strong>{item.label}</strong>
                            <small>{item.description || item.type}</small>
                          </span>
                          <span className="node-palette-row-arrow" aria-hidden="true">
                            +
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="node-palette-list">
                      {paletteSections.map((section) => (
                        <button
                          key={section.key}
                          className="node-palette-category-row"
                          onClick={() => setActivePaletteCategory(section.key)}
                        >
                          <span className="node-palette-icon-wrap">
                            <PaletteIcon icon={section.icon} />
                          </span>
                          <span className="node-palette-row-copy">
                            <strong>{section.title}</strong>
                            <small>{section.description}</small>
                          </span>
                          <span className="node-palette-row-arrow" aria-hidden="true">
                            &rarr;
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </aside>
            </div>
          )}

          <ReactFlow
            nodes={nodes}
            edges={renderEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
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
          >
            <Background id="workflow-grid-minor" variant={BackgroundVariant.Lines} color="#e4ebf5" gap={24} lineWidth={0.65} />
            <Background id="workflow-grid-major" variant={BackgroundVariant.Lines} color="#c8d7ea" gap={120} lineWidth={1.15} />
          </ReactFlow>

          <div className="canvas-controls-left">
            <button onClick={() => reactFlowInstance?.fitView()}>Fit</button>
            <button onClick={() => reactFlowInstance?.zoomIn()}>+</button>
            <button onClick={() => reactFlowInstance?.zoomOut()}>-</button>
            <button onClick={onClearCanvas}>Clear</button>
          </div>

          {!showNodeDrawer && (
            <button
              className="node-drawer-open-btn"
              onClick={onOpenNodeDrawer}
              title="Open node library"
              aria-label="Open node library"
            >
              +
            </button>
          )}

          <div className="execute-strip">
            <button
              className={debugMode ? "execute-btn" : "execute-btn secondary"}
              onClick={() => onDebugModeChange(!debugMode)}
              disabled={busy}
            >
              {debugMode ? "Debug mode: ON" : "Debug mode: OFF"}
            </button>
          </div>
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
                <div className="logs-tabs">
                  <button className="logs-tab active" onClick={() => onLogsTabChange("logs")}>
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
                  {!executionResult && (
                    <div className="logs-placeholder">No debug trace yet. Send a chat message or call a webhook endpoint.</div>
                  )}

                  {executionResult && (
                    <>
                      <div className="log-summary">
                        <span>
                          Status: <strong>{executionResult.status}</strong>
                        </span>
                        <span>Started: {new Date(executionResult.startedAt).toLocaleString()}</span>
                        <span>Completed: {new Date(executionResult.completedAt).toLocaleString()}</span>
                      </div>
                      <div className="node-status-list">
                        {executionResult.nodeResults.map((result) => (
                          <div key={result.nodeId} className="node-status-item">
                            <span>{result.nodeId}</span>
                            <strong style={{ color: statusColors[result.status] ?? "#657087" }}>{result.status}</strong>
                          </div>
                        ))}
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
