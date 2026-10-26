import { render, screen } from "@testing-library/react";
import { AuditChainStatusLine } from "./SettingsPage";

function row(id: string) {
  return { id, createdAt: "2026-01-01T00:00:00.000Z", position: 4, prevHash: "a".repeat(64), entryHash: "b".repeat(64), reason: "2 U+FFFD" };
}

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
    render(<AuditChainStatusLine status={{ ok: false, rowsChecked: 9, unverifiable: [row("aud_old")] }} />);
    expect(screen.getByText(/Not verified: 1 row cannot be checked\. Verified 9 other rows\./)).toBeInTheDocument();
    expect(screen.getByText("aud_old")).toBeInTheDocument();
    expect(screen.queryByText(/intact/)).toBeNull();
    expect(screen.queryByText(/broken/)).toBeNull();
  });

  it("does not assume an unverifiable row is a harmless old row: names its chain position, marks id and time unverified", () => {
    render(<AuditChainStatusLine status={{ ok: false, rowsChecked: 9, unverifiable: [row("aud_old")] }} />);
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent(
      "Content cannot be verified: either a row written before audit text was normalised, or an edit. Compare it with a backup or export."
    );
    expect(item).toHaveTextContent("Row 4 in the chain");
    expect(item).toHaveTextContent("entry hash bbbbbbbbbbbb…");
    expect(item).toHaveTextContent("follows prev hash aaaaaaaaaaaa…");
    expect(item).toHaveTextContent("id and time as stored (unverified): aud_old, 2026-01-01T00:00:00.000Z");
    expect(item).not.toHaveTextContent(/database replaced/);
  });

  it("shows both a broken row and the unverifiable rows before it", () => {
    render(
      <AuditChainStatusLine
        status={{
          ok: false,
          rowsChecked: 2,
          firstBrokenAt: { id: "aud_b", createdAt: "2026-01-02T00:00:00.000Z", expected: "a", stored: "b" },
          unverifiable: [row("aud_old")]
        }}
      />
    );
    expect(screen.getByText(/Chain broken at row aud_b/)).toBeInTheDocument();
    expect(screen.getByText("aud_old")).toBeInTheDocument();
  });
});
