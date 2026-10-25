import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataLabelChips, describeDataLabels } from "./DataLabelChips";

describe("data label chips", () => {
  it("says where the data came from and what it contains, in plain words", () => {
    expect(describeDataLabels({ provenance: ["user", "untrusted_external"], dataClasses: ["email", "card_number"], source: "propagated" })).toEqual([
      "from web",
      "from a person",
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
    expect(html).toContain("from web");
    expect(html).toContain("contains email");
    expect(html).toContain('aria-label="Data labels: from web · contains email"');
  });
});
