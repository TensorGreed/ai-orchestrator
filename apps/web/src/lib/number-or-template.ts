/**
 * A config field that takes a whole number or a `{{ }}` template (an issue number, a Stripe amount): shown as text,
 * stored as a number when the text is a whole number, else as text (the run refuses text that does not render to a
 * whole number), and cleared when empty.
 */
export function parseNumberOrTemplate(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return text;
}

export function numberOrTemplateText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value : "";
}

/** A definition field typed as both a number and a string, e.g. `type: ["integer", "string"]`. */
export function isNumberOrTemplateSchema(propSchema: Record<string, unknown>): boolean {
  const type = propSchema.type;
  if (!Array.isArray(type)) return false;
  return type.includes("string") && (type.includes("integer") || type.includes("number"));
}
