import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowBuilderResult } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { WorkflowBuilderDialog, builderModelLabel, readStoredBuilderModel } from "./WorkflowBuilderDialog";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, buildWorkflowFromDescription: vi.fn(), fetchWorkflowBuilderStatus: vi.fn(), fetchSecrets: vi.fn() };
});

const workflow: Workflow = {
  id: "wf-built",
  name: "Order alerts",
  description: "Posts each new order to the shop API",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  projectId: "default",
  nodes: [
    { id: "incoming", type: "webhook_input", name: "Incoming order", position: { x: 120, y: 160 }, config: { path: "orders-ab12" } },
    { id: "post_order", type: "http_request", name: "Post order", position: { x: 420, y: 160 }, config: { urlTemplate: "https://shop.example.com/orders" } }
  ],
  edges: [{ id: "e1", source: "incoming", target: "post_order" }]
} as Workflow;

const ready: WorkflowBuilderResult = {
  status: "ready",
  workflow,
  attempts: 2,
  model: { providerId: "openai", model: "gpt-4o-mini" },
  preview: {
    nodes: [
      { id: "incoming", label: "Incoming order", type: "webhook_input", typeLabel: "Webhook Input" },
      { id: "post_order", label: "Post order", type: "http_request", typeLabel: "HTTP Request" }
    ],
    credentials: [{ nodeId: "post_order", nodeLabel: "Post order", label: "Shop token", hint: "", required: true }],
    unfinished: [{ nodeId: "post_order", message: "HTTP Request needs a body" }],
    addresses: [{ nodeId: "post_order", nodeLabel: "Post order", url: "https://shop.example.com/orders" }],
    notes: ["Left out credential values the model wrote (post_order.apiKey): pick saved credentials on those nodes."]
  }
};

const defaults = {
  defaultModel: { providerId: "openai", model: "gpt-4o-mini" },
  secrets: [{ id: "sec-1", name: "Local LLM key", provider: "openai_compatible", createdAt: "2026-11-01T00:00:00.000Z" }],
  projectId: "default",
  onClose: () => undefined
};

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(api.fetchWorkflowBuilderStatus).mockResolvedValue({ enabled: true });
  vi.mocked(api.fetchSecrets).mockResolvedValue(defaults.secrets);
});

describe("WorkflowBuilderDialog", () => {
  it("builds from a description and previews the draft before creating it", async () => {
    vi.mocked(api.buildWorkflowFromDescription).mockResolvedValue(ready);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowBuilderDialog {...defaults} onCreate={onCreate} onUseTemplate={vi.fn()} />);
    expect(screen.getByTestId("builder-model")).toHaveTextContent("Model: OpenAI · gpt-4o-mini");
    expect(screen.getByRole("button", { name: "Build" })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("What should the workflow do?"), "When an order arrives, post it to the shop");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(api.buildWorkflowFromDescription).toHaveBeenCalledWith(
      { prompt: "When an order arrives, post it to the shop", projectId: "default" },
      expect.any(AbortSignal)
    );

    const preview = screen.getByRole("region", { name: "Preview" });
    expect(within(preview).getByRole("img", { name: "Preview of Order alerts" })).toBeInTheDocument();
    expect(screen.getByTestId("builder-preview-nodes")).toHaveTextContent("Incoming order Webhook Input");
    expect(screen.getByTestId("builder-preview-credentials")).toHaveTextContent("Post order: Shop token");
    expect(screen.getByTestId("builder-preview-unfinished")).toHaveTextContent("needs a body");
    expect(screen.getByTestId("builder-preview-addresses")).toHaveTextContent("https://shop.example.com/orders");
    expect(preview).toHaveTextContent("Left out credential values");
    expect(onCreate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(onCreate).toHaveBeenCalledWith(workflow);
  });

  it("goes back to the description from the preview", async () => {
    vi.mocked(api.buildWorkflowFromDescription).mockResolvedValue(ready);
    render(<WorkflowBuilderDialog {...defaults} onCreate={vi.fn()} onUseTemplate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("What should the workflow do?"), "orders");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit description" }));
    expect(screen.getByLabelText("What should the workflow do?")).toHaveValue("orders");
  });

  it("without a real model explains why and offers templates", async () => {
    vi.mocked(api.buildWorkflowFromDescription).mockResolvedValue({
      status: "needs_model",
      message: "Describing a workflow needs a real model.",
      templates: [
        { id: "t1", name: "Webhook to Slack", description: "Post incoming webhooks" },
        { id: "t2", name: "Nightly report", description: "" },
        { id: "t3", name: "Docs Q&A", description: "" }
      ]
    });
    const onUseTemplate = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowBuilderDialog {...defaults} defaultModel={{ providerId: "echo", model: "echo" }} onCreate={vi.fn()} onUseTemplate={onUseTemplate} />);
    expect(screen.getByTestId("builder-model")).toHaveTextContent("Echo (built-in demo, no key)");
    await userEvent.type(screen.getByLabelText("What should the workflow do?"), "post webhooks to slack");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    const callout = screen.getByTestId("builder-needs-model");
    expect(callout).toHaveTextContent("needs a real model");
    expect(within(callout).getAllByRole("button", { name: "Use template" })).toHaveLength(3);
    await userEvent.click(within(callout).getAllByRole("button", { name: "Use template" })[0]!);
    expect(onUseTemplate).toHaveBeenCalledWith("t1");
  });

  it("shows the model's question and a failed build's problems", async () => {
    vi.mocked(api.buildWorkflowFromDescription)
      .mockResolvedValueOnce({ status: "question", question: "Which channel?", model: { providerId: "openai", model: "m" } })
      .mockResolvedValueOnce({ status: "failed", message: "Still had problems", issues: [{ message: "unknown node type 'x'" }], attempts: 3, model: { providerId: "openai", model: "m" } })
      .mockRejectedValueOnce(new Error("The model took too long"));
    render(<WorkflowBuilderDialog {...defaults} onCreate={vi.fn()} onUseTemplate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("What should the workflow do?"), "notify");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(screen.getByRole("status")).toHaveTextContent("The model asks: Which channel?");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(screen.getByRole("alert")).toHaveTextContent("unknown node type 'x'");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The model took too long");
  });

  it("uses another model chosen under More and keeps the choice (never a key) in this browser", async () => {
    vi.mocked(api.buildWorkflowFromDescription).mockResolvedValue({ status: "question", question: "?", model: { providerId: "openai_compatible", model: "local" } });
    render(<WorkflowBuilderDialog {...defaults} onCreate={vi.fn()} onUseTemplate={vi.fn()} />);
    await userEvent.click(screen.getByText("More"));
    await userEvent.selectOptions(screen.getByLabelText("Provider"), "openai_compatible");
    await userEvent.type(screen.getByLabelText("Model"), "local");
    await userEvent.type(screen.getByLabelText("Base URL"), "http://127.0.0.1:8000/v1");
    await userEvent.selectOptions(screen.getByLabelText("Credential"), "sec-1");
    expect(screen.getByTestId("builder-model")).toHaveTextContent("OpenAI Compatible · local");
    await userEvent.type(screen.getByLabelText("What should the workflow do?"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(api.buildWorkflowFromDescription).toHaveBeenCalledWith(
      {
        prompt: "x",
        projectId: "default",
        model: { providerId: "openai_compatible", model: "local", baseUrl: "http://127.0.0.1:8000/v1", secretRef: { secretId: "sec-1" } }
      },
      expect.any(AbortSignal)
    );
    expect(readStoredBuilderModel()).toEqual({ providerId: "openai_compatible", model: "local", baseUrl: "http://127.0.0.1:8000/v1", secretRef: { secretId: "sec-1" } });

    await userEvent.click(screen.getByRole("button", { name: "Use the default model" }));
    expect(readStoredBuilderModel()).toBeNull();
    expect(screen.getByTestId("builder-model")).toHaveTextContent("OpenAI · gpt-4o-mini");
  });

  it("shows the model the server says a build in the project uses", async () => {
    vi.mocked(api.fetchWorkflowBuilderStatus).mockResolvedValue({ enabled: true, defaultModel: { providerId: "anthropic", model: "claude-x" } });
    render(<WorkflowBuilderDialog {...defaults} defaultModel={{ providerId: "echo", model: "echo" }} onCreate={vi.fn()} onUseTemplate={vi.fn()} />);
    expect(api.fetchWorkflowBuilderStatus).toHaveBeenCalledWith("default");
    expect(await screen.findByText("Model: Anthropic · claude-x")).toBeInTheDocument();
  });

  it("shows the saved credential the default model uses, not None (the validation's B14)", async () => {
    const saved = { id: "sec-ant", name: "Team Anthropic key", provider: "anthropic", createdAt: "2026-11-01T00:00:00.000Z" };
    vi.mocked(api.fetchSecrets).mockResolvedValue([saved]);
    vi.mocked(api.fetchWorkflowBuilderStatus).mockResolvedValue({
      enabled: true,
      defaultModel: { providerId: "anthropic", model: "claude-x", secretRef: { secretId: "sec-ant" } }
    });
    // The studio's default (loaded before the server answered) agrees on the model but had no credential.
    render(<WorkflowBuilderDialog {...defaults} defaultModel={{ providerId: "anthropic", model: "claude-x" }} onCreate={vi.fn()} onUseTemplate={vi.fn()} />);
    expect(await screen.findByText("Model: Anthropic · claude-x")).toBeInTheDocument();
    const credential = screen.getByLabelText<HTMLSelectElement>("Credential");
    await vi.waitFor(() => expect(credential.value).toBe("sec-ant"));
    expect(credential.selectedOptions[0]!.textContent).toBe("Team Anthropic key (anthropic)");
  });

  it("says the server's key is used when the default model's key comes from the server", async () => {
    vi.mocked(api.fetchWorkflowBuilderStatus).mockResolvedValue({ enabled: true, defaultModel: { providerId: "openai", model: "gpt-4o-mini" } });
    render(<WorkflowBuilderDialog {...defaults} onCreate={vi.fn()} onUseTemplate={vi.fn()} />);
    const credential = screen.getByLabelText<HTMLSelectElement>("Credential");
    await vi.waitFor(() => expect(credential.selectedOptions[0]!.textContent).toBe("The server's key"));
  });

  it("another provider drops the base URL and a credential saved for a different provider; a deleted credential is not sent", async () => {
    vi.mocked(api.buildWorkflowFromDescription).mockResolvedValue({ status: "question", question: "?", model: { providerId: "openai", model: "m" } });
    window.localStorage.setItem(
      "l2m:builder-model:u1",
      JSON.stringify({ providerId: "openai_compatible", model: "local", baseUrl: "http://127.0.0.1:8000/v1", secretRef: { secretId: "gone" } })
    );
    render(<WorkflowBuilderDialog {...defaults} userId="u1" onCreate={vi.fn()} onUseTemplate={vi.fn()} />);
    expect(screen.getByTestId("builder-model")).toHaveTextContent("OpenAI Compatible · local");
    await screen.findByRole("option", { name: "Local LLM key (openai_compatible)" });
    await userEvent.type(screen.getByLabelText("What should the workflow do?"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(vi.mocked(api.buildWorkflowFromDescription).mock.calls[0]![0].model).toEqual({
      providerId: "openai_compatible",
      model: "local",
      baseUrl: "http://127.0.0.1:8000/v1"
    });

    await userEvent.click(screen.getByText("More"));
    await userEvent.selectOptions(screen.getByLabelText("Credential"), "sec-1");
    await userEvent.selectOptions(screen.getByLabelText("Provider"), "openai");
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    expect(readStoredBuilderModel("u1")).toEqual({ providerId: "openai", model: "gpt-4o-mini" });
    // Another person in this browser does not get this choice.
    expect(readStoredBuilderModel("u2")).toBeNull();
  });

  it("closing while it builds stops the build", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(api.buildWorkflowFromDescription).mockImplementation((_payload, given) => {
      signal = given;
      return new Promise(() => undefined);
    });
    const onClose = vi.fn();
    const { unmount } = render(<WorkflowBuilderDialog {...defaults} onCreate={vi.fn()} onUseTemplate={vi.fn()} onClose={onClose} />);
    await userEvent.type(screen.getByLabelText("What should the workflow do?"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("says so when a model spending limit refuses the build", async () => {
    const message =
      'The model spending limit "Default project tokens" is used up for this month, and describing a workflow uses the model too. Try again when the limit resets, or ask an admin to raise it.';
    vi.mocked(api.buildWorkflowFromDescription).mockRejectedValue(new api.ApiError(message, 402, { error: message, code: "budget_exceeded" }));
    render(<WorkflowBuilderDialog {...defaults} onCreate={vi.fn()} onUseTemplate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("What should the workflow do?"), "orders");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("labels models", () => {
    expect(builderModelLabel({ providerId: "echo", model: "echo" })).toBe("Echo (built-in demo, no key)");
    expect(builderModelLabel({ providerId: "anthropic", model: "claude-x" })).toBe("Anthropic · claude-x");
  });
});
