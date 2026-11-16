import { describe, expect, it } from "vitest";
import { categoriesFor, describeCategories, sendsRuleEvents, withRuleEvents } from "./log-stream-categories";

describe("log stream categories", () => {
  it("builds the categories for a new destination", () => {
    expect(categoriesFor("audit", [])).toEqual([]);
    expect(categoriesFor("audit", ["auth"])).toEqual(["auth"]);
    expect(categoriesFor("audit_and_rules", [])).toEqual(["*", "rule_events"]);
    expect(categoriesFor("audit_and_rules", ["auth"])).toEqual(["auth", "rule_events"]);
    expect(categoriesFor("rules", ["auth"])).toEqual(["rule_events"]);
  });

  it("turns content rule events on and off without changing the audit events a destination gets", () => {
    expect(withRuleEvents([], true)).toEqual(["*", "rule_events"]);
    expect(withRuleEvents(["auth"], true)).toEqual(["auth", "rule_events"]);
    expect(withRuleEvents(["rule_events"], true)).toEqual(["rule_events"]);
    expect(withRuleEvents(["*", "rule_events"], false)).toEqual([]);
    expect(withRuleEvents(["auth", "rule_events"], false)).toEqual(["auth"]);
    expect(withRuleEvents(["rule_events"], false)).toBeNull();
    expect(sendsRuleEvents(["auth"])).toBe(false);
  });

  it("describes categories in plain words", () => {
    expect(describeCategories([])).toBe("all audit events");
    expect(describeCategories(["*", "rule_events"])).toBe("all audit events, content rule events");
    expect(describeCategories(["auth"])).toBe("auth");
  });
});
