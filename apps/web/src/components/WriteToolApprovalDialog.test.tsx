import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteToolApprovalSettings } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { WriteToolApprovalDialog } from "./WriteToolApprovalDialog";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, checkApprovalEligibility: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks();
});

function Harness({ initial, onChange }: { initial?: WriteToolApprovalSettings; onChange: (settings: WriteToolApprovalSettings) => void }) {
  const [settings, setSettings] = useState(initial);
  return (
    <WriteToolApprovalDialog
      workflowId="wf-1"
      projectId="default"
      settings={settings}
      onChange={(next) => {
        setSettings(next);
        onChange(next);
      }}
      onClose={() => undefined}
    />
  );
}

describe("WriteToolApprovalDialog", () => {
  it("turns the gate on with self-approval off by default, and offers the self-approval option", async () => {
    vi.mocked(api.checkApprovalEligibility).mockResolvedValue({ othersCanApprove: true, requesterCanApprove: false });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByLabelText("Let the person who started the run approve it")).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Ask for approval before write tools"));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true });
    await userEvent.click(screen.getByLabelText("Let the person who started the run approve it"));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, allowSelfApproval: true });
    await userEvent.click(screen.getByLabelText("admin"));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, allowSelfApproval: true, approverRoles: ["admin"] });
    await waitFor(() => expect(api.checkApprovalEligibility).toHaveBeenCalledWith({ workflowId: "wf-1", projectId: "default", approverRoles: ["admin"], approverUsers: [], allowSelfApproval: true }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when nobody but the requester could approve", async () => {
    vi.mocked(api.checkApprovalEligibility).mockResolvedValue({ othersCanApprove: false, requesterCanApprove: false });
    render(<Harness initial={{ enabled: true }} onChange={() => undefined} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Nobody can approve your runs/);
  });

  it("asks nothing while the gate is off", async () => {
    render(<Harness initial={{ enabled: false }} onChange={() => undefined} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.checkApprovalEligibility).not.toHaveBeenCalled();
  });
});
