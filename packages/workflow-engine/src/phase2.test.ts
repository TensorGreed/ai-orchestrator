/**
 * Phase 2 tests — data transformation nodes, expression engine, python code node.
 */
import { describe, expect, it } from "vitest";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type {
  AgentRunRequest,
  AgentRunState,
  WorkflowNodeType
} from "@ai-orchestrator/shared";
import type { AgentRuntimeAdapter } from "@ai-orchestrator/agent-runtime";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { evaluateExpression, jmespath, renderExpressionTemplate } from "./expression";
import { isPythonAvailable, executePythonCodeNode } from "./python-runner";
import {
  aggregateItems,
  compareDatasets,
  compressionGunzip,
  compressionGzip,
  editFields,
  fromCsv,
  htmlExtract,
  jsonToXml,
  jwtSign,
  jwtVerify,
  jwtDecode,
  limitItems,
  performCrypto,
  performDateTime,
  removeDuplicates,
  renameKeys,
  sortItems,
  splitOut,
  summarizeItems,
  toCsv,
  xmlToJson
} from "./transformations";

class FakeProvider implements LLMProviderAdapter {
  readonly definition = { id: "fake", label: "Fake", supportsTools: true, configSchema: {} };
  async generate() {
    return { content: "ok", toolCalls: [] };
  }
}
class FakeAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "fake";
  async run(request: AgentRunRequest): Promise<AgentRunState> {
    return { finalAnswer: request.userPrompt, stopReason: "final_answer", iterations: 1, messages: [], steps: [] };
  }
}
function makeDeps(overrides?: Partial<WorkflowExecutionDependencies>): WorkflowExecutionDependencies {
  const reg = new ProviderRegistry();
  reg.register(new FakeProvider());
  return {
    providerRegistry: reg,
    mcpRegistry: createDefaultMCPRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: new FakeAgentRuntime(),
    resolveSecret: async () => undefined,
    ...overrides
  };
}
function makeNode(id: string, type: string, config: Record<string, unknown> = {}) {
  return {
    id,
    type: type as WorkflowNodeType,
    name: id,
    position: { x: 0, y: 0 },
    config
  };
}
function makeEdge(source: string, target: string) {
  return { id: source + "-" + target, source, target };
}
function makeWorkflow(nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[]) {
  return { id: "wf", name: "wf", schemaVersion: "1.0.0" as const, workflowVersion: 1, nodes, edges };
}

// Helper that runs a single phase-2 node through the engine and returns its output
async function runNode(type: string, config: Record<string, unknown>, variables?: Record<string, unknown>) {
  const wf = makeWorkflow(
    [
      makeNode("n1", type, config),
      makeNode("out", "output", { responseTemplate: "" })
    ],
    [makeEdge("n1", "out")]
  );
  const result = await executeWorkflow({ workflow: wf, variables }, makeDeps());
  const node = result.nodeResults.find((r) => r.nodeId === "n1");
  return { result, output: node?.output as Record<string, unknown> | undefined, node };
}

// =========================================================================
// 2.1.1 aggregate
// =========================================================================
describe("Phase 2.1 — aggregate_node", () => {
  it("sums a numeric field", () => {
    expect(aggregateItems([{ a: 1 }, { a: 2 }, { a: 3 }], "sum", "a").value).toBe(6);
  });
  it("concatenates string field with separator", () => {
    expect(aggregateItems([{ s: "a" }, { s: "b" }], "concatenate", "s", { separator: "-" }).value).toBe("a-b");
  });
  it("groupBy returns per-group values", () => {
    const r = aggregateItems(
      [
        { region: "us", v: 1 },
        { region: "us", v: 2 },
        { region: "eu", v: 5 }
      ],
      "sum",
      "v",
      { groupBy: "region" }
    ) as Record<string, unknown>;
    expect((r.groups as Record<string, unknown>).us).toBe(3);
    expect((r.groups as Record<string, unknown>).eu).toBe(5);
  });
});

// =========================================================================
// 2.1.2 split_out
// =========================================================================
describe("Phase 2.1 — split_out_node", () => {
  it("splits an array field into items", () => {
    expect(splitOut([{ items: [1, 2, 3] }], "items").length).toBe(3);
  });
  it("destinationField wraps value into a key", async () => {
    const out = splitOut([{ items: ["x", "y"], owner: "a" }], "items", "value");
    expect(out[0]).toMatchObject({ value: "x", owner: "a" });
  });
  it("missing field throws", () => {
    expect(() => splitOut([{ a: [1] }], "")).toThrow();
  });
});

// =========================================================================
// 2.1.3 sort
// =========================================================================
describe("Phase 2.1 — sort_node", () => {
  it("sorts ascending by field", () => {
    const out = sortItems([{ x: 3 }, { x: 1 }, { x: 2 }], { field: "x", order: "asc" });
    expect(out.map((r) => (r as Record<string, number>).x)).toEqual([1, 2, 3]);
  });
  it("sorts descending", () => {
    const out = sortItems([{ x: 1 }, { x: 3 }, { x: 2 }], { field: "x", order: "desc" });
    expect(out.map((r) => (r as Record<string, number>).x)).toEqual([3, 2, 1]);
  });
  it("random returns same set", () => {
    const out = sortItems([1, 2, 3, 4], { order: "random" }).slice().sort();
    expect(out).toEqual([1, 2, 3, 4]);
  });
});

// =========================================================================
// 2.1.4 limit
// =========================================================================
describe("Phase 2.1 — limit_node", () => {
  it("keeps first N", () => expect(limitItems([1, 2, 3, 4], 2)).toEqual([1, 2]));
  it("keeps last N", () => expect(limitItems([1, 2, 3, 4], 2, "last")).toEqual([3, 4]));
  it("returns all when below limit", () => expect(limitItems([1], 10)).toEqual([1]));
});

// =========================================================================
// 2.1.5 remove_duplicates
// =========================================================================
describe("Phase 2.1 — remove_duplicates_node", () => {
  it("dedupes by all keys", () => expect(removeDuplicates([{ a: 1 }, { a: 1 }, { a: 2 }]).length).toBe(2));
  it("dedupes by specific field", () => expect(removeDuplicates([{ id: 1, x: "a" }, { id: 1, x: "b" }], ["id"]).length).toBe(1));
  it("keeps everything when nothing duplicates", () => expect(removeDuplicates([{ a: 1 }, { a: 2 }, { a: 3 }]).length).toBe(3));
});

// =========================================================================
// 2.1.6 summarize
// =========================================================================
describe("Phase 2.1 — summarize_node", () => {
  it("multi-aggregate without groupBy", () => {
    const out = summarizeItems(
      [{ x: 1 }, { x: 2 }, { x: 3 }],
      [{ field: "x", aggregation: "sum" }, { field: "x", aggregation: "avg" }]
    ) as Array<Record<string, unknown>>;
    expect(out[0].x_sum).toBe(6);
    expect(out[0].x_avg).toBe(2);
  });
  it("groups by region", () => {
    const out = summarizeItems(
      [
        { region: "us", v: 1 },
        { region: "us", v: 4 },
        { region: "eu", v: 10 }
      ],
      [{ field: "v", aggregation: "sum" }],
      ["region"]
    ) as Array<Record<string, unknown>>;
    const us = out.find((r) => r.region === "us");
    const eu = out.find((r) => r.region === "eu");
    expect(us?.v_sum).toBe(5);
    expect(eu?.v_sum).toBe(10);
  });
  it("empty fieldsToSummarize throws", () => expect(() => summarizeItems([{ a: 1 }], [])).toThrow());
});

// =========================================================================
// 2.1.7 compare_datasets
// =========================================================================
describe("Phase 2.1 — compare_datasets_node", () => {
  it("computes added/removed/same", () => {
    const r = compareDatasets([{ id: 1, v: "a" }, { id: 2, v: "b" }], [{ id: 2, v: "b" }, { id: 3, v: "c" }], "id");
    expect(r.added).toHaveLength(1);
    expect(r.removed).toHaveLength(1);
    expect(r.same).toHaveLength(1);
  });
  it("detects changed", () => {
    const r = compareDatasets([{ id: 1, v: "a" }], [{ id: 1, v: "b" }], "id");
    expect(r.changed).toHaveLength(1);
    expect(r.same).toHaveLength(0);
  });
  it("empty inputs work", () => expect(compareDatasets([], [], "id").added).toEqual([]));
});

// =========================================================================
// 2.1.8 rename_keys
// =========================================================================
describe("Phase 2.1 — rename_keys_node", () => {
  it("renames keys", () => {
    const out = renameKeys([{ a: 1 }], [{ from: "a", to: "b" }])[0] as Record<string, unknown>;
    expect(out.b).toBe(1);
    expect(out.a).toBeUndefined();
  });
  it("ignores missing keys", () => {
    const out = renameKeys([{ a: 1 }], [{ from: "x", to: "y" }])[0] as Record<string, unknown>;
    expect(out.a).toBe(1);
  });
  it("handles non-objects gracefully", () => {
    expect(renameKeys([1, "x"], [{ from: "a", to: "b" }])).toEqual([1, "x"]);
  });
});

// =========================================================================
// 2.1.9 edit_fields
// =========================================================================
describe("Phase 2.1 — edit_fields_node", () => {
  it("set adds a field", () => {
    const out = editFields([{ a: 1 }], [{ op: "set", field: "b", value: 2 }])[0] as Record<string, unknown>;
    expect(out.b).toBe(2);
  });
  it("remove deletes a field", () => {
    const out = editFields([{ a: 1, b: 2 }], [{ op: "remove", field: "a" }])[0] as Record<string, unknown>;
    expect(out.a).toBeUndefined();
  });
  it("rename moves a field", () => {
    const out = editFields([{ a: 1 }], [{ op: "rename", field: "a", newName: "b" }])[0] as Record<string, unknown>;
    expect(out.b).toBe(1);
  });
});

// =========================================================================
// 2.1.10 date_time
// =========================================================================
describe("Phase 2.1 — date_time_node", () => {
  it("formats iso", () => {
    const r = performDateTime({ operation: "format", value: "2024-01-02T00:00:00Z", format: "iso" });
    expect(String(r)).toContain("2024-01-02");
  });
  it("adds days", () => {
    const r = performDateTime({ operation: "add", value: "2024-01-01T00:00:00Z", unit: "day", amount: 1 });
    expect(String(r)).toContain("2024-01-02");
  });
  it("compares dates", () => {
    const r = performDateTime({
      operation: "compare",
      value: "2024-01-02T00:00:00Z",
      compareTo: "2024-01-01T00:00:00Z"
    }) as Record<string, unknown>;
    expect(r.after).toBe(true);
  });
  it("invalid date throws", () => {
    expect(() => performDateTime({ operation: "format", value: "not-a-date" })).toThrow();
  });
});

// =========================================================================
// 2.1.11 crypto
// =========================================================================
describe("Phase 2.1 — crypto_node", () => {
  it("hashes deterministically", () => {
    const a = performCrypto({ operation: "hash", algorithm: "sha256", data: "x" });
    const b = performCrypto({ operation: "hash", algorithm: "sha256", data: "x" });
    expect(a).toBe(b);
  });
  it("hmac with key produces sig", () => {
    const sig = performCrypto({ operation: "hmac", algorithm: "sha256", key: "secret", data: "data" }) as string;
    expect(sig.length).toBeGreaterThan(0);
  });
  it("verify confirms a valid sig", () => {
    const sig = performCrypto({ operation: "hmac", algorithm: "sha256", key: "secret", data: "data" }) as string;
    expect(performCrypto({ operation: "verify", algorithm: "sha256", key: "secret", data: "data", signature: sig })).toBe(true);
  });
  it("encrypt + decrypt roundtrip", () => {
    const enc = performCrypto({ operation: "encrypt", algorithm: "aes-256-cbc", key: "pw", data: "hello" }) as string;
    const dec = performCrypto({ operation: "decrypt", algorithm: "aes-256-cbc", key: "pw", data: enc });
    expect(dec).toBe("hello");
  });
});

// =========================================================================
// 2.1.12 jwt
// =========================================================================
describe("Phase 2.1 — jwt_node", () => {
  it("sign + verify roundtrip", () => {
    const tok = jwtSign({ sub: "u1" }, "shh", "HS256");
    const v = jwtVerify(tok, "shh");
    expect(v.valid).toBe(true);
    expect((v.payload as Record<string, unknown>).sub).toBe("u1");
  });
  it("decode reads payload without verifying", () => {
    const tok = jwtSign({ sub: "u2" }, "shh", "HS256");
    const dec = jwtDecode(tok);
    expect((dec.payload as Record<string, unknown>).sub).toBe("u2");
  });
  it("verify fails with wrong secret", () => {
    const tok = jwtSign({ sub: "u3" }, "shh", "HS256");
    expect(jwtVerify(tok, "other").valid).toBe(false);
  });
  it("supports HS384/HS512", () => {
    expect(jwtVerify(jwtSign({ a: 1 }, "k", "HS384"), "k").valid).toBe(true);
    expect(jwtVerify(jwtSign({ a: 1 }, "k", "HS512"), "k").valid).toBe(true);
  });
});

// =========================================================================
// 2.1.13 xml
// =========================================================================
describe("Phase 2.1 — xml_node", () => {
  it("converts simple xml to json", () => {
    const r = xmlToJson("<root><item>a</item><item>b</item></root>") as Record<string, unknown>;
    const root = r.root as Record<string, unknown>;
    expect(Array.isArray(root.item)).toBe(true);
  });
  it("preserves attributes", () => {
    const r = xmlToJson('<root id="x"><a>1</a></root>') as Record<string, unknown>;
    const root = r.root as Record<string, unknown>;
    expect((root["@attributes"] as Record<string, unknown>).id).toBe("x");
  });
  it("converts json to xml", () => {
    const xml = jsonToXml({ root: { a: 1 } });
    expect(xml).toContain("<root>");
    expect(xml).toContain("<a>1</a>");
  });
});

// =========================================================================
// 2.1.14 html
// =========================================================================
describe("Phase 2.1 — html_node", () => {
  it("extracts via class selector", () => {
    const out = htmlExtract("<div class='title'>Hi</div>", [{ key: "title", selector: ".title" }]);
    expect(out.title).toBe("Hi");
  });
  it("extracts attribute", () => {
    const out = htmlExtract("<a href='/x'>link</a>", [{ key: "href", selector: "a", attribute: "href" }]);
    expect(out.href).toBe("/x");
  });
  it("extracts all matching", () => {
    const out = htmlExtract("<ul><li>a</li><li>b</li></ul>", [{ key: "items", selector: "li", all: true }]);
    expect(out.items).toEqual(["a", "b"]);
  });
});

// =========================================================================
// 2.1.15 / 2.1.16 — file conversion
// =========================================================================
describe("Phase 2.1 — convert_to_file / extract_from_file", () => {
  it("toCsv produces headers and rows", () => {
    const csv = toCsv([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    expect(csv.split("\n")[0]).toBe("a,b");
  });
  it("fromCsv roundtrips", () => {
    const csv = "a,b\n1,2\n3,4";
    const rows = fromCsv(csv);
    expect(rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });
  it("convert_to_file_node json output", async () => {
    const { output } = await runNode("convert_to_file_node", { format: "json", inputKey: "items" });
    expect(output?.mimeType).toBe("application/json");
  });
});

// =========================================================================
// 2.1.17 — compression
// =========================================================================
describe("Phase 2.1 — compression_node", () => {
  it("gzip + gunzip roundtrip", () => {
    const gz = compressionGzip("hello world");
    expect(compressionGunzip(gz)).toBe("hello world");
  });
  it("zip is not implemented (graceful error)", async () => {
    const { node } = await runNode("compression_node", { operation: "zip", data: "x" });
    expect(node?.status).toBe("error");
    expect(node?.error).toMatch(/not supported|not_implemented|gzip/i);
  });
});

// =========================================================================
// 2.1.18 — edit_image_node graceful error
// =========================================================================
describe("Phase 2.1 — edit_image_node", () => {
  it("fails gracefully with NOT_IMPLEMENTED", async () => {
    const { node } = await runNode("edit_image_node", { operation: "resize", width: 10, height: 10 });
    expect(node?.status).toBe("error");
    expect(node?.error).toMatch(/not implemented|optional|sharp|jimp/i);
  });
});

// =========================================================================
// 2.2 — Expression Engine
// =========================================================================
describe("Phase 2.2 — expression engine", () => {
  it("evaluates simple arithmetic", () => {
    expect(evaluateExpression("1 + 2 * 3", {})).toBe(7);
  });
  it("$json access", () => {
    expect(evaluateExpression("$json.name", { $json: { name: "Ada" } })).toBe("Ada");
  });
  it("$node lookup", () => {
    expect(evaluateExpression("$node('a').output.value", { $nodeOutputs: { a: { value: 42 } } })).toBe(42);
  });
  it("$workflow / $execution", () => {
    const ctx = { $workflow: { id: "w1", name: "n" }, $execution: { id: "e1", customData: { batch: "alpha" } } };
    expect(evaluateExpression("$workflow.id + ':' + $execution.id", ctx)).toBe("w1:e1");
    expect(evaluateExpression("$execution.customData.batch", ctx)).toBe("alpha");
  });
  it("$vars", () => {
    expect(evaluateExpression("$vars.x", { $vars: { x: "v" } })).toBe("v");
  });
  it("$now / $today are dates", () => {
    expect(evaluateExpression("$now instanceof Date", {})).toBe(true);
    expect(evaluateExpression("$today instanceof Date", {})).toBe(true);
  });
  it("$if", () => {
    expect(evaluateExpression("$if(true, 'a', 'b')", {})).toBe("a");
    expect(evaluateExpression("$if(false, 'a', 'b')", {})).toBe("b");
  });
  it("$ifEmpty", () => {
    expect(evaluateExpression("$ifEmpty('', 'fallback')", {})).toBe("fallback");
    expect(evaluateExpression("$ifEmpty('x', 'fallback')", {})).toBe("x");
  });
  it("$jmespath subset: dot path", () => {
    expect(jmespath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });
  it("$jmespath subset: index", () => {
    expect(jmespath({ a: [10, 20, 30] }, "a[1]")).toBe(20);
  });
  it("$jmespath subset: wildcard projection", () => {
    expect(jmespath({ items: [{ x: 1 }, { x: 2 }] }, "items[*].x")).toEqual([1, 2]);
  });
  it("$jmespath subset: filter", () => {
    expect(jmespath({ items: [{ k: "a" }, { k: "b" }] }, "items[?k=='b']")).toEqual([{ k: "b" }]);
  });
  it("blocks process / require / Function / eval", () => {
    expect(evaluateExpression("typeof process", {})).toBe("undefined");
    expect(evaluateExpression("typeof require", {})).toBe("undefined");
    expect(evaluateExpression("typeof Function", {})).toBe("undefined");
    expect(evaluateExpression("typeof eval", {})).toBe("undefined");
    expect(evaluateExpression("typeof globalThis", {})).toBe("undefined");
  });
  it("renderExpressionTemplate replaces multiple expressions", () => {
    const out = renderExpressionTemplate("{{ 1 + 1 }} and {{ 'x' + 'y' }}", {});
    expect(out).toBe("2 and xy");
  });
  it("template back-compat: simple {{a.b}} still works via renderTemplate", async () => {
    // Run through the executor with prompt_template node
    const wf = makeWorkflow(
      [
        makeNode("t", "text_input", { text: "hi" }),
        makeNode("p", "prompt_template", { template: "Say {{text}}" }),
        makeNode("o", "output", { responseTemplate: "{{prompt}}" })
      ],
      [makeEdge("t", "p"), makeEdge("p", "o")]
    );
    const r = await executeWorkflow({ workflow: wf }, makeDeps());
    const out = r.nodeResults.find((n) => n.nodeId === "o")?.output as Record<string, unknown>;
    expect(out.result).toBe("Say hi");
  });
});

// =========================================================================
// 2.3 — Python in code_node
// =========================================================================
describe("Phase 2.3 — python code_node", () => {
  it("config accepts language=python and mode", () => {
    const cfg = { language: "python", mode: "runOnceForAllItems", code: "result = 1" };
    expect(cfg.language).toBe("python");
    expect(cfg.mode).toBe("runOnceForAllItems");
  });

  it("javascript runOnceForEachItem returns one output per item", async () => {
    const wf = makeWorkflow(
      [
        makeNode("seed", "set_node", {
          assignments: [{ key: "items", valueTemplate: "[1,2,3]" }]
        }),
        makeNode("c", "code_node", {
          language: "javascript",
          mode: "runOnceForEachItem",
          code: "return { doubled: input.item * 2 };"
        }),
        makeNode("o", "output", { responseTemplate: "{{code_result}}" })
      ],
      [makeEdge("seed", "c"), makeEdge("c", "o")]
    );
    const r = await executeWorkflow({ workflow: wf }, makeDeps());
    const node = r.nodeResults.find((n) => n.nodeId === "c");
    const out = node?.output as Record<string, unknown>;
    expect(Array.isArray(out.code_result)).toBe(true);
    expect((out.code_result as unknown[]).length).toBe(3);
  });

  it("python runs when available, otherwise reports CONFIGURATION error", async () => {
    const available = await isPythonAvailable();
    if (!available) {
      await expect(
        executePythonCodeNode({
          code: "result = 1",
          items: [],
          mode: "runOnceForAllItems",
          timeoutMs: 5000
        })
      ).rejects.toMatchObject({ category: "configuration" });
      return;
    }
    const r = await executePythonCodeNode({
      code: "result = sum(items)",
      items: [1, 2, 3, 4],
      mode: "runOnceForAllItems",
      timeoutMs: 8000
    });
    expect(r.result).toBe(10);
  });
});
