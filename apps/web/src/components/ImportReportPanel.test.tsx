import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ImportReport } from "@ai-orchestrator/shared";
import { ImportReportPanel } from "./ImportReportPanel";
import type { ImportChecklistNode } from "../lib/external-import";

const REPORT: ImportReport = {
  sourceName: "Lead router",
  nodes: [
    { sourceName: "Ping CRM", sourceType: "acme.http", targetNodeId: "ping", targetType: "http_request", status: "approximated", reason: "Retry settings dropped." },
    { sourceName: "Chat", sourceType: "acme.chatApp", targetNodeId: "chat", targetType: "noop_node", status: "unsupported", reason: "No equivalent node." }
  ],
  unresolvedExpressions: [{ nodeId: "ping", sourceName: "Ping CRM", path: "urlTemplate", expression: "$odd()", reason: "Unknown helper." }],
  secretsToResolve: [{ secretId: "import-crm", credentialType: "apiKey", credentialName: "CRM key", nodeIds: ["ping"] }],
  variablesToSet: ["CRM_BASE"],
  warnings: [],
  summary: { total: 2, mapped: 0, approximated: 1, unsupported: 1 }
};

const NODES: ImportChecklistNode[] = [
  { id: "ping", type: "http_request", label: "Ping CRM", config: { urlTemplate: "{{ $odd() }}", secretRef: { secretId: "import-crm" } } },
  { id: "chat", type: "noop_node", label: "Chat", config: {} }
];

function renderPanel(overrides: Partial<Parameters<typeof ImportReportPanel>[0]> = {}) {
  const props = {
    report: REPORT,
    nodes: NODES,
    variables: {},
    secrets: [{ id: "sec_1", name: "CRM production", provider: "generic" }],
    onLinkSecret: vi.fn(),
    onOpenSecrets: vi.fn(),
    onOpenVariables: vi.fn(),
    onFocusNode: vi.fn(),
    onTidy: vi.fn(),
    onValidate: vi.fn(async () => ({ valid: true, issues: [] })),
    onDismiss: vi.fn(),
    ...overrides
  };
  render(<ImportReportPanel {...props} />);
  return props;
}

describe("ImportReportPanel", () => {
  it("lists what is left to do with progress", () => {
    renderPanel();
    expect(screen.getByRole("complementary", { name: "Import checklist" })).toBeInTheDocument();
    expect(screen.getByText("0 of 4 done")).toBeInTheDocument();
    expect(screen.getByText("Link credentials")).toBeInTheDocument();
    expect(screen.getByText("Fill in variables")).toBeInTheDocument();
    expect(screen.getByText("Rewrite expressions")).toBeInTheDocument();
    expect(screen.getByText("Replace placeholders")).toBeInTheDocument();
    expect(screen.getByText("Finish the import")).toBeInTheDocument();
  });

  it("links a placeholder credential to a stored secret", async () => {
    const user = userEvent.setup();
    const props = renderPanel();
    await user.selectOptions(screen.getByRole("combobox", { name: "Secret for CRM key" }), "sec_1");
    expect(props.onLinkSecret).toHaveBeenCalledWith("import-crm", "sec_1");
  });

  it("ticks items off from the live workflow", () => {
    renderPanel({
      nodes: [{ id: "ping", type: "http_request", label: "Ping CRM", config: { urlTemplate: "{{results.start.url}}", secretRef: { secretId: "sec_1" } } }],
      variables: { CRM_BASE: "https://crm.example" }
    });
    expect(screen.getByText("4 of 4 done")).toBeInTheDocument();
    expect(screen.getByText("Ready to run")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("focuses nodes, tidies and opens the related pages", async () => {
    const user = userEvent.setup();
    const props = renderPanel();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(props.onFocusNode).toHaveBeenCalledWith("chat");
    await user.click(screen.getByRole("button", { name: "Tidy layout" }));
    expect(props.onTidy).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Manage secrets" }));
    expect(props.onOpenSecrets).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open variables" }));
    expect(props.onOpenVariables).toHaveBeenCalled();
  });

  it("hides the secrets link for roles that cannot open it", () => {
    renderPanel({ onOpenSecrets: undefined });
    expect(screen.queryByRole("button", { name: "Manage secrets" })).not.toBeInTheDocument();
  });

  it("validates and shows the issues with links to nodes", async () => {
    const user = userEvent.setup();
    const props = renderPanel({
      onValidate: vi.fn(async () => ({ valid: false, issues: [{ code: "missing_input", message: "has no input edge", nodeId: "chat" }] }))
    });
    await user.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText(/Validation found 1 issue/)).toBeInTheDocument();
    const chatLinks = screen.getAllByRole("button", { name: "Chat" });
    await user.click(chatLinks[chatLinks.length - 1]);
    expect(props.onFocusNode).toHaveBeenCalledWith("chat");
  });

  it("reports a passing validation", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText(/Saved and valid/)).toBeInTheDocument();
  });

  it("surfaces a validation request failure", async () => {
    const user = userEvent.setup();
    renderPanel({ onValidate: vi.fn(async () => Promise.reject(new Error("Save failed"))) });
    await user.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText("Save failed")).toBeInTheDocument();
  });

  it("minimises to a pill and can be dismissed", async () => {
    const user = userEvent.setup();
    const props = renderPanel();
    await user.click(screen.getByRole("button", { name: "Minimise import checklist" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show import checklist" }));
    await user.click(screen.getByRole("button", { name: "Dismiss import checklist" }));
    expect(props.onDismiss).toHaveBeenCalled();
  });
});
