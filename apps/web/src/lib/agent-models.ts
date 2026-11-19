/**
 * "Use for all agents in this workflow": a swarm (a Supervisor and its workers) has one chat model per agent, and
 * changing the model on one of them offers to put the same model on the others in one click. A peer is a node with
 * its own `config.provider` (an LLM Call) attached to an Agent or Supervisor through its `chat_model` port. Each peer
 * keeps its own temperature and token limit; its label follows the model when it names the old one.
 */
import type { Edge } from "reactflow";
import type { EditorNode } from "./workflow";
import { relabelForModel } from "./model-labels";

const AGENT_TYPES = new Set(["agent_orchestrator", "supervisor_node"]);
/** What a model choice is: the provider and model, and where and with which key it calls. */
const MODEL_KEYS = ["providerId", "model", "baseUrl", "secretRef", "extra"] as const;

export interface AgentModelPeer {
  id: string;
  label: string;
  provider: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isAgentChatModel(node: EditorNode, nodes: ReadonlyMap<string, EditorNode>, edges: readonly Edge[]): boolean {
  if (!("provider" in asRecord(node.data.config))) return false;
  return edges.some((edge) => edge.target === node.id && edge.sourceHandle === "chat_model" && AGENT_TYPES.has(nodes.get(edge.source)?.data.nodeType ?? ""));
}

/** The other agents' chat models, when `nodeId` is itself an agent's chat model (else none). */
export function agentModelPeers(nodes: readonly EditorNode[], edges: readonly Edge[], nodeId: string): AgentModelPeer[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const self = byId.get(nodeId);
  if (!self || !isAgentChatModel(self, byId, edges)) return [];
  return nodes
    .filter((node) => node.id !== nodeId && isAgentChatModel(node, byId, edges))
    .map((node) => ({ id: node.id, label: node.data.label, provider: asRecord(asRecord(node.data.config).provider) }));
}

/** The model part of a provider config, for comparing two model choices. */
export function modelChoiceKey(provider: Record<string, unknown>): string {
  return JSON.stringify(MODEL_KEYS.map((key) => provider[key] ?? null));
}

/** A peer's provider with `chosen`'s model, keeping the peer's own temperature and token limit. */
export function withChosenModel(peer: Record<string, unknown>, chosen: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...peer };
  for (const key of MODEL_KEYS) {
    if (chosen[key] === undefined) delete next[key];
    else next[key] = structuredClone(chosen[key]);
  }
  return next;
}

/** The nodes with `chosen`'s model on every peer in `peerIds` (labels that name the old model follow it). */
export function applyModelToPeers(nodes: readonly EditorNode[], peerIds: ReadonlySet<string>, chosen: Record<string, unknown>): EditorNode[] {
  return nodes.map((node) => {
    if (!peerIds.has(node.id)) return node;
    const config = asRecord(node.data.config);
    const before = asRecord(config.provider);
    const provider = withChosenModel(before, chosen);
    const label = relabelForModel(
      node.data.label,
      { providerId: String(before.providerId ?? ""), model: String(before.model ?? "") },
      { providerId: String(provider.providerId ?? ""), model: String(provider.model ?? "") }
    );
    return { ...node, data: { ...node.data, label, config: { ...config, provider } } };
  });
}
