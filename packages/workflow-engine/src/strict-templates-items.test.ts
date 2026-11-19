import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { renderTemplateValue, runWithStrictTemplates, TEMPLATE_VALUE_MISSING_CODE } from "./template";

// Typed Set values and per-item Filter conditions under strict templates, and the `missing` they report.

const position = { x: 0, y: 0 };
const dependencies = () => ({
  providerRegistry: createDefaultProviderRegistry(),
  connectorRegistry: createDefaultConnectorRegistry(),
  mcpRegistry: createDefaultMCPRegistry(),
  agentRuntime: createDefaultAgentRuntime(),
  resolveSecret: async () => undefined
});

function typedSet(assignments: Array<Record<string, unknown>>, strict: boolean): Workflow {
  return {
    id: "wf-typed-strict",
    name: "Typed Set",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    ...(strict ? { settings: { strictTemplates: true } } : {}),
    nodes: [
      { id: "start", type: "set_node", name: "Start", position, config: { assignments: [{ key: "price", valueTemplate: "{{ 10 * 3 }}", type: "auto" }, { key: "none", valueTemplate: "{{ [null][0] }}", type: "auto" }] } },
      { id: "set", type: "set_node", name: "Set", position, config: { assignments } }
    ],
    edges: [{ id: "e1", source: "start", target: "set" }]
  };
}

function itemsFilter(valueTemplate: string, strict: boolean): Workflow {
  return {
    id: "wf-filter-strict",
    name: "Filter",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    ...(strict ? { settings: { strictTemplates: true } } : {}),
    nodes: [
      {
        id: "start",
        type: "set_node",
        name: "Start",
        position,
        config: { assignments: [{ key: "products", valueTemplate: '{{ [{"name":"a","price":10,"min":5},{"name":"b","price":40}] }}', type: "auto" }] }
      },
      {
        id: "filter",
        type: "filter_node",
        name: "Filter",
        position,
        config: { mode: "items", itemsFrom: "products", conditions: [{ field: "price", operator: "gt", value: valueTemplate }] }
      }
    ],
    edges: [{ id: "e1", source: "start", target: "filter" }]
  };
}

describe("renderTemplateValue reports missing values like renderTemplateAdvanced", () => {
  it("lists a missing path, a failed expression and nothing for null", () => {
    expect(renderTemplateValue("{{a.b}}", { a: {} })).toEqual({ single: true, value: undefined, missing: [{ body: "a.b", reason: "missing" }] });
    expect(renderTemplateValue("{{ x.y.z }}", {}).missing).toEqual([{ body: "x.y.z", reason: "missing" }]);
    expect(renderTemplateValue("{{ n }}", { n: null })).toEqual({ single: true, value: undefined, missing: [] });
    expect(renderTemplateValue("<{{a}}>", {})).toEqual({ single: false, rendered: "<>", missing: [{ body: "a", reason: "missing" }] });
  });

  it("throws template_value_missing under strict templates, but not for null", () => {
    expect(() => runWithStrictTemplates(true, () => renderTemplateValue("{{a.b}}", { a: {} }))).toThrow(/strict templates/);
    expect(runWithStrictTemplates(true, () => renderTemplateValue("{{n}}", { n: null })).missing).toEqual([]);
    expect(runWithStrictTemplates(true, () => renderTemplateValue("{{ 1 + 1 }}", {}))).toMatchObject({ single: true, value: 2 });
  });
});

describe("typed Set fields under strict templates", () => {
  for (const type of ["auto", "number", "boolean", "json", "string"]) {
    it(`a ${type} field with a missing value fails the node with template_value_missing`, async () => {
      const result = await executeWorkflow({ workflow: typedSet([{ key: "x", valueTemplate: "{{ nope }}", type }], true) }, dependencies());
      const set = result.nodeResults.find((node) => node.nodeId === "set");
      expect(set?.status).toBe("error");
      expect(set?.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);
      expect(set?.error).toContain("{{nope}}");
    });
  }

  it("keeps types and null values when strict is on and every value is there", async () => {
    const result = await executeWorkflow(
      { workflow: typedSet([{ key: "p", valueTemplate: "{{price}}", type: "auto" }, { key: "n", valueTemplate: "{{none}}", type: "auto" }], true) },
      dependencies()
    );
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((node) => node.nodeId === "set")?.output).toEqual({ p: 30, n: null });
  });

  it("without strict, a missing typed value is null as before", async () => {
    const result = await executeWorkflow({ workflow: typedSet([{ key: "x", valueTemplate: "{{ nope }}", type: "auto" }], false) }, dependencies());
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((node) => node.nodeId === "set")?.output).toEqual({ x: null });
  });
});

describe("per-item Filter conditions under strict templates", () => {
  it("a condition value that reads an item field every item has works", async () => {
    const result = await executeWorkflow({ workflow: itemsFilter("{{ 10 * 2 }}", true) }, dependencies());
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((node) => node.nodeId === "filter")?.output).toMatchObject({ count: 1, rejected_count: 1 });
  });

  it("a condition value with no value for an item fails the Filter under strict, and compares to empty without it", async () => {
    const strict = await executeWorkflow({ workflow: itemsFilter("{{item.min}}", true) }, dependencies());
    const failed = strict.nodeResults.find((node) => node.nodeId === "filter");
    expect(failed?.status).toBe("error");
    expect(failed?.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);
    expect(failed?.error).toContain("{{item.min}}");

    const lenient = await executeWorkflow({ workflow: itemsFilter("{{item.min}}", false) }, dependencies());
    expect(lenient.status).toBe("success");
    // "b" has no min: Number("") is 0, so 40 > 0 keeps it, as before strict templates existed.
    expect(lenient.nodeResults.find((node) => node.nodeId === "filter")?.output).toMatchObject({ count: 2 });
  });

  it("an is_empty condition ignores a leftover template in its unused value under strict", async () => {
    const workflow = itemsFilter("{{ 10 * 2 }}", true);
    (workflow.nodes[1]!.config as { conditions: unknown[] }).conditions = [{ field: "min", operator: "is_empty", value: "{{ nope }}" }];
    const result = await executeWorkflow({ workflow }, dependencies());
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((node) => node.nodeId === "filter")?.output).toMatchObject({ count: 1 });
  });

  it("a condition field that an item lacks is not a template and never fails under strict", async () => {
    const workflow = itemsFilter("{{ 10 * 2 }}", true);
    (workflow.nodes[1]!.config as { conditions: unknown[] }).conditions = [{ field: "min", operator: "is_empty", value: "" }];
    const result = await executeWorkflow({ workflow }, dependencies());
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((node) => node.nodeId === "filter")?.output).toMatchObject({ count: 1 });
  });
});
