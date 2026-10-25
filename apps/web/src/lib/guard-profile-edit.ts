// Phase 12.1 — immutable edits on a guard profile document for the profile
// editor. The API validates the result with the guard-sdk schema; these
// helpers only keep the document's shape.

export type GuardDocument = Record<string, unknown>;

export const GUARD_EDITOR_CHANNELS = ["prompt", "tool_arguments", "tool_result", "model_output", "final_output"] as const;
export const GUARD_EDITOR_ACTIONS = ["allow", "block", "review", "require_approval", "redact", "mask", "protect", "transform"] as const;

export interface ChannelView {
  detectors: Array<{ id: string; threshold: number; options?: Record<string, unknown> }>;
  actions: Record<string, { action: string; shadow?: boolean; providerId?: string }>;
  defaultAction: { action: string; shadow?: boolean };
}

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function cloneDocument(document: GuardDocument): GuardDocument {
  return JSON.parse(JSON.stringify(document)) as GuardDocument;
}

export function channelOf(document: GuardDocument, channel: string): ChannelView | null {
  const raw = rec(rec(document.channels)[channel]);
  if (Object.keys(raw).length === 0) return null;
  const detectors = Array.isArray(raw.detectors)
    ? raw.detectors.map((entry) => rec(entry)).map((entry) => ({ id: String(entry.id ?? ""), threshold: typeof entry.threshold === "number" ? entry.threshold : 0.5, ...(entry.options ? { options: rec(entry.options) } : {}) }))
    : [];
  const actions: ChannelView["actions"] = {};
  for (const [key, value] of Object.entries(rec(raw.actions))) {
    const rule = rec(value);
    actions[key] = { action: String(rule.action ?? "block"), ...(typeof rule.shadow === "boolean" ? { shadow: rule.shadow } : {}), ...(typeof rule.providerId === "string" ? { providerId: rule.providerId } : {}) };
  }
  const fallback = rec(raw.defaultAction);
  return { detectors, actions, defaultAction: { action: String(fallback.action ?? "block"), ...(typeof fallback.shadow === "boolean" ? { shadow: fallback.shadow } : {}) } };
}

function withChannel(document: GuardDocument, channel: string, update: (current: ChannelView) => ChannelView): GuardDocument {
  const next = cloneDocument(document);
  const channels = rec(next.channels);
  const current = channelOf(document, channel) ?? { detectors: [], actions: {}, defaultAction: { action: "block" } };
  channels[channel] = update(current);
  next.channels = channels;
  return next;
}

export function setChannelEnabled(document: GuardDocument, channel: string, enabled: boolean): GuardDocument {
  if (enabled) return withChannel(document, channel, (current) => current);
  const next = cloneDocument(document);
  const channels = rec(next.channels);
  delete channels[channel];
  next.channels = channels;
  return next;
}

export function setDetector(document: GuardDocument, channel: string, detectorId: string, enabled: boolean, threshold?: number): GuardDocument {
  return withChannel(document, channel, (current) => {
    const existing = current.detectors.find((entry) => entry.id === detectorId);
    if (!enabled) return { ...current, detectors: current.detectors.filter((entry) => entry.id !== detectorId) };
    if (existing) {
      return { ...current, detectors: current.detectors.map((entry) => (entry.id === detectorId ? { ...entry, threshold: threshold ?? entry.threshold } : entry)) };
    }
    return { ...current, detectors: [...current.detectors, { id: detectorId, threshold: threshold ?? 0.5 }] };
  });
}

export function setActionRule(document: GuardDocument, channel: string, key: string, rule: { action: string; shadow?: boolean } | null): GuardDocument {
  return withChannel(document, channel, (current) => {
    const actions = { ...current.actions };
    if (!rule) delete actions[key];
    else actions[key] = { ...(actions[key] ?? {}), action: rule.action, ...(rule.shadow ? { shadow: true } : {}) };
    if (rule && !rule.shadow && actions[key]) delete actions[key]!.shadow;
    return { ...current, actions };
  });
}

export function setDefaultAction(document: GuardDocument, channel: string, action: string): GuardDocument {
  return withChannel(document, channel, (current) => ({ ...current, defaultAction: { action } }));
}

/** Profile-level shadow mode for one action (rules can still override it). */
export function setShadowForAction(document: GuardDocument, action: string, shadow: boolean): GuardDocument {
  const next = cloneDocument(document);
  const map = { ...rec(next.shadow) };
  if (shadow) map[action] = true;
  else delete map[action];
  next.shadow = map;
  return next;
}

export function setTopLevel(document: GuardDocument, path: "name" | "description", value: string): GuardDocument {
  const next = cloneDocument(document);
  if (path === "description" && !value.trim()) delete next.description;
  else next[path] = value;
  return next;
}

export function setLatencyBudget(document: GuardDocument, budget: { ms?: number; onExceeded?: string }): GuardDocument {
  const next = cloneDocument(document);
  next.latencyBudget = { ...rec(next.latencyBudget), ...(budget.ms !== undefined ? { ms: budget.ms } : {}), ...(budget.onExceeded ? { onExceeded: budget.onExceeded } : {}) };
  return next;
}

export function setProtectionFallback(document: GuardDocument, fallback: string): GuardDocument {
  const next = cloneDocument(document);
  next.protection = { ...rec(next.protection), fallback };
  return next;
}

export function setSpotlighting(document: GuardDocument, mode: "off" | "delimiters" | "datamark", harden = true): GuardDocument {
  const next = cloneDocument(document);
  if (mode === "off") delete next.spotlighting;
  else next.spotlighting = { mode, hardenSystemPrompt: harden };
  return next;
}

export function setCanaries(document: GuardDocument, enabled: boolean): GuardDocument {
  const next = cloneDocument(document);
  if (enabled) next.canaries = { enabled: true };
  else delete next.canaries;
  return next;
}

/**
 * Phase 16 — "Track where data came from": `labels: "propagated"` on, field
 * removed when off (so a profile that never used it keeps its hash).
 */
export function setLabelTracking(document: GuardDocument, enabled: boolean): GuardDocument {
  const next = cloneDocument(document);
  if (enabled) next.labels = "propagated";
  else delete next.labels;
  return next;
}

/** A copy of a profile under a new id, for "Duplicate" (the built-in profile cannot be edited in place). */
export function duplicateDocument(document: GuardDocument, id: string, name: string): GuardDocument {
  const next = cloneDocument(document);
  next.id = id;
  next.name = name;
  next.version = "1";
  return next;
}

export function suggestProfileId(name: string, taken: Set<string>): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "profile";
  let candidate = base.length >= 2 ? base : `${base}-profile`;
  let counter = 2;
  while (taken.has(candidate)) candidate = `${base}-${counter++}`;
  return candidate;
}

/**
 * Phase 16 — one plain sentence per destination rule of a profile document,
 * for the read-only summary in the editor. Empty when there are none.
 */
export function destinationRuleLines(document: Record<string, unknown>): string[] {
  const destinations = document.destinations as { rules?: unknown } | undefined;
  const rules = Array.isArray(destinations?.rules) ? destinations.rules : [];
  const tierLabel: Record<string, string> = { local: "this machine", private: "the private network", vendor: "approved vendors", public: "anywhere" };
  return rules.map((raw) => {
    const rule = (raw && typeof raw === "object" ? raw : {}) as {
      name?: unknown;
      when?: { dataClasses?: unknown; provenance?: unknown };
      allow?: { maxTier?: unknown; regions?: unknown };
      action?: unknown;
      shadow?: unknown;
    };
    const list = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
    const subjects = [...list(rule.when?.dataClasses), ...list(rule.when?.provenance).map((label) => `${label} data`)];
    const what = subjects.length ? subjects.join(", ") : "Any data";
    const tier = tierLabel[String(rule.allow?.maxTier)] ?? String(rule.allow?.maxTier ?? "?");
    const regions = list(rule.allow?.regions);
    // Regions apply only to vendor and public destinations; this machine and the private network always pass.
    const where = `${tier}${regions.length ? ` in ${regions.join(", ")} (regions apply to vendors and public destinations only)` : ""}`;
    const action = String(rule.action ?? "block").replace(/_/g, " ");
    const name = typeof rule.name === "string" && rule.name ? `${rule.name}: ` : "";
    return `${name}${what} may only go to ${where}; otherwise ${action}${rule.shadow === true ? " (shadow: observe only)" : ""}.`;
  });
}
