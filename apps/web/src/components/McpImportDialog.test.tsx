import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { McpConfigImportResponse, McpImportEntryView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { McpImportDialog } from "./McpImportDialog";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, importMcpConfig: vi.fn() };
});

const CONFIG = JSON.stringify({
  inputs: [{ id: "kb-token", type: "promptString", password: true }],
  servers: {
    files: { type: "stdio", command: "npx", args: ["-y", "fs@1.0.0"], env: { FS_TOKEN: "literal-file-token" } },
    kb: { type: "http", url: "https://kb.example.test/mcp", headers: { Authorization: "Bearer ${input:kb-token}" } }
  }
});

function entry(overrides: Partial<McpImportEntryView>): McpImportEntryView {
  return {
    key: "files",
    name: "files",
    adapterId: "stdio_mcp",
    transport: "stdio",
    connection: { command: "npx", args: ["-y", "fs@1.0.0"], secretEnvVar: "FS_TOKEN" },
    secretMode: "single",
    slots: [
      { id: "env:FS_TOKEN", kind: "secret", target: "env", name: "FS_TOKEN", origin: "literal", needsValue: false, provided: false }
    ],
    report: [{ field: "env.FS_TOKEN", status: "mapped", message: "Credential moved to a secret." }],
    status: "mapped",
    disabledInSource: false,
    duplicate: null,
    decision: "create",
    blockedReason: null,
    ...overrides
  };
}

const kbEntry = entry({
  key: "kb",
  name: "kb",
  adapterId: "http_mcp",
  transport: "http",
  connection: { endpoint: "https://kb.example.test/mcp", transport: "http_streamable", authType: "bearer" },
  slots: [
    {
      id: "header:Authorization",
      kind: "secret",
      target: "header",
      name: "Authorization",
      origin: "input",
      inputId: "kb-token",
      needsValue: true,
      provided: false
    }
  ],
  report: [
    { field: "headers.Authorization", status: "mapped", message: "Prompted value becomes a secret." },
    { field: "autoApprove", status: "skipped", message: "Tool auto-approval is not imported." }
  ],
  status: "approximated",
  duplicate: { serverId: "mcp_kb", serverName: "Knowledge base", match: "url" },
  decision: "skip",
  blockedReason: "Values needed: Authorization."
});

function previewResponse(entries: McpImportEntryView[], dryRun = true): McpConfigImportResponse {
  return {
    dryRun,
    format: "servers_inputs",
    sourceName: null,
    entries,
    summary: { total: entries.length, mapped: 1, approximated: 1, skipped: 0, create: 1, update: 0, copy: 0, skip: 1, blocked: 0 },
    warnings: []
  };
}

describe("McpImportDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("previews a pasted config, collects decisions and secret values, then imports", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    vi.mocked(api.importMcpConfig).mockImplementation(async (payload) => {
      if (payload.dryRun) {
        const decision = payload.entries?.kb?.decision;
        return previewResponse([entry({}), { ...kbEntry, decision: decision ?? "skip", name: decision === "update" ? "Knowledge base" : "kb" }]);
      }
      return {
        ...previewResponse(
          [
            { ...entry({}), result: { action: "created", serverId: "mcp_new" } },
            { ...kbEntry, decision: "update", result: { action: "updated", serverId: "mcp_kb" } }
          ],
          false
        ),
        servers: []
      };
    });

    render(<McpImportDialog open canImport projectId="default" onClose={vi.fn()} onImported={onImported} />);
    fireEvent.change(screen.getByLabelText("Config JSON"), { target: { value: CONFIG } });
    await user.click(screen.getByRole("button", { name: "Preview" }));

    const kb = await screen.findByTestId("import-entry-kb");
    expect(within(kb).getByText(/Matches registered server/)).toBeInTheDocument();
    expect(within(kb).getByText(/1 field not mapped one to one/)).toBeInTheDocument();
    // The duplicate is skipped by default, so only one server is importable.
    expect(screen.getByRole("button", { name: "Import 1 server" })).toBeEnabled();

    await user.selectOptions(within(kb).getByLabelText("What to do with kb"), "update");
    await waitFor(() => expect(api.importMcpConfig).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.importMcpConfig).mock.calls[1]![0]).toMatchObject({ dryRun: true, entries: { kb: { decision: "update" } } });

    // A prompted secret is needed before the entry can be imported.
    const refreshed = await screen.findByTestId("import-entry-kb");
    expect(within(refreshed).getByText("Needed to import: Authorization")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import 2 servers|Import 1 server/ })).toBeDisabled();
    const secretInput = within(refreshed).getByLabelText(/Authorization/);
    expect(secretInput).toHaveAttribute("type", "password");
    await user.type(secretInput, "typed-kb-token");
    await user.click(screen.getByRole("button", { name: "Import 2 servers" }));

    await waitFor(() => expect(api.importMcpConfig).toHaveBeenCalledTimes(3));
    const finalPayload = vi.mocked(api.importMcpConfig).mock.calls[2]![0];
    expect(finalPayload.dryRun).toBeUndefined();
    expect(finalPayload.projectId).toBe("default");
    expect(finalPayload.entries).toEqual({
      files: { decision: "create" },
      kb: { decision: "update", values: { "header:Authorization": "typed-kb-token" } }
    });
    // Preview requests never carry values.
    for (const call of vi.mocked(api.importMcpConfig).mock.calls.slice(0, 2)) {
      expect(JSON.stringify(call[0].entries ?? {})).not.toContain("typed-kb-token");
    }
    expect(await screen.findByText(/Imported 1 new and updated 1 existing server/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("typed-kb-token")).not.toBeInTheDocument();
    expect(onImported).toHaveBeenCalled();
  });

  it("is preview-only for non-admins", async () => {
    const user = userEvent.setup();
    vi.mocked(api.importMcpConfig).mockResolvedValue(previewResponse([entry({})]));
    render(<McpImportDialog open canImport={false} onClose={vi.fn()} onImported={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Config JSON"), { target: { value: CONFIG } });
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/Preview only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();
  });

  it("shows the server's message for an unreadable file", async () => {
    const user = userEvent.setup();
    vi.mocked(api.importMcpConfig).mockRejectedValue(new api.ApiError("The file is not valid JSON: Unexpected token", 400, {}));
    render(<McpImportDialog open canImport onClose={vi.fn()} onImported={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Config JSON"), { target: { value: "{ nope" } });
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not valid JSON");
  });

  it("reads a chosen file", async () => {
    vi.mocked(api.importMcpConfig).mockResolvedValue(previewResponse([entry({})]));
    render(<McpImportDialog open canImport onClose={vi.fn()} onImported={vi.fn()} />);
    const file = new File([CONFIG], "mcp.json", { type: "application/json" });
    // jsdom's File may lack text(); the dialog reads files through it.
    Object.defineProperty(file, "text", { value: async () => CONFIG });
    fireEvent.change(screen.getByTestId("mcp-import-file-input"), { target: { files: [file] } });
    await waitFor(() => expect(api.importMcpConfig).toHaveBeenCalledWith(expect.objectContaining({ fileName: "mcp.json", dryRun: true })));
    expect(await screen.findByText(/Preview of “mcp.json”/)).toBeInTheDocument();
  });
});
