import { describe, expect, it } from "vitest";
import { editorAccess, mayUseEditorRunOptions, roleMayUseEditorRunOptions } from "./editor-access";

const full = { workflowId: "wf", canEdit: true, canRun: true, canShare: true };

describe("editorAccess", () => {
  it("turns editing off for viewers and operators; viewers never run, operators run where they may", () => {
    expect(editorAccess("viewer", full)).toEqual({ editDisabledReason: expect.stringMatching(/viewer role/), runDisabledReason: expect.stringMatching(/operator role or higher/) });
    expect(editorAccess("operator", full)).toEqual({ editDisabledReason: expect.stringMatching(/operator role/), runDisabledReason: null });
    expect(editorAccess("operator", { ...full, canRun: false }).runDisabledReason).toMatch(/permission to run/);
    expect(editorAccess("operator", null).runDisabledReason).toMatch(/Checking/);
  });

  it("lets only builders and admins use the editor's run options", () => {
    expect(["admin", "builder", "operator", "viewer"].map((role) => roleMayUseEditorRunOptions(role as "admin"))).toEqual([true, true, false, false]);
  });

  it("follows the workflow's access for builders and admins", () => {
    expect(editorAccess("builder", full)).toEqual({ editDisabledReason: null, runDisabledReason: null });
    expect(editorAccess("admin", null)).toEqual({ editDisabledReason: null, runDisabledReason: null });
    const shared = editorAccess("builder", { ...full, canEdit: false, canShare: false });
    expect(shared.editDisabledReason).toMatch(/shared with you/);
    expect(shared.runDisabledReason).toBeNull();
    expect(editorAccess("builder", { ...full, canEdit: false, canRun: false }).runDisabledReason).toMatch(/permission to run/);
  });

  it("keeps the editor's run options to someone who may edit the open workflow", () => {
    expect(mayUseEditorRunOptions("builder", full)).toBe(true);
    expect(mayUseEditorRunOptions("admin", null)).toBe(true);
    // A builder who may only run it (a share) runs the saved workflow, as an operator does: the server refuses the options.
    expect(mayUseEditorRunOptions("builder", { ...full, canEdit: false })).toBe(false);
    expect(mayUseEditorRunOptions("operator", full)).toBe(false);
  });
});
