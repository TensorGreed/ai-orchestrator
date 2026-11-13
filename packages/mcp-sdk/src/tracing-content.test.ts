import { describe, expect, it } from "vitest";
import {
  NOOP_RUN_INSTRUMENTATION,
  type InstrumentationContentKind,
  type InstrumentationSpan,
  type MCPServerConfig,
  type MCPToolResult,
  type McpRequestSpanInfo,
  type RunInstrumentation
} from "@ai-orchestrator/shared";
import { instrumentMcpAdapter } from "./tracing";
import type { MCPServerAdapter } from "./types";

/** Tool arguments and results handed to the `tools/call` CLIENT span when it captures content (and only then). */

function fake(captures: boolean) {
  const handed: Array<{ method: string; kind: InstrumentationContentKind; value: unknown }> = [];
  const instrument: RunInstrumentation = {
    ...NOOP_RUN_INSTRUMENTATION,
    enabled: true,
    capturesContent: captures,
    async mcpRequest<T>(info: McpRequestSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
      return await fn({
        recording: true,
        traceId: "t",
        spanId: "s",
        setAttributes: () => undefined,
        recordError: () => undefined,
        keepOpen: () => undefined,
        end: () => undefined,
        capturesContent: captures,
        addContent: (kind, value) => {
          if (!captures) throw new Error("content handed over while capture is off");
          handed.push({ method: info.method, kind, value });
        }
      });
    }
  };
  return { instrument, handed };
}

const config: MCPServerConfig = { serverId: "srv", label: "Srv", connection: {} };

function adapter(result: MCPToolResult): MCPServerAdapter {
  return {
    definition: { id: "http_mcp", label: "HTTP", description: "", configSchema: {} },
    discoverTools: async () => [],
    invokeTool: async () => result
  } as unknown as MCPServerAdapter;
}

describe("MCP tools/call content", () => {
  it("hands the arguments and a successful result to the span", async () => {
    const { instrument, handed } = fake(true);
    const wrapped = instrumentMcpAdapter(adapter({ ok: true, output: { rows: 2 } }), instrument);
    await wrapped.invokeTool("lookup", { q: "x" }, config, {} as never);
    expect(handed).toEqual([
      { method: "tools/call", kind: "tool_call_arguments", value: { q: "x" } },
      { method: "tools/call", kind: "tool_call_result", value: { rows: 2 } }
    ]);
  });

  it("never hands over a failed call's error text", async () => {
    const { instrument, handed } = fake(true);
    const wrapped = instrumentMcpAdapter(adapter({ ok: false, output: null, error: "server said: secret detail", errorKind: "tool" }), instrument);
    await wrapped.invokeTool("lookup", { q: "x" }, config, {} as never);
    expect(handed.map((entry) => entry.kind)).toEqual(["tool_call_arguments"]);
  });

  it("hands nothing over while capture is off, and nothing for other methods", async () => {
    const off = fake(false);
    await instrumentMcpAdapter(adapter({ ok: true, output: "fine" }), off.instrument).invokeTool("lookup", { q: "x" }, config, {} as never);
    expect(off.handed).toEqual([]);
    const on = fake(true);
    await instrumentMcpAdapter(adapter({ ok: true, output: "fine" }), on.instrument).discoverTools(config, {} as never);
    expect(on.handed).toEqual([]);
  });
});
