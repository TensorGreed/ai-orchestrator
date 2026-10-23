import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import * as api from "../lib/api";
import { McpOverviewPage } from "./McpOverviewPage";
import {
  McpMyConnectionsPage,
  limitsDraftFrom,
  limitsFromDraft,
  sandboxDraftFrom,
  sandboxFromDraft,
  sandboxWarnings
} from "./McpRuntimeSafety";
import { McpServersPage } from "./McpServersPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpServers: vi.fn(),
    fetchMcpServer: vi.fn(),
    fetchMcpServerTools: vi.fn(),
    fetchMcpServerTelemetry: vi.fn(),
    fetchMcpPresets: vi.fn(),
    fetchMcpCatalog: vi.fn(),
    fetchSecrets: vi.fn(),
    createMcpServer: vi.fn(),
    resetMcpServerBreaker: vi.fn(),
    fetchMcpServerUserConnections: vi.fn(),
    revokeMcpServerUserConnection: vi.fn(),
    fetchMyMcpConnections: vi.fn(),
    connectMyMcpConnection: vi.fn(),
    disconnectMyMcpConnection: vi.fn(),
    fetchMcpOverview: vi.fn(),
    fetchProjects: vi.fn()
  };
});

const DIGEST = `node:22.11.0-alpine3.20@sha256:${"a".repeat(64)}`;
const policy: api.McpSandboxPolicyView = {
  defaultMode: "none",
  required: false,
  runtime: "auto",
  detectedRuntime: "docker",
  allowedMountRoots: ["/srv/l2m"]
};

function closedRuntime(serverId = "mcp_1"): api.McpRuntimeStateView {
  return {
    serverId,
    breaker: {
      state: "closed",
      since: null,
      consecutiveFailures: 0,
      windowCalls: 0,
      windowFailures: 0,
      retryAt: null,
      lastError: null,
      lastFailureAt: null
    },
    inFlight: 0,
    queued: 0,
    rejected: { rate_limited: 0, concurrency_limited: 0, circuit_open: 0 }
  };
}

function makeServer(overrides: Partial<api.McpRegisteredServer> = {}): api.McpRegisteredServer {
  return {
    id: "mcp_1",
    name: "Files",
    description: null,
    adapterId: "stdio_mcp",
    connection: { command: "node", args: ["files.js"] },
    secretId: null,
    owner: "ops@example.com",
    projectId: null,
    probeEnabled: true,
    probeIntervalMs: null,
    blockOnBreakingChange: false,
    status: "healthy",
    lastProbeAt: "2026-10-20T10:00:00.000Z",
    lastProbeOk: true,
    lastProbeLatencyMs: 120,
    lastProbeError: null,
    toolCount: 1,
    currentSnapshotId: "snap_1",
    pendingBreakingSnapshotId: null,
    sampling: { allow: false, maxTokens: 1024, allowedModels: [], maxRequestsPerCall: 3, defaultModel: null },
    sandbox: { mode: "container", image: "node:22-alpine", network: "bridge" },
    sandboxStatus: {
      mode: "container",
      source: "server",
      runtime: "docker",
      image: "node:22-alpine",
      pinnedByDigest: false,
      network: "bridge",
      ok: true,
      problems: [],
      warnings: ["The image is pinned by tag only."],
      checkedAt: "2026-10-20T10:00:00.000Z"
    },
    limits: limitsFromDraft(limitsDraftFrom(null)).value!,
    credentialMode: "service",
    delegatedFallback: "none",
    runtime: closedRuntime(),
    createdBy: "ops@example.com",
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    latency: { samples: 1, p50Ms: 100, p95Ms: 100, errorRate: 0 },
    ...overrides
  };
}

function mockDetail(server: api.McpRegisteredServer) {
  vi.mocked(api.fetchMcpServer).mockResolvedValue({ server, sandboxPolicy: policy, probes: [], snapshots: [], usages: [] });
  vi.mocked(api.fetchMcpServerTools).mockResolvedValue({ serverId: server.id, snapshotId: null, probedAt: null, tools: [] });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchMcpPresets).mockResolvedValue({ presets: [] });
  vi.mocked(api.fetchMcpCatalog).mockResolvedValue({
    status: { configured: false, fileName: null, mode: "merge", enforce: false, state: "off", loadedAt: null, entryCount: 0, approvedCount: 0, errors: [] },
    entries: []
  });
  vi.mocked(api.fetchSecrets).mockResolvedValue([]);
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });
  vi.mocked(api.fetchMcpServerTelemetry).mockImplementation(async (_id, window = "7d") => ({
    serverId: "mcp_1",
    window,
    since: "",
    totals: { calls: 0, errors: 0, errorRate: 0, p50Ms: null, p95Ms: null, inputTokens: 0, outputTokens: 0, costUsd: null, samplingRequests: 0, samplingInputTokens: 0, samplingOutputTokens: 0, lastCalledAt: null },
    tools: []
  }));
});

afterEach(() => {
  // Unmount first: a late effect of a still-mounted page would otherwise call a mock that was just restored.
  cleanup();
  vi.restoreAllMocks();
});

describe("sandbox and limits drafts", () => {
  it("requires a pinned image, a non-root user and absolute mount paths", () => {
    const base = sandboxDraftFrom({ mode: "container", image: DIGEST });
    expect(sandboxFromDraft(base)).toEqual({ value: { mode: "container", image: DIGEST, network: "none" }, error: null });
    expect(sandboxFromDraft({ ...base, image: "node:latest" }).error).toMatch(/latest/);
    expect(sandboxFromDraft({ ...base, image: "node" }).error).toMatch(/Pin the image/);
    expect(sandboxFromDraft({ ...base, user: "0:0" }).error).toMatch(/root/);
    expect(sandboxFromDraft({ ...base, mounts: [{ source: "data", target: "/data", writable: false }] }).error).toMatch(/absolute/);
    expect(sandboxFromDraft(sandboxDraftFrom(null))).toEqual({ value: null, error: null });
    expect(sandboxFromDraft({ ...base, mode: "none" }).value).toEqual({ mode: "none" });
  });

  it("warns about tag-only images, networking, writable mounts and an unsandboxed server when required", () => {
    const draft = {
      ...sandboxDraftFrom({ mode: "container", image: "node:22-alpine", network: "bridge" }),
      mounts: [{ source: "/srv/l2m/data", target: "/data", writable: true }]
    };
    const warnings = sandboxWarnings(draft, policy).join(" ");
    expect(warnings).toMatch(/pinned by tag only/);
    expect(warnings).toMatch(/Networking is on/);
    expect(warnings).toMatch(/writable mount/);
    expect(sandboxWarnings(sandboxDraftFrom({ mode: "none" }), { ...policy, required: true }).join(" ")).toMatch(/MCP_SANDBOX_REQUIRED/);
    expect(sandboxWarnings(sandboxDraftFrom({ mode: "container", image: DIGEST }), { ...policy, detectedRuntime: null }).join(" ")).toMatch(
      /No docker or podman/
    );
    expect(
      sandboxWarnings(sandboxDraftFrom({ mode: "container", image: DIGEST }), { ...policy, runtime: "podman", detectedRuntime: null }).join(" ")
    ).toMatch(/podman CLI set by MCP_SANDBOX_RUNTIME/);
  });

  it("turns seconds into milliseconds and keeps tool rules", () => {
    const draft = {
      ...limitsDraftFrom(null),
      requestsPerMinute: "60",
      maxConcurrent: "2",
      timeoutSec: "15",
      cooldownSec: "45",
      tools: [{ pattern: "write_*", requestsPerMinute: "5", maxConcurrent: "", timeoutSec: "" }]
    };
    const result = limitsFromDraft(draft);
    expect(result.error).toBeNull();
    expect(result.value).toMatchObject({
      requestsPerMinute: 60,
      maxConcurrent: 2,
      timeoutMs: 15_000,
      maxQueueWaitMs: 10_000,
      tools: [{ pattern: "write_*", requestsPerMinute: 5, maxConcurrent: null, timeoutMs: null }],
      breaker: { enabled: true, failureThreshold: 5, cooldownMs: 45_000 }
    });
    expect(limitsFromDraft({ ...draft, requestsPerMinute: "1.5" }).error).toMatch(/whole number/);
    expect(limitsFromDraft({ ...draft, errorRatePercent: "150" }).error).toMatch(/at most 100/);
  });
});

describe("registry page runtime safety", () => {
  it("registers a sandboxed stdio server with limits and shows the warnings", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpServers).mockResolvedValue({
      servers: [],
      adapters: [
        { id: "stdio_mcp", label: "Stdio" },
        { id: "http_mcp", label: "HTTP" }
      ],
      defaultProbeIntervalMs: 300000,
      sandboxPolicy: policy
    });
    const created = makeServer({ id: "mcp_new" });
    vi.mocked(api.createMcpServer).mockResolvedValue({ server: created });
    mockDetail(created);

    render(<McpServersPage isAdmin />);
    await user.click(await screen.findByRole("button", { name: "+ Register server" }));
    const form = screen.getByRole("form", { name: "Register MCP server" });
    await user.type(within(form).getByLabelText("Name"), "Files");
    await user.selectOptions(within(form).getByLabelText("Adapter"), "stdio_mcp");
    const sandbox = within(form).getByRole("group", { name: "Sandbox" });
    await user.selectOptions(within(sandbox).getByLabelText("Mode"), "container");
    await user.type(within(sandbox).getByLabelText("Image (pinned)"), "node:22-alpine");
    await user.selectOptions(within(sandbox).getByLabelText("Network"), "bridge");
    const warnings = within(sandbox).getByRole("list", { name: "Sandbox warnings" });
    expect(warnings).toHaveTextContent(/pinned by tag only/);
    expect(warnings).toHaveTextContent(/Networking is on/);

    const limits = within(form).getByRole("group", { name: "Limits and circuit breaker" });
    await user.type(within(limits).getByLabelText("Calls per minute"), "30");
    await user.click(within(form).getByRole("button", { name: "Register server" }));

    await waitFor(() => expect(api.createMcpServer).toHaveBeenCalled());
    const payload = vi.mocked(api.createMcpServer).mock.calls[0]![0];
    expect(payload.sandbox).toEqual({ mode: "container", image: "node:22-alpine", network: "bridge" });
    expect(payload.limits).toMatchObject({ requestsPerMinute: 30, breaker: { enabled: true } });
    expect(payload.credentialMode).toBe("service");
  });

  it("shows an open breaker in the list and on the server, and lets an admin reset it", async () => {
    const user = userEvent.setup();
    const open = makeServer({
      runtime: {
        ...closedRuntime(),
        breaker: {
          ...closedRuntime().breaker,
          state: "open",
          consecutiveFailures: 5,
          retryAt: "2026-10-20T10:01:00.000Z",
          lastError: "connect ECONNREFUSED"
        },
        rejected: { rate_limited: 1, concurrency_limited: 0, circuit_open: 4 }
      }
    });
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [open], adapters: [], defaultProbeIntervalMs: 300000, sandboxPolicy: policy });
    mockDetail(open);
    vi.mocked(api.resetMcpServerBreaker).mockResolvedValue({ runtime: closedRuntime() });

    render(<McpServersPage isAdmin />);
    const list = await screen.findByRole("complementary", { name: "Registered MCP servers" });
    expect(within(list).getByText("Circuit open")).toBeInTheDocument();
    const panel = await screen.findByRole("region", { name: "Runtime safety" });
    expect(within(panel).getByRole("alert")).toHaveTextContent(/paused after repeated failures/);
    expect(within(panel).getByText(/Last failure: connect ECONNREFUSED/)).toBeInTheDocument();
    expect(within(panel).getByText(/1 rate limited · 0 over the concurrency cap · 4 while open/)).toBeInTheDocument();
    expect(within(panel).getByText(/container · node:22-alpine · network on/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Reset breaker" }));
    expect(api.resetMcpServerBreaker).toHaveBeenCalledWith("mcp_1");
  });

  it("hides the reset and the last error from builders", async () => {
    const open = makeServer({
      runtime: { ...closedRuntime(), breaker: { ...closedRuntime().breaker, state: "open", lastError: null } }
    });
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [open], adapters: [], defaultProbeIntervalMs: 300000 });
    mockDetail(open);
    render(<McpServersPage isAdmin={false} canBuild />);
    const panel = await screen.findByRole("region", { name: "Runtime safety" });
    expect(within(panel).queryByRole("button", { name: "Reset breaker" })).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Last failure/)).not.toBeInTheDocument();
  });

  it("lists who connected to a delegated server and revokes one", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const delegated = makeServer({
      adapterId: "http_mcp",
      connection: { endpoint: "https://mail.example.test/mcp", authType: "oauth" },
      sandbox: null,
      sandboxStatus: null,
      credentialMode: "delegated"
    });
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [delegated], adapters: [], defaultProbeIntervalMs: 300000 });
    mockDetail(delegated);
    const connection: api.McpUserConnectionView = {
      serverId: "mcp_1",
      serverName: "Files",
      userId: "u_bob",
      userEmail: "bob@example.com",
      state: "connected",
      subject: "bob",
      scope: "mail.read",
      expiresAt: null,
      hasRefreshToken: true,
      connectedAt: "2026-10-20T10:00:00.000Z",
      lastRefreshAt: null,
      lastError: null
    };
    vi.mocked(api.fetchMcpServerUserConnections)
      .mockResolvedValueOnce({ credentialMode: "delegated", delegatedFallback: "none", connections: [connection] })
      .mockResolvedValueOnce({ credentialMode: "delegated", delegatedFallback: "none", connections: [] });
    vi.mocked(api.revokeMcpServerUserConnection).mockResolvedValue({ ok: true });

    render(<McpServersPage isAdmin />);
    const panel = await screen.findByRole("region", { name: "User connections" });
    expect(await within(panel).findByText("bob@example.com")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Revoke" }));
    expect(api.revokeMcpServerUserConnection).toHaveBeenCalledWith("mcp_1", "u_bob");
    expect(await within(panel).findByText("Nobody has connected yet.")).toBeInTheDocument();
  });
});

describe("My connections", () => {
  it("lists delegated servers, connects in a popup and disconnects", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const popup = { closed: false } as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    vi.mocked(api.fetchMyMcpConnections).mockResolvedValue({
      connections: [
        { serverId: "mcp_mail", serverName: "Mail", description: "Team mailbox", delegatedFallback: "owner", connection: null }
      ]
    });
    vi.mocked(api.connectMyMcpConnection).mockResolvedValue({
      authorizationUrl: "https://auth.example.test/authorize?x=1",
      expiresAt: "",
      redirectUri: ""
    });
    render(<McpMyConnectionsPage />);
    expect(await screen.findByRole("heading", { name: "Mail" })).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/use the connection of the workflow's owner/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(api.connectMyMcpConnection).toHaveBeenCalledWith("mcp_mail");
    expect(open).toHaveBeenCalledWith("https://auth.example.test/authorize?x=1", "l2m-mcp-connect-mcp_mail", expect.any(String));

    vi.mocked(api.fetchMyMcpConnections).mockResolvedValue({
      connections: [
        {
          serverId: "mcp_mail",
          serverName: "Mail",
          description: null,
          delegatedFallback: "none",
          connection: {
            serverId: "mcp_mail",
            serverName: "Mail",
            userId: "u_me",
            userEmail: "me@example.com",
            state: "connected",
            subject: "me@corp",
            scope: null,
            expiresAt: null,
            hasRefreshToken: true,
            connectedAt: "2026-10-20T10:00:00.000Z",
            lastRefreshAt: null,
            lastError: null
          }
        }
      ]
    });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "l2m:mcp-oauth", serverId: "mcp_mail", ok: true } }));
    expect(await screen.findByText("Connected as me@corp")).toBeInTheDocument();

    vi.mocked(api.disconnectMyMcpConnection).mockResolvedValue({
      connection: { serverId: "mcp_mail", serverName: "Mail", description: null, delegatedFallback: "none", connection: null }
    });
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(api.disconnectMyMcpConnection).toHaveBeenCalledWith("mcp_mail");
  });

  it("explains an empty list", async () => {
    vi.mocked(api.fetchMyMcpConnections).mockResolvedValue({ connections: [] });
    render(<McpMyConnectionsPage />);
    expect(await screen.findByText("No MCP server here uses personal accounts yet.")).toBeInTheDocument();
  });
});

describe("Overview attention", () => {
  it("lists an open breaker and a sandbox that cannot start", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpOverview).mockResolvedValue({
      window: "7d",
      since: "",
      servers: { total: 1, byStatus: { healthy: 1, degraded: 0, down: 0, unknown: 0 }, list: [] },
      pendingBreaking: [],
      oauthAttention: [],
      breakers: [
        { serverId: "mcp_1", serverName: "Files", state: "open", since: null, retryAt: null, consecutiveFailures: 5 }
      ],
      sandboxAttention: [
        { serverId: "mcp_2", serverName: "Shell", mode: "container", problems: ["No podman CLI was found."], checkedAt: "" }
      ],
      elicitations: { pending: 0, oldestAt: null },
      sampling: [],
      tools: { calls: 0, errors: 0, busiest: [], errorProne: [] },
      clients: { total: 0, active: 0, top: [] },
      changes: []
    });
    render(<McpOverviewPage onNavigate={onNavigate} />);
    const link = await screen.findByRole("button", { name: "Calls to Files are paused after repeated failures" });
    expect(screen.getByText("Circuit open")).toBeInTheDocument();
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Shell: the sandbox cannot start" })).toBeInTheDocument();
    await user.click(link);
    expect(onNavigate).toHaveBeenCalledWith({ page: "servers", serverId: "mcp_1" });
  });
});
