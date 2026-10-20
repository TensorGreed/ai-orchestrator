import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpOAuthConnectionStatus, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { afterEach, beforeEach, vi } from "vitest";
import * as api from "../lib/api";
import { McpAuthFields } from "./McpAuthFields";
import { McpOAuthPanel } from "./McpOAuthPanel";
import { McpServersPage } from "./McpServersPage";
import { McpAnnotationChips, McpOutputSchema } from "./McpToolMeta";
import { RunTape, formatProgress } from "./RunTape";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpServers: vi.fn(),
    fetchMcpServer: vi.fn(),
    fetchMcpServerTools: vi.fn(),
    fetchMcpServerTelemetry: vi.fn(),
    fetchMcpPresets: vi.fn(),
    fetchSecrets: vi.fn(),
    fetchMcpServerOAuth: vi.fn(),
    connectMcpServerOAuth: vi.fn(),
    refreshMcpServerOAuth: vi.fn(),
    disconnectMcpServerOAuth: vi.fn()
  };
});

function oauthStatus(overrides: Partial<McpOAuthConnectionStatus> = {}): McpOAuthConnectionStatus {
  return {
    serverId: "mcp_1",
    state: "not_connected",
    subject: null,
    scope: null,
    authorizationServer: null,
    clientRegistration: null,
    clientId: null,
    expiresAt: null,
    hasRefreshToken: false,
    lastRefreshAt: null,
    connectedAt: null,
    connectedBy: null,
    lastError: null,
    updatedAt: null,
    redirectUri: "http://localhost:5173/api/mcp/oauth/callback",
    ...overrides
  };
}

const server: api.McpRegisteredServer = {
  id: "mcp_1",
  name: "Issues",
  description: null,
  adapterId: "http_mcp",
  connection: { endpoint: "https://mcp.example.test/mcp", authType: "oauth" },
  secretId: null,
  owner: null,
  projectId: null,
  probeEnabled: true,
  probeIntervalMs: null,
  blockOnBreakingChange: false,
  status: "healthy",
  lastProbeAt: "2026-10-20T10:00:00.000Z",
  lastProbeOk: true,
  lastProbeLatencyMs: 12,
  lastProbeError: null,
  toolCount: 1,
  currentSnapshotId: "snap_1",
  pendingBreakingSnapshotId: null,
  createdBy: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  latency: { samples: 1, p50Ms: 12, p95Ms: 12, errorRate: 0 }
};

describe("MCP tool metadata", () => {
  it("renders labelled chips only for hints the server sent", () => {
    render(<McpAnnotationChips annotations={{ title: "Delete issue", destructiveHint: true, idempotentHint: true, openWorldHint: false }} />);
    const chips = screen.getByLabelText("Tool annotations");
    expect(within(chips).getByText("Delete issue")).toBeInTheDocument();
    expect(within(chips).getByText("Destructive")).toBeInTheDocument();
    expect(within(chips).getByText("Idempotent")).toBeInTheDocument();
    expect(within(chips).getByText("Closed world")).toBeInTheDocument();
    expect(within(chips).queryByText("Read-only")).not.toBeInTheDocument();
    expect(within(chips).getByText("Destructive")).toHaveAttribute("title", expect.stringContaining("Hint sent by the MCP server"));
  });

  it("renders nothing without annotations", () => {
    const { container } = render(<McpAnnotationChips annotations={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows output properties with types and required marks, and the raw schema", () => {
    render(
      <McpOutputSchema
        schema={{
          type: "object",
          properties: { count: { type: "integer" }, items: { type: "array", items: { type: "string" } } },
          required: ["count"]
        }}
      />
    );
    expect(screen.getByText("count*")).toBeInTheDocument();
    expect(screen.getByText(": integer")).toBeInTheDocument();
    expect(screen.getByText(": string[]")).toBeInTheDocument();
    expect(screen.getByText("JSON schema")).toBeInTheDocument();
  });

  it("explains a tool without an output schema", () => {
    render(<McpOutputSchema schema={undefined} />);
    expect(screen.getByText("No output schema; the tool returns text.")).toBeInTheDocument();
  });
});

describe("MCP servers page with annotations, output schemas and OAuth", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchMcpPresets).mockResolvedValue({ presets: [] });
    vi.mocked(api.fetchSecrets).mockResolvedValue([]);
    vi.mocked(api.fetchMcpServers).mockResolvedValue({
      servers: [server],
      adapters: [{ id: "http_mcp", label: "HTTP MCP Server" }],
      defaultProbeIntervalMs: 300000
    });
    vi.mocked(api.fetchMcpServer).mockResolvedValue({ server, probes: [], snapshots: [], usages: [] });
    vi.mocked(api.fetchMcpServerTools).mockResolvedValue({
      serverId: "mcp_1",
      snapshotId: "snap_1",
      probedAt: server.lastProbeAt,
      tools: [
        {
          name: "delete_issue",
          description: "Delete an issue",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          annotations: { destructiveHint: true, readOnlyHint: false },
          outputSchema: { type: "object", properties: { deleted: { type: "boolean" } }, required: ["deleted"] }
        }
      ]
    });
    vi.mocked(api.fetchMcpServerTelemetry).mockImplementation(async (_id, window = "7d") => ({
      serverId: "mcp_1",
      window,
      since: "2026-10-13T10:00:00.000Z",
      totals: { calls: 0, errors: 0, errorRate: 0, p50Ms: null, p95Ms: null, inputTokens: 0, outputTokens: 0, costUsd: null, lastCalledAt: null },
      tools: []
    }));
    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: oauthStatus() });
  });

  it("shows annotation chips and the output schema in the Tools table, and the OAuth panel", async () => {
    render(<McpServersPage isAdmin />);
    const table = (await screen.findByRole("columnheader", { name: "Outputs" })).closest("table") as HTMLTableElement;
    await waitFor(() => expect(within(table).getByText("Destructive")).toBeInTheDocument());
    expect(within(table).getByText("Writes")).toBeInTheDocument();
    expect(within(table).getByText("deleted*")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "OAuth connection" })).toBeInTheDocument();
    expect(api.fetchMcpServerOAuth).toHaveBeenCalledWith("mcp_1");
  });
});

describe("McpOAuthPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects through a popup and reloads the status when the callback posts back", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpServerOAuth)
      .mockResolvedValueOnce({ status: oauthStatus() })
      .mockResolvedValue({
        status: oauthStatus({
          state: "connected",
          subject: "ops@example.test",
          hasRefreshToken: true,
          clientRegistration: "dynamic",
          clientId: "client-123",
          authorizationServer: "https://auth.example.test",
          expiresAt: "2026-10-20T11:00:00.000Z"
        })
      });
    vi.mocked(api.connectMcpServerOAuth).mockResolvedValue({
      authorizationUrl: "https://auth.example.test/authorize?state=abc",
      expiresAt: "2026-10-20T10:10:00.000Z",
      redirectUri: "http://localhost:5173/api/mcp/oauth/callback"
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);

    render(<McpOAuthPanel serverId="mcp_1" isAdmin />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:5173/api/mcp/oauth/callback")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(api.connectMcpServerOAuth).toHaveBeenCalledWith("mcp_1");
    expect(openSpy).toHaveBeenCalledWith("https://auth.example.test/authorize?state=abc", expect.any(String), expect.any(String));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "l2m:mcp-oauth", serverId: "mcp_1", ok: true } }));
    });
    expect(await screen.findByText("Connected as ops@example.test")).toBeInTheDocument();
    expect(screen.getByText("client-123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh token" })).toBeInTheDocument();
  });

  it("refreshes and disconnects", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({
      status: oauthStatus({ state: "connected", subject: "ops@example.test", hasRefreshToken: true })
    });
    vi.mocked(api.refreshMcpServerOAuth).mockResolvedValue({
      status: oauthStatus({ state: "connected", subject: "ops@example.test", hasRefreshToken: true, lastRefreshAt: "2026-10-20T10:30:00.000Z" })
    });
    vi.mocked(api.disconnectMcpServerOAuth).mockResolvedValue({ status: oauthStatus() });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<McpOAuthPanel serverId="mcp_1" isAdmin />);
    await user.click(await screen.findByRole("button", { name: "Refresh token" }));
    expect(api.refreshMcpServerOAuth).toHaveBeenCalledWith("mcp_1");
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(api.disconnectMcpServerOAuth).toHaveBeenCalledWith("mcp_1");
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
  });

  it("shows the callback error", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: oauthStatus() });
    vi.mocked(api.connectMcpServerOAuth).mockResolvedValue({
      authorizationUrl: "https://auth.example.test/authorize",
      expiresAt: "2026-10-20T10:10:00.000Z",
      redirectUri: "http://localhost:5173/api/mcp/oauth/callback"
    });
    vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);
    render(<McpOAuthPanel serverId="mcp_1" isAdmin />);
    await user.click(await screen.findByRole("button", { name: "Connect" }));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "l2m:mcp-oauth", serverId: "mcp_1", ok: false, error: "access_denied" } })
      );
    });
    expect(await screen.findByText("access_denied")).toBeInTheDocument();
  });

  it("shows status without actions to non-admins", async () => {
    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: oauthStatus({ state: "expired" }) });
    render(<McpOAuthPanel serverId="mcp_1" isAdmin={false} />);
    expect(await screen.findByText("Token expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });
});

describe("McpAuthFields", () => {
  function Harness({ initial }: { initial: string }) {
    const [json, setJson] = useState(initial);
    return (
      <>
        <McpAuthFields connectionJson={json} onConnectionJsonChange={setJson} />
        <output data-testid="json">{json}</output>
      </>
    );
  }

  it("writes authType and the OAuth client settings into the connection JSON", async () => {
    const user = userEvent.setup();
    render(<Harness initial={JSON.stringify({ endpoint: "https://mcp.example.test/mcp" })} />);
    await user.selectOptions(screen.getByLabelText("Auth type"), "oauth");
    await user.type(screen.getByLabelText("OAuth client ID"), "client-1");
    await user.type(screen.getByLabelText("OAuth scope"), "repo read");
    expect(JSON.parse(screen.getByTestId("json").textContent ?? "{}")).toEqual({
      endpoint: "https://mcp.example.test/mcp",
      authType: "oauth",
      oauth: { clientId: "client-1", scope: "repo read" }
    });
    await user.selectOptions(screen.getByLabelText("Auth type"), "bearer");
    expect(JSON.parse(screen.getByTestId("json").textContent ?? "{}")).toEqual({
      endpoint: "https://mcp.example.test/mcp",
      authType: "bearer"
    });
  });
});

describe("RunTape progress", () => {
  const result: WorkflowExecutionResult = {
    workflowId: "wf",
    status: "partial",
    startedAt: "2026-10-20T10:00:00.000Z",
    completedAt: "2026-10-20T10:00:02.000Z",
    nodeResults: [
      {
        nodeId: "tool",
        status: "running",
        startedAt: "2026-10-20T10:00:00.000Z",
        progress: {
          toolName: "search_issues",
          serverId: "http_mcp",
          progress: 4,
          total: 10,
          message: "indexing",
          at: "2026-10-20T10:00:01.000Z"
        }
      }
    ]
  } as WorkflowExecutionResult;

  it("shows the latest tool progress on the node's lane", () => {
    render(<RunTape executionResult={result} nodeMetaById={new Map([["tool", { label: "Search", type: "mcp_tool" }]])} />);
    expect(screen.getByText("tool search_issues: 40% — indexing")).toBeInTheDocument();
  });

  it("formats progress without a total", () => {
    expect(formatProgress({ toolName: "crawl", serverId: "stdio_mcp", progress: 7, at: "2026-10-20T10:00:00.000Z" })).toBe(
      "tool crawl: progress 7"
    );
  });
});

describe("execution stream parser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes node_progress events to onNodeProgress", async () => {
    const frames = [
      `event: node_progress\ndata: ${JSON.stringify({ nodeId: "tool", toolName: "search_issues", serverId: "http_mcp", progress: 1, total: 2, at: "2026-10-20T10:00:00.000Z" })}\n\n`,
      `event: result\ndata: ${JSON.stringify({ workflowId: "wf", status: "success", startedAt: "a", completedAt: "b", nodeResults: [] })}\n\n`
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const onNodeProgress = vi.fn();
    const final = await api.executeWorkflowStream("wf", {}, { onNodeProgress });
    expect(onNodeProgress).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "tool", toolName: "search_issues", progress: 1, total: 2 }));
    expect(final.status).toBe("success");
  });
});
