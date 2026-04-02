import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance
} from "reactflow";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";

interface DefinitionNode {
  type: string;
  label: string;
  category: string;
  description: string;
  sampleConfig: Record<string, unknown>;
}

type LogsTab = "logs" | "inputs";

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
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onInit: (instance: ReactFlowInstance) => void;
  onOpenNodeConfig: (nodeId: string) => void;
  reactFlowInstance: ReactFlowInstance | null;
  onClearCanvas: () => void;
  onExecute: () => void;
  onWebhookExecute: () => void;
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
  onNodesChange,
  onEdgesChange,
  onConnect,
  onInit,
  onOpenNodeConfig,
  reactFlowInstance,
  onClearCanvas,
  onExecute,
  onWebhookExecute,
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
  return (
    <div className="editor-layout">
      <section className={isLogsPanelCollapsed ? "canvas-and-logs logs-collapsed" : "canvas-and-logs"} style={canvasAndLogsStyle}>
        <div className="canvas-pane" ref={flowWrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
          {showNodeDrawer && (
            <div className="node-drawer">
              <div className="node-drawer-header-row">
                <div className="node-drawer-header">Node Library</div>
                <button
                  className="node-drawer-close-btn"
                  onClick={onCloseNodeDrawer}
                  title="Close node library"
                  aria-label="Close node library"
                >
                  x
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
                        onClick={() => onCreateNodeFromDefinition(item)}
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
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={onInit}
            onNodeDoubleClick={(_event, node) => onOpenNodeConfig(node.id)}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} color="#d5dae3" gap={20} size={1} />
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
            <button className="execute-btn" onClick={onExecute} disabled={busy}>
              Execute workflow
            </button>
            <button className="execute-btn secondary" onClick={onWebhookExecute} disabled={busy}>
              Webhook run
            </button>
          </div>
        </div>

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
              <button className={logsTab === "logs" ? "logs-tab active" : "logs-tab"} onClick={() => onLogsTabChange("logs")}>
                Logs
              </button>
              <button className={logsTab === "inputs" ? "logs-tab active" : "logs-tab"} onClick={() => onLogsTabChange("inputs")}>
                Run Inputs
              </button>
            </div>

            <div className="logs-header-actions">
              {logsTab === "logs" ? (
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
              ) : (
                <span className="muted">Used by Execute and Webhook run.</span>
              )}
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
              {logsTab === "inputs" && (
                <div className="run-inputs-panel">
                  <label>System prompt</label>
                  <textarea value={systemPrompt} onChange={(event) => onSystemPromptChange(event.target.value)} rows={3} />
                  <label>User prompt</label>
                  <textarea value={userPrompt} onChange={(event) => onUserPromptChange(event.target.value)} rows={3} />
                  <label>Session id</label>
                  <input value={sessionId} onChange={(event) => onSessionIdChange(event.target.value)} />
                  <div className="row-actions">
                    <button onClick={onExecute} disabled={busy}>
                      Execute workflow
                    </button>
                    <button onClick={onWebhookExecute} disabled={busy}>
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
      </section>
    </div>
  );
}
