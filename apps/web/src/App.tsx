import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance
} from "reactflow";
import { WORKFLOW_SCHEMA_VERSION, nodeDefinitions, type Workflow, type WorkflowExecutionResult, type WorkflowListItem } from "@ai-orchestrator/shared";
import {
  executeWorkflow,
  fetchDefinitions,
  fetchWorkflow,
  fetchWorkflows,
  importWorkflow,
  runWebhook,
  saveWorkflow
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

interface DefinitionNode {
  type: string;
  label: string;
  category: string;
  description: string;
  sampleConfig: Record<string, unknown>;
}

const statusColors: Record<string, string> = {
  success: "#3fd0a0",
  error: "#ff5e5e",
  skipped: "#9ca3af",
  running: "#f3c75f",
  pending: "#8ca4ff"
};

function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2);
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

export default function App() {
  const [workflowList, setWorkflowList] = useState<WorkflowListItem[]>([]);
  const [currentWorkflow, setCurrentWorkflow] = useState<Workflow>(createBlankWorkflow());
  const [definitions, setDefinitions] = useState<DefinitionNode[]>(nodeDefinitions as unknown as DefinitionNode[]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<WorkflowExecutionResult | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("You are a precise tool-using AI assistant.");
  const [userPrompt, setUserPrompt] = useState("What time is it in America/Toronto? Use tools when needed.");
  const [sessionId, setSessionId] = useState("session-local-dev");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState("{}");
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

  const flowWrapperRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
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

  const executionStatuses = useMemo(() => getNodeStatusMap(executionResult), [executionResult]);

  useEffect(() => {
    setNodes((currentNodes) =>
      currentNodes.map((node) => {
        const status = executionStatuses.get(node.id);
        if (!status) {
          return {
            ...node,
            style: {
              ...node.style,
              borderColor: "#2a3b49",
              boxShadow: "none"
            }
          };
        }

        return {
          ...node,
          style: {
            ...node.style,
            borderColor: statusColors[status] ?? "#2a3b49",
            boxShadow: `0 0 0 2px ${statusColors[status] ?? "#2a3b49"}44`
          }
        };
      })
    );
  }, [executionStatuses, setNodes]);

  useEffect(() => {
    if (!selectedNode) {
      setConfigDraft("{}");
      return;
    }
    setConfigDraft(stringifyPretty(selectedNode.data.config));
  }, [selectedNode]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [workflowItems, definitionPayload] = await Promise.all([fetchWorkflows(), fetchDefinitions()]);
      setWorkflowList(workflowItems);
      setDefinitions(definitionPayload.nodes);

      if (workflowItems[0]) {
        const workflow = await fetchWorkflow(workflowItems[0].id);
        const editor = workflowToEditor(workflow);
        setCurrentWorkflow(workflow);
        setNodes(editor.nodes);
        setEdges(editor.edges);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load app data");
    } finally {
      setLoading(false);
    }
  }, [setEdges, setNodes]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      const source = connection.source;
      const target = connection.target;

      setEdges((existing) =>
        addEdge(
          {
            ...connection,
            source,
            target,
            id: createEdgeId(source, target)
          },
          existing
        )
      );
    },
    [setEdges]
  );

  const onDragStart = useCallback((event: React.DragEvent, definition: DefinitionNode) => {
    event.dataTransfer.setData("application/reactflow", definition.type);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

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

      const id = createNodeId(definition.type as EditorNodeData["nodeType"]);
      const newNode: Node<EditorNodeData> = {
        id,
        type: "default",
        position,
        data: {
          label: definition.label,
          nodeType: definition.type as EditorNodeData["nodeType"],
          config: definition.sampleConfig ?? {}
        },
        style: {
          borderRadius: "12px",
          border: "2px solid #2a3b49",
          padding: "8px",
          background: "#0f1a26",
          color: "#f5f7ff",
          width: 220
        }
      };

      setNodes((existing) => [...existing, newNode]);
    },
    [definitions, reactFlowInstance, setNodes]
  );

  const hydrateWorkflow = useCallback(
    (workflow: Workflow) => {
      const editor = workflowToEditor(workflow);
      setCurrentWorkflow(workflow);
      setNodes(
        editor.nodes.map((node) => ({
          ...node,
          style: {
            borderRadius: "12px",
            border: "2px solid #2a3b49",
            padding: "8px",
            background: "#0f1a26",
            color: "#f5f7ff",
            width: 220
          }
        }))
      );
      setEdges(editor.edges);
      setExecutionResult(null);
      setSelectedNodeId(null);
    },
    [setEdges, setNodes]
  );

  const loadWorkflowById = useCallback(
    async (id: string) => {
      try {
        const workflow = await fetchWorkflow(id);
        hydrateWorkflow(workflow);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load workflow");
      }
    },
    [hydrateWorkflow]
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
    return saved;
  }, [buildCurrentWorkflow]);

  const handleSave = useCallback(async () => {
    try {
      setBusy(true);
      setError(null);
      await persistWorkflow();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save workflow");
    } finally {
      setBusy(false);
    }
  }, [persistWorkflow]);

  const handleExecute = useCallback(async () => {
    try {
      setBusy(true);
      setError(null);
      const saved = await persistWorkflow();
      const result = await executeWorkflow(saved.id, {
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        sessionId
      });
      setExecutionResult(result);
    } catch (execError) {
      setError(execError instanceof Error ? execError.message : "Execution failed");
    } finally {
      setBusy(false);
    }
  }, [persistWorkflow, sessionId, systemPrompt, userPrompt]);

  const handleWebhookExecute = useCallback(async () => {
    try {
      setBusy(true);
      setError(null);
      const saved = await persistWorkflow();
      const result = await runWebhook({
        workflow_id: saved.id,
        session_id: sessionId,
        system_prompt: systemPrompt,
        user_prompt: userPrompt
      });
      setExecutionResult(result);
    } catch (execError) {
      setError(execError instanceof Error ? execError.message : "Webhook execution failed");
    } finally {
      setBusy(false);
    }
  }, [persistWorkflow, sessionId, systemPrompt, userPrompt]);

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
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : "Failed to import workflow");
      } finally {
        setBusy(false);
        event.target.value = "";
      }
    },
    [hydrateWorkflow]
  );

  const updateWorkflowName = useCallback((name: string) => {
    setCurrentWorkflow((current) => ({
      ...current,
      name
    }));
  }, []);

  const applyNodeConfig = useCallback(() => {
    if (!selectedNode) {
      return;
    }

    try {
      const parsed = JSON.parse(configDraft) as Record<string, unknown>;
      setNodes((existing) =>
        existing.map((node) =>
          node.id === selectedNode.id
            ? {
                ...node,
                data: {
                  ...node.data,
                  config: parsed
                }
              }
            : node
        )
      );
      setError(null);
    } catch {
      setError("Node config is not valid JSON");
    }
  }, [configDraft, selectedNode, setNodes]);

  const updateNodeLabel = useCallback(
    (label: string) => {
      if (!selectedNode) {
        return;
      }

      setNodes((existing) =>
        existing.map((node) =>
          node.id === selectedNode.id
            ? {
                ...node,
                data: {
                  ...node.data,
                  label
                }
              }
            : node
        )
      );
    },
    [selectedNode, setNodes]
  );

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNode) {
      return;
    }

    setNodes((existing) => existing.filter((node) => node.id !== selectedNode.id));
    setEdges((existing) =>
      existing.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id)
    );
    setSelectedNodeId(null);
  }, [selectedNode, setEdges, setNodes]);

  if (loading) {
    return <div className="loading-screen">Loading AI Orchestrator...</div>;
  }

  return (
    <div className="layout-root">
      <aside className="sidebar left-sidebar">
        <h1>AI Orchestrator V1</h1>

        <section className="panel-section">
          <label className="label">Workflow Name</label>
          <input
            value={currentWorkflow.name}
            onChange={(event) => updateWorkflowName(event.target.value)}
            className="text-input"
          />
          <div className="button-row">
            <button onClick={handleSave} disabled={busy}>
              Save
            </button>
            <button onClick={handleExport}>Export JSON</button>
          </div>
          <label className="import-label">
            Import JSON
            <input type="file" accept="application/json" onChange={handleImportFile} />
          </label>
        </section>

        <section className="panel-section">
          <h2>Workflows</h2>
          <div className="workflow-list">
            {workflowList.map((workflow) => (
              <button
                key={workflow.id}
                className={workflow.id === currentWorkflow.id ? "workflow-item active" : "workflow-item"}
                onClick={() => loadWorkflowById(workflow.id)}
              >
                <span>{workflow.name}</span>
                <small>v{workflow.workflowVersion}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section">
          <h2>Node Palette</h2>
          {[...groupedDefinitions.entries()].map(([category, items]) => (
            <div key={category} className="category-group">
              <h3>{category}</h3>
              {items.map((item) => (
                <div
                  key={item.type}
                  className="palette-item"
                  draggable
                  onDragStart={(event) => onDragStart(event, item)}
                  title={item.description}
                >
                  <strong>{item.label}</strong>
                  <small>{item.type}</small>
                </div>
              ))}
            </div>
          ))}
        </section>
      </aside>

      <main className="canvas-area" ref={flowWrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setReactFlowInstance}
          onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
          fitView
        >
          <MiniMap />
          <Controls />
          <Background color="#274154" gap={20} />
        </ReactFlow>
      </main>

      <aside className="sidebar right-sidebar">
        <section className="panel-section">
          <h2>Execution</h2>
          <label className="label">System Prompt</label>
          <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={4} />
          <label className="label">User Prompt</label>
          <textarea value={userPrompt} onChange={(event) => setUserPrompt(event.target.value)} rows={4} />
          <label className="label">Session ID</label>
          <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} className="text-input" />
          <div className="button-row">
            <button onClick={handleExecute} disabled={busy}>
              Run from UI
            </button>
            <button onClick={handleWebhookExecute} disabled={busy}>
              Run Webhook
            </button>
          </div>
        </section>

        <section className="panel-section">
          <h2>Node Inspector</h2>
          {!selectedNode && <p className="empty-note">Select a node to edit settings.</p>}
          {selectedNode && (
            <>
              <label className="label">Node ID</label>
              <code className="mono-block">{selectedNode.id}</code>
              <label className="label">Type</label>
              <code className="mono-block">{selectedNode.data.nodeType}</code>
              <label className="label">Label</label>
              <input
                value={selectedNode.data.label}
                onChange={(event) => updateNodeLabel(event.target.value)}
                className="text-input"
              />
              <label className="label">Config (JSON)</label>
              <textarea value={configDraft} onChange={(event) => setConfigDraft(event.target.value)} rows={14} />
              <div className="button-row">
                <button onClick={applyNodeConfig}>Apply Config</button>
                <button className="danger" onClick={deleteSelectedNode}>
                  Delete Node
                </button>
              </div>
            </>
          )}
        </section>

        <section className="panel-section">
          <h2>Execution Result</h2>
          {!executionResult && <p className="empty-note">Run execution to see node status and output.</p>}
          {executionResult && (
            <>
              <p>
                Status: <strong>{executionResult.status}</strong>
              </p>
              <pre>{stringifyPretty(executionResult.output ?? executionResult.error ?? "")}</pre>
              <h3>Node Status</h3>
              <div className="status-list">
                {executionResult.nodeResults.map((result) => (
                  <div key={result.nodeId} className="status-row">
                    <span>{result.nodeId}</span>
                    <strong style={{ color: statusColors[result.status] ?? "#f8f8f8" }}>{result.status}</strong>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        {error && <div className="error-banner">{error}</div>}
      </aside>
    </div>
  );
}
