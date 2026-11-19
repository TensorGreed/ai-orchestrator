import { describe, expect, it } from "vitest";
import {
  applyTemplateSuggestion,
  buildTemplateSuggestions,
  joinTemplatePath,
  rankTemplateSuggestions,
  templateForPath,
  templateTokenAt
} from "./template-suggest";

const sources = {
  nodeId: "post_order",
  parents: [{ id: "fetch_items", label: "Fetch items", output: { status: 200, body: { items: [{ title: "First", price: 30 }] }, _telemetry: {} } }],
  steps: [
    { id: "webhook_input", label: "Webhook", output: { body: { customer: "Ada" } } },
    { id: "fetch_items", label: "Fetch items", output: { status: 200, body: { items: [{ title: "First", price: 30 }] } } },
    { id: "post_order", label: "Post order", output: { ok: true } },
    { id: "later_1", label: "Later", output: undefined }
  ],
  input: {
    parent_outputs: { fetch_items: {} },
    fetch_items: {},
    status: 200,
    webhook: { customer: "Ada" },
    vars: { region: "eu" },
    "has space": 1
  },
  vars: { region: "eu" },
  isInternalKey: (key: string) => key === "_telemetry"
};

describe("template suggestions from the last run", () => {
  const all = buildTemplateSuggestions(sources);
  const paths = all.map((entry) => entry.path);

  it("offers the connected step's fields first, with nested paths and list entries by index", () => {
    expect(paths.slice(0, 6)).toEqual(["status", "body", "body.items", "body.items.0", "body.items.0.title", "body.items.0.price"]);
    expect(all[0]).toEqual({ path: "status", source: "Fetch items", detail: "200" });
    expect(all.find((entry) => entry.path === "body.items")?.detail).toBe("1 item");
    expect(all.find((entry) => entry.path === "body.items.0.title")?.detail).toBe('"First"');
  });

  it("leaves out runtime keys, parent copies and keys a path cannot read", () => {
    expect(paths).not.toContain("_telemetry");
    expect(paths).not.toContain("parent_outputs");
    expect(paths).not.toContain("fetch_items");
    expect(paths.some((path) => path.includes("has space"))).toBe(false);
  });

  it("offers the run input, variables, $json, and every other step under results with its label", () => {
    expect(paths).toContain("webhook.customer");
    expect(all.find((entry) => entry.path === "webhook.customer")?.source).toBe("Run input");
    expect(paths).toContain("vars.region");
    expect(paths).toContain("$json");
    expect(all.find((entry) => entry.path === "results.webhook_input.body.customer")?.source).toBe("Webhook");
    expect(paths).not.toContain("results.post_order");
    expect(all.find((entry) => entry.path === "results.later_1")?.detail).toBe("no run data yet");
  });

  it("has no duplicates", () => {
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("works without a run: steps and variables only", () => {
    const bare = buildTemplateSuggestions({ nodeId: "a", parents: [{ id: "b", label: "B" }], steps: [{ id: "b", label: "B" }], vars: { k: 1 } });
    expect(bare.map((entry) => entry.path)).toEqual(["vars.k", "$json", "results.b"]);
  });
});

describe("ranking what was typed", () => {
  const all = buildTemplateSuggestions(sources);
  it("puts paths that start with the text first, then segment matches, then contains, then the step label", () => {
    const ranked = rankTemplateSuggestions(all, "ti").map((entry) => entry.path);
    expect(ranked[0]).toBe("body.items.0.title");
    expect(rankTemplateSuggestions(all, "results.fetch").map((entry) => entry.path)[0]).toBe("results.fetch_items");
    expect(rankTemplateSuggestions(all, "webhook").some((entry) => entry.path === "results.webhook_input")).toBe(true);
    expect(rankTemplateSuggestions(all, "Later").map((entry) => entry.path)).toEqual(["results.later_1"]);
  });

  it("shows the shortest paths first with nothing typed, and leaves out the exact text typed", () => {
    const ranked = rankTemplateSuggestions(all, "");
    expect(ranked[0]!.path.split(".")).toHaveLength(1);
    expect(rankTemplateSuggestions(all, "status").map((entry) => entry.path)).not.toContain("status");
  });

  it("offers the input fields under $json.", () => {
    const ranked = rankTemplateSuggestions(all, "$json.bo").map((entry) => entry.path);
    expect(ranked[0]).toBe("$json.body");
    expect(ranked.every((path) => path.startsWith("$json."))).toBe(true);
  });
});

describe("the token at the caret", () => {
  it("is the path typed inside an open {{", () => {
    expect(templateTokenAt("Hi {{", 5)).toEqual({ from: 5, to: 5, query: "" });
    expect(templateTokenAt("Hi {{ body.it", 13)).toEqual({ from: 6, to: 13, query: "body.it" });
    expect(templateTokenAt("{{ a > 1 && results.fe }}", 22)).toEqual({ from: 12, to: 22, query: "results.fe" });
  });

  it("covers the whole word when the caret is inside it", () => {
    expect(templateTokenAt("{{body.items}}", 6)).toEqual({ from: 2, to: 12, query: "body" });
  });

  it("is null outside {{ }}", () => {
    expect(templateTokenAt("plain text", 5)).toBeNull();
    expect(templateTokenAt("{{a}} then", 9)).toBeNull();
  });
});

describe("applying a suggestion", () => {
  it("replaces the token and closes the braces when nothing closes them", () => {
    const text = "Hi {{ bo";
    expect(applyTemplateSuggestion(text, templateTokenAt(text, 8)!, "body.items")).toEqual({ text: "Hi {{ body.items }}", caret: 19 });
    const tight = "Hi {{bo";
    expect(applyTemplateSuggestion(tight, templateTokenAt(tight, 7)!, "body")).toEqual({ text: "Hi {{body}}", caret: 11 });
  });

  it("keeps an existing closing", () => {
    const text = "{{bo}} and {{x}}";
    expect(applyTemplateSuggestion(text, templateTokenAt(text, 4)!, "body.items")).toEqual({ text: "{{body.items}} and {{x}}", caret: 12 });
  });

  it("closes when the next }} belongs to a later {{", () => {
    const text = "{{bo and {{x}}";
    expect(applyTemplateSuggestion(text, templateTokenAt(text, 4)!, "body").text).toBe("{{body}} and {{x}}");
  });
});

describe("dragged fields", () => {
  it("insert {{path}}, and only keys a path can read", () => {
    expect(templateForPath("body.items.0.title")).toBe("{{body.items.0.title}}");
    expect(joinTemplatePath("", "status")).toBe("status");
    expect(joinTemplatePath("results.fetch_items", "body")).toBe("results.fetch_items.body");
    expect(joinTemplatePath("items", 0)).toBe("items.0");
    expect(joinTemplatePath("", "has space")).toBeUndefined();
  });
});
