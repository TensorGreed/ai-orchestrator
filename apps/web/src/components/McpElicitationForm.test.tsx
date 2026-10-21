import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { McpElicitationView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { McpElicitationForm, credentialLikeFields } from "./McpElicitationForm";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, answerMcpElicitation: vi.fn() };
});

function makeElicitation(overrides: Partial<McpElicitationView> = {}): McpElicitationView {
  return {
    id: "elc_1",
    executionId: "exec_1",
    workflowId: "wf_1",
    workflowName: "Support triage",
    nodeId: "agent",
    serverId: "mock-mcp",
    registryServerId: "mcp_mock",
    serverName: "Mock",
    toolName: "ask_user",
    message: "Which region should the ticket go to?",
    requestedSchema: {
      type: "object",
      properties: {
        region: { type: "string", title: "Region", enum: ["eu", "us"] },
        urgent: { type: "boolean", title: "Urgent" },
        seats: { type: "integer", minimum: 1 }
      },
      required: ["region"]
    },
    status: "pending",
    createdAt: "2026-10-20T10:00:00.000Z",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides
  };
}

describe("McpElicitationForm", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("validates the schema form and sends the typed answer", async () => {
    const user = userEvent.setup();
    const onAnswered = vi.fn();
    const elicitation = makeElicitation();
    vi.mocked(api.answerMcpElicitation).mockResolvedValue({
      elicitation: { ...elicitation, status: "accepted", answeredBy: "ana@example.com" }
    });
    render(<McpElicitationForm elicitation={elicitation} onAnswered={onAnswered} />);

    expect(screen.getByRole("note")).toHaveTextContent("Never type passwords, API keys or other secrets here.");
    expect(screen.getByText("Which region should the ticket go to?")).toBeInTheDocument();
    expect(screen.getByText(/Mock · ask_user · Support triage/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(api.answerMcpElicitation).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText("Region"), "eu");
    await user.selectOptions(screen.getByLabelText("Urgent"), "true");
    await user.type(screen.getByLabelText("seats"), "3");
    await user.click(screen.getByRole("button", { name: "Send answer" }));

    expect(api.answerMcpElicitation).toHaveBeenCalledWith("elc_1", { action: "accept", content: { region: "eu", urgent: true, seats: 3 } });
    expect(onAnswered).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" }));
  });

  it("declines and cancels without sending values", async () => {
    const user = userEvent.setup();
    const elicitation = makeElicitation();
    vi.mocked(api.answerMcpElicitation).mockResolvedValue({ elicitation: { ...elicitation, status: "declined" } });
    render(<McpElicitationForm elicitation={elicitation} />);
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(api.answerMcpElicitation).toHaveBeenCalledWith("elc_1", { action: "decline" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.answerMcpElicitation).toHaveBeenLastCalledWith("elc_1", { action: "cancel" });
  });

  it("refuses credential-looking schemas: no form, no accept", () => {
    const elicitation = makeElicitation({
      requestedSchema: {
        type: "object",
        properties: { username: { type: "string" }, api_token: { type: "string" }, password: { type: "string" } },
        required: ["api_token"]
      }
    });
    expect(credentialLikeFields(elicitation)).toEqual(["api_token", "password"]);
    render(<McpElicitationForm elicitation={elicitation} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This request asks for credentials (api_token, password)");
    expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("username")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });

  it("shows the outcome and reason once the request is settled", () => {
    render(
      <McpElicitationForm
        elicitation={makeElicitation({
          status: "auto_declined",
          reason: "Unattended run (webhook): nobody can answer, declined automatically."
        })}
      />
    );
    expect(screen.getByText("Declined automatically")).toBeInTheDocument();
    expect(screen.getByText(/Unattended run \(webhook\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
  });

  it("surfaces the API's refusal to accept an answer", async () => {
    const user = userEvent.setup();
    const elicitation = makeElicitation({ requestedSchema: { type: "object", properties: { note: { type: "string" } } } });
    vi.mocked(api.answerMcpElicitation).mockRejectedValue(new api.ApiError("This request was already answered.", 409, {}));
    render(<McpElicitationForm elicitation={elicitation} />);
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This request was already answered.");
  });
});
