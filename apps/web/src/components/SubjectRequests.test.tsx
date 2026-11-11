import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubjectRequestView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { SubjectRefsDialog } from "./SubjectRefsDialog";
import { SubjectRequestsSection } from "./SubjectRequestsSection";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchSubjectRequests: vi.fn(),
    createSubjectRequest: vi.fn(),
    downloadSubjectExport: vi.fn(),
    previewSubjectRefs: vi.fn()
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base: SubjectRequestView = {
  id: "dsr_1",
  type: "export",
  subjectKind: "end_user",
  status: "ready",
  scan: true,
  revealTokens: false,
  counts: { run: 3, approval: 1 },
  foundByReference: 2,
  truncated: false,
  progress: { phase: "finished", kindsDone: 11, kindsTotal: 11, rowsSearched: 120 },
  dueAt: "2026-12-10T12:00:00.000Z",
  overdue: false,
  createdBy: "admin@example.com",
  createdAt: "2026-11-10T12:00:00.000Z",
  updatedAt: "2026-11-10T12:00:00.000Z",
  error: null,
  export: { bytes: 2048, expiresAt: "2026-11-13T12:00:00.000Z", downloadedAt: null, downloadedBy: null, available: true }
};

describe("data-subject requests section", () => {
  it("lists requests with what was found, and downloads an export once", async () => {
    vi.mocked(api.fetchSubjectRequests)
      .mockResolvedValueOnce({ requests: [base, { ...base, id: "dsr_2", status: "searching", counts: {}, export: null, progress: { phase: "scan", kindsDone: 4, kindsTotal: 11, rowsSearched: 50 } }] })
      .mockResolvedValue({ requests: [{ ...base, status: "done", export: { ...base.export!, available: false, downloadedAt: "2026-11-10T13:00:00.000Z", downloadedBy: "admin@example.com" } }] });
    vi.mocked(api.downloadSubjectExport).mockResolvedValue({ blob: new Blob(["zip"]), fileName: "subject-export-dsr_1.zip" });
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    render(<SubjectRequestsSection />);

    const row = await screen.findByTestId("subject-request-dsr_1");
    expect(row.textContent).toContain("Runs (input, output, node results): 3");
    expect(row.textContent).toContain("Approval requests: 1");
    expect(screen.getByTestId("subject-request-dsr_2").textContent).toContain("4 of 11 kinds of data, 50 rows read");

    fireEvent.click(screen.getByRole("button", { name: /Download \(2\.0 KB\)/ }));
    await waitFor(() => expect(api.downloadSubjectExport).toHaveBeenCalledWith("dsr_1"));
    await waitFor(() => expect(screen.getByTestId("subject-request-dsr_1").textContent).toContain("Downloaded"));
    expect(createObjectURL).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
  });

  it("sends the value once and clears the field", async () => {
    vi.mocked(api.fetchSubjectRequests).mockResolvedValue({ requests: [] });
    vi.mocked(api.createSubjectRequest).mockResolvedValue({ ...base, status: "searching" });
    render(<SubjectRequestsSection />);
    expect(await screen.findByText("No requests yet.")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start export" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    const input = screen.getByLabelText(/email, customer id or phone/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ana@example.com" } });
    fireEvent.click(screen.getByLabelText(/Also search stored data/));
    fireEvent.click(start);
    await waitFor(() =>
      expect(api.createSubjectRequest).toHaveBeenCalledWith({ type: "export", subjectKind: "end_user", value: "ana@example.com", scan: false, revealTokens: false })
    );
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("shows a refused request's message", async () => {
    vi.mocked(api.fetchSubjectRequests).mockResolvedValue({ requests: [] });
    vi.mocked(api.createSubjectRequest).mockRejectedValue(new api.ApiError("Enter at least 3 characters", 400, {}));
    render(<SubjectRequestsSection />);
    await screen.findByText("No requests yet.");
    fireEvent.change(screen.getByLabelText(/email, customer id or phone/), { target: { value: "ab" } });
    fireEvent.click(screen.getByRole("button", { name: "Start export" }));
    expect(await screen.findByText("Enter at least 3 characters")).toBeTruthy();
  });
});

describe("subject references dialog", () => {
  it("keeps only valid paths, flags invalid ones, and checks them on recent runs", async () => {
    const onChange = vi.fn();
    vi.mocked(api.previewSubjectRefs).mockResolvedValue({ runs: 4, refs: [{ expression: "{{input.customerId}}", resolved: 3, sample: "C•••7" }] });
    render(<SubjectRefsDialog workflowId="wf-1" subjectRefs={undefined} onChange={onChange} onClose={() => undefined} />);

    const first = screen.getByLabelText("Reference 1");
    fireEvent.change(first, { target: { value: "{{ results.x }}" } });
    expect(screen.getByText(/Use a plain path/)).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.change(first, { target: { value: "{{input.customerId}}" } });
    expect(onChange).toHaveBeenLastCalledWith(["{{input.customerId}}"]);

    fireEvent.click(screen.getByRole("button", { name: "Check on recent runs" }));
    await waitFor(() => expect(api.previewSubjectRefs).toHaveBeenCalledWith({ workflowId: "wf-1", subjectRefs: ["{{input.customerId}}"] }));
    expect((await screen.findByLabelText("Check results")).textContent).toContain("found in 3 of 4 recent runs (latest: C•••7)");
  });

  it("allows at most three references", () => {
    render(<SubjectRefsDialog workflowId="wf-1" subjectRefs={["{{input.a}}", "{{input.b}}"]} onChange={() => undefined} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add reference" }));
    expect(screen.getByLabelText("Reference 3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add reference" })).toBeNull();
  });
});
