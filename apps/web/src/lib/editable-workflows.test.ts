import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { useEditableWorkflows } from "./editable-workflows";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, fetchWorkflowAccess: vi.fn() };
});

describe("useEditableWorkflows", () => {
  it("asks a builder's access once per workflow and answers false until it is known", async () => {
    const fetchAccess = vi.mocked(api.fetchWorkflowAccess);
    fetchAccess.mockImplementation(async (workflowId: string) => ({
      workflowId,
      role: "builder",
      canRead: true,
      canEdit: workflowId === "wf-edit",
      canRun: true,
      canShare: false
    }));
    const { result } = renderHook(() => useEditableWorkflows("builder", ["wf-edit", "wf-run", "wf-edit"]));
    expect(result.current("wf-edit")).toBe(false);
    await waitFor(() => expect(result.current("wf-edit")).toBe(true));
    expect(result.current("wf-run")).toBe(false);
    expect(fetchAccess).toHaveBeenCalledTimes(2);
  });

  it("answers by role for admins, operators and viewers without asking", () => {
    const fetchAccess = vi.mocked(api.fetchWorkflowAccess);
    fetchAccess.mockClear();
    expect(renderHook(() => useEditableWorkflows("admin", ["wf"])).result.current("wf")).toBe(true);
    expect(renderHook(() => useEditableWorkflows("operator", ["wf"])).result.current("wf")).toBe(false);
    expect(renderHook(() => useEditableWorkflows("viewer", ["wf"])).result.current("wf")).toBe(false);
    expect(fetchAccess).not.toHaveBeenCalled();
  });
});
