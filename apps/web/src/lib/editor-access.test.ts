import { describe, expect, it } from "vitest";
import { editorAccess } from "./editor-access";

const full = { workflowId: "wf", canEdit: true, canRun: true, canShare: true };

describe("editorAccess", () => {
  it("turns editing and running off for viewers and operators, whatever the workflow allows", () => {
    expect(editorAccess("viewer", full)).toEqual({ editDisabledReason: expect.stringMatching(/viewer role/), runDisabledReason: expect.stringMatching(/builder role/) });
    expect(editorAccess("operator", null)).toEqual({ editDisabledReason: expect.stringMatching(/operator role/), runDisabledReason: expect.stringMatching(/builder role/) });
  });

  it("follows the workflow's access for builders and admins", () => {
    expect(editorAccess("builder", full)).toEqual({ editDisabledReason: null, runDisabledReason: null });
    expect(editorAccess("admin", null)).toEqual({ editDisabledReason: null, runDisabledReason: null });
    const shared = editorAccess("builder", { ...full, canEdit: false, canShare: false });
    expect(shared.editDisabledReason).toMatch(/shared with you/);
    expect(shared.runDisabledReason).toBeNull();
    expect(editorAccess("builder", { ...full, canEdit: false, canRun: false }).runDisabledReason).toMatch(/permission to run/);
  });
});
