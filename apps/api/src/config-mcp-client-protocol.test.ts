/**
 * MCP 2026-07-28 — the HTTP client's protocol settings: optional, defaults keep earlier behaviour (apart from the
 * safe re-issue rule, on by default), bad values fail fast.
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("MCP client protocol settings", () => {
  it("defaults to legacy, five input rounds and the safe re-issue rule", () => {
    const config = parseConfig({});
    expect(config.MCP_CLIENT_PROTOCOL_DEFAULT).toBe("legacy");
    expect(config.MCP_CLIENT_MRTR_MAX_ROUNDS).toBe(5);
    expect(config.MCP_CLIENT_LEGACY_SAFE_REISSUE).toBe(true);
  });

  it("reads the mode in any case, the round limit and the re-issue flag", () => {
    const config = parseConfig({ MCP_CLIENT_PROTOCOL_DEFAULT: " Auto ", MCP_CLIENT_MRTR_MAX_ROUNDS: "8", MCP_CLIENT_LEGACY_SAFE_REISSUE: "false" });
    expect(config.MCP_CLIENT_PROTOCOL_DEFAULT).toBe("auto");
    expect(config.MCP_CLIENT_MRTR_MAX_ROUNDS).toBe(8);
    expect(config.MCP_CLIENT_LEGACY_SAFE_REISSUE).toBe(false);
    expect(parseConfig({ MCP_CLIENT_PROTOCOL_DEFAULT: "" }).MCP_CLIENT_PROTOCOL_DEFAULT).toBe("legacy");
  });

  it("rejects unknown modes and out-of-range round limits", () => {
    expect(() => parseConfig({ MCP_CLIENT_PROTOCOL_DEFAULT: "stateless" })).toThrow();
    expect(() => parseConfig({ MCP_CLIENT_MRTR_MAX_ROUNDS: "0" })).toThrow();
    expect(() => parseConfig({ MCP_CLIENT_MRTR_MAX_ROUNDS: "21" })).toThrow();
  });
});
