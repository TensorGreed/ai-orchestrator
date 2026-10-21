import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import * as api from "../lib/api";
import type { McpCassetteRecord } from "../lib/api";
import { McpCassetteViewer } from "./McpCassetteViewer";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchMcpCassette: vi.fn(), deleteMcpCassette: vi.fn() };
});

function makeRecord(overrides: Partial<McpCassetteRecord> = {}): McpCassetteRecord {
  return {
    id: "cas_9",
    executionId: "ex-9",
    workflowId: "wf-1",
    workflowName: "Support",
    projectId: "default",
    source: "manual",
    evalRunId: null,
    fixtureId: null,
    callCount: 3,
    serverCount: 1,
    bytes: 2048,
    truncated: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "builder@example.com",
    cassette: {
      format: "l2m.mcp-cassette",
      version: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
      servers: [{ key: "inline:http_mcp:abc", adapterId: "http_mcp" }],
      entries: [
        { seq: 1, server: "inline:http_mcp:abc", method: "tools/list", argsHash: "a", result: [], at: 0, durationMs: 2 },
        {
          seq: 2,
          server: "inline:http_mcp:abc",
          method: "tools/call",
          name: "create_ticket",
          args: { title: "Printer", token: "[REDACTED]" },
          argsHash: "b",
          result: { ok: false, error: "quota exceeded" },
          at: 5,
          durationMs: 1500,
          exchanges: [{ kind: "elicitation", at: 6, request: { message: "Confirm?" }, response: { action: "accept" } }]
        }
      ],
      truncated: true,
      bytes: 2048,
      llm: "not_recorded"
    },
    ...overrides
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("McpCassetteViewer", () => {
  it("lists calls, hides discovery by default and expands a call's arguments and result", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMcpCassette).mockResolvedValue({ cassette: makeRecord() });
    render(<McpCassetteViewer cassetteId="cas_9" onClose={vi.fn()} />);

    const dialog = await screen.findByRole("dialog", { name: "MCP cassette" });
    await within(dialog).findByText("create_ticket");
    expect(within(dialog).getByRole("status")).toHaveTextContent(/Truncated/);
    expect(within(dialog).getByText("error")).toBeInTheDocument();
    expect(within(dialog).getByText("elicitation")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/mcp/cassettes/cas_9/export");

    const list = within(dialog).getByRole("list", { name: "Recorded MCP calls" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await user.click(within(dialog).getByRole("checkbox", { name: /Show discovery calls \(1\)/ }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    const head = within(dialog).getByRole("button", { name: /create_ticket/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    await user.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText(/"token": "\[REDACTED\]"/)).toBeInTheDocument();
    expect(within(dialog).getByText(/quota exceeded/)).toBeInTheDocument();
    expect(within(dialog).getByText(/not re-issued on replay/)).toBeInTheDocument();
  });

  it("lets admins delete a cassette", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    vi.mocked(api.fetchMcpCassette).mockResolvedValue({ cassette: makeRecord({ truncated: false }) });
    vi.mocked(api.deleteMcpCassette).mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<McpCassetteViewer cassetteId="cas_9" onClose={onClose} onDeleted={onDeleted} canDelete />);

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(api.deleteMcpCassette).toHaveBeenCalledWith("cas_9");
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("shows load errors and closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(api.fetchMcpCassette).mockRejectedValue(new Error("Cassette not found"));
    render(<McpCassetteViewer cassetteId="nope" onClose={onClose} />);
    expect(await screen.findByText("Cassette not found")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
