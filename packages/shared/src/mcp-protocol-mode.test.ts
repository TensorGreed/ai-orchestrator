import { describe, expect, it } from "vitest";
import { mcpClientProtocolModeSchema, mcpServerConnectionSchema } from "./schemas";

describe("MCP server connection protocolMode", () => {
  it("accepts the three modes and a connection without one", () => {
    for (const mode of ["auto", "legacy", "modern"]) {
      expect(mcpClientProtocolModeSchema.parse(mode)).toBe(mode);
      expect(mcpServerConnectionSchema.parse({ endpoint: "https://x/mcp", protocolMode: mode })).toEqual({ endpoint: "https://x/mcp", protocolMode: mode });
    }
    expect(mcpServerConnectionSchema.parse({ endpoint: "https://x/mcp", anything: { nested: true } })).toEqual({
      endpoint: "https://x/mcp",
      anything: { nested: true }
    });
  });

  it("rejects an unknown protocolMode with a message on that field", () => {
    const parsed = mcpServerConnectionSchema.safeParse({ endpoint: "https://x/mcp", protocolMode: "2026" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["protocolMode"]);
    expect(mcpServerConnectionSchema.safeParse({ protocolMode: 1 }).success).toBe(false);
  });
});
