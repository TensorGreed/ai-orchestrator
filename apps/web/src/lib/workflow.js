import { WORKFLOW_SCHEMA_VERSION } from "@ai-orchestrator/shared";
export function createBlankWorkflow() {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `wf-${Date.now()}`;
    return {
        id,
        name: "Untitled Workflow",
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        workflowVersion: 1,
        nodes: [],
        edges: []
    };
}
export function workflowToEditor(workflow) {
    const nodes = workflow.nodes.map((node) => ({
        id: node.id,
        type: "default",
        position: node.position,
        data: {
            label: node.name,
            nodeType: node.type,
            config: (node.config ?? {})
        }
    }));
    const edges = workflow.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        label: edge.label
    }));
    return { nodes, edges };
}
export function editorToWorkflow(base, nodes, edges) {
    const normalizedNodes = nodes.map((node) => ({
        id: node.id,
        type: node.data.nodeType,
        name: node.data.label,
        position: node.position,
        config: node.data.config
    }));
    const normalizedEdges = edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? undefined,
        targetHandle: edge.targetHandle ?? undefined,
        label: typeof edge.label === "string" ? edge.label : undefined
    }));
    return {
        ...base,
        nodes: normalizedNodes,
        edges: normalizedEdges
    };
}
export function createNodeId(type) {
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${type}-${suffix}`;
}
export function createEdgeId(source, target) {
    return `edge-${source}-${target}-${Math.random().toString(36).slice(2, 6)}`;
}
