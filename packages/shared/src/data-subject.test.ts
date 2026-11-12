import { describe, expect, it } from "vitest";
import {
  SUBJECT_REF_MAX,
  subjectRefPath,
  subjectRefPreviewSchema,
  subjectRequestCreateSchema,
  workflowDataProtectionSchema
} from "./data-subject";
import { workflowSchema } from "./schemas";

describe("subject references", () => {
  it("accepts plain paths under the run's input, output and custom data, the session id and who started the run", () => {
    expect(subjectRefPath("{{input.customerId}}")).toBe("input.customerId");
    expect(subjectRefPath("  {{ input.headers.x-customer-id }} ")).toBe("input.headers.x-customer-id");
    expect(subjectRefPath("{{output.user.email}}")).toBe("output.user.email");
    expect(subjectRefPath("{{customData.tenant_user}}")).toBe("customData.tenant_user");
    expect(subjectRefPath("{{session_id}}")).toBe("session_id");
    expect(subjectRefPath("{{triggeredBy}}")).toBe("triggeredBy");
  });

  it("refuses expressions, other roots and bare roots", () => {
    for (const bad of ["{{input}}", "{{results.node.x}}", "{{input.a + 1}}", "input.customerId", "{{input..x}}", "{{session_id.x}}", "{{ $json.x }}", "{{input.a}} {{input.b}}"]) {
      expect(subjectRefPath(bad), bad).toBeNull();
    }
  });

  it("allows at most three distinct references per workflow", () => {
    expect(workflowDataProtectionSchema.safeParse({}).success).toBe(true);
    expect(workflowDataProtectionSchema.safeParse({ subjectRefs: ["{{input.a}}", "{{input.b}}", "{{session_id}}"] }).success).toBe(true);
    expect(workflowDataProtectionSchema.safeParse({ subjectRefs: ["{{input.a}}", "{{input.b}}", "{{input.c}}", "{{input.d}}"] }).success).toBe(false);
    expect(SUBJECT_REF_MAX).toBe(3);
    expect(workflowDataProtectionSchema.safeParse({ subjectRefs: ["{{input.a}}", "{{ input.a }}"] }).success).toBe(false);
    expect(workflowDataProtectionSchema.safeParse({ subjectRefs: ["{{results.a}}"] }).success).toBe(false);
    expect(workflowDataProtectionSchema.safeParse({ other: true }).success).toBe(false);
  });

  it("is part of workflow settings, additive to schemaVersion 1.0.0", () => {
    const base = { id: "wf", name: "WF", nodes: [], edges: [] };
    const parsed = workflowSchema.parse({ ...base, settings: { dataProtection: { subjectRefs: ["{{input.customerId}}"] } } });
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.settings?.dataProtection?.subjectRefs).toEqual(["{{input.customerId}}"]);
    expect(workflowSchema.safeParse({ ...base, settings: { dataProtection: { subjectRefs: ["{{ 1 + 1 }}"] } } }).success).toBe(false);
    // A workflow without data protection settings is unchanged.
    expect(workflowSchema.parse(base).settings).toBeUndefined();
  });
});

describe("data-subject requests", () => {
  it("defaults to an end-user export that searches stored data and keeps tokens", () => {
    expect(subjectRequestCreateSchema.parse({ type: "export", value: " ana@example.com " })).toEqual({
      type: "export",
      subjectKind: "end_user",
      value: "ana@example.com",
      scan: true,
      revealTokens: false
    });
  });

  it("refuses unknown types, empty values and unknown fields", () => {
    expect(subjectRequestCreateSchema.safeParse({ type: "erase", value: "x" }).success).toBe(false);
    // 13.3 — a deletion is a request type; revealing tokens is for exports only.
    expect(subjectRequestCreateSchema.safeParse({ type: "delete", value: "x" }).success).toBe(true);
    expect(subjectRequestCreateSchema.safeParse({ type: "delete", value: "x", revealTokens: true }).success).toBe(false);
    expect(subjectRequestCreateSchema.safeParse({ type: "export", value: "  " }).success).toBe(false);
    expect(subjectRequestCreateSchema.safeParse({ type: "export", value: "x".repeat(321) }).success).toBe(false);
    expect(subjectRequestCreateSchema.safeParse({ type: "export", value: "x", extra: 1 }).success).toBe(false);
  });

  it("previews one to three valid references", () => {
    expect(subjectRefPreviewSchema.safeParse({ workflowId: "wf", subjectRefs: ["{{input.a}}"] }).success).toBe(true);
    expect(subjectRefPreviewSchema.safeParse({ workflowId: "wf", subjectRefs: [] }).success).toBe(false);
    expect(subjectRefPreviewSchema.safeParse({ workflowId: "wf", subjectRefs: ["{{nope}}"] }).success).toBe(false);
  });
});
