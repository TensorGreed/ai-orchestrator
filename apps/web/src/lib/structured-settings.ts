/**
 * Typed settings in place of raw JSON: which keys an embedder or a vector store reads from its settings object, with
 * a label and help for each, and small pure helpers to edit those objects and lists without losing keys a form does
 * not know (they stay, and show under "Other settings").
 *
 * The keys mirror what the engine reads: the RAG Retrieve node's `vectorStoreConfig` (packages/workflow-engine
 * executor.ts, rag_retrieve) and a knowledge base's `embedderConfig` (apps/api buildEmbedderFromKbConfig).
 */

export interface SettingField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
}

type Settings = Record<string, unknown>;

const MODEL = (placeholder: string): SettingField => ({ key: "model", label: "Model", placeholder, help: "Blank uses the default model." });

/** The keys each embedder reads (from a RAG node's vector store settings or a knowledge base's embedder settings). */
const EMBEDDER_FIELDS: Record<string, SettingField[]> = {
  "token-embedder": [],
  "openai-embedder": [
    MODEL("text-embedding-3-small"),
    { key: "baseUrl", label: "Base URL", placeholder: "https://api.openai.com/v1", help: "Blank uses OpenAI. Another URL gets only the node's own key, never the deployment's." }
  ],
  "azure-openai-embedder": [
    { key: "endpoint", label: "Endpoint", placeholder: "https://my-resource.openai.azure.com", help: "Blank uses AZURE_OPENAI_ENDPOINT." },
    { key: "deployment", label: "Deployment", placeholder: "text-embedding-3-small", help: "Blank uses the model, else text-embedding-3-small." },
    { key: "apiVersion", label: "API version", placeholder: "2024-02-01", help: "Blank uses AZURE_OPENAI_API_VERSION." }
  ],
  "cohere-embedder": [MODEL("embed-english-v3.0")],
  "mistral-embedder": [MODEL("mistral-embed")],
  "google-vertex-embedder": [MODEL("text-embedding-004")],
  "huggingface-embedder": [MODEL("sentence-transformers/all-MiniLM-L6-v2")]
};

const ENDPOINT = (placeholder: string, envName: string): SettingField => ({ key: "endpoint", label: "Endpoint", placeholder, help: `Blank uses ${envName}.` });

/** The keys each vector store reads from a RAG node's vector store settings. */
const VECTOR_STORE_FIELDS: Record<string, SettingField[]> = {
  "in-memory-vector-store": [],
  "knowledge-base": [],
  "pinecone-vector-store": [{ key: "indexName", label: "Index name", placeholder: "my-index" }],
  "pgvector-store": [{ key: "tableName", label: "Table name", placeholder: "vectors", help: "Blank is vectors." }],
  "azure-ai-search-vector-store": [
    ENDPOINT("https://my-search.search.windows.net", "AZURE_AI_SEARCH_ENDPOINT"),
    { key: "indexName", label: "Index name", placeholder: "my-index" },
    { key: "apiVersion", label: "API version", placeholder: "2024-07-01" },
    { key: "vectorField", label: "Vector field", placeholder: "contentVector" },
    { key: "contentField", label: "Content field", placeholder: "content" },
    { key: "idField", label: "ID field", placeholder: "id" },
    { key: "metadataField", label: "Metadata field", placeholder: "metadata" }
  ],
  "qdrant-vector-store": [
    ENDPOINT("http://localhost:6333", "QDRANT_ENDPOINT"),
    { key: "collectionName", label: "Collection", placeholder: "documents" },
    { key: "apiKeyHeaderName", label: "API key header", placeholder: "api-key" },
    { key: "contentField", label: "Content field", placeholder: "text" },
    { key: "metadataField", label: "Metadata field", placeholder: "metadata" }
  ],
  "chroma-vector-store": [ENDPOINT("http://localhost:8000", "CHROMA_ENDPOINT"), { key: "collectionName", label: "Collection", placeholder: "documents" }],
  "weaviate-vector-store": [ENDPOINT("http://localhost:8080", "WEAVIATE_ENDPOINT"), { key: "className", label: "Class name", placeholder: "Document" }],
  "redis-vector-store": [ENDPOINT("http://localhost:6379", "REDIS_ENDPOINT"), { key: "indexName", label: "Index name", placeholder: "idx:documents" }]
};

/** Keys a settings object may hold that another field of the node edits (not shown as "other settings"). */
const HANDLED_ELSEWHERE = new Set(["knowledgeBaseId"]);

/** The fields a knowledge base's embedder settings show (its key is picked separately, as a secret). */
export function embedderSettingFields(embedderId: string): SettingField[] {
  return EMBEDDER_FIELDS[embedderId] ?? [];
}

/**
 * The fields a RAG node's vector store settings show: the embedder's, then the store's. A key both read (the Azure
 * embedder and a store with an endpoint) is one field: the engine reads one value for both.
 */
export function ragSettingFields(embedderId: string, vectorStoreId: string): SettingField[] {
  const fields: SettingField[] = [];
  const seen = new Set<string>();
  for (const field of [...embedderSettingFields(embedderId), ...(VECTOR_STORE_FIELDS[vectorStoreId] ?? [])]) {
    if (seen.has(field.key)) {
      const index = fields.findIndex((entry) => entry.key === field.key);
      fields[index] = { ...fields[index]!, help: "Used by the embedder and the vector store." };
      continue;
    }
    seen.add(field.key);
    fields.push(field);
  }
  return fields;
}

/** The settings with `key` set to `value`; an empty value removes the key. */
export function withSetting(settings: Settings, key: string, value: string): Settings {
  const { [key]: _previous, ...rest } = settings;
  return value.trim() === "" ? rest : { ...rest, [key]: value };
}

/** The settings the fields do not show (kept as they are, and edited as JSON under "Other settings"). */
export function otherSettings(settings: Settings, fields: readonly SettingField[], hidden: readonly string[] = []): Settings {
  const shown = new Set([...fields.map((field) => field.key), ...hidden, ...HANDLED_ELSEWHERE]);
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !shown.has(key)));
}

/** The settings with the "other settings" replaced by `others` (the shown fields and handled keys are kept). */
export function withOtherSettings(settings: Settings, fields: readonly SettingField[], others: Settings, hidden: readonly string[] = []): Settings {
  const shown = new Set([...fields.map((field) => field.key), ...hidden, ...HANDLED_ELSEWHERE]);
  const kept = Object.fromEntries(Object.entries(settings).filter(([key]) => shown.has(key)));
  const extra = Object.fromEntries(Object.entries(others).filter(([key]) => !shown.has(key)));
  return { ...kept, ...extra };
}

/** Keys of `others` that "Other settings" cannot set, because a field (or another control) edits them. */
export function keysEditedElsewhere(others: Settings, fields: readonly SettingField[], hidden: readonly string[] = []): string[] {
  const shown = new Set([...fields.map((field) => field.key), ...hidden, ...HANDLED_ELSEWHERE]);
  return Object.keys(others).filter((key) => shown.has(key));
}

/** A settings value as the text a field shows (a non-text value shows as JSON, so it is not lost silently). */
export function settingText(settings: Settings, key: string): string {
  const value = settings[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

// ── Switch cases ─────────────────────────────────────────────────────────────

export interface SwitchCaseRow {
  value: string;
  label: string;
}

/** A Switch node's cases as rows (a case saved as plain text is its own value and label). */
export function readSwitchCases(value: unknown): SwitchCaseRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { value: entry, label: entry };
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      value: record.value === undefined || record.value === null ? "" : String(record.value),
      // A case saved without a label is drawn (and routed) by its value, so it reads as its own label.
      label: record.label === undefined || record.label === null ? (record.value === undefined || record.value === null ? "" : String(record.value)) : String(record.label)
    };
  });
}

/**
 * The case row with its value changed. On a case added in this edit (`isNew`) a label that still reads the same as the
 * value follows it. On a saved case the label stays: it names the output its branch is connected to.
 */
export function withCaseValue(row: SwitchCaseRow, value: string, isNew = false): SwitchCaseRow {
  return { value, label: isNew && row.label === row.value ? value : row.label };
}

/** Labels used by more than one case (their branches would share one output). */
export function duplicateCaseLabels(rows: readonly SwitchCaseRow[], defaultLabel: string): string[] {
  const counts = new Map<string, number>();
  for (const label of [...rows.map((row) => row.label.trim()), defaultLabel.trim()]) {
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([label]) => label);
}

// ── Key/value mappings (Execute Workflow input and output mapping) ───────────

export interface MappingRow {
  from: string;
  to: string;
}

export function readMapping(value: unknown): MappingRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([from, to]) => ({ from, to: to === undefined || to === null ? "" : String(to) }));
}

/** The rows as a mapping object; rows without a source are left out (a later row with the same source wins). */
export function mappingOf(rows: readonly MappingRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const from = row.from.trim();
    if (from) out[from] = row.to.trim();
  }
  return out;
}

// ── Form Trigger fields ──────────────────────────────────────────────────────

export const FORM_FIELD_TYPES = ["text", "textarea", "email", "number", "select", "checkbox"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormFieldRow {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  placeholder: string;
  /** Select only: one choice per entry. */
  options: string[];
  /** Keys of a saved field this editor does not show, kept as they were. */
  extra: Record<string, unknown>;
}

const FORM_FIELD_KNOWN_KEYS = new Set(["name", "label", "type", "required", "placeholder", "options"]);

export function readFormFields(value: unknown): FormFieldRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      label: typeof entry.label === "string" ? entry.label : "",
      type: (FORM_FIELD_TYPES as readonly string[]).includes(String(entry.type)) ? (entry.type as FormFieldType) : "text",
      required: entry.required === true,
      placeholder: typeof entry.placeholder === "string" ? entry.placeholder : "",
      options: Array.isArray(entry.options) ? entry.options.map((option) => String(option)) : [],
      extra: Object.fromEntries(Object.entries(entry).filter(([key]) => !FORM_FIELD_KNOWN_KEYS.has(key)))
    }));
}

/** The rows as the Form Trigger's `fields`: only the keys that are set, and options only on a select. */
export function formFieldsOf(rows: readonly FormFieldRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    ...row.extra,
    name: row.name,
    ...(row.label ? { label: row.label } : {}),
    type: row.type,
    ...(row.required ? { required: true } : {}),
    ...(row.placeholder ? { placeholder: row.placeholder } : {}),
    ...(row.type === "select" ? { options: row.options.map((option) => option.trim()).filter(Boolean) } : {})
  }));
}

/** A field name from its label: lower case words joined by underscores (what the run reads it as). */
export function fieldNameFromLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
