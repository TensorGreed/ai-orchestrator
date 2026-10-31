import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteToolApprovalSettings } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { WriteToolApprovalDialog } from "./WriteToolApprovalDialog";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, checkApprovalEligibility: vi.fn(), fetchUntrustedWriteSwitch: vi.fn(), setUntrustedWriteSwitch: vi.fn() };
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

  it("turns the untrusted-content switch on at once, on the server", async () => {
    const off = { enabled: false, ruleId: "mtp_wf_untrusted_writes_wf-1" };
    vi.mocked(api.fetchUntrustedWriteSwitch).mockResolvedValue({ switch: off });
    vi.mocked(api.setUntrustedWriteSwitch).mockResolvedValue({ switch: { ...off, enabled: true, mode: "enforce", ruleEnabled: true, customised: false } });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByLabelText("Approve writes only after untrusted content");
    await waitFor(() => expect(box).toBeEnabled());
    await userEvent.click(box);
    expect(api.setUntrustedWriteSwitch).toHaveBeenCalledWith("wf-1", true);
    await waitFor(() => expect(box).toBeChecked());
    // Not a workflow setting: the workflow itself is unchanged.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("asks to save first when the workflow is not saved, and shows a refusal", async () => {
    vi.mocked(api.fetchUntrustedWriteSwitch).mockRejectedValueOnce(new api.ApiError("Workflow not found", 404));
    const { unmount } = render(<Harness onChange={() => undefined} />);
    expect(await screen.findByText(/Save the workflow first/)).toBeInTheDocument();
    expect(screen.getByLabelText("Approve writes only after untrusted content")).toBeDisabled();
    unmount();

    vi.mocked(api.fetchUntrustedWriteSwitch).mockResolvedValue({ switch: { enabled: false, ruleId: "r" } });
    vi.mocked(api.setUntrustedWriteSwitch).mockRejectedValue(new api.ApiError("It would set aside the enforced deny 'No writes'", 409));
    render(<Harness onChange={() => undefined} />);
    const box = screen.getByLabelText("Approve writes only after untrusted content");
    await waitFor(() => expect(box).toBeEnabled());
    await userEvent.click(box);
    expect(await screen.findByText(/No writes/)).toBeInTheDocument();
    expect(box).not.toBeChecked();
  });
});
