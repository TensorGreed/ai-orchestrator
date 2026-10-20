import type { ImportReport } from "@ai-orchestrator/shared";
import {
  buildImportChecklist,
  detectImportFormat,
  forgetImportReport,
  inspectImportText,
  recallImportReport,
  referencesSecret,
  rememberImportReport,
  replaceSecretRefs,
  summarizeReport,
  type ImportChecklistNode
} from "./external-import";

function makeReport(): ImportReport {
  return {
    sourceName: "Feedback intake",
    nodes: [
      { sourceName: "Hook", sourceType: "acme.webhook", targetNodeId: "hook", targetType: "webhook_input", status: "mapped", reason: "Mapped directly." },
      { sourceName: "Ask", sourceType: "acme.http", targetNodeId: "ask", targetType: "http_request", status: "approximated", reason: "Pagination dropped." },
      { sourceName: "Chat", sourceType: "acme.chatApp", targetNodeId: "chat", targetType: "noop_node", status: "unsupported", reason: "No equivalent." }
    ],
    unresolvedExpressions: [
      { nodeId: "ask", sourceName: "Ask", path: "urlTemplate", expression: "$items('Hook')[0]", reason: "Unknown helper." }
    ],
    secretsToResolve: [
      { secretId: "import-httpheaderauth-crm", credentialType: "httpHeaderAuth", credentialName: "CRM", nodeIds: ["ask"] }
    ],
    variablesToSet: ["API_BASE"],
    warnings: [],
    summary: { total: 3, mapped: 1, approximated: 1, unsupported: 1 }
  };
}

function makeNodes(): ImportChecklistNode[] {
  return [
    { id: "hook", type: "webhook_input", label: "Hook", config: {} },
    {
      id: "ask",
      type: "http_request",
      label: "Ask",
      config: { urlTemplate: "{{ $items('Hook')[0] }}", auth: { secretRef: { secretId: "import-httpheaderauth-crm" } } }
    },
    { id: "chat", type: "noop_node", label: "Chat", config: { original: {} } }
  ];
}

describe("detectImportFormat", () => {
  it("recognises native exports, bare or wrapped", () => {
    expect(detectImportFormat({ nodes: [], edges: [] })).toBe("native");
    expect(detectImportFormat({ schemaVersion: "1.0.0", workflow: { nodes: [], edges: [] } })).toBe("native");
  });

  it("recognises exports that use a connections map", () => {
    expect(detectImportFormat({ name: "x", nodes: [{ type: "a" }], connections: {} })).toBe("external");
    expect(detectImportFormat({ nodes: [] })).toBe("external");
  });

  it("rejects anything else", () => {
    expect(detectImportFormat(null)).toBe("unknown");
    expect(detectImportFormat([])).toBe("unknown");
    expect(detectImportFormat({ hello: 1 })).toBe("unknown");
  });

  it("reports parse errors from text", () => {
    expect(inspectImportText('{"nodes":[],"connections":{}}')).toEqual({ format: "external" });
    const broken = inspectImportText("{nope");
    expect(broken.format).toBe("unknown");
    expect(broken.error).toBeTruthy();
  });
});

describe("secret references", () => {
  it("finds nested references", () => {
    expect(referencesSecret({ a: [{ b: { secretId: "s1" } }] }, "s1")).toBe(true);
    expect(referencesSecret({ a: [{ b: { secretId: "s2" } }] }, "s1")).toBe(false);
  });

  it("rewrites every matching reference without mutating the input", () => {
    const input = { secretRef: { secretId: "old" }, list: [{ secretRef: { secretId: "old" } }, { secretId: "keep" }] };
    const output = replaceSecretRefs(input, "old", "new");
    expect(output).toEqual({ secretRef: { secretId: "new" }, list: [{ secretRef: { secretId: "new" } }, { secretId: "keep" }] });
    expect(input.secretRef.secretId).toBe("old");
    expect(output.list[1]).toBe(input.list[1]);
  });

  it("returns the same object when nothing matches", () => {
    const input = { secretRef: { secretId: "a" } };
    expect(replaceSecretRefs(input, "zzz", "b")).toBe(input);
  });
});

describe("buildImportChecklist", () => {
  it("lists every open item for a fresh import", () => {
    const checklist = buildImportChecklist(makeReport(), { nodes: makeNodes(), variables: { API_BASE: "" } });
    expect(checklist.items.map((item) => item.kind)).toEqual(["secret", "variable", "expression", "unsupported"]);
    expect(checklist.resolved).toBe(0);
    expect(checklist.total).toBe(4);
    expect(checklist.review.map((entry) => entry.targetNodeId)).toEqual(["ask"]);
    expect(checklist.items[0]).toMatchObject({ secretId: "import-httpheaderauth-crm", nodeIds: ["ask"], code: "httpHeaderAuth" });
  });

  it("ticks items off as the workflow is fixed", () => {
    const nodes = makeNodes();
    nodes[1] = {
      ...nodes[1],
      config: replaceSecretRefs({ ...nodes[1].config, urlTemplate: "{{results.hook.url}}" }, "import-httpheaderauth-crm", "sec_real")
    };
    nodes[2] = { ...nodes[2], type: "http_request" };
    const checklist = buildImportChecklist(makeReport(), { nodes, variables: { API_BASE: "https://crm.example" } });
    expect(checklist.resolved).toBe(4);
    expect(checklist.items.every((item) => item.resolved)).toBe(true);
  });

  it("treats deleted nodes as resolved and drops them from review", () => {
    const checklist = buildImportChecklist(makeReport(), { nodes: [makeNodes()[0]], variables: {} });
    const expression = checklist.items.find((item) => item.kind === "expression");
    const unsupported = checklist.items.find((item) => item.kind === "unsupported");
    expect(expression?.resolved).toBe(true);
    expect(unsupported?.resolved).toBe(true);
    expect(checklist.review).toEqual([]);
  });
});

describe("summarizeReport", () => {
  it("skips empty buckets", () => {
    expect(summarizeReport(makeReport())).toBe("1 mapped · 1 approximated · 1 placeholder");
    const allMapped = { ...makeReport(), summary: { total: 2, mapped: 2, approximated: 0, unsupported: 0 } };
    expect(summarizeReport(allMapped)).toBe("2 mapped");
  });
});

describe("report persistence", () => {
  it("round-trips through local storage and can be forgotten", () => {
    const report = makeReport();
    rememberImportReport("wf-1", report);
    expect(recallImportReport("wf-1")).toEqual(report);
    forgetImportReport("wf-1");
    expect(recallImportReport("wf-1")).toBeNull();
  });

  it("ignores corrupt entries", () => {
    window.localStorage.setItem("l2m.importReport.wf-2", "{not json");
    expect(recallImportReport("wf-2")).toBeNull();
  });
});
