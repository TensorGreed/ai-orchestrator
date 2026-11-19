/**
 * HTTP status handling, node retries and the error output:
 * - an HTTP Request node with "Fail on HTTP error status" fails on a status
 *   outside 200–299, and retries only the statuses on its retry list;
 * - older nodes keep returning the response unless they ask for retries;
 * - retries wait exponentially with jitter, up to a cap, and honour Retry-After;
 * - Retries on Failure and its delay (set in the editor) are used;
 * - with On Error = branch, a failed node sends the error and its input item
 *   to the targets of its `error` output, and its other outputs are skipped;
 *   on success the `error` output's targets are skipped;
 * - a network failure names the method and URL without credentials or query.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { NodeActivityEvent, NodeErrorConfig, Workflow, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { validateWorkflowGraph } from "./validation";

afterEach(() => {
  vi.unstubAllGlobals();
});

function deps(extra: Partial<WorkflowExecutionDependencies> = {}): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    outboundDnsResolver: async () => ["93.184.216.34"],
    ...extra
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}, errorConfig?: NodeErrorConfig): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config, ...(errorConfig ? { errorConfig } : {}) };
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `${source}-${sourceHandle ?? "main"}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf-http-errors", name: "HTTP errors", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

/** input → http → output */
function single(httpConfig: Record<string, unknown>, errorConfig?: NodeErrorConfig): Workflow {
  return workflow(
    [node("input", "text_input", { text: "x" }), node("http", "http_request", { method: "GET", ...httpConfig }, errorConfig), node("output", "output")],
    [edge("input", "http"), edge("http", "output")]
  );
}

/** A fetch stub answering each call from `statuses` in turn (the last one repeats). */
function stubStatuses(statuses: Array<number | { status: number; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      calls.push(String(input));
      const next = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
      const spec = typeof next === "number" ? { status: next } : next;
      return new Response(spec.status === 304 ? null : JSON.stringify({ attempt: calls.length }), {
        status: spec.status,
        headers: { "content-type": "application/json", ...(spec.headers ?? {}) }
      });
    })
  );
  return calls;
}

const resultOf = (result: Awaited<ReturnType<typeof executeWorkflow>>, nodeId: string) => result.nodeResults.find((entry) => entry.nodeId === nodeId)!;
const result_statuses = (result: Awaited<ReturnType<typeof executeWorkflow>>, nodeId: string) =>
  result.nodeResults.filter((entry) => entry.nodeId === nodeId).map((entry) => entry.status);
const retryEvents = (result: Awaited<ReturnType<typeof executeWorkflow>>, nodeId: string) =>
  (resultOf(result, nodeId).activity ?? []).filter((event): event is Extract<NodeActivityEvent, { kind: "retry" }> => event.kind === "retry");

describe("HTTP Request: fail on HTTP error status", () => {
  it("fails on 503 and retries it (429 and 5xx are retried by default)", async () => {
    const calls = stubStatuses([503, 503, 503]);
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/flaky?api_key=s3cr3t", failOnHttpError: true, retryCount: 2, retryDelayMs: 1 }) },
      deps()
    );
    expect(calls).toHaveLength(3);
    expect(result.status).toBe("error");
    const http = resultOf(result, "http");
    expect(http.status).toBe("error");
    expect(http.error).toContain("HTTP 503");
    expect(http.error).toContain("GET https://api.example.com/flaky");
    expect(http.error).not.toContain("s3cr3t");
    expect(http.attempts ?? 3).toBe(3);
    expect(http.retryable).toBe(true);
    expect(http.errorRemediation).not.toMatch(/file an issue/i);
  });

  it("succeeds once a retried status clears", async () => {
    const calls = stubStatuses([502, 200]);
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x", failOnHttpError: true, retryCount: 3, retryDelayMs: 1 }) }, deps());
    expect(calls).toHaveLength(2);
    expect(result.status).toBe("success");
    expect(resultOf(result, "http").output).toMatchObject({ status: 200, ok: true });
  });

  it("does not retry a status that is not on the list", async () => {
    const calls = stubStatuses([404]);
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/missing", failOnHttpError: true, retryCount: 3, retryDelayMs: 1 }) }, deps());
    expect(calls).toHaveLength(1);
    expect(resultOf(result, "http").error).toContain("HTTP 404");
    expect(resultOf(result, "http").retryable).toBe(false);
  });

  it("retries the statuses the node lists", async () => {
    const calls = stubStatuses([404, 404, 200]);
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/eventually", failOnHttpError: true, retryOnStatus: "404, 5xx", retryCount: 2, retryDelayMs: 1 }) },
      deps()
    );
    expect(calls).toHaveLength(3);
    expect(result.status).toBe("success");
  });

  it("returns the response when the option is off", async () => {
    const calls = stubStatuses([500]);
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x", failOnHttpError: false, retryCount: 2, retryDelayMs: 1 }) }, deps());
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("success");
    expect(resultOf(result, "http").output).toMatchObject({ status: 500, ok: false });
  });

  it("keeps an older node (no option saved) returning the response", async () => {
    const calls = stubStatuses([500]);
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x" }) }, deps());
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("success");
    expect(resultOf(result, "http").output).toMatchObject({ status: 500, ok: false });
  });

  it("makes an older node that asks for retries retry its retried statuses and fail once they are spent", async () => {
    const calls = stubStatuses([503]);
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x", retryCount: 1, retryDelayMs: 1 }) }, deps());
    expect(calls).toHaveLength(2);
    expect(result.status).toBe("error");
    expect(resultOf(result, "http").error).toContain("HTTP 503");
  });

  it("keeps an older node that asks for retries returning other error statuses", async () => {
    const calls = stubStatuses([404]);
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x", retryCount: 2, retryDelayMs: 1 }) }, deps());
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("success");
    expect(resultOf(result, "http").output).toMatchObject({ status: 404, ok: false });
  });

  it("treats errorConfig.retryOnFail on an older node the same way", async () => {
    const calls = stubStatuses([502, 200]);
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/x" }, { retryOnFail: true, maxRetries: 2, retryIntervalMs: 1 }) },
      deps()
    );
    expect(calls).toHaveLength(2);
    expect(result.status).toBe("success");
  });
});

describe("retry waits", () => {
  it("grow exponentially with jitter", async () => {
    stubStatuses([503]);
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/x", failOnHttpError: true, retryCount: 3, retryDelayMs: 10 }) },
      deps()
    );
    const delays = retryEvents(result, "http").map((event) => event.delayMs);
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(8);
    expect(delays[0]).toBeLessThanOrEqual(12);
    expect(delays[1]).toBeGreaterThanOrEqual(16);
    expect(delays[1]).toBeLessThanOrEqual(24);
    expect(delays[2]).toBeGreaterThanOrEqual(32);
    expect(delays[2]).toBeLessThanOrEqual(48);
  });

  it("stop at the node's cap", async () => {
    stubStatuses([503]);
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/x", failOnHttpError: true, retryCount: 3, retryDelayMs: 10, retryMaxDelayMs: 15 }) },
      deps()
    );
    const delays = retryEvents(result, "http").map((event) => event.delayMs);
    expect(Math.max(...delays)).toBeLessThanOrEqual(15);
  });

  it("honour Retry-After", async () => {
    const calls = stubStatuses([{ status: 429, headers: { "retry-after": "1" } }, 200]);
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/x", failOnHttpError: true, retryCount: 1, retryDelayMs: 1 }) },
      deps()
    );
    expect(calls).toHaveLength(2);
    expect(result.status).toBe("success");
    expect(retryEvents(result, "http")[0]!.delayMs).toBe(1000);
  });

  it("fail at once when Retry-After asks for longer than the cap", async () => {
    const calls = stubStatuses([{ status: 503, headers: { "retry-after": "120" } }]);
    const started = Date.now();
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/x", failOnHttpError: true, retryCount: 3, retryDelayMs: 1, retryMaxDelayMs: 5000 }) },
      deps()
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toHaveLength(1);
    expect(resultOf(result, "http").error).toMatch(/Retry-After/);
  });
});

describe("Retries on Failure from the editor", () => {
  it("retries a failing node as many times as set", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      })
    );
    await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x", retryCount: 3, retryDelayMs: 1 }) }, deps());
    expect(calls).toBe(4);
  });

  it("does not retry when Retries on Failure is 0", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      })
    );
    await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x", retryCount: 0 }) }, deps());
    expect(calls).toBe(1);
  });
});

describe("network errors", () => {
  it("name the method and URL without credentials, query or fragment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" }) });
      })
    );
    const result = await executeWorkflow(
      { workflow: single({ method: "POST", urlTemplate: "https://user:pw@api.example.com/v1/items?token=abc123#frag", retryCount: 0 }) },
      deps()
    );
    const http = resultOf(result, "http");
    expect(http.error).toContain("POST https://api.example.com/v1/items");
    expect(http.error).toContain("ECONNREFUSED");
    for (const secret of ["abc123", "user:pw", "frag"]) expect(http.error).not.toContain(secret);
    expect(http.errorRemediation).not.toMatch(/file an issue/i);
    // A system error code stays internal: only codes meant for callers become the run's errorCode.
    expect(http.errorCode).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
  });

  it("name the URL when the request times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          })
      )
    );
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/slow?k=v", timeoutMs: 20, retryCount: 0 }) }, deps());
    expect(resultOf(result, "http").error).toContain("timed out after 20ms");
    expect(resultOf(result, "http").error).toContain("GET https://api.example.com/slow");
  });
});

describe("error output (On Error = branch)", () => {
  /** input → http ─main→ ok → out_ok;  http ─error→ fallback → out_err */
  function branching(httpConfig: Record<string, unknown>): Workflow {
    return workflow(
      [
        node("input", "set_node", { assignments: [{ key: "customer", valueTemplate: "acme" }] }),
        node("http", "http_request", { method: "GET", urlTemplate: "https://api.example.com/x", onError: "branch", retryCount: 0, ...httpConfig }),
        node("ok", "set_node", { assignments: [{ key: "path", valueTemplate: "ok" }] }),
        node("fallback", "set_node", { assignments: [{ key: "path", valueTemplate: "fallback {{customer}} {{status}}" }] }),
        node("out_ok", "output"),
        node("out_err", "output")
      ],
      [edge("input", "http"), edge("http", "ok"), edge("http", "fallback", "error"), edge("ok", "out_ok"), edge("fallback", "out_err")]
    );
  }

  it("routes a failure, with the error and the failing item, to the error output and skips the main one", async () => {
    stubStatuses([500]);
    const result = await executeWorkflow({ workflow: branching({ failOnHttpError: true }) }, deps());
    expect(resultOf(result, "http").status).toBe("error");
    expect(resultOf(result, "ok").status).toBe("skipped");
    expect(resultOf(result, "out_ok").status).toBe("skipped");
    expect(resultOf(result, "fallback").status).toBe("success");
    const fallbackInput = resultOf(result, "fallback").input as Record<string, unknown>;
    expect(JSON.stringify(fallbackInput)).toContain("HTTP 500");
    expect(resultOf(result, "fallback").output).toMatchObject({ path: "fallback acme 500" });
    expect(fallbackInput).toMatchObject({ failedNodeId: "http", failedNodeType: "http_request", errorCategory: "http_status", status: 500, customer: "acme" });
    expect(result.status).not.toBe("error");
  });

  it("skips the error output when the node succeeds", async () => {
    stubStatuses([200]);
    const result = await executeWorkflow({ workflow: branching({ failOnHttpError: true }) }, deps());
    expect(resultOf(result, "ok").status).toBe("success");
    expect(resultOf(result, "fallback").status).toBe("skipped");
    expect(resultOf(result, "out_err").status).toBe("skipped");
    expect(result.status).toBe("success");
  });

  it("works on any node type", async () => {
    const result = await executeWorkflow(
      {
        workflow: workflow(
          [
            node("start", "manual_trigger"),
            node("code", "stop_and_error", { message: "boom", onError: "branch" }),
            node("ok", "output", { responseTemplate: "ok" }),
            node("handled", "output", { responseTemplate: "handled: {{error}}" })
          ],
          [edge("start", "code"), edge("code", "ok"), edge("code", "handled", "error")]
        )
      },
      deps()
    );
    expect(resultOf(result, "ok").status).toBe("skipped");
    expect(resultOf(result, "handled").status).toBe("success");
    expect(JSON.stringify(resultOf(result, "handled").output)).toContain("boom");
  });

  it("is not part of a Loop's body: it is skipped when the loop succeeds", async () => {
    const loopFlow = (items: string) =>
      workflow(
        [
          node("start", "set_node", { assignments: [{ key: "list", valueTemplate: items }] }),
          node("loop", "loop_node", { inputKey: "list", itemVariable: "item", onError: "branch" }),
          node("body", "set_node", { assignments: [{ key: "seen", valueTemplate: "{{item}}" }] }),
          node("handler", "set_node", { assignments: [{ key: "handled", valueTemplate: "{{error}}" }] }),
          node("out", "output")
        ],
        [edge("start", "loop"), edge("loop", "body"), edge("loop", "handler", "error"), edge("body", "out")]
      );
    const ok = await executeWorkflow({ workflow: loopFlow("{{ ['a', 'b'] }}") }, deps());
    expect(result_statuses(ok, "handler")).toEqual(["skipped"]);
    expect(result_statuses(ok, "body")).toEqual(["success", "success"]);
  });

  it("lets a node's own connected Error output win over an enclosing Try/Catch", async () => {
    stubStatuses([500]);
    const result = await executeWorkflow(
      {
        workflow: workflow(
          [
            node("start", "manual_trigger"),
            node("try", "try_catch"),
            node("http", "http_request", { method: "GET", urlTemplate: "https://api.example.com/x", failOnHttpError: true, onError: "branch", retryCount: 0 }),
            node("own", "set_node", { assignments: [{ key: "by", valueTemplate: "own" }] }),
            node("catch", "set_node", { assignments: [{ key: "by", valueTemplate: "catch" }] }),
            node("out", "output")
          ],
          [edge("start", "try"), edge("try", "http", "success"), edge("try", "catch", "error"), edge("http", "own", "error"), edge("own", "out")]
        )
      },
      deps()
    );
    expect(resultOf(result, "own").status).toBe("success");
    expect(resultOf(result, "catch").status).toBe("skipped");
  });

  it("retries a URL whose path contains words like billing or quota", async () => {
    const calls = stubStatuses([503, 503, 200]);
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/billing/quota", failOnHttpError: true, retryCount: 2, retryDelayMs: 1 }) },
      deps()
    );
    expect(calls).toHaveLength(3);
    expect(result.status).toBe("success");
  });

  it("does not fail on 304 Not Modified", async () => {
    stubStatuses([304]);
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x", failOnHttpError: true, retryCount: 0 }) }, deps());
    expect(resultOf(result, "http").status).toBe("success");
  });

  it("does not run a node an IF skipped just because a failed node's Error output also reaches it", async () => {
    stubStatuses([500]);
    // start → gate(IF, false) ─true→ a → x;  start → http ─error→ e → x.  The IF skips x (not reachable from its taken branch).
    const run = (ifFirst: boolean) => {
      const ifNodes = [node("gate", "if_node", { condition: "{{ false }}" }), node("a", "set_node", { assignments: [{ key: "from", valueTemplate: "a" }] })];
      const httpNodes = [
        node("http", "http_request", { method: "GET", urlTemplate: "https://api.example.com/x", failOnHttpError: true, onError: "branch", retryCount: 0 }),
        node("e", "set_node", { assignments: [{ key: "from", valueTemplate: "e" }] })
      ];
      return executeWorkflow(
        {
          workflow: workflow(
            [node("start", "manual_trigger"), ...(ifFirst ? [...ifNodes, ...httpNodes] : [...httpNodes, ...ifNodes]), node("x", "set_node", { assignments: [{ key: "shared", valueTemplate: "x" }] }), node("out", "output")],
            [edge("start", "gate"), edge("gate", "a", "true"), edge("a", "x"), edge("start", "http"), edge("http", "e", "error"), edge("e", "x"), edge("x", "out")]
          )
        },
        deps()
      );
    };
    const statuses = async (ifFirst: boolean) => {
      const result = await run(ifFirst);
      return ["a", "e", "x"].map((id) => resultOf(result, id).status);
    };
    const ifFirst = await statuses(true);
    const httpFirst = await statuses(false);
    expect(ifFirst).toEqual(httpFirst);
    expect(ifFirst).toEqual(["skipped", "success", "skipped"]);
  });

  it("runs an error handler shared by two nodes when one of them fails, in either node order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => new Response("{}", { status: String(input).includes("/bad") ? 500 : 200, headers: { "content-type": "application/json" } }))
    );
    const http = (id: string, path: string) =>
      node(id, "http_request", { method: "GET", urlTemplate: `https://api.example.com${path}`, failOnHttpError: true, onError: "branch", retryCount: 0 });
    for (const goodFirst of [true, false]) {
      const pair = goodFirst ? [http("good", "/ok"), http("bad", "/bad")] : [http("bad", "/bad"), http("good", "/ok")];
      const result = await executeWorkflow(
        {
          workflow: workflow(
            [node("start", "manual_trigger"), ...pair, node("handler", "set_node", { assignments: [{ key: "handled", valueTemplate: "{{error}}" }] }), node("out", "output")],
            [edge("start", "good"), edge("start", "bad"), edge("good", "handler", "error"), edge("bad", "handler", "error"), edge("good", "out"), edge("bad", "out")]
          )
        },
        deps()
      );
      expect([goodFirst, resultOf(result, "handler").status]).toEqual([goodFirst, "success"]);
    }
  });

  it("is checked by validation", () => {
    const unconnected = workflow(
      [node("start", "manual_trigger"), node("http", "http_request", { method: "GET", urlTemplate: "https://x.test", onError: "branch" }), node("out", "output")],
      [edge("start", "http"), edge("http", "out")]
    );
    expect(validateWorkflowGraph(unconnected).issues).toContainEqual(expect.objectContaining({ code: "error_output_not_connected", nodeId: "http", severity: "warning" }));

    const badList = workflow(
      [node("start", "manual_trigger"), node("http", "http_request", { method: "GET", urlTemplate: "https://x.test", retryOnStatus: "429, teapot" }), node("out", "output")],
      [edge("start", "http"), edge("http", "out")]
    );
    expect(validateWorkflowGraph(badList).issues).toContainEqual(expect.objectContaining({ code: "invalid_http_retry_on_status", nodeId: "http" }));
  });
});

describe("a stored errorConfig with invalid values", () => {
  // A save refuses these; a workflow stored before that check still validates (with a warning) and runs on its valid fields.
  const invalid = { retryOnFail: true, maxRetries: -3, retryIntervalMs: "soon" } as unknown as NodeErrorConfig;

  it("validates with an invalid_error_config warning naming the fields", () => {
    const validation = validateWorkflowGraph(single({ urlTemplate: "https://api.example.com/x" }, invalid));
    expect(validation.valid).toBe(true);
    const issue = validation.issues.find((entry) => entry.code === "invalid_error_config");
    expect(issue).toMatchObject({ nodeId: "http", severity: "warning" });
    expect(issue?.message).toContain("maxRetries, retryIntervalMs");
  });

  it("runs, ignoring the invalid fields (default retry count and wait) and keeping the valid ones", async () => {
    const calls = stubStatuses([502, 502, 200]);
    const result = await executeWorkflow({ workflow: single({ urlTemplate: "https://api.example.com/x" }, invalid) }, deps());
    // retryOnFail stays on; maxRetries falls back to 2 and retryIntervalMs to its default.
    expect(result.status).toBe("success");
    expect(calls).toHaveLength(3);
  }, 20_000);

  it("a continueOnFail kept from an invalid errorConfig still continues", async () => {
    stubStatuses([500]);
    const result = await executeWorkflow(
      { workflow: single({ urlTemplate: "https://api.example.com/x", failOnHttpError: true, retryCount: 0 }, { continueOnFail: true, maxRetries: "x" } as unknown as NodeErrorConfig) },
      deps()
    );
    // A continued failure makes the run partial, not failed.
    expect(result.status).toBe("partial");
    expect(resultOf(result, "http").status).toBe("error");
  });
});

describe("an invalid Retry on status list", () => {
  it("is an unfinished setting: it stops a run but not a draft save", async () => {
    const { saveBlockingIssues, unfinishedDraftIssues } = await import("./validation");
    const validation = validateWorkflowGraph(single({ urlTemplate: "https://api.example.com/x", failOnHttpError: true, retryOnStatus: "5xx, soon" }));
    expect(validation.valid).toBe(false);
    expect(unfinishedDraftIssues(validation).map((issue) => issue.code)).toEqual(["invalid_http_retry_on_status"]);
    expect(saveBlockingIssues(validation)).toEqual([]);
  });
});
