/**
 * 12.7 — a log stream destination's categories. No category sends every audit event; `*` stands for every audit
 * category; `rule_events` (content rule events) is never implied and must be listed.
 */
export const RULE_EVENTS_CATEGORY = "rule_events";
export const ALL_AUDIT_CATEGORIES = "*";

export type LogStreamEventsChoice = "audit" | "audit_and_rules" | "rules";

export const LOG_STREAM_EVENT_CHOICES: Array<{ value: LogStreamEventsChoice; label: string }> = [
  { value: "audit", label: "Audit events" },
  { value: "audit_and_rules", label: "Audit and content rule events" },
  { value: "rules", label: "Content rule events only" }
];

/** The categories to save for a new destination. */
export function categoriesFor(choice: LogStreamEventsChoice, auditCategories: string[]): string[] {
  if (choice === "rules") return [RULE_EVENTS_CATEGORY];
  if (choice === "audit") return [...auditCategories];
  return [...(auditCategories.length > 0 ? auditCategories : [ALL_AUDIT_CATEGORIES]), RULE_EVENTS_CATEGORY];
}

export function sendsRuleEvents(categories: string[]): boolean {
  return categories.includes(RULE_EVENTS_CATEGORY);
}

/**
 * The categories after turning content rule events on or off, keeping the audit events the destination gets now.
 * Null: turning them off would leave a rule-events-only destination with nothing to send (disable it instead).
 */
export function withRuleEvents(categories: string[], on: boolean): string[] | null {
  if (on) {
    if (sendsRuleEvents(categories)) return categories;
    return [...(categories.length > 0 ? categories : [ALL_AUDIT_CATEGORIES]), RULE_EVENTS_CATEGORY];
  }
  const rest = categories.filter((category) => category !== RULE_EVENTS_CATEGORY);
  if (rest.length === 0) return null;
  return rest.length === 1 && rest[0] === ALL_AUDIT_CATEGORIES ? [] : rest;
}

/** A short label for the destinations table. */
export function describeCategories(categories: string[]): string {
  if (categories.length === 0) return "all audit events";
  return categories
    .map((category) => (category === ALL_AUDIT_CATEGORIES ? "all audit events" : category === RULE_EVENTS_CATEGORY ? "content rule events" : category))
    .join(", ");
}
