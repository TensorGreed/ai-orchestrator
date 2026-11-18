/**
 * The editor's rules for a new edge, shared by every way one is made: dragging a connection, a node picked in the
 * palette after the selected node, and the `+` on an output. It infers the agent port an edge from an Agent or
 * Supervisor uses, remaps a Content Rules node's protection provider, and refuses edges the runtime would reject,
 * with the notice the editor shows.
 */
import type { EditorNodeData } from "./workflow";

type NodeType = EditorNodeData["nodeType"];

export interface RuleNode {
  id: string;
  data: { nodeType: NodeType | string; label: string };
}

export interface RuleEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface ConnectionRequest {
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export type ConnectionVerdict = { ok: true; sourceHandle: string | null } | { ok: false; message: string };

export const AUXILIARY_HANDLES: ReadonlySet<string> = new Set(["chat_model", "memory", "tool", "worker", "guard", "protection"]);

export const CHAT_MODEL_NODE_TYPES: NodeType[] = [
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model",
  "llm_call"
];

export const AGENT_PRIMARY_INPUT_NODE_TYPES: ReadonlySet<string> = new Set(["webhook_input", "text_input", "user_prompt"]);

const EXPECTED_TARGET_TYPE: Record<string, string[]> = {
  chat_model: CHAT_MODEL_NODE_TYPES,
  memory: ["local_memory"],
  tool: ["mcp_tool", "workflow_tool"],
  worker: ["agent_orchestrator", "supervisor_node"],
  guard: ["guard"],
  protection: ["guard_protection"]
};

const EXPECTED_HANDLE_BY_TARGET_TYPE: Record<string, string> = {
  llm_call: "chat_model",
  openai_chat_model: "chat_model",
  anthropic_chat_model: "chat_model",
  ollama_chat_model: "chat_model",
  openai_compatible_chat_model: "chat_model",
  ai_gateway_chat_model: "chat_model",
  azure_openai_chat_model: "chat_model",
  google_gemini_chat_model: "chat_model",
  local_memory: "memory",
  mcp_tool: "tool",
  workflow_tool: "tool"
};

const isAgent = (type: string | undefined) => type === "agent_orchestrator" || type === "supervisor_node";

export function validateConnection(request: ConnectionRequest, nodes: readonly RuleNode[], edges: readonly RuleEdge[]): ConnectionVerdict {
  const sourceNode = nodes.find((node) => node.id === request.source);
  const targetNode = nodes.find((node) => node.id === request.target);
  const sourceType = sourceNode?.data.nodeType;
  const targetType = targetNode?.data.nodeType;

  let sourceHandle = request.sourceHandle ?? "";
  if (isAgent(sourceType) && !sourceHandle && targetNode) {
    const inferred = EXPECTED_HANDLE_BY_TARGET_TYPE[targetType as string];
    if (inferred) sourceHandle = inferred;
    else if (isAgent(targetType)) sourceHandle = "worker";
    else if (targetType === "guard") sourceHandle = "guard";
  }
  if (sourceType === "guard" && targetType === "guard_protection" && (!sourceHandle || sourceHandle === "pass")) {
    sourceHandle = "protection";
  }

  if (isAgent(targetType) && sourceNode) {
    const requiredHandle = EXPECTED_HANDLE_BY_TARGET_TYPE[sourceType as string];
    if (requiredHandle) {
      return { ok: false, message: `Attach '${sourceNode.data.label}' from the Agent '${requiredHandle}' port (drag edge from Agent to node).` };
    }
  }

  const isAttachment = AUXILIARY_HANDLES.has(sourceHandle);
  if (isAttachment) {
    const carrierOk = sourceHandle === "protection" ? sourceType === "guard" : isAgent(sourceType);
    if (!carrierOk) {
      return {
        ok: false,
        message:
          sourceHandle === "protection"
            ? "The protection handle can only be used from a Content Rules node."
            : "chat_model/memory/tool/worker/guard handles can only be used from an Agent Orchestrator or Supervisor node."
      };
    }
    const required = EXPECTED_TARGET_TYPE[sourceHandle];
    if (required && !required.includes(targetType as string)) {
      return { ok: false, message: `Invalid attachment. '${sourceHandle}' must connect to a '${required.join(" or ")}' node.` };
    }
  }

  if (!isAttachment && targetType === "agent_orchestrator" && sourceNode) {
    const primaryTypes = new Set<string>();
    for (const edge of edges) {
      const existingIsAttachment = edge.sourceHandle ? AUXILIARY_HANDLES.has(edge.sourceHandle) : false;
      if (existingIsAttachment || edge.target !== request.target) continue;
      const existingType = nodes.find((node) => node.id === edge.source)?.data.nodeType;
      if (existingType && AGENT_PRIMARY_INPUT_NODE_TYPES.has(existingType)) primaryTypes.add(existingType);
    }
    if (AGENT_PRIMARY_INPUT_NODE_TYPES.has(sourceType as string)) primaryTypes.add(sourceType as string);
    if (primaryTypes.size > 1) {
      return { ok: false, message: `Agent can only use one primary input type. Found: ${[...primaryTypes].sort().join(", ")}.` };
    }
  }

  return { ok: true, sourceHandle: sourceHandle || null };
}
