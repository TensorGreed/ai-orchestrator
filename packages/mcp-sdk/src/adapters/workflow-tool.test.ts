import { describe, expect, it } from "vitest";
import { WORKFLOW_TOOL_ADAPTER_ID, type MCPServerConfig } from "@ai-orchestrator/shared";
import { WorkflowToolMCPServerAdapter } from "./workflow-tool";
import { createDefaultMCPRegistry } from "../index";
import type { MCPExecutionContext, WorkflowToolCall } from "../types";

const schema = { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] };
const config = (extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  serverId: WORKFLOW_TOOL_ADAPTER_ID,
  registryServerId: "workflow:wf-1",
  connection: { workflowId: "wf-1", nodeId: "n1", toolName: "order_lookup", description: "Looks up orders.", inputSchema: schema },
  ...extra
});

describe("workflow tool adapter", () => {
  it("is registered by default and lists the one tool its config derived, not read-only unless marked", async () => {
    const adapter = createDefaultMCPRegistry().get(WORKFLOW_TOOL_ADAPTER_ID);
    const context: MCPExecutionContext = { resolveSecret: async () => undefined };
    expect(await adapter.discoverTools(config(), context)).toEqual([
      expect.objectContaining({ name: "order_lookup", description: "Looks up orders.", inputSchema: schema, annotations: { title: "order_lookup", readOnlyHint: false } })
    ]);
    const readOnly = config({ connection: { ...(config().connection as object), readOnly: true } });
    expect((await adapter.discoverTools(readOnly, context))[0]!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("hands calls to the engine's runner, and refuses without one or outside its workflow:<id> key", async () => {
    const adapter = new WorkflowToolMCPServerAdapter();
    const calls: WorkflowToolCall[] = [];
    const context: MCPExecutionContext = {
      resolveSecret: async () => undefined,
      runWorkflowTool: async (call) => {
        calls.push(call);
        return { ok: true, output: { status: "shipped" } };
      }
    };
    expect(await adapter.invokeTool("order_lookup", { order_id: "A" }, config(), context)).toEqual({ ok: true, output: { status: "shipped" } });
    expect(calls).toEqual([{ workflowId: "wf-1", nodeId: "n1", toolName: "order_lookup", args: { order_id: "A" } }]);
    expect(await adapter.invokeTool("order_lookup", {}, config(), { resolveSecret: async () => undefined })).toMatchObject({ ok: false, error: expect.stringMatching(/inside an agent/) });
    const inline = { serverId: WORKFLOW_TOOL_ADAPTER_ID, connection: { workflowId: "wf-1", toolName: "order_lookup" } };
    expect(await adapter.invokeTool("order_lookup", {}, inline, context)).toMatchObject({ ok: false, error: expect.stringMatching(/Workflow Tool node/) });
    expect(await adapter.invokeTool("other", {}, config(), context)).toMatchObject({ ok: false, errorKind: "invalid_arguments" });
    expect(calls).toHaveLength(1);
  });
});
