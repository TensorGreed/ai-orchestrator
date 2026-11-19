import { describe, expect, it } from "vitest";
import type { Edge } from "reactflow";
import type { EditorNode } from "./workflow";
import { agentModelPeers, applyModelToPeers, modelChoiceKey } from "./agent-models";

const node = (id: string, nodeType: string, label: string, config: Record<string, unknown> = {}): EditorNode =>
  ({ id, type: "workflowNode", position: { x: 0, y: 0 }, data: { label, nodeType, config } }) as unknown as EditorNode;
const echo = { providerId: "echo", model: "demo", temperature: 0.1 };

/** The Supervisor swarm template: a supervisor and two workers, each with its own Echo chat model. */
const nodes = [
  node("start", "manual_trigger", "Start"),
  node("supervisor", "supervisor_node", "Supervisor"),
  node("researcher", "agent_orchestrator", "Researcher"),
  node("computer", "agent_orchestrator", "Computer"),
  node("sup_model", "llm_call", "Supervisor Chat Model (echo)", { provider: { ...echo } }),
  node("res_model", "llm_call", "Researcher Chat (echo)", { provider: { ...echo, temperature: 0.7 } }),
  node("cmp_model", "llm_call", "Computer Chat (echo)", { provider: { ...echo } }),
  node("summary", "llm_call", "Summary", { provider: { ...echo } })
];
const edges = [
  { id: "1", source: "start", target: "supervisor" },
  { id: "2", source: "supervisor", target: "sup_model", sourceHandle: "chat_model" },
  { id: "3", source: "supervisor", target: "researcher", sourceHandle: "worker" },
  { id: "4", source: "supervisor", target: "computer", sourceHandle: "worker" },
  { id: "5", source: "researcher", target: "res_model", sourceHandle: "chat_model" },
  { id: "6", source: "computer", target: "cmp_model", sourceHandle: "chat_model" },
  { id: "7", source: "supervisor", target: "summary" }
] as Edge[];

describe("agent model peers", () => {
  it("are the other agents' chat models, only for an agent's chat model", () => {
    expect(agentModelPeers(nodes, edges, "sup_model").map((peer) => peer.id)).toEqual(["res_model", "cmp_model"]);
    // A step LLM Call is not an agent's model and gets no offer.
    expect(agentModelPeers(nodes, edges, "summary")).toEqual([]);
  });

  it("all get the chosen model in one go, keeping their own temperature; labels naming Echo follow", () => {
    const chosen = { providerId: "anthropic", model: "claude-sonnet-4-5", secretRef: { secretId: "sec-1" }, temperature: 0 };
    const next = applyModelToPeers(nodes, new Set(["res_model", "cmp_model"]), chosen);
    const res = next.find((entry) => entry.id === "res_model")!;
    expect(res.data.config.provider).toEqual({ providerId: "anthropic", model: "claude-sonnet-4-5", secretRef: { secretId: "sec-1" }, temperature: 0.7 });
    expect(res.data.label).toBe("Researcher Chat (anthropic)");
    expect(next.find((entry) => entry.id === "summary")!.data.config.provider).toEqual(echo);
    expect(modelChoiceKey(next.find((entry) => entry.id === "cmp_model")!.data.config.provider as Record<string, unknown>)).toBe(modelChoiceKey(chosen));
  });

  it("drops a base URL or key the chosen model does not have", () => {
    const withUrl = [node("a", "agent_orchestrator", "A"), node("m", "llm_call", "M", { provider: { providerId: "openai_compatible", model: "x", baseUrl: "http://h/v1", secretRef: { secretId: "s" } } })];
    const next = applyModelToPeers(withUrl, new Set(["m"]), { providerId: "echo", model: "echo" });
    expect(next[1]!.data.config.provider).toEqual({ providerId: "echo", model: "echo" });
  });
});
