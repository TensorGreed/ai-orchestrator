/**
 * A model node's label that names its provider or model ("Chat Model (echo)", "OpenAI Chat Model", "gpt-4o-mini")
 * follows the node's model when the provider or model changes, so the canvas never says Echo for a node that calls
 * Anthropic. Only labels in those shapes change: any other name is the person's own and is kept.
 */
import { MODEL_PROVIDER_CHOICES } from "@ai-orchestrator/shared";

export interface ModelRef {
  providerId?: string;
  model?: string;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  echo: "Echo",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  azure_openai: "Azure OpenAI",
  openai_compatible: "OpenAI Compatible",
  ollama: "Ollama"
};

/** The short name of a provider, as labels write it. */
export function providerDisplayName(providerId: string): string {
  return PROVIDER_NAMES[providerId] ?? MODEL_PROVIDER_CHOICES.find((choice) => choice.value === providerId)?.label ?? providerId;
}

/** Every way a label may name a provider (id, short name, picker label, "Google Gemini"), lower case. */
const PROVIDER_TOKENS: ReadonlySet<string> = new Set(
  [
    ...Object.keys(PROVIDER_NAMES),
    ...Object.values(PROVIDER_NAMES),
    ...MODEL_PROVIDER_CHOICES.map((choice) => choice.label),
    "Google Gemini",
    "Azure",
    "OpenAI-compatible"
  ].map((token) => token.toLowerCase())
);

const PAREN_SUFFIX = /^(.*\S)\s*\(([^()]+)\)$/;
const PROVIDER_PREFIX = /^(.+?)\s+(Chat Model|Chat|Model|LLM)$/i;

/**
 * The label after the node's model changed from `before` to `after`: a provider or model named in a trailing
 * "(…)", a "<Provider> Chat Model" label, or a label that is just the model's name follows the change; any other
 * label comes back as it is.
 */
export function relabelForModel(label: string, before: ModelRef, after: ModelRef): string {
  const fromProvider = (before.providerId ?? "").trim();
  const toProvider = (after.providerId ?? "").trim();
  const fromModel = (before.model ?? "").trim();
  const toModel = (after.model ?? "").trim();
  const providerChanged = Boolean(toProvider) && fromProvider !== toProvider;
  const modelChanged = Boolean(toModel) && fromModel !== toModel;
  if (!providerChanged && !modelChanged) return label;

  const suffix = PAREN_SUFFIX.exec(label);
  if (suffix) {
    const inner = suffix[2]!.trim();
    const lower = inner.toLowerCase();
    if (providerChanged && PROVIDER_TOKENS.has(lower)) {
      // "(echo)" was written lower case in the shipped templates: keep the case style.
      const name = providerDisplayName(toProvider);
      return `${suffix[1]} (${inner === lower ? name.toLowerCase() : name})`;
    }
    if (modelChanged && fromModel && lower === fromModel.toLowerCase()) return `${suffix[1]} (${toModel})`;
    return label;
  }
  const prefixed = PROVIDER_PREFIX.exec(label);
  if (prefixed && providerChanged && PROVIDER_TOKENS.has(prefixed[1]!.trim().toLowerCase())) {
    return `${providerDisplayName(toProvider)} ${prefixed[2]}`;
  }
  if (modelChanged && fromModel && label.trim().toLowerCase() === fromModel.toLowerCase()) return toModel;
  return label;
}
