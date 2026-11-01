import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataLabelChips, EndorsementNote, describeDataLabels } from "./DataLabelChips";

describe("data label chips", () => {
  it("says where the data came from and what it contains, in plain words", () => {
    expect(describeDataLabels({ provenance: ["user", "untrusted_external"], dataClasses: ["email", "card_number"], source: "propagated" })).toEqual([
      "from outside",
      "from a user",
      "contains email, card number"
    ]);
    expect(describeDataLabels({ provenance: ["trusted"], dataClasses: [], source: "propagated" })).toEqual(["from your system"]);
  });

  it("renders nothing for runs without labels", () => {
    expect(describeDataLabels(undefined)).toEqual([]);
    expect(describeDataLabels({ provenance: [], dataClasses: [], source: "propagated" })).toEqual([]);
    expect(describeDataLabels("nonsense")).toEqual([]);
    expect(renderToStaticMarkup(<DataLabelChips labels={undefined} />)).toBe("");
  });

  it("renders one chip per word", () => {
    const html = renderToStaticMarkup(<DataLabelChips labels={{ provenance: ["untrusted_external"], dataClasses: ["email"], source: "propagated" }} />);
    expect(html).toContain("from outside");
    expect(html).toContain("contains email");
    expect(html).toContain('aria-label="Data labels: from outside · contains email"');
  });

  it("shows an approval that cleared outside content, and nothing without one", () => {
    expect(renderToStaticMarkup(<EndorsementNote endorsement={undefined} />)).toBe("");
    const html = renderToStaticMarkup(<EndorsementNote endorsement={{ kind: "human_approval", approvedBy: "maria@example.org", approvedAt: "2026-10-31T10:04:00.000Z", nodeIds: ["ask"] }} />);
    expect(html).toContain(">cleared<");
    expect(html).toContain("maria@example.org");
    // 12.2 — an approval that showed no step's data reads "approved": it cleared nothing.
    const bland = renderToStaticMarkup(<EndorsementNote endorsement={{ kind: "human_approval", approvedBy: "maria@example.org", approvedAt: "2026-10-31T10:04:00.000Z", nodeIds: [] }} />);
    expect(bland).toContain(">approved<");
    expect(bland).toContain("nothing was cleared");
  });
});
