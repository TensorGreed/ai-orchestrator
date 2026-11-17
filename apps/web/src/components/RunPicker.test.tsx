import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { RunPicker } from "./RunPicker";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchExecutions: vi.fn() };
});

function summary(id: string, startedAt: string, status = "success") {
  return {
    id,
    workflowId: "wf",
    workflowName: "WF",
    status,
    startedAt,
    completedAt: startedAt,
    durationMs: 5,
    triggerType: "manual",
    triggeredBy: null,
    customData: null,
    error: null,
    createdAt: startedAt
  };
}

describe("RunPicker", () => {
  beforeEach(() => {
    vi.mocked(api.fetchExecutions).mockResolvedValue({
      items: [summary("run-2", "2026-01-02T10:00:00.000Z"), summary("run-1", "2026-01-01T10:00:00.000Z", "error")],
      total: 2,
      page: 1,
      pageSize: 10
    } as Awaited<ReturnType<typeof api.fetchExecutions>>);
  });

  it("lists the workflow's recent runs and loads the one picked", async () => {
    const onPick = vi.fn();
    render(<RunPicker workflowId="wf" enabled current={{ executionId: "run-2", startedAt: "2026-01-02T10:00:00.000Z", status: "success" }} onPick={onPick} />);
    const select = await screen.findByLabelText("Run data");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    expect(api.fetchExecutions).toHaveBeenCalledWith({ page: 1, pageSize: 10, workflowId: "wf" });
    expect(select).toHaveValue("run-2");
    expect(select.querySelector("option")!.textContent).toMatch(/^Latest · /);
    await userEvent.selectOptions(select, "run-1");
    expect(onPick).toHaveBeenCalledWith("run-1");
  });

  it("names a run that is not in the list yet (in progress) and shows nothing for an unsaved workflow", async () => {
    const { unmount } = render(<RunPicker workflowId="wf" enabled current={{ startedAt: "2026-01-03T10:00:00.000Z", status: "partial" }} onPick={vi.fn()} />);
    const select = await screen.findByLabelText("Run data");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(3));
    expect(select.querySelector("option")!.textContent).toMatch(/^This run · .* · partial/);
    unmount();
    vi.mocked(api.fetchExecutions).mockClear();
    const { container } = render(<RunPicker workflowId="wf" enabled={false} current={null} onPick={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(api.fetchExecutions).not.toHaveBeenCalled();
  });
});
