import { describe, expect, it } from "vitest";
import { validateConnection, type RuleNode } from "./connection-rules";

const n = (id: string, nodeType: string, label = id): RuleNode => ({ id, data: { nodeType, label } });

describe("validateConnection", () => {
  it("allows an ordinary step edge and keeps its handle", () => {
    const nodes = [n("a", "set_node"), n("if", "if_node"), n("b", "output")];
    expect(validateConnection({ source: "a", target: "b" }, nodes, [])).toEqual({ ok: true, sourceHandle: null });
    expect(validateConnection({ source: "if", target: "b", sourceHandle: "false" }, nodes, [])).toEqual({ ok: true, sourceHandle: "false" });
  });

  it("refuses a model fed into an agent, with the editor's notice", () => {
    const verdict = validateConnection({ source: "m", target: "agent" }, [n("m", "llm_call", "Model"), n("agent", "agent_orchestrator")], []);
    expect(verdict).toEqual({ ok: false, message: "Attach 'Model' from the Agent 'chat_model' port (drag edge from Agent to node)." });
  });

  it("infers the agent port from the target and checks the target type", () => {
    const nodes = [n("agent", "agent_orchestrator"), n("mem", "local_memory"), n("w", "agent_orchestrator"), n("set", "set_node")];
    expect(validateConnection({ source: "agent", target: "mem" }, nodes, [])).toEqual({ ok: true, sourceHandle: "memory" });
    expect(validateConnection({ source: "agent", target: "w" }, nodes, [])).toEqual({ ok: true, sourceHandle: "worker" });
    expect(validateConnection({ source: "agent", target: "set", sourceHandle: "tool" }, nodes, [])).toEqual({
      ok: false,
      message: "Invalid attachment. 'tool' must connect to a 'mcp_tool or workflow_tool' node."
    });
    expect(validateConnection({ source: "set", target: "mem", sourceHandle: "memory" }, nodes, []).ok).toBe(false);
  });

  it("puts a protection provider on a Content Rules node's protection port", () => {
    const nodes = [n("rules", "guard"), n("p", "guard_protection")];
    expect(validateConnection({ source: "rules", target: "p", sourceHandle: "pass" }, nodes, [])).toEqual({ ok: true, sourceHandle: "protection" });
  });

  it("refuses a second kind of primary input into one agent", () => {
    const nodes = [n("hook", "webhook_input"), n("text", "text_input"), n("agent", "agent_orchestrator")];
    const verdict = validateConnection({ source: "text", target: "agent" }, nodes, [{ source: "hook", target: "agent" }]);
    expect(verdict).toEqual({ ok: false, message: "Agent can only use one primary input type. Found: text_input, webhook_input." });
  });
});
