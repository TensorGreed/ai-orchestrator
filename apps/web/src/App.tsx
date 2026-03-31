
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
  type WorkflowExecutionResult,
  type WorkflowListItem
} from "@ai-orchestrator/shared";
import {
  ApiError,
  createSecret,
  executeWorkflow,
  fetchAuthMe,
  fetchDefinitions,
  fetchSecrets,
  fetchWorkflow,
  fetchWorkflows,
  importWorkflow,
  loginUser,
  logoutUser,
  runWebhook,
  saveWorkflow,
  type AuthUser,
  type SecretListItem
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
import { TopBar } from "./components/TopBar";
import type { EdgePathMode, StudioMode } from "./components/studio-layout-types";

interface DefinitionNode {
  type: string;
  label: string;
  category: string;
  description: string;
  sampleConfig: Record<string, unknown>;
}

type LogsTab = "logs" | "inputs";

const statusColors: Record<string, string> = {
  success: "#18a35f",
  error: "#d64545",
  skipped: "#7f8797",
  running: "#d68f16",
  pending: "#5b7bd8"
};
const auxiliaryHandles = new Set(["chat_model", "memory", "tool"]);
const WIP_WORKFLOW_STORAGE_KEY = "ai-orchestrator:wip-workflow";
const LAST_WORKFLOW_ID_STORAGE_KEY = "ai-orchestrator:last-workflow-id";
const EDGE_PATH_MODE_STORAGE_KEY = "ai-orchestrator:edge-path-mode";

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

function readEdgePathMode(): EdgePathMode {
  if (typeof window === "undefined") {
    return "bezier";
  }

  const stored = localStorage.getItem(EDGE_PATH_MODE_STORAGE_KEY);
  return stored === "smoothstep" ? "smoothstep" : "bezier";
}

function decorateEdge(edge: Edge, nodes: EditorNode[], mode: EdgePathMode): Edge {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  const isAuxiliary =
    edge.sourceHandle?.startsWith("aux") ||
    edge.targetHandle?.startsWith("aux") ||
    (edge.sourceHandle ? auxiliaryHandles.has(edge.sourceHandle) : false) ||
    (edge.targetHandle ? auxiliaryHandles.has(edge.targetHandle) : false) ||
    target?.data.nodeType === "mcp_tool" ||
    target?.data.nodeType === "connector_source";

  const stroke = isAuxiliary ? "#aab0bc" : "#6e7789";
  return {
    ...edge,
    type: mode,
    animated: Boolean(isAuxiliary),
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

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [workflowList, setWorkflowList] = useState<WorkflowListItem[]>([]);
  const [currentWorkflow, setCurrentWorkflow] = useState<Workflow>(createBlankWorkflow());
  const [definitions, setDefinitions] = useState<DefinitionNode[]>(nodeDefinitions as unknown as DefinitionNode[]);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secretBusy, setSecretBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretMessage, setSecretMessage] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<WorkflowExecutionResult | null>(null);

  const [systemPrompt, setSystemPrompt] = useState("You are a precise tool-using AI assistant.");
  const [userPrompt, setUserPrompt] = useState("What time is it in America/Toronto? Use tools when needed.");
  const [sessionId, setSessionId] = useState("session-local-dev");

  const [secretName, setSecretName] = useState("Default LLM Key");
  const [secretProvider, setSecretProvider] = useState("openai");
  const [secretValue, setSecretValue] = useState("");

  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [showNodeDrawer, setShowNodeDrawer] = useState(true);
  const [activeMode, setActiveMode] = useState<StudioMode>("editor");
  const [logsTab, setLogsTab] = useState<LogsTab>("logs");
  const [isLogsPanelCollapsed, setIsLogsPanelCollapsed] = useState(false);
  const [edgePathMode, setEdgePathMode] = useState<EdgePathMode>(readEdgePathMode);

  const flowWrapperRef = useRef<HTMLDivElement>(null);
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
  const currentWorkflowExists = workflowList.some((item) => item.id === currentWorkflow.id);
  const canManageSecrets = authUser?.role === "admin" || authUser?.role === "builder";

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
    setEdges((currentEdges) => currentEdges.map((edge) => decorateEdge(edge, nodes as EditorNode[], edgePathMode)));
  }, [edgePathMode, nodes, setEdges]);

  useEffect(() => {
    localStorage.setItem(EDGE_PATH_MODE_STORAGE_KEY, edgePathMode);
  }, [edgePathMode]);

  useEffect(() => {
    if (!editingNodeId) {
      return;
    }

    const stillExists = nodes.some((node) => node.id === editingNodeId);
    if (!stillExists) {
      setEditingNodeId(null);
    }
  }, [editingNodeId, nodes]);

  const refreshSecrets = useCallback(async () => {
    if (!canManageSecrets) {
      setSecrets([]);
      return [];
    }
    const items = await fetchSecrets();
    setSecrets(items);
    return items;
  }, [canManageSecrets]);

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
      const decoratedEdges = editor.edges.map((edge) => decorateEdge(edge, editor.nodes as EditorNode[], edgePathMode));

      setCurrentWorkflow(workflow);
      setNodes(editor.nodes as EditorNode[]);
      setEdges(decoratedEdges);
      setExecutionResult(null);
      setEditingNodeId(null);
    },
    [edgePathMode, setEdges, setNodes]
  );

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [workflowItems, definitionPayload, secretItems] = await Promise.all([
        fetchWorkflows(),
        fetchDefinitions(),
        canManageSecrets ? fetchSecrets() : Promise.resolve([])
      ]);

      setWorkflowList(workflowItems);
      setDefinitions(definitionPayload.nodes);
      setSecrets(secretItems);

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

  const handleApiError = useCallback((apiError: unknown, fallbackMessage: string) => {
    if (apiError instanceof ApiError && apiError.status === 401) {
      setAuthUser(null);
      setAuthError("Session expired. Sign in again.");
      return;
    }
    setError(apiError instanceof Error ? apiError.message : fallbackMessage);
  }, []);

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
      setLogsTab("logs");
      setActiveMode("editor");
    } catch (execError) {
      handleApiError(execError, "Execution failed");
    } finally {
      setBusy(false);
    }
  }, [handleApiError, persistWorkflow, sessionId, systemPrompt, userPrompt]);

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
      setLogsTab("logs");
      setActiveMode("editor");
    } catch (execError) {
      handleApiError(execError, "Webhook execution failed");
    } finally {
      setBusy(false);
    }
  }, [handleApiError, persistWorkflow, sessionId, systemPrompt, userPrompt]);

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
      const sourceHandle = connection.sourceHandle ?? "";
      const isAgentAttachmentHandle = auxiliaryHandles.has(sourceHandle);

      if (isAgentAttachmentHandle) {
        if (sourceNode?.data.nodeType !== "agent_orchestrator") {
          setError("chat_model/memory/tool handles can only be used from an Agent Orchestrator node.");
          return;
        }

        const expectedTargetType: Record<string, EditorNodeData["nodeType"]> = {
          chat_model: "llm_call",
          memory: "local_memory",
          tool: "mcp_tool"
        };
        const requiredType = expectedTargetType[sourceHandle];
        if (requiredType && targetNode?.data.nodeType !== requiredType) {
          setError(`Invalid attachment. '${sourceHandle}' must connect to a '${requiredType}' node.`);
          return;
        }
      }

      setEdges((existing) => {
        const edge = decorateEdge(
          {
            ...connection,
            source,
            target,
            id: createEdgeId(source, target)
          },
          nodes as EditorNode[],
          edgePathMode
        );

        return addEdge(edge, existing);
      });
      setError(null);
    },
    [edgePathMode, nodes, setEdges]
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
    if (!secretName.trim() || !secretProvider.trim() || !secretValue.trim()) {
      setError("Secret name, provider, and value are required.");
      return;
    }

    try {
      setSecretBusy(true);
      setError(null);
      setSecretMessage(null);
      await createSecret({
        name: secretName.trim(),
        provider: secretProvider.trim(),
        value: secretValue
      });
      await refreshSecrets();
      setSecretValue("");
      setSecretMessage("Secret created.");
    } catch (createError) {
      handleApiError(createError, "Failed to create secret");
    } finally {
      setSecretBusy(false);
    }
  }, [handleApiError, refreshSecrets, secretName, secretProvider, secretValue]);

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
    setSecrets([]);
    setExecutionResult(null);
    setNodes([]);
    setEdges([]);
    setEditingNodeId(null);
    setActiveMode("editor");
    setLoading(false);
    setError(null);
    setSecretMessage(null);
  }, [setEdges, setNodes]);

  if (authChecking) {
    return <div className="loading-screen">Checking session...</div>;
  }

  if (!authUser) {
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={handleLogin}>
          <h1>AI Orchestrator</h1>
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
    return <div className="loading-screen">Loading AI Orchestrator...</div>;
  }

  return (
    <div className="studio-shell">
      <LeftMenuBar
        activeMode={activeMode}
        canManageSecrets={canManageSecrets}
        onToggleNodeDrawer={() => {
          setActiveMode("editor");
          setShowNodeDrawer((value) => !value);
        }}
        onModeChange={setActiveMode}
      />

      <div className="studio-main">
        <TopBar
          activeMode={activeMode}
          canManageSecrets={canManageSecrets}
          currentWorkflowName={currentWorkflow.name}
          currentWorkflowId={currentWorkflow.id}
          currentWorkflowExists={currentWorkflowExists}
          workflowList={workflowList}
          authUser={authUser}
          busy={busy}
          secretBusy={secretBusy}
          edgePathMode={edgePathMode}
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
          onEdgePathModeChange={setEdgePathMode}
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

          {activeMode === "editor" && (
            <div className="editor-layout">
              <section className={isLogsPanelCollapsed ? "canvas-and-logs logs-collapsed" : "canvas-and-logs"}>
                <div className="canvas-pane" ref={flowWrapperRef} onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
                  {showNodeDrawer && (
                    <div className="node-drawer">
                      <div className="node-drawer-header">Node Library</div>
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
                      setEdges((current) => current.map((edge) => decorateEdge(edge, nodes as EditorNode[], edgePathMode)));
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

                  <div className="canvas-controls-right">
                    <button onClick={() => setShowNodeDrawer((value) => !value)}>Nodes</button>
                    <button onClick={() => setEdgePathMode((value) => (value === "bezier" ? "smoothstep" : "bezier"))}>
                      {edgePathMode === "bezier" ? "Curved" : "Stepped"}
                    </button>
                    {canManageSecrets && <button onClick={() => setActiveMode("secrets")}>Secrets</button>}
                  </div>

                  <div className="execute-strip">
                    <button className="execute-btn" onClick={handleExecute} disabled={busy}>
                      Execute workflow
                    </button>
                    <button className="execute-btn secondary" onClick={handleWebhookExecute} disabled={busy}>
                      Webhook run
                    </button>
                  </div>
                </div>

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
          )}

          {activeMode === "executions" && (
            <section className="placeholder-pane">
              <h2>Executions</h2>
              {!executionResult && <p>No runs yet. Execute a workflow from the editor.</p>}
              {executionResult && <pre className="result-block">{stringifyPretty(executionResult)}</pre>}
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
                  <input value={secretProvider} onChange={(event) => setSecretProvider(event.target.value)} />
                  <label>Secret value</label>
                  <input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} />
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
          secrets={secrets}
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
