import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BUILTIN_DESTINATIONS, dataDestinationInputSchema, type DataDestinationRow, type UnclassifiedDestination } from "@ai-orchestrator/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { describeMatch, EMPTY_DESTINATION_FORM, formFromRow, formFromSuggestion, inputFromForm } from "../lib/data-destinations";
import { destinationRuleLines } from "../lib/guard-profile-edit";
import { DataDestinationsView } from "./DataDestinationsView";
import { GuardProtectionFields } from "./GuardNodeConfigFields";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchDataDestinations: vi.fn(),
    fetchUnclassifiedDestinations: vi.fn(),
    createDataDestination: vi.fn(),
    updateDataDestination: vi.fn(),
    deleteDataDestination: vi.fn()
  };
});

const row: DataDestinationRow = {
  id: "dst_1",
  name: "Corp network",
  kind: "http",
  targetId: null,
  host: "*.corp.example",
  tier: "private",
  region: "eu-west-1",
  holdsDataClasses: ["email"],
  note: null,
  builtIn: false,
  createdAt: null,
  updatedAt: null,
  createdBy: null,
  updatedBy: null
};

const pending: UnclassifiedDestination = {
  kind: "model_provider",
  targetId: "openai_compatible",
  host: "llm.example.net",
  seenIn: ['Workflow "Support" · Ask model'],
  current: { tier: "public", region: "unknown", holdsDataClasses: [], matchedBy: "unmatched" },
  suggestion: { name: "llm.example.net", kind: "model_provider", targetId: "openai_compatible", host: "llm.example.net", tier: "vendor" }
};

describe("data destination form helpers", () => {
  it("round-trips a row and builds valid API input", () => {
    const form = formFromRow(row);
    expect(form).toMatchObject({ name: "Corp network", host: "*.corp.example", region: "eu-west-1", holds: "email" });
    const input = inputFromForm({ ...form, holds: "email, phone, email" });
    expect(input).toEqual({ name: "Corp network", kind: "http", host: "*.corp.example", tier: "private", region: "eu-west-1", holdsDataClasses: ["email", "phone"] });
    expect(dataDestinationInputSchema.safeParse(input).success).toBe(true);
    expect(formFromRow({ ...row, region: "unknown" }).region).toBe("");
  });

  it("drops the target id for web addresses and prefills from a suggestion", () => {
    expect(inputFromForm({ ...EMPTY_DESTINATION_FORM, name: "x", kind: "http", targetId: "ignored", host: "a.example" }).targetId).toBeUndefined();
    expect(formFromSuggestion(pending)).toMatchObject({ name: "llm.example.net", kind: "model_provider", targetId: "openai_compatible", tier: "vendor" });
    expect(describeMatch(pending)).toBe("Model provider openai_compatible at llm.example.net");
    expect(describeMatch(row)).toBe("Web address *.corp.example");
  });

  it("describes a profile's destination rules in plain sentences", () => {
    expect(destinationRuleLines({})).toEqual([]);
    expect(
      destinationRuleLines({
        destinations: {
          rules: [
            { name: "Keep sensitive data in-house", when: { dataClasses: ["card_number", "iban"] }, allow: { maxTier: "private" }, action: "block", shadow: true },
            { when: { provenance: ["sensitive"] }, allow: { maxTier: "vendor", regions: ["eu"] }, action: "require_approval" }
          ]
        }
      })
    ).toEqual([
      "Keep sensitive data in-house: card_number, iban may only go to the private network; otherwise block (shadow: observe only).",
      "sensitive data may only go to approved vendors in eu; otherwise require approval."
    ]);
  });
});

describe("DataDestinationsView", () => {
  beforeEach(() => {
    vi.mocked(api.fetchDataDestinations).mockReset();
    vi.mocked(api.fetchUnclassifiedDestinations).mockReset();
    vi.mocked(api.createDataDestination).mockReset();
  });

  it("shows the empty state, greyed built-ins and a read-only not-classified list for non-admins", async () => {
    vi.mocked(api.fetchDataDestinations).mockResolvedValue({ destinations: [], builtIns: [...BUILTIN_DESTINATIONS], canEdit: false });
    vi.mocked(api.fetchUnclassifiedDestinations).mockResolvedValue({ destinations: [pending] });
    render(<DataDestinationsView />);
    expect(await screen.findByText("No destinations classified yet.")).toBeTruthy();
    expect(screen.getByText(/destinations do nothing until a guard profile has destination rules/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add destination" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Classify/ })).toBeNull();
    expect(screen.getByText(/Ask an admin to classify them/)).toBeTruthy();
    const builtIn = screen.getByRole("table", { name: "Built-in destinations" });
    expect(within(builtIn).getByText("api.openai.com", { exact: false })).toBeTruthy();
    expect(within(builtIn).getAllByText("built-in").length).toBe(BUILTIN_DESTINATIONS.length);
  });

  it("lets an admin classify a pending destination in one click, with Advanced settings", async () => {
    vi.mocked(api.fetchDataDestinations).mockResolvedValue({ destinations: [], builtIns: [], canEdit: true });
    vi.mocked(api.fetchUnclassifiedDestinations).mockResolvedValue({ destinations: [pending] });
    vi.mocked(api.createDataDestination).mockResolvedValue({ destination: { ...row, id: "dst_2" } });
    const user = userEvent.setup();
    render(<DataDestinationsView />);
    await user.click(await screen.findByRole("button", { name: "Classify Model provider openai_compatible at llm.example.net" }));
    const form = screen.getByRole("form", { name: "Add destination" });
    expect((within(form).getByLabelText("Provider id") as HTMLInputElement).value).toBe("openai_compatible");
    await user.click(within(form).getByText("Advanced"));
    await user.type(within(form).getByLabelText("Region"), "eu-west-1");
    await user.click(within(form).getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(api.createDataDestination).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createDataDestination).mock.calls[0]![0]).toEqual({
      name: "llm.example.net",
      kind: "model_provider",
      targetId: "openai_compatible",
      host: "llm.example.net",
      tier: "vendor",
      region: "eu-west-1",
      holdsDataClasses: []
    });
  });

  it("shows the API's plain message when a save is refused", async () => {
    vi.mocked(api.fetchDataDestinations).mockResolvedValue({ destinations: [row], builtIns: [], canEdit: true });
    vi.mocked(api.fetchUnclassifiedDestinations).mockResolvedValue({ destinations: [] });
    vi.mocked(api.createDataDestination).mockRejectedValue(new api.ApiError("Enter a host name (api.example.com), a wildcard (*.corp.example) or an IP range (10.0.0.0/8)", 400));
    const user = userEvent.setup();
    render(<DataDestinationsView />);
    expect(await screen.findByRole("table", { name: "Your destinations" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const form = screen.getByRole("form", { name: "Add destination" });
    await user.type(within(form).getByLabelText("Name"), "Bad");
    await user.click(within(form).getByRole("button", { name: "Save destination" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/Enter a host name/);
  });
});

describe("Protection Provider surrogate", () => {
  it("is offered and marked one-way, pointing to the token vault", () => {
    render(<GuardProtectionFields config={{ providerId: "surrogate", dataClasses: ["email"] }} setConfig={() => undefined} secrets={[]} />);
    expect(screen.getByRole("option", { name: "Surrogate (one-way)" })).toBeTruthy();
    expect(screen.getByText("One-way")).toBeTruthy();
    expect(screen.getByText(/use the token vault if you need it back/)).toBeTruthy();
    expect(screen.queryByLabelText("Key (from Secrets)")).toBeNull();
  });
});
