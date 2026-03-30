import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap, addEdge, useEdgesState, useNodesState } from "reactflow";
import { WORKFLOW_SCHEMA_VERSION, nodeDefinitions } from "@ai-orchestrator/shared";
import { executeWorkflow, fetchDefinitions, fetchWorkflow, fetchWorkflows, importWorkflow, runWebhook, saveWorkflow } from "./lib/api";
import { createBlankWorkflow, createEdgeId, createNodeId, editorToWorkflow, workflowToEditor } from "./lib/workflow";
const statusColors = {
    success: "#3fd0a0",
    error: "#ff5e5e",
    skipped: "#9ca3af",
    running: "#f3c75f",
    pending: "#8ca4ff"
};
function stringifyPretty(value) {
    return JSON.stringify(value, null, 2);
}
function getNodeStatusMap(result) {
    const map = new Map();
    if (!result) {
        return map;
    }
    for (const nodeResult of result.nodeResults) {
        map.set(nodeResult.nodeId, nodeResult.status);
    }
    return map;
}
export default function App() {
    const [workflowList, setWorkflowList] = useState([]);
    const [currentWorkflow, setCurrentWorkflow] = useState(createBlankWorkflow());
    const [definitions, setDefinitions] = useState(nodeDefinitions);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [executionResult, setExecutionResult] = useState(null);
    const [systemPrompt, setSystemPrompt] = useState("You are a precise tool-using AI assistant.");
    const [userPrompt, setUserPrompt] = useState("What time is it in America/Toronto? Use tools when needed.");
    const [sessionId, setSessionId] = useState("session-local-dev");
    const [selectedNodeId, setSelectedNodeId] = useState(null);
    const [configDraft, setConfigDraft] = useState("{}");
    const [reactFlowInstance, setReactFlowInstance] = useState(null);
    const flowWrapperRef = useRef(null);
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
    const groupedDefinitions = useMemo(() => {
        const grouped = new Map();
        for (const definition of definitions) {
            const list = grouped.get(definition.category) ?? [];
            list.push(definition);
            grouped.set(definition.category, list);
        }
        return grouped;
    }, [definitions]);
    const executionStatuses = useMemo(() => getNodeStatusMap(executionResult), [executionResult]);
    useEffect(() => {
        setNodes((currentNodes) => currentNodes.map((node) => {
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
        }));
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
        }
        catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load app data");
        }
        finally {
            setLoading(false);
        }
    }, [setEdges, setNodes]);
    useEffect(() => {
        void loadData();
    }, [loadData]);
    const onConnect = useCallback((connection) => {
        if (!connection.source || !connection.target) {
            return;
        }
        const source = connection.source;
        const target = connection.target;
        setEdges((existing) => addEdge({
            ...connection,
            source,
            target,
            id: createEdgeId(source, target)
        }, existing));
    }, [setEdges]);
    const onDragStart = useCallback((event, definition) => {
        event.dataTransfer.setData("application/reactflow", definition.type);
        event.dataTransfer.effectAllowed = "move";
    }, []);
    const onDragOver = useCallback((event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
    }, []);
    const onDrop = useCallback((event) => {
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
        const id = createNodeId(definition.type);
        const newNode = {
            id,
            type: "default",
            position,
            data: {
                label: definition.label,
                nodeType: definition.type,
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
    }, [definitions, reactFlowInstance, setNodes]);
    const hydrateWorkflow = useCallback((workflow) => {
        const editor = workflowToEditor(workflow);
        setCurrentWorkflow(workflow);
        setNodes(editor.nodes.map((node) => ({
            ...node,
            style: {
                borderRadius: "12px",
                border: "2px solid #2a3b49",
                padding: "8px",
                background: "#0f1a26",
                color: "#f5f7ff",
                width: 220
            }
        })));
        setEdges(editor.edges);
        setExecutionResult(null);
        setSelectedNodeId(null);
    }, [setEdges, setNodes]);
    const loadWorkflowById = useCallback(async (id) => {
        try {
            const workflow = await fetchWorkflow(id);
            hydrateWorkflow(workflow);
        }
        catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load workflow");
        }
    }, [hydrateWorkflow]);
    const buildCurrentWorkflow = useCallback(() => {
        return editorToWorkflow(currentWorkflow, nodes, edges);
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
        }
        catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : "Failed to save workflow");
        }
        finally {
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
        }
        catch (execError) {
            setError(execError instanceof Error ? execError.message : "Execution failed");
        }
        finally {
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
        }
        catch (execError) {
            setError(execError instanceof Error ? execError.message : "Webhook execution failed");
        }
        finally {
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
    const handleImportFile = useCallback(async (event) => {
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
        }
        catch (importError) {
            setError(importError instanceof Error ? importError.message : "Failed to import workflow");
        }
        finally {
            setBusy(false);
            event.target.value = "";
        }
    }, [hydrateWorkflow]);
    const updateWorkflowName = useCallback((name) => {
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
            const parsed = JSON.parse(configDraft);
            setNodes((existing) => existing.map((node) => node.id === selectedNode.id
                ? {
                    ...node,
                    data: {
                        ...node.data,
                        config: parsed
                    }
                }
                : node));
            setError(null);
        }
        catch {
            setError("Node config is not valid JSON");
        }
    }, [configDraft, selectedNode, setNodes]);
    const updateNodeLabel = useCallback((label) => {
        if (!selectedNode) {
            return;
        }
        setNodes((existing) => existing.map((node) => node.id === selectedNode.id
            ? {
                ...node,
                data: {
                    ...node.data,
                    label
                }
            }
            : node));
    }, [selectedNode, setNodes]);
    const deleteSelectedNode = useCallback(() => {
        if (!selectedNode) {
            return;
        }
        setNodes((existing) => existing.filter((node) => node.id !== selectedNode.id));
        setEdges((existing) => existing.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
        setSelectedNodeId(null);
    }, [selectedNode, setEdges, setNodes]);
    if (loading) {
        return _jsx("div", { className: "loading-screen", children: "Loading AI Orchestrator..." });
    }
    return (_jsxs("div", { className: "layout-root", children: [_jsxs("aside", { className: "sidebar left-sidebar", children: [_jsx("h1", { children: "AI Orchestrator V1" }), _jsxs("section", { className: "panel-section", children: [_jsx("label", { className: "label", children: "Workflow Name" }), _jsx("input", { value: currentWorkflow.name, onChange: (event) => updateWorkflowName(event.target.value), className: "text-input" }), _jsxs("div", { className: "button-row", children: [_jsx("button", { onClick: handleSave, disabled: busy, children: "Save" }), _jsx("button", { onClick: handleExport, children: "Export JSON" })] }), _jsxs("label", { className: "import-label", children: ["Import JSON", _jsx("input", { type: "file", accept: "application/json", onChange: handleImportFile })] })] }), _jsxs("section", { className: "panel-section", children: [_jsx("h2", { children: "Workflows" }), _jsx("div", { className: "workflow-list", children: workflowList.map((workflow) => (_jsxs("button", { className: workflow.id === currentWorkflow.id ? "workflow-item active" : "workflow-item", onClick: () => loadWorkflowById(workflow.id), children: [_jsx("span", { children: workflow.name }), _jsxs("small", { children: ["v", workflow.workflowVersion] })] }, workflow.id))) })] }), _jsxs("section", { className: "panel-section", children: [_jsx("h2", { children: "Node Palette" }), [...groupedDefinitions.entries()].map(([category, items]) => (_jsxs("div", { className: "category-group", children: [_jsx("h3", { children: category }), items.map((item) => (_jsxs("div", { className: "palette-item", draggable: true, onDragStart: (event) => onDragStart(event, item), title: item.description, children: [_jsx("strong", { children: item.label }), _jsx("small", { children: item.type })] }, item.type)))] }, category)))] })] }), _jsx("main", { className: "canvas-area", ref: flowWrapperRef, onDrop: onDrop, onDragOver: onDragOver, children: _jsxs(ReactFlow, { nodes: nodes, edges: edges, onNodesChange: onNodesChange, onEdgesChange: onEdgesChange, onConnect: onConnect, onInit: setReactFlowInstance, onNodeClick: (_event, node) => setSelectedNodeId(node.id), fitView: true, children: [_jsx(MiniMap, {}), _jsx(Controls, {}), _jsx(Background, { color: "#274154", gap: 20 })] }) }), _jsxs("aside", { className: "sidebar right-sidebar", children: [_jsxs("section", { className: "panel-section", children: [_jsx("h2", { children: "Execution" }), _jsx("label", { className: "label", children: "System Prompt" }), _jsx("textarea", { value: systemPrompt, onChange: (event) => setSystemPrompt(event.target.value), rows: 4 }), _jsx("label", { className: "label", children: "User Prompt" }), _jsx("textarea", { value: userPrompt, onChange: (event) => setUserPrompt(event.target.value), rows: 4 }), _jsx("label", { className: "label", children: "Session ID" }), _jsx("input", { value: sessionId, onChange: (event) => setSessionId(event.target.value), className: "text-input" }), _jsxs("div", { className: "button-row", children: [_jsx("button", { onClick: handleExecute, disabled: busy, children: "Run from UI" }), _jsx("button", { onClick: handleWebhookExecute, disabled: busy, children: "Run Webhook" })] })] }), _jsxs("section", { className: "panel-section", children: [_jsx("h2", { children: "Node Inspector" }), !selectedNode && _jsx("p", { className: "empty-note", children: "Select a node to edit settings." }), selectedNode && (_jsxs(_Fragment, { children: [_jsx("label", { className: "label", children: "Node ID" }), _jsx("code", { className: "mono-block", children: selectedNode.id }), _jsx("label", { className: "label", children: "Type" }), _jsx("code", { className: "mono-block", children: selectedNode.data.nodeType }), _jsx("label", { className: "label", children: "Label" }), _jsx("input", { value: selectedNode.data.label, onChange: (event) => updateNodeLabel(event.target.value), className: "text-input" }), _jsx("label", { className: "label", children: "Config (JSON)" }), _jsx("textarea", { value: configDraft, onChange: (event) => setConfigDraft(event.target.value), rows: 14 }), _jsxs("div", { className: "button-row", children: [_jsx("button", { onClick: applyNodeConfig, children: "Apply Config" }), _jsx("button", { className: "danger", onClick: deleteSelectedNode, children: "Delete Node" })] })] }))] }), _jsxs("section", { className: "panel-section", children: [_jsx("h2", { children: "Execution Result" }), !executionResult && _jsx("p", { className: "empty-note", children: "Run execution to see node status and output." }), executionResult && (_jsxs(_Fragment, { children: [_jsxs("p", { children: ["Status: ", _jsx("strong", { children: executionResult.status })] }), _jsx("pre", { children: stringifyPretty(executionResult.output ?? executionResult.error ?? "") }), _jsx("h3", { children: "Node Status" }), _jsx("div", { className: "status-list", children: executionResult.nodeResults.map((result) => (_jsxs("div", { className: "status-row", children: [_jsx("span", { children: result.nodeId }), _jsx("strong", { style: { color: statusColors[result.status] ?? "#f8f8f8" }, children: result.status })] }, result.nodeId))) })] }))] }), error && _jsx("div", { className: "error-banner", children: error })] })] }));
}
