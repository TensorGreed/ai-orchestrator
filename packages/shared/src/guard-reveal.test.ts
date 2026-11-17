import { describe, expect, it } from "vitest";
import {
  findRevealRule,
  REVEAL_GATEWAY_CLIENT_SOURCE,
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

  it("treats a service account's address as a service account even without its id", () => {
    const subject = revealSubjectOf({ source: "user", role: "admin", userId: "sa-1", email: "crm-bot@SERVICE.invalid" });
    expect(subject).toEqual({ source: "service_account", serviceAccountId: "sa-1" });
    expect(findRevealRule(rules, { subject, dataClass: "card_number" })).toBeUndefined();
    expect(findRevealRule(rules, { subject, dataClass: "email" })).toBe(rules[1]);
    expect(revealSubjectIsAdmin(subject)).toBe(false);
    expect(revealSubjectOf({ source: "user", role: "admin", email: "bot@service.invalid" })).toEqual({ source: "service_account" });
    expect(revealSubjectOf({ source: "user", role: "admin", userId: "u", email: "ana@service.invalid.example.org" })).toEqual({ source: "user", role: "admin", userId: "u" });
  });

  it("treats only a signed-in admin as an admin for unscoped tokens", () => {
    expect(revealSubjectIsAdmin(revealSubjectOf({ source: "user", role: "admin", userId: "u" }))).toBe(true);
    expect(revealSubjectIsAdmin(revealSubjectOf({ source: "owner", role: "admin", userId: "u" }))).toBe(false);
    expect(revealSubjectIsAdmin(revealSubjectOf({ source: "user", role: "builder", userId: "u" }))).toBe(false);
    expect(revealSubjectIsAdmin(revealSubjectOf(undefined))).toBe(false);
  });
});

describe("reveal rules for MCP gateway clients", () => {
  const rules = [
    { dataClasses: ["email"], subjects: { gatewayClients: ["mcpc_a"] } },
    { dataClasses: ["phone"], subjects: { roles: ["admin"], users: ["usr_1"] } }
  ];
  const client = (id: string) => ({ source: REVEAL_GATEWAY_CLIENT_SOURCE, gatewayClientId: id, role: "admin", userId: "usr_1" });

  it("matches a gateway client only by its id, never by the role or user it acts as", () => {
    expect(findRevealRule(rules, { subject: client("mcpc_a"), dataClass: "email" })).toBe(rules[0]);
    expect(findRevealRule(rules, { subject: client("mcpc_b"), dataClass: "email" })).toBeUndefined();
    expect(findRevealRule(rules, { subject: client("mcpc_a"), dataClass: "phone" })).toBeUndefined();
  });

  it("does not let a person match a gateway client rule", () => {
    expect(findRevealRule(rules, { subject: { source: "user", role: "admin", userId: "mcpc_a" }, dataClass: "email" })).toBeUndefined();
    expect(findRevealRule(rules, { subject: { source: "user", role: "admin" }, dataClass: "phone" })).toBe(rules[1]);
  });
});
