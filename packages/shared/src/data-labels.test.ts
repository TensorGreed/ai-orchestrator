import { describe, expect, it } from "vitest";
import { recordedInputLabels } from "./data-label-provenance";
import { modelMemorySeedSchema } from "./model-tape";
import { unionDataLabels, type DataLabels } from "./data-labels";

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
