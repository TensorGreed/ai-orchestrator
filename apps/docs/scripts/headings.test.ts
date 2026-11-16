import { describe, expect, it } from "vitest";
import { plainHeading } from "../docs/.vitepress/site/headings.js";

describe("plainHeading", () => {
  it("returns the first H1 as plain text", () => {
    expect(plainHeading("---\ntitle: \"Secrets: encrypted storage\"\n---\n\n# Secrets\n\nBody")).toBe("Secrets");
    expect(plainHeading("# Workflow Tool: Call Another Workflow {#tool}\n")).toBe("Workflow Tool: Call Another Workflow");
    expect(plainHeading("# The [`chart`](/nodes/chart) node\n")).toBe("The chart node");
    expect(plainHeading("# **Bold** and *em* and _under_\n")).toBe("Bold and em and under");
    expect(plainHeading("# <span>Tagged</span> heading\n")).toBe("Tagged heading");
  });

  it("keeps underscores inside identifiers", () => {
    expect(plainHeading("# The session_id field and `max_iterations`\n")).toBe("The session_id field and max_iterations");
  });

  it("ignores a # line inside a code fence and needs a space after #", () => {
    expect(plainHeading("Intro\n\n```bash\n# not a heading\n```\n\n# Real heading\n")).toBe("Real heading");
    expect(plainHeading("#\nNext line\n")).toBe("");
    expect(plainHeading("No heading here\n")).toBe("");
  });
});
