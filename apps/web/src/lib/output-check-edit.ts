// Phase 12 coverage — form helpers for the output checks (schema, topic, safety, grounding) in the rule set editor
// and on the Output Guardrail node. The API checks the result when it is saved; these only keep the shape.

export const OUTPUT_CHECK_IDS = ["output.schema", "output.topic", "output.safety", "output.grounding"] as const;
export type OutputCheckId = (typeof OUTPUT_CHECK_IDS)[number];

export const SAFETY_CATEGORY_LABELS: Record<string, string> = {
  self_harm: "Self-harm",
  violence: "Violence",
  sexual: "Sexual content",
  sexual_minors: "Sexual content involving minors",
  hate: "Hate"
};

export const OUTPUT_CHECK_LABELS: Record<OutputCheckId, string> = {
  "output.schema": "Answer schema",
  "output.topic": "Topics",
  "output.safety": "Content safety",
  "output.grounding": "Grounding in sources"
};

/** The finding category each check reports, for its `stream: "buffer"` rule. */
export const OUTPUT_CHECK_CATEGORY: Record<OutputCheckId, string> = {
  "output.schema": "schema_violation",
  "output.topic": "off_topic",
  "output.safety": "unsafe_content",
  "output.grounding": "ungrounded"
};

export function isOutputCheck(id: string): id is OutputCheckId {
  return (OUTPUT_CHECK_IDS as readonly string[]).includes(id);
}

export interface TopicEntry {
  name: string;
  phrases?: string[];
  dictionary?: string;
  examples?: string[];
}

/** Topics as editable text: one per line, `name: phrase, phrase` (a bare name matches itself). */
export function topicsToText(topics: unknown): string {
  if (!Array.isArray(topics)) return "";
  return topics
    .map((topic) => {
      if (typeof topic === "string") return topic;
      if (!topic || typeof topic !== "object") return "";
      const entry = topic as TopicEntry;
      const phrases = Array.isArray(entry.phrases) ? entry.phrases : [];
      return phrases.length > 0 ? `${entry.name}: ${phrases.join(", ")}` : String(entry.name ?? "");
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Text back to topics. A line keeps the fields the text does not show (a dictionary, examples) from the topic of the
 * same name in `previous`, so editing phrases never drops them.
 */
export function textToTopics(text: string, previous: unknown = []): Array<string | TopicEntry> {
  const before = new Map<string, TopicEntry>();
  if (Array.isArray(previous)) {
    for (const topic of previous) if (topic && typeof topic === "object" && typeof (topic as TopicEntry).name === "string") before.set((topic as TopicEntry).name, topic as TopicEntry);
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(":");
      const name = (colon >= 0 ? line.slice(0, colon) : line).trim();
      const phrases = colon >= 0 ? line.slice(colon + 1).split(",").map((phrase) => phrase.trim()).filter(Boolean) : [];
      const kept = before.get(name);
      const { phrases: _old, ...extra } = kept ?? ({} as TopicEntry);
      if (phrases.length === 0 && Object.keys(extra).filter((key) => key !== "name").length === 0) return name;
      return { ...extra, name, ...(phrases.length > 0 ? { phrases } : {}) };
    })
    .filter((topic) => (typeof topic === "string" ? topic : topic.name));
}

/** A model option as two fields; empty fields mean "no model named". Other fields of the option are kept. */
export function modelFields(model: unknown): { providerId: string; model: string } {
  const record = model && typeof model === "object" ? (model as Record<string, unknown>) : {};
  return { providerId: typeof record.providerId === "string" ? record.providerId : "", model: typeof record.model === "string" ? record.model : "" };
}

export function withModelField(model: unknown, field: "providerId" | "model", value: string): Record<string, unknown> | undefined {
  const record = { ...(model && typeof model === "object" ? (model as Record<string, unknown>) : {}), [field]: value.trim() };
  if (!record.providerId && !record.model) return undefined;
  return record;
}

/** The stored secret a model option names (`secretRef.secretId`), or "". */
export function modelSecretId(model: unknown): string {
  const record = model && typeof model === "object" ? (model as Record<string, unknown>) : {};
  const ref = record.secretRef && typeof record.secretRef === "object" ? (record.secretRef as Record<string, unknown>) : {};
  return typeof ref.secretId === "string" ? ref.secretId : "";
}

/** A model option naming a stored secret (never a key); "" removes it. Undefined when no model is named. */
export function withModelSecret(model: unknown, secretId: string): Record<string, unknown> | undefined {
  const record = { ...(model && typeof model === "object" ? (model as Record<string, unknown>) : {}) };
  if (secretId) record.secretRef = { secretId };
  else delete record.secretRef;
  if (!record.providerId && !record.model) return undefined;
  return record;
}

/** Set or drop one option; `undefined`, empty strings and empty lists drop it. */
export function withOption(options: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const next = { ...options };
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete next[key];
  else next[key] = value;
  return next;
}
