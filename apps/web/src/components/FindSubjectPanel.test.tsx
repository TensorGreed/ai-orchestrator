import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayFindSubjectMatch, ReplayFindSubjectResult } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { FindSubjectPanel } from "./FindSubjectPanel";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, findReplaySubject: vi.fn(), deleteReplaySubject: vi.fn() };
});

function match(id: string, certainty: ReplayFindSubjectMatch["certainty"], storedCallingCode?: string): ReplayFindSubjectMatch {
  return {
    kind: "recording",
    id,
    workflowId: "wf-1",
    projectId: "default",
    name: `Run ${id}`,
    status: "golden",
    matchedAs: ["raw"],
    fields: ["input"],
    hits: [{ field: "input", matchedAs: "raw", dataClass: "phone", excerpt: "call [(•••) •••-••34]", certainty, ...(storedCallingCode ? { storedCallingCode } : {}) }],
    certainty
  };
}

function result(matches: ReplayFindSubjectMatch[], overrides: Partial<ReplayFindSubjectResult> = {}): ReplayFindSubjectResult {
  return {
    dataClass: "phone",
    callingCode: "1",
    classesTried: ["phone"],
    matches,
    counts: { recording: matches.length, fixture: 0, eval_result: 0, execution: 0, cassette: 0 },
    searched: { recording: 3, fixture: 0, eval_result: 0, execution: 0, cassette: 0 },
    covered: ["Golden runs"],
    notCovered: ["Logs"],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FindSubjectPanel", () => {
  it("offers Read as and a country for bare digits, and says how it searched", async () => {
    vi.mocked(api.findReplaySubject).mockResolvedValue(result([match("a", "exact")]));
    render(<FindSubjectPanel />);
    const value = screen.getByLabelText("Value");
    await userEvent.type(value, "jane@example.com");
    expect(screen.queryByLabelText("Read as")).toBeNull();
    await userEvent.clear(value);
    await userEvent.type(value, "4155551234");
    expect(screen.getByLabelText("Read as")).toHaveValue("text");
    expect(screen.queryByLabelText("Country")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Read as"), "phone");
    expect(screen.getByLabelText("Country")).toHaveValue("");
    await userEvent.selectOptions(screen.getByLabelText("Country"), "US");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.findReplaySubject).toHaveBeenCalledWith({ value: "4155551234", dataClass: "phone", country: "US" }));
    expect(await screen.findByText(/Searched as phone \(\+1\)\. 1 certain, 0 possible\./)).toBeInTheDocument();
  });

  it("lists possible matches apart and unticked; deleting one sends its confirmation", async () => {
    vi.mocked(api.findReplaySubject).mockResolvedValue(result([match("a", "exact"), match("b", "national_only", "33"), match("c", "national_only")]));
    vi.mocked(api.deleteReplaySubject).mockResolvedValue({
      deleted: { recording: 2, fixture: 0, eval_result: 0, execution: 0, cassette: 0 },
      removed: [
        { kind: "recording", id: "a" },
        { kind: "recording", id: "c" }
      ],
      skipped: []
    });
    render(<FindSubjectPanel />);
    await userEvent.type(screen.getByLabelText("Value"), "+1 415 555 1234");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    const certain = await screen.findByRole("list", { name: "Matches" });
    expect(within(certain).getByRole("checkbox", { name: "Select Run a" })).toBeChecked();
    expect(screen.getByText("Possible matches (no country code in the data)")).toBeInTheDocument();
    const possible = screen.getByRole("list", { name: "Possible matches" });
    expect(within(possible).getByRole("checkbox", { name: "Select Run b" })).not.toBeChecked();
    expect(within(possible).getByRole("checkbox", { name: "Select Run c" })).not.toBeChecked();
    expect(within(possible).getByText(/stored with \+33/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete selected (1)" })).toBeInTheDocument();

    await userEvent.click(within(possible).getByRole("checkbox", { name: "Select Run c" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    expect(api.deleteReplaySubject).not.toHaveBeenCalled();
    expect(screen.getByText(/Permanently delete 2 rows\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api.deleteReplaySubject).toHaveBeenCalledWith({ value: "+1 415 555 1234" }, [
        { kind: "recording", id: "a" },
        { kind: "recording", id: "c", confirmPossible: true }
      ])
    );
    expect(await screen.findByText("Deleted 2 rows.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select Run a" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Select Run b" })).not.toBeChecked();
  });

  it("shows the server's refusal", async () => {
    vi.mocked(api.findReplaySubject).mockRejectedValue(new Error("That does not read as a phone number: it needs 7 to 15 digits."));
    render(<FindSubjectPanel />);
    await userEvent.type(screen.getByLabelText("Value"), "1234567");
    await userEvent.selectOptions(screen.getByLabelText("Read as"), "phone");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not read as a phone number");
  });
});
