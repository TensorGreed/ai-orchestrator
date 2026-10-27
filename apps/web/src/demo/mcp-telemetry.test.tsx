import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_IN_DEMO, createFakeBackend } from "./fake-backend";
import { demoFixtures } from "./fixtures";
import apiSource from "../lib/api.ts?raw";
import overviewSource from "../components/McpOverviewPage.tsx?raw";
import toolsSource from "../components/McpToolsPage.tsx?raw";
import serversSource from "../components/McpServersPage.tsx?raw";

const transport = vi.hoisted(() => ({ backend: null as null | { fetch: (input: string, init?: RequestInit) => Promise<Response>; openEventSource: (url: string) => EventSource } }));

vi.mock("../lib/transport", () => ({
  apiFetch: (input: string, init?: RequestInit) => transport.backend!.fetch(input, init),
  openEventSource: (url: string) => transport.backend!.openEventSource(url)
}));

const api = await import("../lib/api");
const { McpOverviewPage } = await import("../components/McpOverviewPage");

/** Every value of `McpTelemetryWindow`, read from the API client so a new window cannot go unrecorded. */
const WINDOWS = (() => {
  const union = /export type McpTelemetryWindow = ([^;]+);/.exec(apiSource)?.[1] ?? "";
  return [...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]!) as Array<import("../lib/api").McpTelemetryWindow>;
})();

const get = (key: string) => demoFixtures.responses.get[key]?.body as Record<string, any> | undefined;
const servers = (get("GET /api/mcp/servers")?.servers ?? []) as Array<{ id: string; name: string }>;

function backend() {
  const created = createFakeBackend({ fixtures: demoFixtures, storage: null, pace: 0 });
  transport.backend = created;
  return created;
}

afterEach(() => {
  transport.backend = null;
});

describe("demo MCP telemetry", () => {
  it("covers every window the MCP pages can pick or open on", () => {
    expect(WINDOWS.length).toBeGreaterThanOrEqual(3);
    expect(WINDOWS).toEqual(expect.arrayContaining(["24h", "7d", "30d"]));
    const picker = /const WINDOWS: McpTelemetryWindow\[\] = \[([^\]]+)\]/.exec(overviewSource)?.[1] ?? "";
    expect([...picker.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort()).toEqual([...WINDOWS].sort());
    for (const source of [overviewSource, toolsSource, serversSource]) {
      for (const match of source.matchAll(/useState<McpTelemetryWindow>\("([^"]+)"\)/g)) expect(WINDOWS).toContain(match[1]);
    }
  });

  it("has a recording of every window for the overview, the inline telemetry, the tool catalog and each server", () => {
    expect(servers.length).toBeGreaterThan(0);
    for (const window of WINDOWS) {
      const urls = [
        `/api/mcp/overview?window=${window}`,
        `/api/mcp/telemetry?window=${window}`,
        `/api/mcp/tools?window=${window}`,
        ...servers.map((server) => `/api/mcp/servers/${server.id}/telemetry?window=${window}`)
      ];
      for (const url of urls) expect(get(`GET ${url}`)?.window, url).toBe(window);
    }
  });

  it("records real calls to the registered server: tool calls, a failure, latency and per-tool rows", () => {
    for (const window of WINDOWS) {
      const overview = get(`GET /api/mcp/overview?window=${window}`)!;
      expect(overview.tools.calls, window).toBeGreaterThan(0);
      expect(overview.tools.errors, window).toBeGreaterThan(0);
      expect(overview.tools.errors, window).toBeLessThan(overview.tools.calls);
      expect(overview.tools.busiest.map((row: { toolName: string }) => row.toolName).sort()).toEqual(["calculator", "lookup_kb"]);
      for (const row of overview.tools.busiest) expect(row.p95Ms, `${window} ${row.toolName}`).toBeGreaterThan(0);
      expect(overview.tools.errorProne.map((row: { toolName: string }) => row.toolName)).toEqual(["calculator"]);
      const demoTools = servers.find((server) => server.name === "Demo tools")!;
      const telemetry = get(`GET /api/mcp/servers/${demoTools.id}/telemetry?window=${window}`)!;
      expect(telemetry.totals.calls).toBe(overview.tools.calls);
      expect(telemetry.totals.p50Ms).toBeGreaterThan(0);
      // The cold knowledge-base search is the slow call.
      expect(telemetry.tools.find((row: { toolName: string }) => row.toolName === "lookup_kb").p95Ms).toBeGreaterThan(1000);
    }
  });

  it("answers each window through the API client and refuses a window it has no recording for", async () => {
    const demo = backend();
    const demoTools = servers.find((server) => server.name === "Demo tools")!;
    for (const window of WINDOWS) {
      const overview = await api.fetchMcpOverview(window);
      expect(overview.window).toBe(window);
      expect(overview.tools.calls).toBeGreaterThan(0);
      expect((await api.fetchMcpServerTelemetry(demoTools.id, window)).window).toBe(window);
      expect((await api.fetchInlineMcpTelemetry(window)).window).toBe(window);
      expect((await api.fetchMcpToolCatalog({ projectId: "default", window })).window).toBe(window);
    }
    expect(demo.misses()).toEqual([]);

    const unrecorded = "90d" as import("../lib/api").McpTelemetryWindow;
    for (const request of [() => api.fetchMcpOverview(unrecorded), () => api.fetchMcpToolCatalog({ window: unrecorded })]) {
      const error = await request().then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(api.ApiError);
      expect((error as InstanceType<typeof api.ApiError>).status).toBe(501);
      expect((error as InstanceType<typeof api.ApiError>).payload?.code).toBe(NOT_IN_DEMO);
    }
    expect(demo.misses()).toEqual(["GET /api/mcp/overview?window=90d", "GET /api/mcp/tools?window=90d"]);
  });

  it("shows numbers on MCP overview in every window, not an error or a dash", async () => {
    backend();
    const user = userEvent.setup();
    render(<McpOverviewPage onNavigate={() => undefined} />);
    for (const window of ["7d", ...WINDOWS.filter((entry) => entry !== "7d")]) {
      if (window !== "7d") await user.click(screen.getByRole("button", { name: window, exact: true }));
      const overview = get(`GET /api/mcp/overview?window=${window}`)!;
      await waitFor(() => expect(screen.getByText(`Tool calls · ${window}`)).toBeInTheDocument());
      expect(screen.queryByText(/Not available in the demo/)).toBeNull();
      expect(screen.getByText(`Tool calls · ${window}`).parentElement).toHaveTextContent(String(overview.tools.calls));
      expect(screen.getByText(`Failed calls · ${window}`).parentElement).toHaveTextContent(String(overview.tools.errors));
      const busiest = screen.getByRole("region", { name: "Busiest tools" });
      expect(within(busiest).queryByText("No tool calls in this window.")).toBeNull();
      expect(within(busiest).getByRole("button", { name: /^calculator on Demo tools: \d+ calls$/ })).toBeInTheDocument();
      // The table view has the p95 latency and cost of each tool.
      await user.click(within(busiest).getByRole("button", { name: "Show table" }));
      const rows = within(within(busiest).getByRole("table")).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toHaveTextContent(/\d+ ms|\d+\.\d s/);
        expect(row).not.toHaveTextContent("—");
      }
      await user.click(within(busiest).getByRole("button", { name: "Show chart" }));
      const errorProne = screen.getByRole("region", { name: "Most error-prone tools" });
      expect(within(errorProne).getByText(/^\d+% · 1 of \d+ failed$/)).toBeInTheDocument();
    }
  });
});
