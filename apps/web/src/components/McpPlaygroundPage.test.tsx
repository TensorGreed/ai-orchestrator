import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { McpPlaygroundCallResponse } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { McpPlaygroundPage, maskExchange, readPlaygroundHistory } from "./McpPlaygroundPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpServerTools: vi.fn(),
    callMcpPlaygroundTool: vi.fn()
  };
});

function makeServer(overrides: Partial<api.McpRegisteredServer> = {}): api.McpRegisteredServer {
  return {
    id: "mcp_echo",
    name: "Echo",
    description: null,
    adapterId: "stdio_mcp",
    connection: { command: "node" },
    secretId: "sec_1",
    owner: null,
    projectId: null,
    probeEnabled: true,
    probeIntervalMs: null,
    blockOnBreakingChange: false,
    status: "healthy",
    lastProbeAt: "2026-10-20T10:00:00.000Z",
    lastProbeOk: true,
    lastProbeLatencyMs: 20,
    lastProbeError: null,
    toolCount: 2,
    currentSnapshotId: "snap_1",
    pendingBreakingSnapshotId: null,
    createdBy: null,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    latency: { samples: 1, p50Ms: 20, p95Ms: 20, errorRate: 0 },
    ...overrides
  };
}

const tools: api.McpSnapshotTool[] = [
  {
    name: "echo",
    description: "Echo a message",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    annotations: { readOnlyHint: true },
    classification: { readOnly: true, source: "annotation" },
    manualReadOnly: null,
    access: { allowed: true }
  },
  {
    name: "create_ticket",
    description: "Open a ticket",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["low", "high"] },
        labels: { type: "array", items: { type: "string" } },
        reporter: {
          type: "object",
          properties: { name: { type: "string" }, notify: { type: "boolean" } },
          required: ["name"]
        }
      },
      required: ["title", "reporter"]
    },
    classification: { readOnly: false, source: "unknown" },
    manualReadOnly: null,
    access: { allowed: true }
  }
];

function response(overrides: Partial<McpPlaygroundCallResponse> = {}): McpPlaygroundCallResponse {
  return {
    ok: true,
    durationMs: 42,
    toolName: "create_ticket",
    serverId: "mcp_echo",
    classification: { readOnly: false, source: "unknown" },
    result: {
      content: [{ type: "text", text: "Created T-1: Disk" }],
      structuredContent: { id: "T-1", title: "Disk" }
    },
    exchange: {
      // Deliberately unmasked: the panel must mask on its own as well.
      transport: { kind: "http", endpoint: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer live-token-123", "X-Api-Key": "k-999", "X-Team": "core" } },
      request: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_ticket", arguments: {} } },
      response: { jsonrpc: "2.0", id: 1, result: {} },
      note: "Request as sent."
    },
    policy: { role: "builder", projectId: "default" },
    telemetryId: "mtc_1",
    ...overrides
  };
}

describe("McpPlaygroundPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    vi.mocked(api.fetchMcpServerTools).mockResolvedValue({ serverId: "mcp_echo", snapshotId: "snap_1", probedAt: null, tools });
  });

  it("builds a nested form from the input schema, confirms the write tool and sends typed arguments", async () => {
    const user = userEvent.setup();
    vi.mocked(api.callMcpPlaygroundTool).mockResolvedValue(response());
    render(<McpPlaygroundPage servers={[makeServer()]} activeProjectId="default" userId="u1" />);

    await user.click(await screen.findByRole("button", { name: /create_ticket/ }));
    expect(screen.getByRole("heading", { name: "create_ticket" })).toBeInTheDocument();
    const reporter = screen.getByRole("group", { name: /reporter/ });
    expect(within(reporter).getByLabelText("name")).toBeInTheDocument();

    // Required fields are checked before anything is sent.
    await user.click(screen.getByRole("button", { name: "Call tool" }));
    expect(screen.getAllByText("Required")).toHaveLength(2);
    expect(api.callMcpPlaygroundTool).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("title"), "Disk");
    await user.selectOptions(screen.getByLabelText("priority"), "high");
    await user.type(screen.getByLabelText("labels item 1"), "ops");
    await user.type(within(reporter).getByLabelText("name"), "Ana");
    await user.selectOptions(within(reporter).getByLabelText("notify"), "true");
    await user.click(screen.getByRole("button", { name: "Call tool" }));

    // Write tool: ask first.
    const confirm = screen.getByRole("alertdialog", { name: "Confirm write tool" });
    expect(api.callMcpPlaygroundTool).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Call write tool" }));

    await waitFor(() =>
      expect(api.callMcpPlaygroundTool).toHaveBeenCalledWith("mcp_echo", {
        toolName: "create_ticket",
        args: { title: "Disk", priority: "high", labels: ["ops"], reporter: { name: "Ana", notify: true } },
        projectId: "default",
        confirmWrite: true
      })
    );
    expect(await screen.findByText("Created T-1: Disk")).toBeInTheDocument();
    expect(screen.getByText(/"id": "T-1"/)).toBeInTheDocument();
    expect(readPlaygroundHistory("u1")[0]).toMatchObject({ toolName: "create_ticket", ok: true });
  });

  it("calls read-only tools without asking and masks credentials in the exchange panel", async () => {
    const user = userEvent.setup();
    vi.mocked(api.callMcpPlaygroundTool).mockResolvedValue(response({ toolName: "echo", classification: { readOnly: true, source: "annotation" } }));
    render(<McpPlaygroundPage servers={[makeServer()]} />);

    await user.type(await screen.findByLabelText("message"), "hello");
    await user.click(screen.getByRole("button", { name: "Call tool" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.callMcpPlaygroundTool).toHaveBeenCalledWith("mcp_echo", { toolName: "echo", args: { message: "hello" } }));

    await user.click(await screen.findByText("JSON-RPC exchange"));
    const transport = screen.getByTestId("exchange-transport");
    expect(transport.textContent).toContain("Bearer ••••••");
    expect(transport.textContent).toContain('"X-Team": "core"');
    expect(transport.textContent).not.toContain("live-token-123");
    expect(transport.textContent).not.toContain("k-999");
  });

  it("shows a server's policy refusal", async () => {
    const user = userEvent.setup();
    vi.mocked(api.callMcpPlaygroundTool).mockRejectedValue(new api.ApiError("Blocked by rule No echo", 403, {}));
    render(<McpPlaygroundPage servers={[makeServer()]} />);
    await user.type(await screen.findByLabelText("message"), "x");
    await user.click(screen.getByRole("button", { name: "Call tool" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Blocked by rule No echo");
  });

  it("disables calling a tool the policy blocks for the user", async () => {
    vi.mocked(api.fetchMcpServerTools).mockResolvedValue({
      serverId: "mcp_echo",
      snapshotId: "snap_1",
      probedAt: null,
      tools: [{ ...tools[0]!, access: { allowed: false, ruleName: "No echo", message: "Blocked by No echo" } }]
    });
    render(<McpPlaygroundPage servers={[makeServer()]} />);
    expect(await screen.findByText("Blocked by No echo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Call tool" })).toBeDisabled();
  });
});

describe("maskExchange", () => {
  it("masks secret-looking env values and keeps the rest", () => {
    const masked = maskExchange({
      transport: { kind: "stdio", command: "node", args: [], env: { API_TOKEN: "raw", MODE: "x" } },
      request: {},
      response: {},
      note: ""
    });
    expect(masked.transport).toEqual({ kind: "stdio", command: "node", args: [], env: { API_TOKEN: "••••••", MODE: "x" } });
  });
});
