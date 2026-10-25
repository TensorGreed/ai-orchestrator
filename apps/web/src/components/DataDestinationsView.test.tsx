import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BUILTIN_DESTINATIONS, dataDestinationInputSchema, type DataDestinationRow, type UnclassifiedDestination } from "@ai-orchestrator/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { describeMatch, EMPTY_DESTINATION_FORM, formFromBuiltIn, formFromRow, formFromSuggestion, ID_ONLY_ROW_HINT, inputFromForm } from "../lib/data-destinations";
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
  suggestion: { name: "llm.example.net", kind: "model_provider", targetId: "openai_compatible", host: "llm.example.net", tier: "public" }
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
    expect(formFromSuggestion(pending)).toMatchObject({ name: "llm.example.net", kind: "model_provider", targetId: "openai_compatible", host: "llm.example.net", tier: "public" });
    // A new row starts public: the admin picks a nearer tier on purpose.
    expect(EMPTY_DESTINATION_FORM.tier).toBe("public");
    const openai = BUILTIN_DESTINATIONS.find((entry) => entry.id === "builtin:openai")!;
    expect(formFromBuiltIn(openai)).toMatchObject({ name: "OpenAI", kind: "http", host: "api.openai.com", tier: "vendor", region: "" });
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
      "sensitive data may only go to approved vendors in eu (regions apply to vendors and public destinations only); otherwise require approval."
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
    expect((within(form).getByLabelText("Host (optional)") as HTMLInputElement).value).toBe("llm.example.net");
    expect((within(form).getByLabelText("Tier") as HTMLSelectElement).value).toBe("public");
    await user.selectOptions(within(form).getByLabelText("Tier"), "vendor");
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

  it("says a row without a host can only make calls stricter", async () => {
    vi.mocked(api.fetchDataDestinations).mockResolvedValue({ destinations: [], builtIns: [], canEdit: true });
    vi.mocked(api.fetchUnclassifiedDestinations).mockResolvedValue({ destinations: [] });
    const user = userEvent.setup();
    render(<DataDestinationsView />);
    await user.click(await screen.findByRole("button", { name: "Add destination" }));
    const form = screen.getByRole("form", { name: "Add destination" });
    expect(within(form).queryByText(ID_ONLY_ROW_HINT)).toBeNull();
    await user.selectOptions(within(form).getByLabelText("Kind"), "model_provider");
    expect(within(form).getByText(ID_ONLY_ROW_HINT)).toBeTruthy();
    await user.type(within(form).getByLabelText("Host (optional)"), "llm.corp.example");
    expect(within(form).queryByText(ID_ONLY_ROW_HINT)).toBeNull();
  });

  it("lets an admin override a built-in row with Add destination pre-filled", async () => {
    vi.mocked(api.fetchDataDestinations).mockResolvedValue({ destinations: [], builtIns: [...BUILTIN_DESTINATIONS], canEdit: true });
    vi.mocked(api.fetchUnclassifiedDestinations).mockResolvedValue({ destinations: [] });
    vi.mocked(api.createDataDestination).mockResolvedValue({ destination: { ...row, id: "dst_3" } });
    const user = userEvent.setup();
    render(<DataDestinationsView />);
    await user.click(await screen.findByRole("button", { name: "Override OpenAI" }));
    const form = screen.getByRole("form", { name: "Add destination" });
    expect((within(form).getByLabelText("Host, wildcard or IP range") as HTMLInputElement).value).toBe("api.openai.com");
    expect((within(form).getByLabelText("Tier") as HTMLSelectElement).value).toBe("vendor");
    await user.click(within(form).getByText("Advanced"));
    await user.type(within(form).getByLabelText("Region"), "us");
    await user.click(within(form).getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(api.createDataDestination).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createDataDestination).mock.calls[0]![0]).toEqual({ name: "OpenAI", kind: "http", host: "api.openai.com", tier: "vendor", region: "us", holdsDataClasses: [] });
  });

  it("offers Override to admins only", async () => {
    vi.mocked(api.fetchDataDestinations).mockResolvedValue({ destinations: [], builtIns: [...BUILTIN_DESTINATIONS], canEdit: false });
    vi.mocked(api.fetchUnclassifiedDestinations).mockResolvedValue({ destinations: [] });
    render(<DataDestinationsView />);
    expect(await screen.findByRole("table", { name: "Built-in destinations" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Override/ })).toBeNull();
  });
});

describe("Protection Provider surrogate", () => {
  it("is not offered until the deployment key is wired", () => {
    render(<GuardProtectionFields config={{ providerId: "token_vault", dataClasses: ["email"] }} setConfig={() => undefined} secrets={[]} />);
    expect(screen.queryByRole("option", { name: "Surrogate (one-way)" })).toBeNull();
    expect(screen.getByRole("option", { name: "Token vault" })).toBeTruthy();
  });

  it("a node that already uses it says plainly that it blocks", () => {
    render(<GuardProtectionFields config={{ providerId: "surrogate", dataClasses: ["email"] }} setConfig={() => undefined} secrets={[]} />);
    expect(screen.getByRole("option", { name: "Surrogate (one-way)" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Surrogate needs the deployment key; until it is available this node blocks.");
    expect(screen.queryByLabelText("Key (from Secrets)")).toBeNull();
  });
});
