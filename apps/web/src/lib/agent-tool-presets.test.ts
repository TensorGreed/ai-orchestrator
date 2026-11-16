import { describe, expect, it } from "vitest";
import { nodeDefinitions } from "@ai-orchestrator/shared";
import { isPaletteDefinition, withAgentToolPresets } from "./agent-tool-presets";

describe("palette definitions", () => {
  it("leaves out nodes that cannot run in this build, such as the IMAP email trigger", () => {
    const offered = withAgentToolPresets(nodeDefinitions).filter(isPaletteDefinition).map((definition) => definition.type);
    expect(offered).not.toContain("imap_email_trigger");
    expect(offered).toContain("smtp_send_email");
    // The definition itself stays, so stored workflows that contain the node still load.
    expect(nodeDefinitions.some((definition) => definition.type === "imap_email_trigger")).toBe(true);
  });
});
