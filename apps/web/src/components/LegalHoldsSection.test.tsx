import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LegalHoldView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { LegalHoldsSection } from "./LegalHoldsSection";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchLegalHolds: vi.fn(), placeLegalHold: vi.fn(), releaseLegalHold: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const hold: LegalHoldView = {
  id: "lh_1",
  name: "Acme v. Doe",
  reason: "Litigation",
  matterRef: "M-7",
  scopeType: "project",
  scopeId: "p1",
  status: "active",
  endsAt: null,
  itemCount: 0,
  createdBy: "counsel@example.com",
  createdAt: "2026-11-10T12:00:00.000Z",
  releasedBy: null,
  releasedAt: null,
  releaseReason: null
};

describe("LegalHoldsSection", () => {
  it("lists active holds and releases one only with a reason", async () => {
    vi.mocked(api.fetchLegalHolds).mockResolvedValue({ holds: [hold] });
    vi.mocked(api.releaseLegalHold).mockResolvedValue({ hold: { ...hold, status: "released" } });
    render(<LegalHoldsSection />);
    const row = await screen.findByTestId("legal-hold-lh_1");
    expect(row.textContent).toContain("Acme v. Doe");
    expect(row.textContent).toContain("Matter M-7");
    expect(row.textContent).toContain("Project p1");
    expect(api.fetchLegalHolds).toHaveBeenCalledWith("active");
    fireEvent.click(screen.getByRole("button", { name: "Release…" }));
    const release = screen.getByRole("button", { name: "Release" });
    expect((release as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for release"), { target: { value: "Settled" } });
    fireEvent.click(release);
    await waitFor(() => expect(api.releaseLegalHold).toHaveBeenCalledWith("lh_1", "Settled"));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("Released"));
  });

  it("shows a scope it does not know as stored, never as another scope", async () => {
    vi.mocked(api.fetchLegalHolds).mockResolvedValue({ holds: [{ ...hold, id: "lh_9", scopeType: "organization", scopeId: "org-1" }] });
    render(<LegalHoldsSection />);
    const row = await screen.findByTestId("legal-hold-lh_9");
    expect(row.textContent).toContain("Other scope: organization org-1");
    expect(row.textContent).not.toContain("Project");
  });

  it("places a runs hold from a list of ids, and shows a refusal", async () => {
    vi.mocked(api.fetchLegalHolds).mockResolvedValue({ holds: [] });
    vi.mocked(api.placeLegalHold).mockResolvedValueOnce({ hold: { ...hold, scopeType: "runs", scopeId: "lh_2", itemCount: 2 } });
    render(<LegalHoldsSection />);
    await screen.findByText("No active holds.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Runs" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Preserve" } });
    fireEvent.change(screen.getByLabelText("Covers"), { target: { value: "runs" } });
    fireEvent.change(screen.getByLabelText(/Run ids/), { target: { value: "run-1, run-2\nrun-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Place hold" }));
    await waitFor(() =>
      expect(api.placeLegalHold).toHaveBeenCalledWith({ name: "Runs", reason: "Preserve", scopeType: "runs", executionIds: ["run-1", "run-2", "run-3"] })
    );
    expect((await screen.findByRole("status")).textContent).toContain("2 runs");

    vi.mocked(api.placeLegalHold).mockRejectedValueOnce(new api.ApiError("Project not found", 404, {}));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "P" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "r" } });
    fireEvent.change(screen.getByLabelText("Covers"), { target: { value: "project" } });
    fireEvent.change(screen.getByLabelText("Project id"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Place hold" }));
    expect(await screen.findByText("Project not found")).toBeTruthy();
  });
});
