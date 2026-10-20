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
    callMcpPlaygroundTool: vi.fn(),
    fetchMcpServerResources: vi.fn(),
    readMcpServerResource: vi.fn(),
    fetchMcpServerPrompts: vi.fn(),
    getMcpServerPrompt: vi.fn()
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

  describe("resources and prompts panels", () => {
    const capabilities = { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } };
    const policy = { role: "builder" as const, projectId: "default" };

    beforeEach(() => {
      vi.mocked(api.fetchMcpServerResources).mockResolvedValue({
        serverId: "mcp_echo",
        capabilities,
        updatedAt: "2026-10-20T10:00:00.000Z",
        policy,
        resources: [
          { uri: "mock://docs/readme", name: "readme", title: "Read me", mimeType: "text/plain", access: { allowed: true } },
          { uri: "mock://secrets/vault", name: "vault", mimeType: "text/plain", access: { allowed: false, message: "Blocked by rule No vault" } }
        ],
        resourceTemplates: [{ uriTemplate: "mock://kb/{topic}", name: "kb", title: "Knowledge base", access: { allowed: true } }]
      });
      vi.mocked(api.fetchMcpServerPrompts).mockResolvedValue({
        serverId: "mcp_echo",
        capabilities,
        updatedAt: "2026-10-20T10:00:00.000Z",
        policy,
        prompts: [
          {
            name: "explain_topic",
            title: "Explain a topic",
            description: "Explains a topic for a reader",
            arguments: [
              { name: "topic", required: true },
              { name: "audience", required: false }
            ],
            access: { allowed: true }
          }
        ]
      });
    });

    it("lists resources and templates, expands template variables and shows the contents read", async () => {
      const user = userEvent.setup();
      vi.mocked(api.readMcpServerResource).mockResolvedValue({
        serverId: "mcp_echo",
        uri: "mock://kb/rag",
        bytes: 12,
        durationMs: 3,
        contents: [{ uri: "mock://kb/rag", mimeType: "application/json", text: '{"topic":"rag"}' }],
        policy
      });
      render(<McpPlaygroundPage servers={[makeServer()]} activeProjectId="default" userId="u1" />);
      await user.click(screen.getByRole("tab", { name: "Resources" }));

      const list = await screen.findByRole("complementary", { name: "Resources" });
      expect(within(list).getByText("mock://docs/readme")).toBeInTheDocument();
      expect(within(list).getByText("Blocked for your role")).toBeInTheDocument();

      // Blocked entries cannot be read.
      await user.click(within(list).getByRole("button", { name: /vault/ }));
      expect(screen.getByRole("status")).toHaveTextContent("Blocked by rule No vault");
      expect(screen.getByRole("button", { name: "Read resource" })).toBeDisabled();

      await user.click(within(list).getByRole("button", { name: /Knowledge base/ }));
      await user.type(screen.getByLabelText("topic"), "rag");
      expect(screen.getByText("mock://kb/rag")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Read resource" }));

      await waitFor(() => expect(api.readMcpServerResource).toHaveBeenCalledWith("mcp_echo", { uri: "mock://kb/rag", projectId: "default" }));
      const result = await screen.findByRole("region", { name: "Resource contents" });
      expect(within(result).getByText(/"topic": "rag"/)).toBeInTheDocument();
      await user.click(within(result).getByRole("button", { name: "Show raw" }));
      expect(within(result).getByText('{"topic":"rag"}')).toBeInTheDocument();
    });

    it("explains when a server offers no resources and refreshes the list on request", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchMcpServerResources).mockResolvedValue({
        serverId: "mcp_echo",
        capabilities: { tools: { listChanged: false } },
        updatedAt: null,
        policy,
        resources: [],
        resourceTemplates: []
      });
      render(<McpPlaygroundPage servers={[makeServer()]} activeProjectId="default" userId="u1" />);
      await user.click(screen.getByRole("tab", { name: "Resources" }));
      expect(await screen.findByText(/does not advertise resources/)).toBeInTheDocument();
    });

    it("renders a prompt with its arguments and previews the messages", async () => {
      const user = userEvent.setup();
      vi.mocked(api.getMcpServerPrompt).mockResolvedValue({
        serverId: "mcp_echo",
        durationMs: 2,
        policy,
        prompt: {
          name: "explain_topic",
          description: "Explain rag",
          messages: [
            { role: "user", content: { type: "text", text: "Explain rag to engineers" } },
            { role: "assistant", content: { type: "text", text: "Sure." } }
          ]
        }
      });
      render(<McpPlaygroundPage servers={[makeServer()]} activeProjectId="default" userId="u1" />);
      await user.click(screen.getByRole("tab", { name: "Prompts" }));

      const list = await screen.findByRole("complementary", { name: "Prompts" });
      await user.click(within(list).getByRole("button", { name: /Explain a topic/ }));
      expect(screen.getByRole("heading", { name: "Explain a topic" })).toBeInTheDocument();

      // Required arguments are checked before the request is sent.
      await user.click(screen.getByRole("button", { name: "Preview prompt" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Required");
      expect(api.getMcpServerPrompt).not.toHaveBeenCalled();

      await user.type(screen.getByLabelText("topic"), "rag");
      await user.type(screen.getByLabelText("audience"), "engineers");
      await user.click(screen.getByRole("button", { name: "Preview prompt" }));
      await waitFor(() =>
        expect(api.getMcpServerPrompt).toHaveBeenCalledWith("mcp_echo", {
          name: "explain_topic",
          arguments: { topic: "rag", audience: "engineers" },
          projectId: "default"
        })
      );
      const rendered = await screen.findByRole("region", { name: "Rendered prompt" });
      expect(within(rendered).getByText("2 messages")).toBeInTheDocument();
      expect(within(rendered).getByText("Explain rag to engineers")).toBeInTheDocument();
    });
  });
});
