import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { apiErrorText, splitDraftIssues, validationMessagesOf } from "../lib/draft-validation";
import { DraftWarnings } from "./DraftWarnings";

describe("apiErrorText", () => {
  const output = "Workflow must include at least one Output node.";

  it("does not repeat an issue the message already names (the API's save error lists them)", () => {
    const payload = { validation: { issues: [{ code: "x", message: output }] } };
    expect(apiErrorText(`Workflow validation failed: ${output}`, payload)).toBe(`Workflow validation failed: ${output}`);
  });

  it("adds the issues the message leaves out, once each", () => {
    const payload = { validation: { issues: [{ code: "a", message: "A is wrong." }, { code: "b", message: "B is wrong." }, { code: "b", message: "B is wrong." }] } };
    expect(apiErrorText("Import failed", payload)).toBe("Import failed: A is wrong.; B is wrong.");
    expect(apiErrorText("Import failed: A is wrong.", payload)).toBe("Import failed: A is wrong.: B is wrong.");
  });

  it("keeps a message without validation as it is", () => {
    expect(apiErrorText("Insufficient permissions", {})).toBe("Insufficient permissions");
    expect(validationMessagesOf(undefined)).toEqual([]);
  });
});

describe("DraftWarnings", () => {
  const issues = [
    { code: "missing_http_request_url_template", message: "HTTP Request node requires a non-empty urlTemplate.", nodeId: "http-1" },
    { code: "missing_output_node", message: "No Output node: the run's result is the output of the last node that runs.", severity: "warning" as const }
  ];

  it("splits what stops a run from notes", () => {
    const split = splitDraftIssues(issues);
    expect(split.toFix.map((issue) => issue.code)).toEqual(["missing_http_request_url_template"]);
    expect(split.notes.map((issue) => issue.code)).toEqual(["missing_output_node"]);
  });

  it("renders nothing without issues", () => {
    const { container } = render(<DraftWarnings issues={[]} nodeLabel={() => undefined} onDismiss={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the settings to finish, names their node, and opens it on click", async () => {
    const onSelectNode = vi.fn();
    const onDismiss = vi.fn();
    render(<DraftWarnings issues={issues} nodeLabel={(id) => (id === "http-1" ? "Post order" : undefined)} onSelectNode={onSelectNode} onDismiss={onDismiss} />);
    const banner = screen.getByTestId("draft-warnings");
    expect(banner).toHaveTextContent("Unfinished draft. One setting needs finishing before this workflow can run or be published");
    expect(banner).toHaveTextContent("HTTP Request node requires a non-empty urlTemplate.");
    expect(banner).toHaveTextContent("No Output node");
    await userEvent.click(screen.getByRole("button", { name: "Post order" }));
    expect(onSelectNode).toHaveBeenCalledWith("http-1");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("says live triggers are paused only when the API says production would run this unfinished version", () => {
    const { rerender } = render(<DraftWarnings issues={issues} nodeLabel={() => undefined} onDismiss={() => undefined} />);
    expect(screen.queryByTestId("live-triggers-paused")).toBeNull();
    rerender(<DraftWarnings issues={issues} liveTriggersPaused nodeLabel={() => undefined} onDismiss={() => undefined} />);
    expect(screen.getByTestId("live-triggers-paused")).toHaveTextContent("Live triggers (webhooks, schedules, forms and app triggers) are paused until it is finished");
    // Shown even when the draft lists nothing left to finish (production's version is the unfinished one).
    rerender(<DraftWarnings issues={[]} liveTriggersPaused nodeLabel={() => undefined} onDismiss={() => undefined} />);
    expect(screen.getByTestId("live-triggers-paused")).toBeInTheDocument();
  });

  it("shows notes alone without the draft heading", () => {
    render(<DraftWarnings issues={[issues[1]!]} nodeLabel={() => undefined} onDismiss={() => undefined} />);
    expect(screen.getByTestId("draft-warnings")).not.toHaveTextContent("Unfinished draft");
  });
});
