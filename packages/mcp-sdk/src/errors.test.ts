import { describe, expect, it } from "vitest";
import {
  McpJsonRpcError,
  McpMissingClientCapabilityError,
  McpOutcomeUnknownError,
  classifyMcpError,
  isServerFailureKind
} from "./errors";

describe("MCP 2026-07-28 error kinds", () => {
  it("reports a call whose outcome is unknown as outcome_unknown, which counts against the server", () => {
    const kind = classifyMcpError(new McpOutcomeUnknownError("sent, no answer"));
    expect(kind).toBe("outcome_unknown");
    expect(isServerFailureKind(kind)).toBe(true);
  });

  it("reports a missing client capability as a tool-level problem, and keeps the error data", () => {
    const error = new McpMissingClientCapabilityError("needs sampling", -32021, { requiredCapabilities: { sampling: {} } });
    expect(classifyMcpError(error)).toBe("tool");
    expect(isServerFailureKind("tool")).toBe(false);
    expect(error.data).toEqual({ requiredCapabilities: { sampling: {} } });
    // A plain -32021 JSON-RPC error (an initialize-based server's own code) keeps its earlier classification.
    expect(classifyMcpError(new McpJsonRpcError("whatever", -32021))).toBe("protocol");
  });
});
