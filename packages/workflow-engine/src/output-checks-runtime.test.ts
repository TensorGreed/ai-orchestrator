import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultGuardRegistry, hashGuardProfile, parseGuardProfile, type GuardProfileInput, type GuardSource } from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import {
  EmbeddingProviderRegistry,
  ProviderRegistry,
  type EmbeddingProviderAdapter,
  type LLMProviderAdapter,
  type ProviderCallRequest
} from "@ai-orchestrator/provider-sdk";
import type { LLMUsage, Workflow, WorkflowEdge, WorkflowExecutionResult, WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { createAgentGuardSession, type GuardEvalScope, type GuardRunResolution, type GuardVerdictEvent, type ResolvedGuardProfile } from "./guard-runtime";
import {
  OUTPUT_GUARDRAIL_PROFILE_ID,
  createGuardModelServices,
  groundingSourcesFor,
  outputGuardrailProfile,
  readOutputGuardrailConfig,
  type CheckModelUsage
} from "./output-checks-runtime";

/**
 * Phase 12 coverage, output checks lane — the engine side: model calls a
 * check makes (offline, through a mock provider) and their usage, grounding
 * sources from retrieval nodes upstream, and the Output Guardrail node's
 * checks as content rules, with its original checks pinned.
 */

/** A mock chat model: answers from a script and reports token usage. */
class MockModel implements LLMProviderAdapter {
  readonly definition: { id: string; label: string; supportsTools: boolean; configSchema: Record<string, unknown> };
  readonly requests: ProviderCallRequest[] = [];
  constructor(
    id: string,
    private readonly answer: (request: ProviderCallRequest) => string,
    private readonly usage: LLMUsage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
  ) {
    this.definition = { id, label: id, supportsTools: true, configSchema: {} };
  }
  async generate(request: ProviderCallRequest) {
    this.requests.push(request);
    return { content: this.answer(request), toolCalls: [], usage: this.usage, latencyMs: 5 };
  }
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

/** A workflow; an Output node is added after `last` when the list has none. */
function workflow(nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>, last?: string): Workflow {
  const all = [...nodes];
  const links = [...edges];
  if (last && !all.some((entry) => entry.type === "output")) {
    all.push(node("__out", "output"));
    links.push({ source: last, target: "__out" });
  }
  return { id: "wf-out", name: "Output checks", schemaVersion: "1.0.0", workflowVersion: 1, nodes: all, edges: links.map((edge, index) => ({ id: `e${index}`, ...edge })) };
}

function resolved(id: string, document: Omit<GuardProfileInput, "id" | "name" | "version">): ResolvedGuardProfile {
  const profile = parseGuardProfile({ id, name: id, version: "1", ...document });
  return { profileId: id, version: 1, hash: hashGuardProfile(profile), name: id, profile };
}

function guardDeps(stack: ResolvedGuardProfile[] = []) {
  const events: GuardVerdictEvent[] = [];
  const resolution: GuardRunResolution = { source: stack.length ? "project" : "none", stack, chain: [] };
  return {
    events,
    guard: {
      registry: createDefaultGuardRegistry(),
      resolveRun: () => resolution,
      loadProfile: (id: string) => stack.find((entry) => entry.profileId === id),
      onVerdict: (event: GuardVerdictEvent) => {
        events.push(event);
      }
    } satisfies WorkflowExecutionDependencies["guard"]
  };
}

function deps(input: { models?: LLMProviderAdapter[]; guard?: WorkflowExecutionDependencies["guard"]; embeddings?: EmbeddingProviderRegistry } = {}): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  for (const model of input.models ?? []) providerRegistry.register(model);
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    ...(input.guard ? { guard: input.guard } : {}),
    ...(input.embeddings ? { embeddingProviderRegistry: input.embeddings } : {})
  };
}

const resultOf = (result: WorkflowExecutionResult, id: string) => result.nodeResults.filter((entry) => entry.nodeId === id).at(-1);
const outputOf = (result: WorkflowExecutionResult, id: string) => (resultOf(result, id)?.output ?? {}) as Record<string, unknown>;

/** in → llm (a mock model answering `reply`) → rail (Output Guardrail) → out */
async function runGuardrail(reply: string, rail: Record<string, unknown>, extra: { models?: LLMProviderAdapter[]; guard?: WorkflowExecutionDependencies["guard"] } = {}) {
  const writer = new MockModel("writer", () => reply);
  const wf = workflow(
    [node("in", "webhook_input"), node("llm", "llm_call", { provider: { providerId: "writer", model: "w-1" } }), node("rail", "output_guardrail", { onFail: "error", ...rail }), node("out", "output")],
    [{ source: "in", target: "llm" }, { source: "llm", target: "rail" }, { source: "rail", target: "out" }]
  );
  const result = await executeWorkflow({ workflow: wf, executionId: "rail-run", webhookPayload: { user_prompt: "hello" } }, deps({ models: [writer, ...(extra.models ?? [])], ...(extra.guard ? { guard: extra.guard } : {}) }));
  return { result, writer, rail: resultOf(result, "rail"), output: outputOf(result, "rail") };
}

describe("Output Guardrail: original checks keep their behaviour", () => {
  it("no_profanity keeps its word list and substring match", async () => {
    expect((await runGuardrail("Well, damn.", { checks: ["no_profanity"] })).rail?.error).toBe("Output guardrail checks failed: no_profanity");
    expect((await runGuardrail("A fine answer.", { checks: ["no_profanity"] })).rail?.status).toBe("success");
  });

  it("must_contain_json and matches_schema without a schema parse as before", async () => {
    expect((await runGuardrail('Here: ```json\n{"a":1}\n```', { checks: ["must_contain_json"] })).rail?.status).toBe("success");
    expect((await runGuardrail("no json", { checks: ["must_contain_json"] })).rail?.error).toBe("Output guardrail checks failed: must_contain_json");
    expect((await runGuardrail('{"a":1}', { checks: ["matches_schema"] })).rail?.status).toBe("success");
    expect((await runGuardrail('Result: {"a":1}', { checks: ["matches_schema"] })).rail?.error).toBe("Output guardrail checks failed: matches_schema");
  });

  it("a passing node's output is unchanged: no usage, no new fields", async () => {
    const passing = await runGuardrail("A fine answer.", { checks: ["no_profanity"] });
    expect(passing.output).toEqual({ answer: "A fine answer.", text: "A fine answer.", guardrail: { checks: ["no_profanity"], attempts: 0, passed: true } });
  });
});

describe("Output Guardrail: rule checks", () => {
  it("no_pii uses the data detector: Luhn-checked cards, emails; random digits pass", async () => {
    expect((await runGuardrail("Order 1234 5678 9012 3456 is confirmed.", { checks: ["no_pii"] })).rail?.status).toBe("success");
    expect((await runGuardrail("Card 4111 1111 1111 1111 on file.", { checks: ["no_pii"] })).rail?.error).toMatch(/^Output guardrail checks failed: no_pii \(block: sensitive_data\/card_number/);
    expect((await runGuardrail("Mail me at jane@example.com", { checks: ["no_pii"] })).rail?.error).toContain("no_pii");
  });

  it("records rule events with placement node under the Output Guardrail rule set", async () => {
    const harness = guardDeps();
    await runGuardrail("Mail me at jane@example.com", { checks: ["no_pii"] }, { guard: harness.guard });
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({ nodeId: "rail", placement: "node", channel: "final_output", profile: { profileId: OUTPUT_GUARDRAIL_PROFILE_ID } });
    expect(harness.events[0]!.verdict.findings[0]!.evidence).not.toContain("jane@example.com");
  });

  it("matches_schema reads the node's schema (an object or JSON text)", async () => {
    const schema = { type: "object", required: ["status"], properties: { status: { enum: ["ok", "late"] } } };
    expect((await runGuardrail('{"status":"ok"}', { checks: ["matches_schema"], schema })).rail?.status).toBe("success");
    expect((await runGuardrail('{"status":"lost"}', { checks: ["matches_schema"], schema })).rail?.error).toContain("matches_schema (block: schema_violation");
    expect((await runGuardrail('{"status":"late"}', { checks: ["matches_schema"], schema: JSON.stringify(schema) })).rail?.status).toBe("success");
    // Settings errors are refused before the run starts.
    expect((await runGuardrail('{"status":"late"}', { checks: ["matches_schema"], schema: "{not json" })).result.error).toContain("schema is not valid JSON");
    expect((await runGuardrail('{"status":"late"}', { checks: ["matches_schema"], schema: { type: "nope" } })).result.error).toContain("could not be compiled");
  });

  it("topic and safety checks", async () => {
    const topics = { deny: [{ name: "investment advice", phrases: ["buy stocks", "crypto"] }] };
    expect((await runGuardrail("You should buy stocks today.", { checks: ["topic"], topics })).rail?.error).toContain("topic (block: off_topic");
    expect((await runGuardrail("Your refund is on its way.", { checks: ["topic"], topics })).rail?.status).toBe("success");
    expect((await runGuardrail("x", { checks: ["topic"] })).result.error).toContain("needs topics");
    expect((await runGuardrail("x", { checks: ["sarcasm"] })).result.error).toContain("must be one of no_pii");
    expect((await runGuardrail("I am going to kill you.", { checks: ["safety"] })).rail?.error).toContain("safety (block: unsafe_content");
    expect((await runGuardrail("Kill the process and restart it.", { checks: ["safety"] })).rail?.status).toBe("success");
  });

  it("model safety asks the check model offline and counts its usage; retries count too", async () => {
    const judge = new MockModel("mock", (request) => (String(request.messages[1]?.content).includes("violent") ? '{"violence":0.95}' : '{"violence":0.01}'), { inputTokens: 40, outputTokens: 6 });
    const rail = { checks: ["safety"], safety: { mode: "model" }, checkModel: { providerId: "mock", model: "judge-1" } };
    const clean = await runGuardrail("A calm answer.", rail, { models: [judge] });
    expect(clean.rail?.status).toBe("success");
    expect(judge.requests).toHaveLength(1);
    expect(judge.requests[0]!.provider).toMatchObject({ providerId: "mock", model: "judge-1", temperature: 0 });
    expect(clean.output._childTelemetry).toEqual([
      { providerId: "mock", model: "judge-1", usage: { inputTokens: 40, outputTokens: 6 }, llmCallCount: 1, latencyMs: 5, purpose: "content_rules", detectorId: "output.safety" }
    ]);
    const blocked = await runGuardrail("A violent answer.", rail, { models: [judge] });
    expect(blocked.rail?.error).toContain("safety (block: unsafe_content");

    // Retry: the upstream model rewrites; each retry and each check is a counted model call.
    const writerAnswers = ["A violent answer.", "A calm answer."];
    const writer = new MockModel("writer", () => writerAnswers.shift() ?? "A calm answer.");
    const wf = workflow(
      [
        node("in", "webhook_input"),
        node("llm", "llm_call", { provider: { providerId: "writer", model: "w-1" } }),
        node("rail", "output_guardrail", { ...rail, onFail: "retry" }),
        node("out", "output")
      ],
      [{ source: "in", target: "llm" }, { source: "llm", target: "rail" }, { source: "rail", target: "out" }]
    );
    const retried = await executeWorkflow({ workflow: wf, executionId: "retry", webhookPayload: { user_prompt: "hi" } }, deps({ models: [writer, judge] }));
    const output = outputOf(retried, "rail");
    expect(output.answer).toBe("A calm answer.");
    expect((output._childTelemetry as CheckModelUsage[]).map((entry) => entry.purpose)).toEqual(["content_rules", "guardrail_retry", "content_rules"]);
  });

  it("a model check that cannot get scores fails closed, naming the check", async () => {
    // The upstream writer is the default check model here, and it answers prose, not scores.
    const { rail } = await runGuardrail("text", { checks: ["safety"], safety: { mode: "model" } });
    expect(rail?.error).toMatch(/^Output guardrail checks failed: safety \(block: detector failure \(fail closed\); output.safety failed: output.safety: the model's answer held no safety scores\)$/);
  });

  it("the upstream model is the default check model", async () => {
    const judge = new MockModel("writer", () => '{"violence":0}');
    const wf = workflow(
      [node("in", "webhook_input"), node("llm", "llm_call", { provider: { providerId: "writer", model: "w-1" } }), node("rail", "output_guardrail", { checks: ["safety"], safety: { mode: "model" }, onFail: "error" })],
      [{ source: "in", target: "llm" }, { source: "llm", target: "rail" }],
      "rail"
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "default-model", webhookPayload: { user_prompt: "hi" } }, deps({ models: [judge] }));
    expect(resultOf(result, "rail")?.status).toBe("success");
    expect(judge.requests.at(-1)!.messages[0]!.content).toContain("content safety classifier");
  });
});

const DOCS = [
  { id: "kb-1", text: "Refunds are issued within 14 days of the return arriving at the warehouse." },
  { id: "kb-2", text: "Standard shipping takes 3 to 5 business days within the country." }
];

/** in → rag (two documents) → llm → check → out */
function ragWorkflow(check: WorkflowNode, extra: WorkflowNode[] = [], extraEdges: Array<Omit<WorkflowEdge, "id">> = []): Workflow {
  return workflow(
    [node("in", "webhook_input"), node("rag", "rag_retrieve", { documents: DOCS, topK: 2, queryTemplate: "{{user_prompt}}" }), node("llm", "llm_call", { provider: { providerId: "writer", model: "w-1" } }), check, ...extra],
    [{ source: "in", target: "rag" }, { source: "rag", target: "llm" }, { source: "llm", target: check.id }, ...extraEdges],
    check.id
  );
}

describe("grounding with sources from retrieval nodes", () => {
  it("Output Guardrail grounding passes supported answers and fails unsupported ones", async () => {
    const run = async (reply: string) => {
      const writer = new MockModel("writer", () => reply);
      const result = await executeWorkflow(
        { workflow: ragWorkflow(node("rail", "output_guardrail", { checks: ["grounding"], onFail: "error" })), executionId: "g", webhookPayload: { user_prompt: "refund shipping" } },
        deps({ models: [writer] })
      );
      return resultOf(result, "rail");
    };
    const rag = await run("Refunds are issued within 14 days of the return arriving.");
    expect(rag?.status).toBe("success");
    expect((await run("Refunds are paid in cash at any partner bank branch immediately."))?.error).toContain("grounding (block: ungrounded");
  });

  it("a Content Rules node with output.grounding routes an unsupported answer to blocked", async () => {
    const profile = resolved("grounded", {
      channels: { final_output: { detectors: [{ id: "output.grounding", threshold: 0.5, options: {} }], actions: {}, defaultAction: { action: "block" } } }
    } as never);
    const run = async (reply: string) => {
      const writer = new MockModel("writer", () => reply);
      const harness = guardDeps([profile]);
      const check = node("rules", "guard", { profileId: "grounded", channel: "final_output", inputField: "answer" });
      const result = await executeWorkflow({ workflow: ragWorkflow(check), executionId: "cr", webhookPayload: { user_prompt: "refund" } }, deps({ models: [writer], guard: harness.guard }));
      return outputOf(result, "rules");
    };
    expect((await run("Standard shipping takes 3 to 5 business days [2].")).guard).toMatchObject({ route: "pass" });
    const blocked = await run("Shipping is free worldwide for every order over ten dollars [2].");
    expect(blocked.guard).toMatchObject({ route: "blocked" });
    expect(JSON.stringify(blocked.guard)).toContain("ungrounded");
  });

  it("an agent's final answer is checked against upstream documents and its tool results", async () => {
    const profile = resolved("agent-grounded", {
      channels: { final_output: { detectors: [{ id: "output.grounding", threshold: 0.5, options: {} }], actions: {}, defaultAction: { action: "block" } } }
    } as never);
    const run = async (reply: string) => {
      const writer = new MockModel("writer", () => reply);
      const harness = guardDeps([profile]);
      const wf = workflow(
        [
          node("in", "webhook_input"),
          node("rag", "rag_retrieve", { documents: DOCS, topK: 2 }),
          node("agent", "agent_orchestrator", { maxIterations: 2, userPromptTemplate: "{{user_prompt}}" }),
          node("model", "llm_call", { provider: { providerId: "writer", model: "w-1" } })
        ],
        [{ source: "in", target: "rag" }, { source: "rag", target: "agent" }, { source: "agent", sourceHandle: "chat_model", target: "model" }],
        "agent"
      );
      const result = await executeWorkflow({ workflow: wf, executionId: "ag", webhookPayload: { user_prompt: "refund" } }, deps({ models: [writer], guard: harness.guard }));
      return { agent: resultOf(result, "agent"), events: harness.events };
    };
    expect((await run("Refunds are issued within 14 days of the return arriving [1].")).agent?.status).toBe("success");
    const blocked = await run("Refunds are paid in cash at any partner bank branch immediately.");
    expect(blocked.agent?.status).toBe("error");
    expect(blocked.events.some((event) => event.channel === "final_output" && event.verdict.findings.some((finding) => finding.category === "ungrounded"))).toBe(true);
  });

  it("an agent's model check counts in the agent's usage", async () => {
    const judge = new MockModel("mock", () => '{"self_harm":0,"violence":0,"sexual":0,"sexual_minors":0,"hate":0}', { inputTokens: 30, outputTokens: 4 });
    const profile = resolved("agent-safety", {
      channels: {
        final_output: {
          detectors: [{ id: "output.safety", threshold: 0.5, options: { mode: "model", model: { providerId: "mock", model: "judge-1" } } }],
          actions: {},
          defaultAction: { action: "block" }
        }
      },
      latencyBudget: { ms: 10_000, onExceeded: "fail_closed" }
    } as never);
    const writer = new MockModel("writer", () => "All good.");
    const harness = guardDeps([profile]);
    const wf = workflow(
      [node("in", "webhook_input"), node("agent", "agent_orchestrator", { maxIterations: 2, userPromptTemplate: "{{user_prompt}}" }), node("model", "llm_call", { provider: { providerId: "writer", model: "w-1" } })],
      [{ source: "in", target: "agent" }, { source: "agent", sourceHandle: "chat_model", target: "model" }],
      "agent"
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "as", webhookPayload: { user_prompt: "hi" } }, deps({ models: [writer, judge], guard: harness.guard }));
    expect(resultOf(result, "agent")?.status).toBe("success");
    expect(outputOf(result, "agent")._childTelemetry).toEqual([
      { providerId: "mock", model: "judge-1", usage: { inputTokens: 30, outputTokens: 4 }, llmCallCount: 1, latencyMs: 5, purpose: "content_rules", detectorId: "output.safety" }
    ]);
  });

  it("a run with no output checks configured reports no check usage", async () => {
    const writer = new MockModel("writer", () => "Hello.");
    const harness = guardDeps();
    const wf = workflow(
      [node("in", "webhook_input"), node("agent", "agent_orchestrator", { maxIterations: 2, userPromptTemplate: "{{user_prompt}}" }), node("model", "llm_call", { provider: { providerId: "writer", model: "w-1" } })],
      [{ source: "in", target: "agent" }, { source: "agent", sourceHandle: "chat_model", target: "model" }],
      "agent"
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "zero", webhookPayload: { user_prompt: "hi" } }, deps({ models: [writer], guard: harness.guard }));
    expect(outputOf(result, "agent")._childTelemetry).toBeUndefined();
    expect(writer.requests).toHaveLength(1);
  });
});

describe("groundingSourcesFor", () => {
  const outputs = new Map<string, unknown>([
    ["rag", { documents: [{ id: "a", text: "alpha" }, { text: "beta", metadata: { title: "Beta", url: "https://b.example" } }] }],
    ["rerank", { documents: [{ id: "b", text: "beta" }] }],
    ["other", { documents: [{ id: "z", text: "not retrieval" }] }]
  ]);

  it("takes the nearest retrieval node upstream and numbers its documents", () => {
    const wf = workflow([node("rag", "rag_retrieve"), node("llm", "llm_call"), node("check", "guard")], [{ source: "rag", target: "llm" }, { source: "llm", target: "check" }]);
    expect(groundingSourcesFor(wf, "check", outputs)).toEqual([
      { id: "a", text: "alpha", citation: 1, nodeId: "rag" },
      { id: "rag:2", text: "beta", citation: 2, title: "Beta", uri: "https://b.example", nodeId: "rag" }
    ]);
  });

  it("a rerank stands in for the retrieve before it; non-retrieval nodes and attachments are ignored", () => {
    const wf = workflow(
      [node("rag", "rag_retrieve"), node("rerank", "rerank"), node("other", "set_node"), node("agent", "agent_orchestrator")],
      [{ source: "rag", target: "rerank" }, { source: "rerank", target: "agent" }, { source: "other", target: "agent" }, { source: "agent", sourceHandle: "tool", target: "rag" }]
    );
    expect(groundingSourcesFor(wf, "agent", outputs).map((source) => source.id)).toEqual(["b"]);
  });

  it("two retrieval nodes: ids only, no citation numbers", () => {
    const wf = workflow([node("rag", "rag_retrieve"), node("rerank", "rerank"), node("check", "guard")], [{ source: "rag", target: "check" }, { source: "rerank", target: "check" }]);
    expect(groundingSourcesFor(wf, "check", outputs).every((source) => source.citation === undefined)).toBe(true);
  });
});

describe("createGuardModelServices", () => {
  const embedder = (calls: string[][]): EmbeddingProviderAdapter => ({
    id: "mock-embed",
    embed: async (request) => {
      calls.push(request.input);
      return { embeddings: request.input.map(() => [1, 0]), usage: { inputTokens: 12, totalTokens: 12 }, latencyMs: 3 };
    }
  });

  it("embeds through the embedding registry, checks the allowlist and records usage", async () => {
    const calls: string[][] = [];
    const registry = new EmbeddingProviderRegistry();
    registry.register(embedder(calls));
    const usage: CheckModelUsage[] = [];
    const checked: unknown[] = [];
    const services = createGuardModelServices({
      providerRegistry: new ProviderRegistry(),
      embeddingRegistry: registry,
      providerContext: () => ({ resolveSecret: async () => undefined }),
      usage,
      checkEmbeddingModel: async (target) => {
        checked.push(target);
      }
    });
    const vectors = await services.embed!({ model: { providerId: "mock-embed", model: "e-1" }, texts: ["a", "b"], detectorId: "output.topic" });
    expect(vectors).toEqual([[1, 0], [1, 0]]);
    expect(checked).toEqual([{ providerId: "mock-embed", model: "e-1" }]);
    expect(usage).toEqual([{ providerId: "mock-embed", model: "e-1", usage: { inputTokens: 12, totalTokens: 12 }, llmCallCount: 1, latencyMs: 3, purpose: "content_rules", detectorId: "output.topic" }]);
    await expect(services.embed!({ texts: ["a"], detectorId: "output.topic" })).rejects.toThrow(/needs options.model/);
    await expect(services.embed!({ model: { providerId: "nope", model: "x" }, texts: ["a"], detectorId: "output.topic" })).rejects.toThrow(/no embedding adapter/);
  });

  it("a refused embedding model is never called", async () => {
    const calls: string[][] = [];
    const registry = new EmbeddingProviderRegistry();
    registry.register(embedder(calls));
    const services = createGuardModelServices({
      providerRegistry: new ProviderRegistry(),
      embeddingRegistry: registry,
      providerContext: () => ({ resolveSecret: async () => undefined }),
      usage: [],
      checkEmbeddingModel: async () => {
        throw new Error("model not allowed");
      }
    });
    await expect(services.embed!({ model: { providerId: "mock-embed", model: "e-1" }, texts: ["a"], detectorId: "output.topic" })).rejects.toThrow("model not allowed");
    expect(calls).toEqual([]);
  });

  it("semantic topic checks run in a Content Rules node with a mock embedder, counted in its usage", async () => {
    const calls: string[][] = [];
    const registry = new EmbeddingProviderRegistry();
    registry.register({
      id: "mock-embed",
      embed: async (request) => {
        calls.push(request.input);
        return { embeddings: request.input.map((text) => (/stock|crypto|invest/i.test(text) ? [1, 0] : [0, 1])), usage: { inputTokens: 8 }, latencyMs: 1 };
      }
    });
    const profile = resolved("topics", {
      channels: {
        final_output: {
          detectors: [{ id: "output.topic", threshold: 0.5, options: { mode: "semantic", model: { providerId: "mock-embed", model: "e-1" }, deny: [{ name: "investing", examples: ["which stocks to buy"] }] } }],
          actions: {},
          defaultAction: { action: "block" }
        }
      }
    } as never);
    const writer = new MockModel("writer", () => "Put it all in crypto.");
    const harness = guardDeps([profile]);
    const wf = workflow(
      [node("in", "webhook_input"), node("llm", "llm_call", { provider: { providerId: "writer", model: "w-1" } }), node("rules", "guard", { profileId: "topics", channel: "final_output", inputField: "answer" })],
      [{ source: "in", target: "llm" }, { source: "llm", target: "rules" }],
      "rules"
    );
    const result = await executeWorkflow({ workflow: wf, executionId: "topic", webhookPayload: { user_prompt: "hi" } }, { ...deps({ models: [writer], guard: harness.guard, embeddings: registry }) });
    const output = outputOf(result, "rules");
    expect(output.guard).toMatchObject({ route: "blocked" });
    expect(output._childTelemetry).toEqual([{ providerId: "mock-embed", model: "e-1", usage: { inputTokens: 8 }, llmCallCount: 1, latencyMs: 1, purpose: "content_rules", detectorId: "output.topic" }]);
  });
});

describe("readOutputGuardrailConfig / outputGuardrailProfile", () => {
  it("old configs map to the same checks; only rule checks build a rule set", () => {
    expect(outputGuardrailProfile(readOutputGuardrailConfig({ checks: ["no_profanity", "must_contain_json", "matches_schema"] }))).toBeUndefined();
    const profile = outputGuardrailProfile(readOutputGuardrailConfig({ checks: ["no_pii", "matches_schema"], schema: { type: "object" } }))!;
    expect(profile.profile.channels.final_output!.detectors.map((entry) => entry.id)).toEqual(["dlp.patterns", "output.schema"]);
    expect(() => readOutputGuardrailConfig({ checks: [], checkModel: { providerId: "" } })).toThrow(/check model/);
  });
});

describe("agent grounding sources", () => {
  const profile = resolved("tool-grounded", {
    channels: { final_output: { detectors: [{ id: "output.grounding", threshold: 0.5, options: {} }], actions: {}, defaultAction: { action: "block" } } }
  } as never);

  async function session(groundingSources?: () => GuardSource[]) {
    const harness = guardDeps([profile]);
    const scope: GuardEvalScope = { guard: harness.guard, resolveSecret: async () => undefined, executionId: "x", workflowId: "wf", nodeId: "agent", placement: "agent" };
    const created = await createAgentGuardSession({ scope, protectionNodes: [], describeTool: () => undefined, ...(groundingSources ? { groundingSources } : {}) });
    return created!;
  }

  it("the run's tool results become sources for the final answer", async () => {
    const guard = await session();
    const answer = "The warehouse in Leeds ships parcels every Tuesday morning.";
    expect((await guard.hooks.check({ channel: "final_output", content: answer, labels: [], iteration: 1 })).outcome).toBe("allow");
    // Sources exist now, and the answer is not supported by them.
    await guard.hooks.check({ channel: "tool_result", content: "Opening hours: 9 to 5 on weekdays.", labels: ["untrusted_external"], iteration: 1, tool: { name: "hours" } });
    expect((await guard.hooks.check({ channel: "final_output", content: answer, labels: [], iteration: 2 })).outcome).toBe("block");
    await guard.hooks.check({ channel: "tool_result", content: "The Leeds warehouse ships parcels every Tuesday morning.", labels: ["untrusted_external"], iteration: 2, tool: { name: "ship" } });
    expect((await guard.hooks.check({ channel: "final_output", content: answer, labels: [], iteration: 3 })).outcome).toBe("allow");
  });

  it("upstream documents are read only when a rule set checks grounding", async () => {
    let reads = 0;
    const guard = await session(() => (reads += 1, [{ id: "d", text: "The Leeds warehouse ships parcels every Tuesday morning." }]));
    expect((await guard.hooks.check({ channel: "final_output", content: "The warehouse in Leeds ships parcels every Tuesday morning.", labels: [], iteration: 1 })).outcome).toBe("allow");
    expect(reads).toBe(1);
    await guard.hooks.check({ channel: "prompt", content: "hi", labels: ["user"], iteration: 1 });
    expect(reads).toBe(1);
  });
});
