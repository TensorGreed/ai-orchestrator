import { render, screen } from "@testing-library/react";
import { AuditChainStatusLine } from "./SettingsPage";

describe("AuditChainStatusLine", () => {
  it("says the chain is intact when ok", () => {
    render(<AuditChainStatusLine status={{ ok: true, rowsChecked: 12 }} />);
    expect(screen.getByText(/Chain intact — verified 12 rows/)).toBeInTheDocument();
  });

  it("names the first broken row", () => {
    render(
      <AuditChainStatusLine
        status={{ ok: false, rowsChecked: 3, firstBrokenAt: { id: "aud_x", createdAt: "2026-01-01T00:00:00.000Z", expected: "a", stored: "b" } }}
      />
    );
    expect(screen.getByText(/Chain broken at row aud_x/)).toBeInTheDocument();
  });

  it("lists unverifiable rows and never says intact", () => {
    render(
      <AuditChainStatusLine
        status={{ ok: false, rowsChecked: 9, unverifiable: [{ id: "aud_old", createdAt: "2026-01-01T00:00:00.000Z", reason: "2 U+FFFD" }] }}
      />
    );
    expect(screen.getByText(/Not verified: 1 row cannot be checked\. Verified 9 other rows\./)).toBeInTheDocument();
    expect(screen.getByText("aud_old")).toBeInTheDocument();
    expect(screen.queryByText(/intact/)).toBeNull();
    expect(screen.queryByText(/broken/)).toBeNull();
  });

  it("shows both a broken row and the unverifiable rows before it", () => {
    render(
      <AuditChainStatusLine
        status={{
          ok: false,
          rowsChecked: 2,
          firstBrokenAt: { id: "aud_b", createdAt: "2026-01-02T00:00:00.000Z", expected: "a", stored: "b" },
          unverifiable: [{ id: "aud_old", createdAt: "2026-01-01T00:00:00.000Z", reason: "r" }]
        }}
      />
    );
    expect(screen.getByText(/Chain broken at row aud_b/)).toBeInTheDocument();
    expect(screen.getByText("aud_old")).toBeInTheDocument();
  });
});
