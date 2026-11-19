import { describe, expect, it } from "vitest";
import { getNodeDefinition } from "./definitions";
import { NODE_OUTPUT_SPECS, nodeOutputAliases, nodeOutputFieldNames } from "./node-outputs";

describe("node output lists", () => {
  it("are on the node definitions, with answer as the LLM Call's field and text as its alias", () => {
    const llm = getNodeDefinition("llm_call")!;
    expect(llm.outputs?.fields.map((field) => field.name)).toEqual(["answer", "toolCalls", "raw"]);
    expect(llm.outputs?.aliases).toEqual({ text: "answer" });
    expect(nodeOutputAliases("llm_call")).toEqual({ text: "answer" });
    expect(nodeOutputAliases("http_request")).toEqual({});
  });

  it("name every field a closed node outputs, with the fields its settings name", () => {
    expect([...nodeOutputFieldNames("llm_call", {})!]).toEqual(["answer", "toolCalls", "raw", "text"]);
    expect(nodeOutputFieldNames("prompt_template", { outputKey: "question" })).toEqual(new Set(["prompt", "question"]));
    expect(nodeOutputFieldNames("set_node", { assignments: [{ key: "a" }, { key: " b " }, {}] })).toEqual(new Set(["a", "b"]));
    expect(nodeOutputFieldNames("output", {})).toEqual(new Set(["result"]));
  });

  it("are null for open nodes and nodes they do not describe", () => {
    expect(nodeOutputFieldNames("webhook_input", {})).toBeNull();
    expect(nodeOutputFieldNames("if_node", {})).toBeNull();
    expect(nodeOutputFieldNames("slack_send_message", {})).toBeNull();
  });

  it("only describe node types that exist", () => {
    for (const type of Object.keys(NODE_OUTPUT_SPECS)) expect(getNodeDefinition(type), type).toBeTruthy();
  });
});
