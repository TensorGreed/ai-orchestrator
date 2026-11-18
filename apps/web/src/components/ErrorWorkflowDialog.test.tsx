import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorWorkflowDialog } from "./ErrorWorkflowDialog";

const WORKFLOWS = [
  { id: "wf-1", name: "Order intake" },
  { id: "wf-alerts", name: "Failure alerts" },
  { id: "wf-cleanup", name: "Clean up" }
];

function Harness({ initial, onChange }: { initial?: string; onChange: (id: string | undefined) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ErrorWorkflowDialog
      workflowId="wf-1"
      errorWorkflowId={value}
      workflows={WORKFLOWS}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      onClose={() => undefined}
    />
  );
}

describe("ErrorWorkflowDialog", () => {
  it("lists the other workflows, sets one and turns it off again", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const select = screen.getByLabelText("Run on failure");
    expect(select).toHaveValue("");
    const names = Array.from((select as HTMLSelectElement).options).map((option) => option.textContent);
    // The workflow itself is not offered.
    expect(names).toEqual(["None", "Failure alerts", "Clean up"]);
    await userEvent.selectOptions(select, "wf-alerts");
    expect(onChange).toHaveBeenLastCalledWith("wf-alerts");
    expect(select).toHaveValue("wf-alerts");
    await userEvent.selectOptions(select, "");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps a saved id that is not in the list visible", () => {
    render(<Harness initial="wf-shared-elsewhere" onChange={vi.fn()} />);
    expect(screen.getByLabelText("Run on failure")).toHaveValue("wf-shared-elsewhere");
    expect(screen.getByText(/not in the list of this project's workflows/, { selector: ".cfg-help" })).toBeInTheDocument();
  });

  it("closes with Done and with Escape", async () => {
    const onClose = vi.fn();
    render(<ErrorWorkflowDialog workflowId="wf-1" errorWorkflowId={undefined} workflows={WORKFLOWS} onChange={vi.fn()} onClose={onClose} />);
    // Focus starts on the picker.
    expect(screen.getByLabelText("Run on failure")).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps focus where the user put it when the host re-renders with a new onClose", async () => {
    const { rerender } = render(<ErrorWorkflowDialog workflowId="wf-1" errorWorkflowId={undefined} workflows={WORKFLOWS} onChange={vi.fn()} onClose={() => undefined} />);
    const done = screen.getByRole("button", { name: "Done" });
    done.focus();
    const onClose = vi.fn();
    rerender(<ErrorWorkflowDialog workflowId="wf-1" errorWorkflowId="wf-alerts" workflows={WORKFLOWS} onChange={vi.fn()} onClose={onClose} />);
    expect(done).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the element that opened it when it closes", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<ErrorWorkflowDialog workflowId="wf-1" errorWorkflowId={undefined} workflows={WORKFLOWS} onChange={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Run on failure")).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
