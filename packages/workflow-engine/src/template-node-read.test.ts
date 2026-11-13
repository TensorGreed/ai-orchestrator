/**
 * `{{ $node('id') }}` in workflow templates reads any completed node, as `{{results.id.field}}` does, and counts as a
 * read of that node everywhere `results.id` does: its labels reach the reading node, a destination rule judges the
 * value it sends, and content capture drops the content of a call that read sensitive data through it. Every case
 * runs the `results.X` form beside the `$node('X')` form and expects the same outcome.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultGuardProfile, createDefaultGuardRegistry, hashGuardProfile, InMemoryTokenVaultStorage, parseGuardProfile, type GuardProfileInput } from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  NOOP_RUN_INSTRUMENTATION,
  type ContentSensitivity,
  type DataDestinationRow,
  type DataLabels,
  type RunInstrumentation,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecutionResult,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, type AgentSessionArtifactStore, type WorkflowExecutionDependencies } from "./executor";
import type { GuardRunResolution, ResolvedGuardProfile } from "./guard-runtime";
import { evaluateInSandbox, serializeExpressionPayload } from "./expression-sandbox";
import { renderTemplate } from "./template";

const CARD = "4111 1111 1111 1111";
const EMAIL = "ana.lopez@example.org";

/** The two ways to read an earlier node that is not a direct parent. */
const FORMS = {
  results: (nodeId: string, field: string) => `{{results.${nodeId}.${field}}}`,
  node: (nodeId: string, field: string) => `{{ $node('${nodeId}').output.${field} }}`
} as const;
type Form = keyof typeof FORMS;
const FORM_NAMES = Object.keys(FORMS) as Form[];

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function set(id: string, fields: Record<string, string>, extra: Record<string, unknown> = {}): WorkflowNode {
  return node(id, "set_node", { assignments: Object.entries(fields).map(([key, valueTemplate]) => ({ key, valueTemplate })), ...extra });
}

function workflow(id: string, nodes: WorkflowNode[], edges: Array<[string, string, string?]>): Workflow {
  const list: WorkflowEdge[] = edges.map(([source, target, sourceHandle], index) => ({ id: `e${index}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) }));
  return { id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes, edges: list };
}

function resolved(id: string, document: GuardProfileInput): ResolvedGuardProfile {
  const profile = parseGuardProfile({ ...document, id });
  return { profileId: id, version: 1, hash: hashGuardProfile(profile), name: profile.name, profile };
}

const IN_HOUSE = { dataClasses: ["card_number"] };
const PROFILES: Record<string, ResolvedGuardProfile> = {
  tracking: resolved("tracking", { ...createDefaultGuardProfile(), labels: "propagated" }),
  block: resolved("block", {
    ...createDefaultGuardProfile(),
    destinations: { rules: [{ name: "Keep cards in-house", when: IN_HOUSE, allow: { maxTier: "private" }, action: "block" }] }
  } as never)
};

function guardFor(profileId: string, rows: DataDestinationRow[] = []): WorkflowExecutionDependencies["guard"] {
  const profile = PROFILES[profileId]!;
  const resolution: GuardRunResolution = { source: "project", stack: [profile], chain: [{ level: "project", mode: "override", profileId: profile.profileId }] };
  return {
    registry: createDefaultGuardRegistry({ resolver: async () => ["93.184.215.14"] }),
    resolveRun: () => resolution,
    loadProfile: (id: string) => PROFILES[id],
    vault: new InMemoryTokenVaultStorage(),
    onVerdict: () => undefined,
    destinationRows: () => rows
  };
}

class Scripted implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly prompts: string[] = [];
  /** What the run's content check answered while each call was made (as the OTel layer asks when content arrives). */
  readonly answers: ContentSensitivity[][] = [];
  constructor(private readonly checks: Array<() => ContentSensitivity> = []) {}
  async generate(request: ProviderCallRequest) {
    this.prompts.push(request.messages.map((message) => message.content).join("\n"));
    this.answers.push(this.checks.map((check) => check()));
    return { content: "ok", toolCalls: [] };
  }
}

function deps(extra: Partial<WorkflowExecutionDependencies> = {}, provider: LLMProviderAdapter = new Scripted()): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider);
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    ...extra
  };
}

const resultOf = (result: WorkflowExecutionResult, id: string) => result.nodeResults.filter((entry) => entry.nodeId === id).at(-1);
const outputOf = (result: WorkflowExecutionResult, id: string) => resultOf(result, id)?.output as Record<string, unknown> | undefined;
const L = (provenance: DataLabels["provenance"], dataClasses: string[] = []): DataLabels => ({ provenance, dataClasses, source: "propagated" });

describe("$node() in a template", () => {
  it("renders the output of any completed node in `results`, and nothing when the node is missing", () => {
    const values = { results: { fetch: { title: "Hello" } } };
    expect(renderTemplate("{{ $node('fetch').output.title }}", values)).toBe("Hello");
    expect(renderTemplate("{{ $node('missing').output ? 'yes' : 'none' }}", values)).toBe("none");
    expect(renderTemplate("{{ $node('fetch').output.title }}", {})).toBe("");
  });

  it("sends node outputs that are the template data's own `results` to the sandbox once", () => {
    const results = { fetch: { title: "Only-once-marker" } };
    const base = { workflow: { id: "w", name: "w" }, execution: { id: "e", customData: {} }, env: {}, vars: {}, itemIndex: 0 };
    const shared = serializeExpressionPayload({ ...base, input: { results }, nodeOutputs: results });
    expect(shared.split("Only-once-marker")).toHaveLength(2);
    expect(evaluateInSandbox("$node('fetch').output.title", shared)).toBe("Only-once-marker");
    // Node outputs that are not the input's `results` are sent as they are.
    const separate = serializeExpressionPayload({ ...base, input: { results }, nodeOutputs: { fetch: { title: "other" } } });
    expect(evaluateInSandbox("$node('fetch').output.title + '/' + $input.results.fetch.title", separate)).toBe("other/Only-once-marker");
  });

  it("reads a node two steps away, where the bare {{nodeId.field}} form (direct parents only) stays empty", async () => {
    // start → fetch → mid → probe: fetch is not a direct parent of probe.
    const wf = workflow(
      "wf-two-steps",
      [
        node("start", "manual_trigger"),
        set("fetch", { title: "Hello" }),
        set("mid", { note: "between" }),
        set("probe", { viaNode: FORMS.node("fetch", "title"), viaResults: FORMS.results("fetch", "title"), bare: "{{fetch.title}}" }),
        node("out", "output")
      ],
      [["start", "fetch"], ["fetch", "mid"], ["mid", "probe"], ["probe", "out"]]
    );
    const result = await executeWorkflow({ workflow: wf }, deps());
    expect(result.status, result.error).toBe("success");
    expect(outputOf(result, "probe")).toMatchObject({ viaNode: "Hello", viaResults: "Hello", bare: "" });
  });
});

describe("a $node() read is a read of that node, as results.X is", () => {
  /**
   * start → hr (sensitive output) and start → a → reader: the reader is not after hr in the graph, so whatever of
   * hr's labels it carries came from its template read alone. `other` reads nothing of hr.
   */
  const sideRead = (form: Form) =>
    workflow(
      `wf-side-${form}`,
      [
        node("start", "manual_trigger"),
        set("hr", { salary: "100" }, { sensitiveOutput: true }),
        set("a", { step: "a" }),
        set("reader", { copy: FORMS[form]("hr", "salary") }),
        set("other", { copy: "{{step}}" }),
        node("out", "output")
      ],
      [["start", "hr"], ["start", "a"], ["a", "reader"], ["a", "other"], ["reader", "out"], ["other", "out"]]
    );

  it.each(FORM_NAMES)("%s: the labels of the node read reach the reading node", async (form) => {
    const result = await executeWorkflow({ workflow: sideRead(form), inputLabels: L(["user"]) }, deps({ guard: guardFor("tracking") }));
    expect(result.status, result.error).toBe("success");
    expect(outputOf(result, "reader")?.copy).toBe("100");
    expect(resultOf(result, "reader")?.labels?.provenance).toEqual(["user", "sensitive"]);
    expect(resultOf(result, "other")?.labels?.provenance ?? []).not.toContain("sensitive");
  });

  // A local server the HTTP Request node posts to; the rows below make it a public destination.
  let server: Server;
  let base = "";
  const received: string[] = [];
  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const PUBLIC_LOCALHOST = [
    { id: "dst_pub", name: "Test server", kind: "http", targetId: null, host: "127.0.0.1", tier: "public", region: "unknown", holdsDataClasses: [], createdAt: "", updatedAt: "", createdBy: null, updatedBy: null }
  ] as unknown as DataDestinationRow[];

  it.each(FORM_NAMES)("%s: a destination rule blocks the value read two steps away, found in what would be sent", async (form) => {
    // start → card → mid → http: the request body reads the card through the template.
    const wf = workflow(
      `wf-dest-${form}`,
      [
        node("start", "manual_trigger"),
        set("card", { number: CARD }),
        set("mid", { note: "between" }),
        node("http", "http_request", { method: "POST", urlTemplate: `${base}/send`, bodyTemplate: `{"card":"${FORMS[form]("card", "number")}"}` }),
        node("out", "output")
      ],
      [["start", "card"], ["card", "mid"], ["mid", "http"], ["http", "out"]]
    );
    const before = received.length;
    const result = await executeWorkflow({ workflow: wf, executionId: `dest-${form}` }, deps({ guard: guardFor("block", PUBLIC_LOCALHOST) }));
    expect(result.status).toBe("error");
    expect(received.length).toBe(before);
    const error = resultOf(result, "http")?.error ?? "";
    expect(error).toContain("was blocked by content rules");
    expect(error).toContain("card_number");
    // The card is in the body itself, not only in the labels the node inherited.
    expect(error).not.toContain("not found in the text");
    expect(error).not.toContain("4111");
  });

  /** A capturing instrumentation: the provider asks the run's content check while each call is made. */
  function capturing() {
    const checks: Array<() => ContentSensitivity> = [];
    const instrument: RunInstrumentation = {
      ...NOOP_RUN_INSTRUMENTATION,
      enabled: true,
      capturesContent: true,
      withContentExclusion: <T>(check: () => ContentSensitivity, fn: () => T): T => {
        checks.push(check);
        return fn();
      }
    };
    return { instrument, checks };
  }

  it.each(FORM_NAMES)("%s: a call that read sensitive data through the template exports no content, and what it saves is marked", async (form) => {
    // start → mail (an email address: a data class, so sensitive) and start → a → … : nothing on the second branch is
    // after mail in the graph. `quiet` reads nothing of mail; `askPrompt` reads it through the template, and the LLM
    // call `ask` sends that prompt. `save` reads it too.
    const MODEL = { providerId: "scripted", model: "m" };
    const wf = workflow(
      `wf-capture-${form}`,
      [
        node("start", "manual_trigger"),
        set("mail", { to: EMAIL }),
        set("a", { step: "a" }),
        node("quietPrompt", "prompt_template", { template: "Say hi", outputKey: "prompt" }),
        node("quiet", "llm_call", { provider: MODEL, promptKey: "prompt" }),
        node("askPrompt", "prompt_template", { template: `Write to ${FORMS[form]("mail", "to")}`, outputKey: "prompt" }),
        node("ask", "llm_call", { provider: MODEL, promptKey: "prompt" }),
        node("save", "session_artifact_save", { namespace: "shared", sessionIdTemplate: "s", artifactKey: "note", valueTemplate: FORMS[form]("mail", "to") }),
        node("out", "output")
      ],
      [
        ["start", "mail"],
        ["start", "a"],
        ["a", "quietPrompt"],
        ["quietPrompt", "quiet"],
        ["quiet", "askPrompt"],
        ["askPrompt", "ask"],
        ["a", "save"],
        ["ask", "out"],
        ["save", "out"]
      ]
    );
    const capture = capturing();
    const provider = new Scripted(capture.checks);
    const saved = new Map<string, { value: unknown; sensitive: boolean }>();
    const sessionArtifactStore: AgentSessionArtifactStore = {
      saveArtifact: async (input) => {
        saved.set(input.artifactKey, { value: input.value, sensitive: input.sensitive === true });
        const { sensitive: _sensitive, ...rest } = input;
        return { ...rest, createdAt: "c", updatedAt: "u" };
      },
      loadArtifact: async () => null
    };
    const result = await executeWorkflow(
      { workflow: wf, executionId: `cap-${form}`, sessionId: "s" },
      deps({ guard: guardFor("tracking"), instrument: capture.instrument, sessionArtifactStore }, provider)
    );
    expect(result.status, result.error).toBe("success");
    expect(provider.prompts).toHaveLength(2);
    // `quiet` read nothing sensitive: its content may be exported.
    expect(provider.answers[0]!.every((answer) => answer === false)).toBe(true);
    // `ask` was sent the address, and its content is dropped.
    expect(provider.prompts[1]).toContain(EMAIL);
    expect(provider.answers[1]!.some((answer) => answer !== false)).toBe(true);
    // The saved value holds the address and carries the mark.
    expect(JSON.stringify(saved.get("note")?.value)).toContain(EMAIL);
    expect(saved.get("note")?.sensitive).toBe(true);
  });
});
