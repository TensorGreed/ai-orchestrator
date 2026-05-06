// Visual styling for agent attachment ports (Supervisor / Agent Orchestrator
// auxiliary edges). Shared between the canvas edge renderer (decorateEdge) and
// the canvas legend overlay so colours and labels never drift.

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
    stroke: "#5b8ad6",
    label: "Chat Model",
    bg: "#eef3fb",
    border: "#c8d8ee",
    description: "LLM provider node attached to an Agent — required for the agent to talk to a model."
  },
  memory: {
    stroke: "#d4a657",
    label: "Memory",
    bg: "#fbf5e8",
    border: "#ecdab2",
    description: "Conversation memory store keyed by namespace + session_id."
  },
  tool: {
    stroke: "#5cb888",
    label: "Tool",
    bg: "#ecf7f0",
    border: "#c4e3d1",
    description: "MCP Tool node — its discovered tools become callable by the agent loop."
  },
  worker: {
    stroke: "#9b6dd8",
    label: "Worker",
    bg: "#f3eefa",
    border: "#dcc7ed",
    description: "Subordinate Agent or Supervisor exposed to the parent Supervisor as a synthetic tool (recursive Swarm delegation)."
  }
};

export const AGENT_ATTACHMENT_HANDLES = Object.keys(AGENT_ATTACHMENT_STYLES) as AgentAttachmentHandle[];
