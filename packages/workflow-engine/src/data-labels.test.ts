import { describe, expect, it } from "vitest";
import {
  createLabelScanner,
  labelsOf,
  referencesInExpression,
  referencesInPath,
  RunLabelState,
  runInLabelScope,
  unionLabels
} from "./data-labels";
import { renderTemplate } from "./template";

describe("template references", () => {
  it("a plain results path names one node", () => {
    expect(referencesInPath("results.fetch.body")).toEqual({ nodes: ["fetch"], all: false, heads: [] });
    expect(referencesInPath("results")).toEqual({ nodes: [], all: true, heads: [] });
    expect(referencesInPath("user_prompt")).toEqual({ nodes: [], all: false, heads: ["user_prompt"] });
    expect(referencesInPath("parent_outputs.a.text")).toEqual({ nodes: ["a"], all: false, heads: [] });
    expect(referencesInPath("vars.region").heads).toEqual([]);
  });

  it("literal references in expressions are parsed", () => {
    expect(referencesInExpression('results.fetch.body.toUpperCase()').nodes).toEqual(["fetch"]);
    expect(referencesInExpression('results["node-2"].text + results[\'b\'].x').nodes).toEqual(["node-2", "b"]);
    expect(referencesInExpression('$node("Fetch page").output').nodes).toEqual(["Fetch page"]);
    expect(referencesInExpression("$node('a').output").nodes).toEqual(["a"]);
    expect(referencesInExpression("$json.results.fetch.status").nodes).toEqual(["fetch"]);
    expect(referencesInExpression("results?.fetch?.body").nodes).toEqual(["fetch"]);
    const literal = referencesInExpression("results.a.x > 3 ? results.b.y : 'none'");
    expect(literal.nodes).toEqual(["a", "b"]);
    expect(literal.all).toBe(false);
  });

  it("any dynamic access reads everything in context", () => {
    expect(referencesInExpression("results[key].text").all).toBe(true);
    expect(referencesInExpression("results[`${prefix}a`]").all).toBe(true);
    expect(referencesInExpression("$node(name).output").all).toBe(true);
    expect(referencesInExpression("JSON.stringify(results)").all).toBe(true);
    expect(referencesInExpression("Object.keys($json).length").all).toBe(true);
    expect(referencesInExpression("$input[field]").all).toBe(true);
    expect(referencesInExpression("$json.results[k]").all).toBe(true);
  });

  it("property names and string contents are not reads", () => {
    const refs = referencesInExpression("item.results.length > 0 && 'results' !== status");
    expect(refs.nodes).toEqual([]);
    expect(refs.all).toBe(false);
    expect(refs.heads).toContain("item");
    expect(refs.heads).toContain("status");
    expect(refs.heads).not.toContain("length");
    expect(referencesInExpression("{ user_prompt: 1 }.user_prompt").heads).not.toContain("user_prompt");
  });

  it("bare names and $json fields are heads", () => {
    expect(referencesInExpression("user_prompt.length > 3").heads).toEqual(["user_prompt"]);
    expect(referencesInExpression("$json.webhook.body").heads).toEqual(["webhook"]);
    expect(referencesInExpression("Math.max(a, 2)").heads).toEqual(["a"]);
  });
});

describe("run label state", () => {
  const external = labelsOf(["untrusted_external"]);
  const user = labelsOf(["user"]);

  it("input nodes carry the run input, fetching nodes add untrusted_external, others only inherit", () => {
    const run = new RunLabelState({ input: user, tracked: false });
    const none = labelsOf([]);
    expect(run.scope({ nodeId: "t", nodeType: "webhook_input", parents: [] }).finish({})).toEqual(user);
    expect(run.scope({ nodeId: "h", nodeType: "http_request", parents: [user] }).finish({})).toEqual(labelsOf(["user", "untrusted_external"]));
    expect(run.scope({ nodeId: "s", nodeType: "set_node", parents: [none] }).finish({})).toEqual(labelsOf([]));
    expect(run.scope({ nodeId: "m", nodeType: "mcp_tool", parents: [none] }).finish({})).toEqual(external);
  });

  it("a root node (no parent ran) reads the run input: handlers read the run's globals directly", () => {
    const run = new RunLabelState({ input: external, tracked: false });
    expect(run.scope({ nodeId: "llm", nodeType: "llm_call", parents: [] }).finish({})).toEqual(external);
    expect(run.scope({ nodeId: "m", nodeType: "mcp_tool", parents: [] }).finish({})).toEqual(external);
  });

  it("records template reads of the node that is running", () => {
    const run = new RunLabelState({ input: user, tracked: false });
    run.set("fetch", external);
    run.set("other", labelsOf(["sensitive"]));
    const scope = run.scope({ nodeId: "n", nodeType: "set_node", parents: [labelsOf([])], merged: { title: "x" }, globals: { user_prompt: "hi", vars: {} } });
    runInLabelScope(scope, () => {
      renderTemplate("{{results.fetch.body}} {{title}} {{vars.region}}", { results: { fetch: { body: "b" } }, title: "x", vars: {} });
    });
    expect(scope.inputLabels()).toEqual(external);
    runInLabelScope(scope, () => renderTemplate("{{user_prompt}}", { user_prompt: "hi" }));
    expect(scope.inputLabels()).toEqual(labelsOf(["user", "untrusted_external"]));
    // Reads outside a scope are not recorded anywhere.
    renderTemplate("{{results.other.x}}", { results: { other: { x: 1 } } });
    expect(scope.inputLabels().provenance).not.toContain("sensitive");
  });

  it("a read of a node that has not run adds nothing", () => {
    const run = new RunLabelState({ input: user, tracked: false });
    const scope = run.scope({ nodeId: "n", nodeType: "set_node", parents: [labelsOf([])] });
    scope.readPath("results.later.x");
    expect(scope.inputLabels()).toEqual(labelsOf([]));
  });

  it("dynamic reads take every node in context and the input", () => {
    const run = new RunLabelState({ input: user, tracked: false });
    run.set("a", external);
    run.set("b", labelsOf([], ["email"]));
    const scope = run.scope({ nodeId: "c", nodeType: "code_node", parents: [] });
    scope.readExpression("results[name]");
    expect(scope.inputLabels()).toEqual(labelsOf(["user", "untrusted_external"], ["email"]));
  });

  it("declassifying removes data classes, never provenance", () => {
    const run = new RunLabelState({ input: user, tracked: false });
    const scope = run.scope({ nodeId: "g", nodeType: "guard", parents: [labelsOf(["untrusted_external"], ["email", "card_number"])] });
    scope.declassify(["email", "untrusted_external"]);
    expect(scope.finish({})).toEqual(labelsOf(["untrusted_external"], ["card_number"]));
  });

  it("scans outputs for data classes only when tracked", () => {
    const scan = createLabelScanner([]);
    const untracked = new RunLabelState({ input: user, tracked: false, scan });
    expect(untracked.scope({ nodeId: "a", nodeType: "set_node", parents: [] }).finish({ text: "mail jane@example.com" }).dataClasses).toEqual([]);
    const tracked = new RunLabelState({ input: user, tracked: true, scan });
    expect(tracked.scope({ nodeId: "a", nodeType: "set_node", parents: [] }).finish({ text: "mail jane@example.com", _trace: "4111 1111 1111 1111" }).dataClasses).toEqual(["email"]);
  });

  it("the scanner uses profile dictionaries", () => {
    const scan = createLabelScanner([{ dataClass: "project_codename", terms: ["bluebird"], patterns: [], score: 0.9 }]);
    expect(scan({ notes: ["Ship Bluebird on Friday"] })).toEqual(["project_codename"]);
    expect(scan({ n: 4111111111111111 })).toEqual(["card_number"]);
  });

  it("round-trips through the paused state, keeping only non-empty labels", () => {
    const run = new RunLabelState({ input: user, tracked: true });
    run.set("a", external);
    run.set("b", labelsOf([]));
    run.outputNodeId = "a";
    const state = run.toState();
    expect(state.nodes).toEqual({ a: external });
    const restored = RunLabelState.fromState(state)!;
    expect(restored.tracked).toBe(true);
    expect(restored.get("a")).toEqual(external);
    expect(restored.outputNodeId).toBe("a");
    expect(restored.resultField("a")).toEqual({ labels: external });
    expect(new RunLabelState({ input: user, tracked: false }).resultField("a")).toEqual({});
  });

  it("unions sort and de-duplicate", () => {
    expect(unionLabels([labelsOf(["user"], ["email"]), labelsOf(["trusted", "user"], ["card_number"]), undefined])).toEqual(
      labelsOf(["trusted", "user"], ["card_number", "email"])
    );
    expect(unionLabels([])).toEqual(labelsOf([]));
  });
});

describe("round 1 fixes: expressions that escape the parser, segments", () => {
  it("names that reach the whole scope, template strings with ${ } and escape keys read everything", () => {
    for (const expression of [
      "arguments[0].results.fetch.body",
      "__scope.results.fetch",
      "this.results",
      "globalThis.x",
      "(0).constructor.constructor('return 1')()",
      "x['constructor']",
      "`${results.fetch.body}`"
    ]) {
      expect(referencesInExpression(expression).all, expression).toBe(true);
    }
    // Plain template strings and ordinary property names stay precise.
    expect(referencesInExpression("`hello` + results.fetch.body").all).toBe(false);
    expect(referencesInExpression("results.fetch.body.length").nodes).toEqual(["fetch"]);
  });

  it("segments keep a part's reads apart; the node's input still counts them", async () => {
    const run = new RunLabelState({ input: labelsOf(["user"]), tracked: false });
    run.set("crm", labelsOf(["trusted"], ["email"]));
    run.set("page", labelsOf(["untrusted_external"], ["iban"]));
    const scope = run.scope({ nodeId: "agent", nodeType: "agent_orchestrator", parents: [labelsOf([])] });
    scope.readPath("results.crm.email");
    scope.segment("user_prompt", () => scope.readPath("results.page.text"));
    expect(scope.segmentLabels("user_prompt")).toEqual(labelsOf(["untrusted_external"], ["iban"]));
    expect(scope.inputLabelsExcept(["user_prompt"])).toEqual(labelsOf(["trusted"], ["email"]));
    expect(scope.inputLabels()).toEqual(labelsOf(["trusted", "untrusted_external"], ["email", "iban"]));
    // An async segment collects every read until it settles.
    await scope.segmentAsync("agent_run", async () => {
      await Promise.resolve();
      scope.readEverything();
    });
    expect(scope.segmentLabels("agent_run")).toEqual(labelsOf(["trusted", "user", "untrusted_external"], ["email", "iban"]));
    expect(scope.segmentLabels("missing")).toEqual(labelsOf([]));
  });

  it("a paused run's labels keep tracking when the resumed run tracks now", () => {
    const state = new RunLabelState({ input: labelsOf(["user"]), tracked: false }).toState();
    expect(RunLabelState.fromState(state)!.tracked).toBe(false);
    expect(RunLabelState.fromState(state, undefined, true)!.tracked).toBe(true);
  });
});
