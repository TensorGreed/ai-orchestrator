import { describe, expect, it } from "vitest";
import type { WorkflowExecutionDependencies } from "./executor";
import { childGuardFor, redactingSessionStores, RevealRedactor } from "./reveal-redaction";

/** Phase 12 coverage — revealed values are put back as their tokens in everything a run keeps or sends outside. */

const CARD = "4111 1111 1111 1111";
const CARD_TOKEN = "tok_card_number_AAAAAAAAAAAAAAAA";

describe("RevealRedactor", () => {
  it("returns the value itself while nothing was revealed", () => {
    const redactor = new RevealRedactor();
    const value = { text: CARD };
    expect(redactor.active).toBe(false);
    expect(redactor.redact(value)).toBe(value);
  });

  it("puts every revealed value back as its token, deep, without changing the original", () => {
    const redactor = new RevealRedactor();
    redactor.add(CARD, CARD_TOKEN);
    redactor.add("4111", "tok_short_BBBBBBBBBBBBBBBB");
    const original = { a: [`Card ${CARD}`, { b: CARD }], n: 1, flag: true, nil: null };
    const redacted = redactor.redact(original);
    // The longer value wins over a value it contains.
    expect(redacted).toEqual({ a: [`Card ${CARD_TOKEN}`, { b: CARD_TOKEN }], n: 1, flag: true, nil: null });
    expect(original.a[0]).toBe(`Card ${CARD}`);
  });

  it("finds a value inside serialised JSON, in error messages and through cycles", () => {
    const redactor = new RevealRedactor();
    redactor.add('Ana "the" Lopez', "tok_person_CCCCCCCCCCCCCCCC");
    expect(redactor.redactText(JSON.stringify({ name: 'Ana "the" Lopez' }))).toBe(JSON.stringify({ name: "tok_person_CCCCCCCCCCCCCCCC" }));
    const error = redactor.redact(new Error('Rejected Ana "the" Lopez'));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Rejected tok_person_CCCCCCCCCCCCCCCC");
    const cyclic: Record<string, unknown> = { name: 'Ana "the" Lopez' };
    cyclic.self = cyclic;
    const out = redactor.redact(cyclic) as Record<string, unknown>;
    expect(out.name).toBe("tok_person_CCCCCCCCCCCCCCCC");
    expect(out.self).toBe(out);
  });

  it("ignores values too short to put back safely", () => {
    const redactor = new RevealRedactor();
    redactor.add("42", "tok_x_DDDDDDDDDDDDDDDD");
    expect(redactor.active).toBe(false);
    expect(redactor.redactText("42 apples")).toBe("42 apples");
  });

  it("puts tokens back in what the session stores save, and reads unchanged", async () => {
    const redactor = new RevealRedactor();
    redactor.add(CARD, CARD_TOKEN);
    const saved: unknown[] = [];
    const stores = redactingSessionStores(
      {
        memoryStore: {
          loadMessages: async () => [{ role: "user", content: CARD }],
          saveMessages: async (_namespace, _sessionId, messages) => void saved.push(messages)
        },
        toolDataStore: {
          saveToolCall: async (input) => (saved.push(input), { ...input, id: "1", createdAt: "" }),
          listToolCalls: async () => [],
          getToolCall: async () => null
        },
        sessionArtifactStore: {
          saveArtifact: async (input) => (saved.push(input), { ...input, createdAt: "", updatedAt: "" }),
          loadArtifact: async () => null
        }
      } as Pick<WorkflowExecutionDependencies, "memoryStore" | "toolDataStore" | "sessionArtifactStore">,
      redactor
    );
    await stores.memoryStore!.saveMessages("ns", "s1", [{ role: "assistant", content: `Card ${CARD}` }]);
    await stores.toolDataStore!.saveToolCall({ namespace: "ns", sessionId: "s1", toolName: "pay", args: { card: CARD }, output: CARD });
    await stores.sessionArtifactStore!.saveArtifact({ namespace: "ns", sessionId: "s1", artifactKey: "k", value: { card: CARD } });
    expect(JSON.stringify(saved)).not.toContain(CARD);
    expect(JSON.stringify(saved)).toContain(CARD_TOKEN);
    expect(await stores.memoryStore!.loadMessages("ns", "s1")).toEqual([{ role: "user", content: CARD }]);
  });
});

describe("childGuardFor", () => {
  const guard = { resolveRun: () => ({ source: "none" as const, stack: [], chain: [] }), loadProfile: () => undefined, projectId: "proj-a", onReveal: () => undefined };

  it("keeps the run's content rules for a child in the same project", () => {
    expect(childGuardFor(guard, { id: "c", projectId: "proj-a" })).toBe(guard);
  });

  it("turns reveal off for a child in another project when the API gives no scope", () => {
    const child = childGuardFor(guard, { id: "c", projectId: "proj-b" });
    expect(child.revealDisabled).toBe(true);
    expect(child.onReveal).toBeUndefined();
  });

  it("asks the API for the child's own scope when it can", () => {
    const scoped = { ...guard, projectId: "proj-b" };
    const asked: unknown[] = [];
    expect(childGuardFor({ ...guard, forWorkflow: (workflow) => (asked.push(workflow), scoped) }, { id: "c", projectId: "proj-b" })).toBe(scoped);
    expect(asked).toEqual([{ id: "c", projectId: "proj-b" }]);
  });
});
