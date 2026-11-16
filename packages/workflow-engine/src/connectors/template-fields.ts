import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import { renderCheckedTemplate as renderTemplate } from "../template";

/**
 * A whole-number config field that takes a number or a `{{ }}` template (an issue number from the triggering event,
 * an amount from the request). Undefined when the field is empty or renders empty; a node error when the value is not
 * a whole number.
 */
export function renderIntegerField(
  config: Record<string, unknown>,
  key: string,
  templateData: Record<string, unknown>,
  nodeLabel: string
): number | undefined {
  const raw = config[key];
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string") {
    const rendered = renderTemplate(raw, templateData).trim();
    if (!rendered) return undefined;
    if (!/^-?\d+$/.test(rendered)) {
      throw new WorkflowError(`${nodeLabel}: '${key}' must be a whole number, got '${rendered.slice(0, 40)}'`, ErrorCategory.NODE_CONFIG, false);
    }
    value = Number(rendered);
  } else {
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    throw new WorkflowError(`${nodeLabel}: '${key}' must be a whole number`, ErrorCategory.NODE_CONFIG, false);
  }
  return value;
}

/** A required string config field, rendered as a template; a node error when it is missing or renders empty. */
export function renderRequiredString(
  config: Record<string, unknown>,
  key: string,
  templateData: Record<string, unknown>,
  nodeLabel: string
): string {
  const raw = config[key];
  const rendered = typeof raw === "string" ? renderTemplate(raw, templateData).trim() : "";
  if (!rendered) {
    throw new WorkflowError(
      typeof raw === "string" && raw.trim()
        ? `${nodeLabel}: config field '${key}' rendered empty.`
        : `${nodeLabel} requires config field '${key}'.`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  return rendered;
}
