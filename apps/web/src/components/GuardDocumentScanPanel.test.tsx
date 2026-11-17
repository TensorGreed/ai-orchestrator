import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DocumentScanResult } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { fileToBase64, GuardDocumentScanPanel } from "./GuardDocumentScanPanel";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, scanGuardDocument: vi.fn() };
});

const result: DocumentScanResult = {
  documentId: "0123456789abcdef",
  source: { kind: "upload", filename: "people.csv" },
  mediaType: "text/plain",
  sniffedType: "csv",
  typeMismatch: true,
  encoding: "utf-8",
  bytes: 2048,
  chars: 2000,
  truncated: true,
  covered: { chars: 1000, of: 2000 },
  riskLevel: "high",
  countsByClass: { card_number: 1, email: 2 },
  findings: [
    { dataClass: "email", score: 0.95, location: { kind: "csv", row: 2, column: 2, field: "email", label: "row 2, column 2 (email)" }, maskedPreview: "j•••@e••••.com" },
    { dataClass: "card_number", score: 0.99, location: { kind: "csv", row: 2, column: 3, label: "row 2, column 3" }, maskedPreview: "•••• 1111" }
  ],
  findingsTruncated: true,
  redacted: { style: "placeholder", text: "name,email\nJane,[EMAIL_1]" },
  ruleSet: { id: "pii", version: 0 }
};

describe("Scan a document", () => {
  it("uploads a file as base64 with the unsaved draft, and shows locations, masked previews, risk and the redacted text", async () => {
    const user = userEvent.setup();
    vi.mocked(api.scanGuardDocument).mockResolvedValue({ result });
    render(<GuardDocumentScanPanel profileId="pii" draft={{ id: "pii", name: "PII", version: "1" }} />);
    const scan = screen.getByRole("button", { name: "Scan document" });
    expect(scan).toBeDisabled();
    const file = new File(["name,email\nJane,jane@example.com"], "people.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Document"), file);
    await user.selectOptions(screen.getByLabelText("Redacted text"), "placeholder");
    await user.click(scan);
    await waitFor(() =>
      expect(api.scanGuardDocument).toHaveBeenCalledWith("pii", {
        source: { kind: "upload", contentBase64: btoa("name,email\nJane,jane@example.com"), filename: "people.csv", mediaType: "text/csv" },
        document: { id: "pii", name: "PII", version: "1" },
        redact: "placeholder"
      })
    );
    const view = await screen.findByRole("status", { name: "Scan result" });
    expect(view).toHaveTextContent("Risk: high");
    expect(view).toHaveTextContent("2 email");
    expect(view).toHaveTextContent("not as the declared text/plain");
    expect(view).toHaveTextContent("Only the first 1,000 of 2,000 characters were checked");
    const rows = within(view).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("row 2, column 2 (email)");
    expect(rows[1]).toHaveTextContent("j•••@e••••.com");
    expect(view).toHaveTextContent("The first 2 findings are listed");
    expect(screen.queryByLabelText("Redacted text", { selector: "textarea" })).toBeNull();
    await user.click(within(view).getByRole("checkbox", { name: "Show redacted text" }));
    expect(screen.getByLabelText("Redacted text", { selector: "textarea" })).toHaveValue("name,email\nJane,[EMAIL_1]");
  });

  it("scans a URL with the latest version and shows the server's refusal", async () => {
    const user = userEvent.setup();
    vi.mocked(api.scanGuardDocument).mockRejectedValue(new api.ApiError("Host '10.0.0.5' resolves to a private address, which is blocked", 422));
    render(<GuardDocumentScanPanel profileId="pii" draft={null} />);
    await user.click(screen.getByRole("radio", { name: "URL" }));
    await user.type(screen.getByLabelText("Document URL"), "http://10.0.0.5/x");
    expect(screen.queryByRole("checkbox", { name: "Use unsaved changes" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scan document" }));
    await waitFor(() => expect(api.scanGuardDocument).toHaveBeenLastCalledWith("pii", { source: { kind: "url", url: "http://10.0.0.5/x" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("private address");
  });

  it("encodes large files in chunks", async () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
    const encoded = await fileToBase64(new Blob([bytes]));
    expect(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))).toEqual(bytes);
  });
});
