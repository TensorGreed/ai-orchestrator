import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ImportReport, Workflow } from "@ai-orchestrator/shared";
import { ExternalImportDialog } from "./ExternalImportDialog";
import type { ExternalImportResponse } from "../lib/api";

const EXTERNAL_TEXT = JSON.stringify({ name: "Lead router", nodes: [{ name: "Start", type: "acme.manual" }], connections: {} });

function makeResponse(overrides: Partial<ImportReport> = {}): ExternalImportResponse {
  const report: ImportReport = {
    sourceName: "Lead router",
    nodes: [
      { sourceName: "Start", sourceType: "acme.manual", targetNodeId: "start", targetType: "manual_trigger", status: "mapped", reason: "Mapped directly." },
      { sourceName: "Ping CRM", sourceType: "acme.http", targetNodeId: "ping", targetType: "http_request", status: "approximated", reason: "Retry settings dropped." },
      { sourceName: "Chat", sourceType: "acme.chatApp", targetNodeId: "chat", targetType: "noop_node", status: "unsupported", reason: "No equivalent node." }
    ],
    unresolvedExpressions: [],
    secretsToResolve: [{ secretId: "import-x", credentialType: "apiKey", credentialName: "CRM key", nodeIds: ["ping"] }],
    variablesToSet: [],
    warnings: ["Pinned data was dropped."],
    summary: { total: 3, mapped: 1, approximated: 1, unsupported: 1 },
    ...overrides
  };
  return { workflow: { id: "lead-router", name: "Lead router" } as Workflow, report, dryRun: true };
}

function renderDialog(overrides: Partial<Parameters<typeof ExternalImportDialog>[0]> = {}) {
  const props = {
    open: true,
    projectName: "Sales",
    onPreview: vi.fn(async () => makeResponse()),
    onImport: vi.fn(async () => undefined),
    onNativeFile: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  };
  render(<ExternalImportDialog {...props} />);
  return props;
}

describe("ExternalImportDialog", () => {
  it("previews pasted JSON and imports it under the edited name", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    expect(screen.getByRole("dialog", { name: "Import from another builder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    await user.click(screen.getByRole("textbox"));
    await user.paste(EXTERNAL_TEXT);
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(props.onPreview).toHaveBeenCalledWith(EXTERNAL_TEXT);
    expect(await screen.findByText(/1 credential to link/)).toBeInTheDocument();
    expect(screen.getByText("No equivalent node.")).toBeInTheDocument();
    expect(screen.getByText("Pinned data was dropped.")).toBeInTheDocument();
    expect(screen.getByText("Imports into Sales")).toBeInTheDocument();

    const name = screen.getByRole("textbox", { name: "Workflow name" });
    expect(name).toHaveValue("Lead router");
    await user.clear(name);
    await user.type(name, "Leads v2");
    await user.click(screen.getByRole("button", { name: "Import workflow" }));
    expect(props.onImport).toHaveBeenCalledWith(EXTERNAL_TEXT, "Leads v2");
  });

  it("previews a dropped file straight away", async () => {
    const props = renderDialog({ initialSource: { text: EXTERNAL_TEXT, fileName: "leads.json" } });
    await waitFor(() => expect(props.onPreview).toHaveBeenCalledWith(EXTERNAL_TEXT));
    expect(await screen.findByRole("button", { name: "Import workflow" })).toBeInTheDocument();
  });

  it("says when every node converts cleanly", async () => {
    const clean = makeResponse({
      nodes: [{ sourceName: "Start", sourceType: "acme.manual", targetNodeId: "start", targetType: "manual_trigger", status: "mapped", reason: "Mapped directly." }],
      secretsToResolve: [],
      warnings: [],
      summary: { total: 1, mapped: 1, approximated: 0, unsupported: 0 }
    });
    renderDialog({ initialSource: { text: EXTERNAL_TEXT }, onPreview: vi.fn(async () => clean) });
    expect(await screen.findByText(/Every node converts cleanly/)).toBeInTheDocument();
  });

  it("hands L2M exports to the regular import", async () => {
    const native = JSON.stringify({ nodes: [], edges: [] });
    const props = renderDialog({ initialSource: { text: native } });
    await waitFor(() => expect(props.onNativeFile).toHaveBeenCalledWith({ text: native }));
    expect(props.onPreview).not.toHaveBeenCalled();
  });

  it("explains invalid JSON and unrecognised files without calling the API", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(screen.getByRole("textbox"));
    await user.paste("{broken");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("alert")).toHaveTextContent("not valid JSON");

    await user.clear(screen.getByRole("textbox"));
    await user.paste('{"hello":1}');
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("alert")).toHaveTextContent("does not look like a workflow export");
    expect(props.onPreview).not.toHaveBeenCalled();
  });

  it("shows conversion errors from the server", async () => {
    renderDialog({
      initialSource: { text: EXTERNAL_TEXT },
      onPreview: vi.fn(async () => {
        throw new Error("Node #1 has no 'type'.");
      })
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Node #1 has no 'type'.");
  });

  it("keeps the dialog open with the error when the import fails", async () => {
    const onImport = vi.fn(async () => {
      throw new Error("You do not have access to this project");
    });
    const user = userEvent.setup();
    renderDialog({ initialSource: { text: EXTERNAL_TEXT }, onImport });
    await user.click(await screen.findByRole("button", { name: "Import workflow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access to this project");
    expect(screen.getByRole("button", { name: "Import workflow" })).toBeEnabled();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });
});
