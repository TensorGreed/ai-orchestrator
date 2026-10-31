import { describe, expect, it } from "vitest";
import { recordedInputLabels } from "./data-label-provenance";
import { modelMemorySeedSchema } from "./model-tape";
import {
  declaresSensitiveOutput,
  endorseLabels,
  TRIGGER_TRUST_LEVELS,
  triggerInputProvenance,
  triggerTrustOf,
  unionDataLabels,
  withImpliedSensitive,
  type DataLabels
} from "./data-labels";
import { workflowNodeSchema } from "./schemas";

const L = (provenance: DataLabels["provenance"], dataClasses: string[] = [], source: DataLabels["source"] = "propagated"): DataLabels => ({ provenance, dataClasses, source });

describe("recorded input labels (Phase 16, Q7)", () => {
  it("the recording's input-node labels win", () => {
    expect(recordedInputLabels({ nodes: [{ nodeType: "webhook_input", labels: L(["untrusted_external"], ["email"]) }, { nodeType: "http_request", labels: L(["user"]) }], sourceTriggerType: "manual" })).toEqual(
      L(["untrusted_external"])
    );
  });

  it("without input-node labels the source trigger decides: user-started runs are a user's, others outside content", () => {
    expect(recordedInputLabels({ sourceTriggerType: "manual" })).toEqual(L(["user"]));
    expect(recordedInputLabels({ sourceTriggerType: "eval" })).toEqual(L(["user"]));
    expect(recordedInputLabels({ sourceTriggerType: "chat" })).toEqual(L(["user"]));
    expect(recordedInputLabels({ sourceTriggerType: "webhook" })).toEqual(L(["untrusted_external"]));
    // A caller-chosen trigger name earns nothing: never trusted without the server's own scheduler.
    expect(recordedInputLabels({ sourceTriggerType: "cron" })).toEqual(L(["untrusted_external"]));
    expect(recordedInputLabels({ sourceTriggerType: null })).toEqual(L(["untrusted_external"]));
  });

  it("labels read from a file never carry trusted", () => {
    expect(recordedInputLabels({ nodes: [{ nodeType: "webhook_input", labels: L(["trusted", "user"], [], "file") }], sourceTriggerType: "schedule" })).toEqual(L(["user"]));
    expect(recordedInputLabels({ nodes: [{ nodeType: "schedule_trigger", labels: L(["trusted"], [], "scan") }], sourceTriggerType: "schedule" })).toEqual(L(["trusted"]));
    // A recording imported from a file: its trigger type and labels are the file's claim, never only a user's.
    expect(recordedInputLabels({ sourceTriggerType: "manual", imported: true })).toEqual(L(["user", "untrusted_external"]));
    expect(recordedInputLabels({ nodes: [{ nodeType: "webhook_input", labels: L(["user"], [], "file") }], sourceTriggerType: "manual", imported: true })).toEqual(
      L(["user", "untrusted_external"])
    );
    expect(recordedInputLabels({ sourceTriggerType: "manual", imported: false })).toEqual(L(["user"]));
  });
});

describe("label helpers", () => {
  it("unionDataLabels merges, sorts and ignores missing parts", () => {
    expect(unionDataLabels([L(["user"], ["email"]), undefined, L(["trusted"], ["card_number"], "scan")])).toEqual(L(["trusted", "user"], ["card_number", "email"]));
    expect(unionDataLabels([])).toEqual(L([]));
  });

  it("a memory seed keeps the labels its memory had", () => {
    const parsed = modelMemorySeedSchema.parse({ sessions: [{ namespace: "n", sessionId: "s", messages: [], labels: L(["user"], ["iban"]) }], truncated: false });
    expect(parsed.sessions[0]!.labels).toEqual(L(["user"], ["iban"]));
  });
});

describe("12.2 provenance sources", () => {
  it("a webhook's input is the user's only when the server verified the caller, unless an admin set its trust", () => {
    expect(triggerInputProvenance({ verified: false })).toBe("untrusted_external");
    expect(triggerInputProvenance({ verified: true })).toBe("user");
    expect(triggerInputProvenance({ verified: true, trust: "untrusted_external" })).toBe("untrusted_external");
    expect(triggerInputProvenance({ verified: false, trust: "user" })).toBe("user");
  });

  it("reads only valid trust settings and never offers trusted", () => {
    expect(triggerTrustOf({ inputTrust: "user" })).toBe("user");
    expect(triggerTrustOf({ inputTrust: "trusted" })).toBeUndefined();
    expect(triggerTrustOf({})).toBeUndefined();
    expect(triggerTrustOf(null)).toBeUndefined();
    expect(TRIGGER_TRUST_LEVELS).not.toContain("trusted");
  });

  it("the node schema accepts the optional keys and refuses bad values", () => {
    const base = { id: "w", type: "webhook_input", name: "W", position: { x: 0, y: 0 } };
    expect(workflowNodeSchema.safeParse({ ...base, config: {} }).success).toBe(true);
    expect(workflowNodeSchema.safeParse({ ...base, config: { inputTrust: "user", sensitiveOutput: true } }).success).toBe(true);
    expect(workflowNodeSchema.safeParse({ ...base, config: { inputTrust: "trusted" } }).success).toBe(false);
    expect(workflowNodeSchema.safeParse({ ...base, config: { sensitiveOutput: "yes" } }).success).toBe(false);
  });

  it("endorsing turns untrusted_external into user and keeps everything else", () => {
    const labels: DataLabels = { provenance: ["untrusted_external", "sensitive"], dataClasses: ["email"], source: "propagated" };
    expect(endorseLabels(labels)).toEqual({ provenance: ["user", "sensitive"], dataClasses: ["email"], source: "propagated" });
    const trusted: DataLabels = { provenance: ["trusted"], dataClasses: [], source: "propagated" };
    expect(endorseLabels(trusted)).toBe(trusted);
  });

  it("data classes imply sensitive; a declared flag reads only true", () => {
    expect(withImpliedSensitive({ provenance: ["user"], dataClasses: ["iban"], source: "propagated" }).provenance).toEqual(["user", "sensitive"]);
    expect(withImpliedSensitive({ provenance: ["user"], dataClasses: [], source: "propagated" }).provenance).toEqual(["user"]);
    expect(declaresSensitiveOutput({ sensitiveOutput: true })).toBe(true);
    expect(declaresSensitiveOutput({ sensitiveOutput: "true" })).toBe(false);
    expect(declaresSensitiveOutput(undefined)).toBe(false);
  });
});
