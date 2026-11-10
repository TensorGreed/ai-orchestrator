import { describe, expect, it } from "vitest";
import {
  findRevealRule,
  GUARD_ACTION_VALUES,
  GUARD_EVENT_ACTION_VALUES,
  GUARD_EVENT_CHANNEL_VALUES,
  GUARD_PROFILE_CHANNEL_VALUES,
  guardRevealNodeConfigSchema,
  revealSubjectIsAdmin,
  revealSubjectOf
} from "./guard";
import { nodeDefinitions } from "./definitions";
import { REPLAY_NODE_CLASSES } from "./replay";

describe("Reveal node contract", () => {
  it("defaults to the effective rule set, keeps refused tokens, and lists no keys", () => {
    expect(guardRevealNodeConfigSchema.parse({})).toEqual({
      profileId: "effective",
      inputField: "text",
      keySecretRefs: [],
      formatPreservingClasses: [],
      onRefused: "keep",
      timeoutMinutes: 1440
    });
    expect(guardRevealNodeConfigSchema.safeParse({ onRefused: "drop" }).success).toBe(false);
    expect(guardRevealNodeConfigSchema.safeParse({ formatPreservingClasses: ["card number"] }).success).toBe(false);
    expect(guardRevealNodeConfigSchema.safeParse({ keySecretRefs: [{ secretId: "" }] }).success).toBe(false);
  });

  it("is a node definition whose replay class runs it (it passes its input through in a replay)", () => {
    expect(nodeDefinitions.some((definition) => definition.type === "guard_reveal")).toBe(true);
    expect(REPLAY_NODE_CLASSES.guard_reveal).toBe("guard");
  });

  it("widens event actions and channels with reveal, but never the rule actions or rule set channels", () => {
    expect(GUARD_EVENT_ACTION_VALUES).toContain("reveal");
    expect(GUARD_ACTION_VALUES as readonly string[]).not.toContain("reveal");
    expect(GUARD_EVENT_CHANNEL_VALUES).toContain("reveal");
    expect(GUARD_PROFILE_CHANNEL_VALUES as readonly string[]).not.toContain("reveal");
  });
});

describe("reveal subjects", () => {
  const rules = [
    { dataClasses: ["card_number"], subjects: { roles: ["admin"] } },
    { dataClasses: ["email"], subjects: { serviceAccounts: ["sa-1"] } }
  ];

  it("maps a service account run to its id only, so role rules never match it", () => {
    const subject = revealSubjectOf({ source: "user", role: "admin", userId: "sa-1", serviceAccountId: "sa-1" });
    expect(subject).toEqual({ source: "service_account", serviceAccountId: "sa-1" });
    expect(findRevealRule(rules, { subject, dataClass: "card_number" })).toBeUndefined();
    expect(findRevealRule(rules, { subject, dataClass: "email" })).toBe(rules[1]);
    expect(revealSubjectIsAdmin(subject)).toBe(false);
  });

  it("treats only a signed-in admin as an admin for unscoped tokens", () => {
    expect(revealSubjectIsAdmin(revealSubjectOf({ source: "user", role: "admin", userId: "u" }))).toBe(true);
    expect(revealSubjectIsAdmin(revealSubjectOf({ source: "owner", role: "admin", userId: "u" }))).toBe(false);
    expect(revealSubjectIsAdmin(revealSubjectOf({ source: "user", role: "builder", userId: "u" }))).toBe(false);
    expect(revealSubjectIsAdmin(revealSubjectOf(undefined))).toBe(false);
  });
});
