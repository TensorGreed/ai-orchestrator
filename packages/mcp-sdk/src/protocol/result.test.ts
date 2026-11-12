import { describe, expect, it } from "vitest";
import { McpInvalidResultError, classifyMcpResult } from "./result";

describe("classifyMcpResult", () => {
  it("treats an absent resultType (legacy servers) as complete", () => {
    const legacy = { content: [{ type: "text", text: "hi" }] };
    expect(classifyMcpResult("tools/call", legacy)).toEqual({ resultType: "complete", result: legacy });
    expect(classifyMcpResult("tools/list", { tools: [] })).toEqual({ resultType: "complete", result: { tools: [] } });
  });

  it("accepts complete from modern servers on any method", () => {
    const modern = { resultType: "complete", tools: [], ttlMs: 60000, cacheScope: "private" };
    expect(classifyMcpResult("tools/list", modern)).toEqual({ resultType: "complete", result: modern });
  });

  it("rejects unknown and non-string resultType values", () => {
    expect(() => classifyMcpResult("tools/call", { resultType: "task", task: {} })).toThrow(/resultType 'task'/);
    expect(() => classifyMcpResult("tools/call", { resultType: "Complete" })).toThrow(McpInvalidResultError);
    expect(() => classifyMcpResult("tools/call", { resultType: null })).toThrow(/of type object/);
    expect(() => classifyMcpResult("tools/call", { resultType: 1 })).toThrow(/of type number/);
    expect(() => classifyMcpResult("tools/call", "text")).toThrow(/not an object/);
  });

  it("parses input_required with requests and state", () => {
    const classified = classifyMcpResult("tools/call", {
      resultType: "input_required",
      inputRequests: {
        login: { method: "elicitation/create", params: { message: "Who?", requestedSchema: { type: "object", properties: {} } } },
        ask: { method: "sampling/createMessage" }
      },
      requestState: "opaque"
    });
    expect(classified).toEqual({
      resultType: "input_required",
      inputRequired: {
        inputRequests: {
          login: { method: "elicitation/create", params: { message: "Who?", requestedSchema: { type: "object", properties: {} } } },
          ask: { method: "sampling/createMessage" }
        },
        requestState: "opaque"
      }
    });
    expect(classifyMcpResult("resources/read", { resultType: "input_required", requestState: "" })).toEqual({
      resultType: "input_required",
      inputRequired: { inputRequests: {}, requestState: "" }
    });
  });

  it("rejects malformed input_required results", () => {
    expect(() => classifyMcpResult("tools/call", { resultType: "input_required" })).toThrow(/neither inputRequests nor requestState/);
    expect(() => classifyMcpResult("tools/call", { resultType: "input_required", inputRequests: {} })).toThrow(/neither/);
    expect(() => classifyMcpResult("tools/call", { resultType: "input_required", inputRequests: [] })).toThrow(/not an object/);
    expect(() => classifyMcpResult("tools/call", { resultType: "input_required", inputRequests: { a: { params: {} } } })).toThrow(/without a method/);
    expect(() => classifyMcpResult("tools/call", { resultType: "input_required", inputRequests: { a: { method: "x", params: [] } } })).toThrow(/params/);
    expect(() => classifyMcpResult("tools/call", { resultType: "input_required", requestState: 5 })).toThrow(/requestState/);
  });

  it("allows input_required only on tools/call, resources/read and prompts/get", () => {
    for (const method of ["tools/call", "resources/read", "prompts/get"]) {
      expect(classifyMcpResult(method, { resultType: "input_required", requestState: "s" }).resultType).toBe("input_required");
    }
    for (const method of ["tools/list", "server/discover", "resources/list"]) {
      expect(() => classifyMcpResult(method, { resultType: "input_required", requestState: "s" })).toThrow(/only tools\/call/);
    }
  });
});
