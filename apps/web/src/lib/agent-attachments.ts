// Visual styling for agent attachment ports (Supervisor / Agent Orchestrator
// auxiliary edges). Shared between the canvas edge renderer (decorateEdge),
// the hub ring slots and the optional canvas key so colours and labels never
// drift. Colours are the `--port-*` tokens from src/styles/tokens.css so both
// themes resolve them.

export type AgentAttachmentHandle = "chat_model" | "memory" | "tool" | "worker";

export interface AttachmentStyle {
  stroke: string;
  label: string;
  bg: string;
  border: string;
  description: string;
}

export const AGENT_ATTACHMENT_STYLES: Record<AgentAttachmentHandle, AttachmentStyle> = {
  chat_model: {
    stroke: "var(--port-model)",
    label: "Chat Model",
    bg: "var(--port-model-soft)",
    border: "var(--port-model)",
    description: "LLM provider node attached to an Agent — required for the agent to talk to a model."
  },
  memory: {
    stroke: "var(--port-memory)",
    label: "Memory",
    bg: "var(--port-memory-soft)",
    border: "var(--port-memory)",
    description: "Conversation memory store keyed by namespace + session_id."
  },
  tool: {
    stroke: "var(--port-tool)",
    label: "Tool",
    bg: "var(--port-tool-soft)",
    border: "var(--port-tool)",
    description: "MCP Tool node — its discovered tools become callable by the agent loop."
  },
  worker: {
    stroke: "var(--port-worker)",
    label: "Worker",
    bg: "var(--port-worker-soft)",
    border: "var(--port-worker)",
    description: "Subordinate Agent or Supervisor exposed to the parent Supervisor as a synthetic tool (recursive Swarm delegation)."
  }
};

export const AGENT_ATTACHMENT_HANDLES = Object.keys(AGENT_ATTACHMENT_STYLES) as AgentAttachmentHandle[];
