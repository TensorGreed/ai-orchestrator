import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { runPromptReads, type Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";

/**
 * The editor sends its built-in prompts only to workflows that `runPromptReads` says read them. These tests hold that
 * list to the engine: every node handler that reads the run's `user_prompt` / `system_prompt` by itself must be on it.
 */

/** The executor's node handlers: each `case "type":` group of the node switch with the code up to the next group. */
function nodeHandlers(source: string): Array<{ types: string[]; body: string }> {
  const lines = source.split("\n");
  const handlers: Array<{ types: string[]; body: string }> = [];
  let current: { types: string[]; body: string } | undefined;
  for (const line of lines) {
    const label = /^ {4}case "([a-z0-9_]+)":/.exec(line);
    if (label) {
      if (current && current.body.trim()) {
        handlers.push(current);
        current = undefined;
      }
      current ??= { types: [], body: "" };
      current.types.push(label[1]!);
      const rest = line.slice(label[0].length);
      current.body += rest + "\n";
      continue;
    }
    if (/^ {4}default:/.test(line) && current) {
      handlers.push(current);
      current = undefined;
      continue;
    }
    if (current) current.body += line + "\n";
  }
  if (current) handlers.push(current);
  return handlers;
}

// Handlers that read the run's prompt only as part of "everything the node was given", when the node's own input has
// nothing better: by design these do not make a workflow a prompt reader (the editor's prompt is not what they want).
const WHOLE_INPUT_FALLBACKS = new Set(["output", "pdf_output"]);

const READS_USER = /"user_prompt"|\{\{user_prompt\}\}|globals\.user_prompt|templateData\.user_prompt|resolveRuntimeUserPrompt|executePhase35TriggerNode/;
const READS_SYSTEM = /"system_prompt"|\{\{system_prompt\}\}|globals\.system_prompt/;

describe("runPromptReads matches the engine", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  const switchStart = source.indexOf('    case "schedule_trigger": {');
  const handlers = nodeHandlers(source.slice(switchStart));

  it("parses the node switch", () => {
    const types = handlers.flatMap((handler) => handler.types);
    expect(types).toEqual(expect.arrayContaining(["llm_call", "agent_orchestrator", "output", "http_request", "chat_trigger"]));
    expect(types.length).toBeGreaterThan(100);
  });

  it("lists every handler that reads the run's user prompt by itself", () => {
    const readers = handlers
      .filter((handler) => READS_USER.test(handler.body))
      .flatMap((handler) => handler.types)
      .filter((type) => !WHOLE_INPUT_FALLBACKS.has(type));
    // The Phase 3.5 trigger group reads it only for the chat trigger (connectors/triggers.ts executeChatTrigger).
    const triggerGroup = handlers.find((handler) => handler.types.includes("chat_trigger"))!.types;
    const missing = readers.filter((type) => !triggerGroup.includes(type) || type === "chat_trigger").filter((type) => !runPromptReads([{ type, config: {} }]).userPrompt);
    expect(missing).toEqual([]);
    const chatOnly = readFileSync(new URL("./connectors/triggers.ts", import.meta.url), "utf8");
    expect(chatOnly.match(/ctx\.globals\.user_prompt/g)?.length).toBe(2);
    expect(chatOnly.slice(chatOnly.indexOf("export function executeChatTrigger"))).toContain("ctx.globals.user_prompt");
  });

  it("lists every handler that reads the run's system prompt by itself", () => {
    const readers = handlers
      .filter((handler) => READS_SYSTEM.test(handler.body))
      .flatMap((handler) => handler.types)
      .filter((type) => !WHOLE_INPUT_FALLBACKS.has(type));
    const missing = readers.filter((type) => !runPromptReads([{ type, config: {} }]).systemPrompt);
    expect(missing).toEqual([]);
  });
});

describe("a workflow the editor sends no prompt to", () => {
  const position = { x: 0, y: 0 };
  const dependencies = () => ({
    providerRegistry: createDefaultProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: createDefaultAgentRuntime(),
    resolveSecret: async () => undefined
  });

  it("runs on the prompt it is given when it reads one", async () => {
    const workflow: Workflow = {
      id: "wf-reads",
      name: "Reads",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "llm", type: "llm_call", name: "LLM", position, config: { provider: { providerId: "echo", model: "echo" } } },
        { id: "out", type: "output", name: "Out", position, config: { responseTemplate: "{{answer}}" } }
      ],
      edges: [{ id: "e1", source: "llm", target: "out" }]
    };
    expect(runPromptReads(workflow.nodes).userPrompt).toBe(true);
    const result = await executeWorkflow({ workflow, userPrompt: "ping from the run" }, dependencies());
    expect(JSON.stringify(result.nodeResults.find((node) => node.nodeId === "out")?.output)).toContain("ping from the run");
  });

  it("counts a node whose input mapping copies the prompt, as the engine reads mapping keys", async () => {
    const workflow: Workflow = {
      id: "wf-maps",
      name: "Maps",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "start", type: "noop_node", name: "Start", position, config: {} },
        { id: "out", type: "output", name: "Out", position, config: { responseTemplate: "Q: {{question}}", inputMapping: { user_prompt: "question" } } }
      ],
      edges: [{ id: "e1", source: "start", target: "out" }]
    };
    expect(runPromptReads(workflow.nodes).userPrompt).toBe(true);
    const result = await executeWorkflow({ workflow, userPrompt: "mapped prompt" }, dependencies());
    expect(JSON.stringify(result.nodeResults.find((node) => node.nodeId === "out")?.output)).toContain("Q: mapped prompt");
  });

  it("does not show the editor's prompt as the output of a workflow that does not read it", async () => {
    const workflow: Workflow = {
      id: "wf-no-read",
      name: "No read",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "set", type: "noop_node", name: "No-op", position, config: {} },
        { id: "out", type: "output", name: "Out", position, config: {} }
      ],
      edges: [{ id: "e1", source: "set", target: "out" }]
    };
    expect(runPromptReads(workflow.nodes).userPrompt).toBe(false);
    const sent = await executeWorkflow({ workflow, userPrompt: "What time is it in America/Toronto?" }, dependencies());
    const notSent = await executeWorkflow({ workflow }, dependencies());
    const output = (result: typeof sent) => JSON.stringify(result.nodeResults.find((node) => node.nodeId === "out")?.output);
    expect(output(sent)).toContain("America/Toronto");
    expect(output(notSent)).not.toContain("America/Toronto");
  });
});
