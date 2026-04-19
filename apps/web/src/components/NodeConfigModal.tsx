import { useCallback, useEffect, useMemo, useState } from "react";
import type { LLMProviderConfig, MCPToolDefinition, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { EditorNode, EditorNodeData } from "../lib/workflow";
import {
  createSecret,
  discoverMcpTools,
  fetchProviderModels,
  fetchWorkflows,
  previewExpression,
  testCodeNode,
  testConnector,
  testProvider,
  type SecretListItem
} from "../lib/api";

export interface NodeInputOption {
  id: string;
  label: string;
}

interface NodeConfigModalProps {
  node: EditorNode;
  inputOptions: NodeInputOption[];
  executionResult: WorkflowExecutionResult | null;
  workflowContext?: {
    id?: string;
    name?: string;
    vars?: Record<string, unknown>;
  };
  pinnedData?: Record<string, unknown>;
  showRuntimeInspection?: boolean;
  secrets: SecretListItem[];
  onRefreshSecrets?: () => Promise<SecretListItem[]>;
  mcpServerDefinitions: Array<{ id: string; label: string; description: string }>;
  onClose: () => void;
  onSave: (payload: {
    label: string;
    config: Record<string, unknown>;
    disabled?: boolean;
    color?: EditorNodeData["color"];
  }) => void;
  onExecuteStep: () => void;
  onPinNodeOutput?: (nodeId: string) => Promise<void> | void;
  onUnpinNodeOutput?: (nodeId: string) => Promise<void> | void;
}

const NODE_INPUT_OPTION_ID = "__node_input__";
const ADD_NEW_CREDENTIAL_VALUE = "__add_new_credential__";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toNumberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toBooleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toProviderLabel(provider: string): string {
  const normalized = provider.trim();
  if (!normalized) {
    return "Custom";
  }

  return normalized
    .split(/[_\s-]+/)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function ToggleField({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="cfg-toggle-row">
      <span>{label}</span>
      <button
        type="button"
        className={checked ? "cfg-toggle on" : "cfg-toggle"}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
      >
        <span className="cfg-toggle-knob" />
      </button>
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="cfg-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="cfg-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="cfg-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
  readOnly = false
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  readOnly?: boolean;
}) {
  return (
    <label className="cfg-field">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={rows} readOnly={readOnly} />
    </label>
  );
}

interface KeyValueRow {
  key: string;
  value: string;
  depth: number;
  importantScore: number;
}

const PREVIEW_TABLE_MAX_ROWS = 250;
const PREVIEW_TABLE_MAX_DEPTH = 5;
const PREVIEW_IMPORTANT_MAX_ROWS = 18;
const PREVIEW_IMPORTANT_FALLBACK_ROWS = 12;

const IMPORTANT_PRIMARY_TOKENS = new Set([
  "prompt",
  "user_prompt",
  "system_prompt",
  "question",
  "query",
  "input",
  "response",
  "answer",
  "output",
  "result",
  "content",
  "message",
  "status",
  "error"
]);

const IMPORTANT_SECONDARY_TOKENS = new Set([
  "model",
  "provider",
  "tool",
  "tool_name",
  "latency",
  "duration",
  "time_ms",
  "tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "finish_reason"
]);

function serializePreviewValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return "[unserializable value]";
  }
}

function scoreImportantKey(rowKey: string, rawValue: unknown, depth: number): number {
  const key = rowKey.toLowerCase();
  if (!key || key === "...") {
    return -100;
  }
  if (key.includes("parent_outputs")) {
    return -80;
  }

  const tokens = key.split(/[\.\[\]_\-\s]+/).filter(Boolean);
  let score = 0;

  for (const token of tokens) {
    if (IMPORTANT_PRIMARY_TOKENS.has(token)) {
      score += 55;
    } else if (IMPORTANT_SECONDARY_TOKENS.has(token)) {
      score += 30;
    }
  }

  if (key.endsWith(".error") || key === "error") {
    score += 40;
  }
  if (key.endsWith(".status") || key === "status") {
    score += 20;
  }

  if (depth <= 1) {
    score += 15;
  }

  const isPrimitive =
    rawValue === null ||
    rawValue === undefined ||
    typeof rawValue === "string" ||
    typeof rawValue === "number" ||
    typeof rawValue === "boolean" ||
    typeof rawValue === "bigint";

  if (isPrimitive) {
    score += 10;
  }

  return score;
}

function toKeyValueRows(value: unknown): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  let truncated = false;

  const appendRow = (key: string, rawValue: unknown, depth: number) => {
    if (rows.length >= PREVIEW_TABLE_MAX_ROWS) {
      truncated = true;
      return;
    }
    rows.push({
      key: key || "value",
      value: serializePreviewValue(rawValue),
      depth,
      importantScore: scoreImportantKey(key || "value", rawValue, depth)
    });
  };

  const visit = (entry: unknown, path: string, depth: number) => {
    if (rows.length >= PREVIEW_TABLE_MAX_ROWS) {
      truncated = true;
      return;
    }
    if (entry === null || typeof entry !== "object") {
      appendRow(path, entry, depth);
      return;
    }
    if (depth >= PREVIEW_TABLE_MAX_DEPTH) {
      appendRow(path, entry, depth);
      return;
    }

    if (Array.isArray(entry)) {
      if (entry.length === 0) {
        appendRow(path, [], depth);
        return;
      }
      entry.forEach((item, index) => {
        visit(item, `${path}[${index}]`, depth + 1);
      });
      return;
    }

    const entries = Object.entries(entry as Record<string, unknown>);
    if (entries.length === 0) {
      appendRow(path, {}, depth);
      return;
    }
    for (const [key, child] of entries) {
      visit(child, path ? `${path}.${key}` : key, depth + 1);
      if (rows.length >= PREVIEW_TABLE_MAX_ROWS) {
        truncated = true;
        return;
      }
    }
  };

  visit(value, "", 0);

  if (!rows.length) {
    appendRow("value", value, 0);
  }
  if (truncated) {
    rows.push({
      key: "...",
      value: `Preview truncated at ${PREVIEW_TABLE_MAX_ROWS} rows`,
      depth: 0,
      importantScore: -100
    });
  }

  return rows;
}

function toImportantRows(rows: KeyValueRow[]): KeyValueRow[] {
  const truncationRow = rows.find((row) => row.key === "...");
  const dataRows = rows.filter((row) => row.key !== "...");
  const importantRows = dataRows
    .filter((row) => row.importantScore >= 55)
    .slice(0, PREVIEW_IMPORTANT_MAX_ROWS);

  const baseRows = importantRows.length ? importantRows : dataRows.slice(0, PREVIEW_IMPORTANT_FALLBACK_ROWS);
  if (!truncationRow) {
    return baseRows;
  }
  return [...baseRows, truncationRow];
}

function describeSchema(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array<empty>";
    return [describeSchema(value[0], depth + 1)];
  }
  if (typeof value !== "object" || value === undefined) {
    return typeof value;
  }
  if (depth >= PREVIEW_TABLE_MAX_DEPTH) {
    return "object";
  }
  const schema: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    schema[key] = describeSchema(child, depth + 1);
  }
  return schema;
}

function KeyValueTable({ label, value }: { label: string; value: unknown }) {
  const rows = useMemo(() => toKeyValueRows(value), [value]);
  const importantRows = useMemo(() => toImportantRows(rows), [rows]);
  const schemaValue = useMemo(() => describeSchema(value), [value]);
  const [viewMode, setViewMode] = useState<"important" | "table" | "schema" | "json">("important");

  useEffect(() => {
    setViewMode("important");
  }, [value, label]);

  const visibleRows = viewMode === "important" ? importantRows : rows;
  const fullDataRowCount = rows.filter((row) => row.key !== "...").length;
  const visibleDataRowCount = visibleRows.filter((row) => row.key !== "...").length;

  return (
    <div className="cfg-field node-kv-field">
      <span>{label}</span>
      <div className="node-kv-toolbar">
        <div className="node-kv-count">
          {viewMode === "important"
            ? `Showing ${visibleDataRowCount} important fields`
            : viewMode === "table"
              ? `Showing all ${fullDataRowCount} fields`
              : viewMode === "schema"
                ? "Showing inferred structure"
                : "Showing raw JSON"}
        </div>
        <div className="node-kv-view-switch" role="tablist" aria-label={`${label} preview mode`}>
          <button
            type="button"
            className={viewMode === "important" ? "active" : ""}
            onClick={() => setViewMode("important")}
          >
            Summary
          </button>
          <button type="button" className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")}>
            Table
          </button>
          <button type="button" className={viewMode === "schema" ? "active" : ""} onClick={() => setViewMode("schema")}>
            Schema
          </button>
          <button type="button" className={viewMode === "json" ? "active" : ""} onClick={() => setViewMode("json")}>
            JSON
          </button>
        </div>
      </div>
      {viewMode === "schema" || viewMode === "json" ? (
        <pre className="result-block">
          {JSON.stringify(viewMode === "schema" ? schemaValue : value, null, 2)}
        </pre>
      ) : (
        <div className="node-kv-table-wrap">
          <table className="node-kv-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, index) => (
                <tr key={`${row.key}-${index}`}>
                  <td className="node-kv-key">{row.key}</td>
                  <td className="node-kv-value">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface ExpressionPreviewContext {
  input?: unknown;
  vars?: Record<string, unknown>;
  nodeOutputs?: Record<string, unknown>;
  workflow?: { id?: string; name?: string };
  executionId?: string;
  customData?: Record<string, unknown>;
}

const EXPRESSION_SUGGESTIONS = [
  { label: "$json", value: "$json" },
  { label: "$input", value: "$input" },
  { label: "$vars", value: "$vars" },
  { label: "$now", value: "$now.toISOString()" },
  { label: "$execution", value: "$execution.customData" },
  { label: "$if", value: "$if(condition, trueValue, falseValue)" },
  { label: "$ifEmpty", value: "$ifEmpty(value, fallback)" },
  { label: "$jmespath", value: "$jmespath($json, \"path.to.field\")" },
  { label: "Template", value: "{{ $json }}" }
];

function stringifyInline(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ExpressionField({
  label,
  value,
  onChange,
  rows = 3,
  mode = "expression",
  previewContext
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  mode?: "expression" | "template";
  previewContext?: ExpressionPreviewContext;
}) {
  const [previewText, setPreviewText] = useState("");
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    const expression = value.trim();
    if (!expression) {
      setPreviewText("");
      setPreviewError("");
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void previewExpression({
        expression: value,
        mode,
        context: previewContext
      })
        .then((response) => {
          if (cancelled) return;
          if (response.ok) {
            setPreviewText(stringifyInline(response.result));
            setPreviewError("");
          } else {
            setPreviewText("");
            setPreviewError(response.error ?? "Preview failed.");
          }
        })
        .catch((error) => {
          if (cancelled) return;
          setPreviewText("");
          setPreviewError(error instanceof Error ? error.message : "Preview failed.");
        });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, previewContext, value]);

  return (
    <div className="cfg-field expression-field">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={rows} />
      <div className="expression-suggestions" aria-label={`${label} suggestions`}>
        {EXPRESSION_SUGGESTIONS.map((item) => (
          <button
            key={item.label}
            type="button"
            className="mini-btn"
            onClick={() => onChange(value ? `${value} ${item.value}` : item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {(previewText || previewError) && (
        <div className={previewError ? "expression-preview error" : "expression-preview"}>
          <strong>Preview</strong>
          <pre>{previewError || previewText}</pre>
        </div>
      )}
    </div>
  );
}

function getApiBaseUrl(): string {
  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  if (envBase) {
    return envBase.replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    return window.location.origin.replace(/\/+$/, "");
  }

  return "";
}

function getSuggestedDirectApiBaseUrl(currentBaseUrl: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  if (envBase) {
    return null;
  }

  const hostname = window.location.hostname;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
  if (!isLocalhost) {
    return null;
  }

  const directPortFromEnv = (import.meta.env.VITE_API_PORT as string | undefined)?.trim();
  const normalizedPort = directPortFromEnv && /^\d+$/.test(directPortFromEnv) ? directPortFromEnv : "4000";
  const suggested = `${window.location.protocol}//${hostname}:${normalizedPort}`;
  if (suggested.replace(/\/+$/, "") === currentBaseUrl.replace(/\/+$/, "")) {
    return null;
  }

  return suggested;
}

export function NodeConfigModal({
  node,
  inputOptions,
  executionResult,
  workflowContext,
  pinnedData,
  showRuntimeInspection = true,
  secrets,
  onRefreshSecrets,
  mcpServerDefinitions,
  onClose,
  onSave,
  onExecuteStep,
  onPinNodeOutput,
  onUnpinNodeOutput
}: NodeConfigModalProps) {
  const [label, setLabel] = useState(node.data.label);
  const [config, setConfig] = useState<Record<string, unknown>>(asRecord(node.data.config));
  const [nodeDisabled, setNodeDisabled] = useState<boolean>(Boolean(node.data.disabled));
  const [nodeColor, setNodeColor] = useState<EditorNodeData["color"]>(node.data.color);
  const [activeTab, setActiveTab] = useState<"parameters" | "settings">("parameters");
  const [selectedInputId, setSelectedInputId] = useState(NODE_INPUT_OPTION_ID);
  const [discoveredTools, setDiscoveredTools] = useState<MCPToolDefinition[]>([]);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null);
  const [mcpToolSearchQuery, setMcpToolSearchQuery] = useState("");
  const [codeTestInput, setCodeTestInput] = useState("{\n  \"user_prompt\": \"Hello from code node\"\n}");
  const [codeTestBusy, setCodeTestBusy] = useState(false);
  const [codeTestError, setCodeTestError] = useState<string | null>(null);
  const [codeTestResult, setCodeTestResult] = useState<{ result: unknown; logs: string[] } | null>(null);
  const [connectorTestBusy, setConnectorTestBusy] = useState(false);
  const [connectorTestError, setConnectorTestError] = useState<string | null>(null);
  const [connectorTestMessage, setConnectorTestMessage] = useState<string | null>(null);
  const [providerTestBusy, setProviderTestBusy] = useState(false);
  const [providerTestError, setProviderTestError] = useState<string | null>(null);
  const [providerTestMessage, setProviderTestMessage] = useState<string | null>(null);
  const [workflowOptions, setWorkflowOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [workflowOptionsError, setWorkflowOptionsError] = useState<string | null>(null);
  const [inlineCreatedSecrets, setInlineCreatedSecrets] = useState<SecretListItem[]>([]);
  const [geminiModels, setGeminiModels] = useState<Array<{ value: string; label: string }> | null>(null);
  const [geminiModelsLoading, setGeminiModelsLoading] = useState(false);
  const [llmModels, setLlmModels] = useState<Array<{ value: string; label: string }> | null>(null);
  const [llmModelsLoading, setLlmModelsLoading] = useState(false);
  const [activeSecretFieldKey, setActiveSecretFieldKey] = useState<string | null>(null);
  const [inlineSecretProvider, setInlineSecretProvider] = useState("custom");
  const [inlineSecretName, setInlineSecretName] = useState("");
  const [inlineSecretValue, setInlineSecretValue] = useState("");
  const [inlineGoogleAuthMode, setInlineGoogleAuthMode] = useState<"access_token" | "service_account_json">("access_token");
  const [inlineGoogleAccessToken, setInlineGoogleAccessToken] = useState("");
  const [inlineGoogleServiceAccountJson, setInlineGoogleServiceAccountJson] = useState("");
  const [inlineSecretBusy, setInlineSecretBusy] = useState(false);
  const [inlineSecretError, setInlineSecretError] = useState<string | null>(null);

  const geminiSecretId = node.data.nodeType === "google_gemini_chat_model"
    ? toStringValue(asRecord(config.secretRef).secretId)
    : "";

  useEffect(() => {
    if (node.data.nodeType !== "google_gemini_chat_model" || !geminiSecretId) {
      return;
    }
    let canceled = false;
    setGeminiModelsLoading(true);
    fetchProviderModels({ providerId: "gemini", secretRef: { secretId: geminiSecretId } })
      .then((result) => {
        if (canceled) return;
        setGeminiModels(
          result.models.map((m) => ({ value: m.id, label: m.label }))
        );
      })
      .catch(() => {
        if (!canceled) setGeminiModels(null);
      })
      .finally(() => {
        if (!canceled) setGeminiModelsLoading(false);
      });
    return () => { canceled = true; };
  }, [node.data.nodeType, geminiSecretId]);

  const llmProviderId = node.data.nodeType === "llm_call"
    ? toStringValue(asRecord(config.provider).providerId, "ollama")
    : "";
  const llmSecretId = node.data.nodeType === "llm_call"
    ? toStringValue(asRecord(asRecord(config.provider).secretRef).secretId)
    : "";
  const llmBaseUrl = node.data.nodeType === "llm_call"
    ? toStringValue(asRecord(config.provider).baseUrl)
    : "";

  useEffect(() => {
    if (node.data.nodeType !== "llm_call" || !llmProviderId) {
      return;
    }
    const needsSecret = llmProviderId === "openai" || llmProviderId === "anthropic" || llmProviderId === "gemini";
    const needsBaseUrl = llmProviderId === "openai_compatible";
    if (needsSecret && !llmSecretId) { setLlmModels(null); return; }
    if (needsBaseUrl && !llmBaseUrl) { setLlmModels(null); return; }

    let canceled = false;
    setLlmModelsLoading(true);
    const providerExtra = asRecord(asRecord(config.provider).extra);
    fetchProviderModels({
      providerId: llmProviderId,
      ...(llmSecretId ? { secretRef: { secretId: llmSecretId } } : {}),
      ...(llmBaseUrl ? { baseUrl: llmBaseUrl } : {}),
      ...(Object.keys(providerExtra).length > 0 ? { extra: providerExtra } : {})
    })
      .then((result) => {
        if (canceled) return;
        setLlmModels(result.models.map((m) => ({ value: m.id, label: m.label })));
      })
      .catch(() => {
        if (!canceled) setLlmModels(null);
      })
      .finally(() => {
        if (!canceled) setLlmModelsLoading(false);
      });
    return () => { canceled = true; };
  }, [node.data.nodeType, llmProviderId, llmSecretId, llmBaseUrl]);

  useEffect(() => {
    const initialConfig = asRecord(node.data.config);
    if (node.data.nodeType === "mcp_tool") {
      const baseConnection = asRecord(initialConfig.connection);
      setConfig({
        ...initialConfig,
        serverId:
          typeof initialConfig.serverId === "string" && initialConfig.serverId.trim()
            ? initialConfig.serverId
            : (mcpServerDefinitions[0]?.id ?? "mock-mcp"),
        toolName:
          typeof initialConfig.toolName === "string" && initialConfig.toolName.trim()
            ? initialConfig.toolName
            : "__all__",
        connection: {
          endpoint:
            typeof baseConnection.endpoint === "string" && baseConnection.endpoint.trim()
              ? baseConnection.endpoint
              : "http://127.0.0.1:7001/mcp",
          transport:
            typeof baseConnection.transport === "string" && baseConnection.transport.trim()
              ? baseConnection.transport
              : "http_streamable",
          authType:
            typeof baseConnection.authType === "string" && baseConnection.authType.trim()
              ? baseConnection.authType
              : "none",
          ...baseConnection
        }
      });
    } else {
      setConfig(initialConfig);
    }

    setLabel(node.data.label);
    setNodeDisabled(Boolean(node.data.disabled));
    setNodeColor(node.data.color);
    setActiveTab("parameters");
    setSelectedInputId(NODE_INPUT_OPTION_ID);
    setDiscoveredTools([]);
    setDiscoverBusy(false);
    setDiscoverError(null);
    setDiscoverMessage(null);
    setMcpToolSearchQuery("");
    setCodeTestInput("{\n  \"user_prompt\": \"Hello from code node\"\n}");
    setCodeTestBusy(false);
    setCodeTestError(null);
    setCodeTestResult(null);
    setConnectorTestBusy(false);
    setConnectorTestError(null);
    setConnectorTestMessage(null);
    setProviderTestBusy(false);
    setProviderTestError(null);
    setProviderTestMessage(null);
    setWorkflowOptions([]);
    setWorkflowOptionsError(null);
    setInlineCreatedSecrets([]);
    setActiveSecretFieldKey(null);
    setInlineSecretProvider("custom");
    setInlineSecretName("");
    setInlineSecretValue("");
    setInlineGoogleAuthMode("access_token");
    setInlineGoogleAccessToken("");
    setInlineGoogleServiceAccountJson("");
    setInlineSecretBusy(false);
    setInlineSecretError(null);
  }, [inputOptions, mcpServerDefinitions, node]);

  const availableSecrets = useMemo(() => {
    const byId = new Map<string, SecretListItem>();
    for (const secret of secrets) {
      byId.set(secret.id, secret);
    }
    for (const secret of inlineCreatedSecrets) {
      byId.set(secret.id, secret);
    }
    return [...byId.values()];
  }, [inlineCreatedSecrets, secrets]);

  useEffect(() => {
    let cancelled = false;
    if (node.data.nodeType !== "execute_workflow") {
      return () => {
        cancelled = true;
      };
    }

    const loadWorkflowOptions = async () => {
      try {
        setWorkflowOptionsError(null);
        const workflows = await fetchWorkflows();
        if (cancelled) {
          return;
        }
        setWorkflowOptions(workflows.map((workflow) => ({ id: workflow.id, name: workflow.name })));
      } catch (error) {
        if (cancelled) {
          return;
        }
        setWorkflowOptionsError(error instanceof Error ? error.message : "Failed to load workflows");
      }
    };

    void loadWorkflowOptions();
    return () => {
      cancelled = true;
    };
  }, [node.data.nodeType]);

  const provider = useMemo(() => asRecord(config.provider), [config.provider]);
  const discoveredToolByName = useMemo(
    () => new Map(discoveredTools.map((tool) => [tool.name, tool])),
    [discoveredTools]
  );
  const mcpServerIdOptions = useMemo(() => {
    const base = mcpServerDefinitions.map((server) => ({
      value: server.id,
      label: `${server.label} (${server.id})`
    }));

    if (!base.length) {
      return [{ value: "mock-mcp", label: "Mock MCP Server (mock-mcp)" }];
    }

    return base;
  }, [mcpServerDefinitions]);
  const nodeResultById = useMemo(() => {
    const map = new Map<string, { input?: unknown; output?: unknown; error?: string; status?: string }>();
    for (const result of executionResult?.nodeResults ?? []) {
      map.set(result.nodeId, {
        input: result.input,
        output: result.output,
        error: result.error,
        status: result.status
      });
    }
    return map;
  }, [executionResult]);
  const currentNodeResult = nodeResultById.get(node.id);
  const nodeOutputsForPreview = useMemo(() => {
    const outputs: Record<string, unknown> = {};
    for (const result of executionResult?.nodeResults ?? []) {
      if (result.output !== undefined) {
        outputs[result.nodeId] = result.output;
      }
    }
    return outputs;
  }, [executionResult]);
  const expressionPreviewContext = useMemo<ExpressionPreviewContext>(
    () => ({
      input: currentNodeResult?.input ?? currentNodeResult?.output,
      vars: workflowContext?.vars,
      nodeOutputs: nodeOutputsForPreview,
      workflow: {
        id: workflowContext?.id,
        name: workflowContext?.name
      },
      executionId: executionResult?.executionId,
      customData: executionResult?.customData
    }),
    [
      currentNodeResult?.input,
      currentNodeResult?.output,
      executionResult?.executionId,
      executionResult?.customData,
      nodeOutputsForPreview,
      workflowContext?.id,
      workflowContext?.name,
      workflowContext?.vars
    ]
  );
  const currentNodePinned = hasOwnRecordKey(asRecord(pinnedData), node.id);
  const currentPinnedOutput = currentNodePinned ? asRecord(pinnedData)[node.id] : undefined;

  const resolvedInputPreview = useMemo(() => {
    if (selectedInputId === NODE_INPUT_OPTION_ID) {
      return currentNodeResult?.input;
    }
    if (!selectedInputId || selectedInputId === "none") {
      return undefined;
    }
    return nodeResultById.get(selectedInputId)?.output;
  }, [currentNodeResult, nodeResultById, selectedInputId]);

  const resolvedOutputPreview = useMemo(() => {
    if (!currentNodeResult) {
      return undefined;
    }
    if (currentNodeResult.error) {
      return {
        error: currentNodeResult.error,
        output: currentNodeResult.output ?? null
      };
    }
    return currentNodeResult.output;
  }, [currentNodeResult]);

  useEffect(() => {
    const validInputIds = new Set([NODE_INPUT_OPTION_ID, ...inputOptions.map((option) => option.id)]);
    if (!validInputIds.has(selectedInputId)) {
      setSelectedInputId(NODE_INPUT_OPTION_ID);
    }
  }, [inputOptions, selectedInputId]);

  const setProvider = (patch: Record<string, unknown>) => {
    setConfig((current) => ({
      ...current,
      provider: {
        ...asRecord(current.provider),
        ...patch
      }
    }));
  };

  const setProviderExtra = (patch: Record<string, unknown>) => {
    setConfig((current) => {
      const provider = asRecord(current.provider);
      return {
        ...current,
        provider: {
          ...provider,
          extra: {
            ...asRecord(provider.extra),
            ...patch
          }
        }
      };
    });
  };

  const buildInlineSecretPayload = useCallback(
    (providerInput: string): { provider: string; value?: string; error?: string } => {
      const provider = providerInput.trim() || "custom";

      if (provider === "google_drive") {
        if (inlineGoogleAuthMode === "access_token") {
          const token = inlineGoogleAccessToken.trim();
          if (!token) {
            return { provider, error: "Google Drive access token is required." };
          }
          return { provider, value: token };
        }

        const rawJson = inlineGoogleServiceAccountJson.trim();
        if (!rawJson) {
          return { provider, error: "Google Drive service account JSON is required." };
        }

        try {
          const parsed = JSON.parse(rawJson) as Record<string, unknown>;
          if (typeof parsed.client_email !== "string" || !parsed.client_email.trim()) {
            return { provider, error: "Google service account JSON must include client_email." };
          }
          if (typeof parsed.private_key !== "string" || !parsed.private_key.trim()) {
            return { provider, error: "Google service account JSON must include private_key." };
          }
          return { provider, value: JSON.stringify(parsed) };
        } catch {
          return { provider, error: "Google service account must be valid JSON." };
        }
      }

      const value = inlineSecretValue.trim();
      if (!value) {
        return { provider, error: "Credential value is required." };
      }
      return { provider, value };
    },
    [inlineGoogleAccessToken, inlineGoogleAuthMode, inlineGoogleServiceAccountJson, inlineSecretValue]
  );

  const openInlineSecretCreator = useCallback((fieldKey: string, provider: string) => {
    const normalizedProvider = provider.trim() || "custom";
    setActiveSecretFieldKey(fieldKey);
    setInlineSecretProvider(normalizedProvider);
    setInlineSecretName(`${toProviderLabel(normalizedProvider)} Credential`);
    setInlineSecretValue("");
    setInlineGoogleAuthMode("access_token");
    setInlineGoogleAccessToken("");
    setInlineGoogleServiceAccountJson("");
    setInlineSecretError(null);
  }, []);

  const closeInlineSecretCreator = useCallback(() => {
    if (inlineSecretBusy) {
      return;
    }
    setActiveSecretFieldKey(null);
    setInlineSecretProvider("custom");
    setInlineSecretName("");
    setInlineSecretValue("");
    setInlineGoogleAuthMode("access_token");
    setInlineGoogleAccessToken("");
    setInlineGoogleServiceAccountJson("");
    setInlineSecretError(null);
  }, [inlineSecretBusy]);

  const renderCredentialSecretField = useCallback(
    (input: {
      fieldKey: string;
      label: string;
      value: string;
      noneLabel: string;
      preferredProvider: string;
      onSelect: (secretId: string) => void;
      filter?: (secret: SecretListItem) => boolean;
    }) => {
      const filteredSecrets = input.filter ? availableSecrets.filter(input.filter) : availableSecrets;
      const options = [
        { value: "", label: input.noneLabel },
        ...filteredSecrets.map((secret) => ({
          value: secret.id,
          label: `${secret.name} (${secret.provider})`
        })),
        { value: ADD_NEW_CREDENTIAL_VALUE, label: "+ Add New Credential..." }
      ];
      const isActiveCreator = activeSecretFieldKey === input.fieldKey;
      const isGoogleDriveProvider = inlineSecretProvider.trim() === "google_drive";

      const handleCreateInlineSecret = async () => {
        const name = inlineSecretName.trim();
        const provider = inlineSecretProvider.trim() || input.preferredProvider.trim() || "custom";
        const payload = buildInlineSecretPayload(provider);

        if (!name) {
          setInlineSecretError("Credential name is required.");
          return;
        }
        if (payload.error || !payload.value) {
          setInlineSecretError(payload.error ?? "Credential value is required.");
          return;
        }

        try {
          setInlineSecretBusy(true);
          setInlineSecretError(null);
          const created = await createSecret({
            name,
            provider: payload.provider,
            value: payload.value
          });
          const createdSecret: SecretListItem = {
            id: created.id,
            name: created.name,
            provider: created.provider,
            createdAt: new Date().toISOString()
          };
          setInlineCreatedSecrets((current) => {
            const map = new Map(current.map((entry) => [entry.id, entry]));
            map.set(createdSecret.id, createdSecret);
            return [...map.values()];
          });
          input.onSelect(createdSecret.id);
          setActiveSecretFieldKey(null);
          setInlineSecretProvider("custom");
          setInlineSecretName("");
          setInlineSecretValue("");
          setInlineGoogleAuthMode("access_token");
          setInlineGoogleAccessToken("");
          setInlineGoogleServiceAccountJson("");
          setInlineSecretError(null);

          if (onRefreshSecrets) {
            try {
              await onRefreshSecrets();
            } catch {
              // local state already has the newly created secret
            }
          }
        } catch (error) {
          setInlineSecretError(error instanceof Error ? error.message : "Failed to create credential.");
        } finally {
          setInlineSecretBusy(false);
        }
      };

      return (
        <>
          <SelectField
            label={input.label}
            value={input.value}
            onChange={(next) => {
              if (next === ADD_NEW_CREDENTIAL_VALUE) {
                openInlineSecretCreator(input.fieldKey, input.preferredProvider);
                return;
              }
              closeInlineSecretCreator();
              input.onSelect(next);
            }}
            options={options}
          />
          {isActiveCreator && (
            <div className="cfg-tip">
              <div style={{ marginBottom: "8px" }}>
                Create credential for provider <code>{toProviderLabel(inlineSecretProvider)}</code>.
              </div>
              <TextField label="Credential Name" value={inlineSecretName} onChange={setInlineSecretName} />
              {isGoogleDriveProvider ? (
                <>
                  <SelectField
                    label="Google Auth Mode"
                    value={inlineGoogleAuthMode}
                    onChange={(next) => setInlineGoogleAuthMode(next as "access_token" | "service_account_json")}
                    options={[
                      { value: "access_token", label: "Access Token" },
                      { value: "service_account_json", label: "Service Account JSON" }
                    ]}
                  />
                  {inlineGoogleAuthMode === "access_token" ? (
                    <TextField
                      label="Google Drive Access Token"
                      value={inlineGoogleAccessToken}
                      onChange={setInlineGoogleAccessToken}
                      placeholder="ya29..."
                    />
                  ) : (
                    <TextAreaField
                      label="Google Service Account JSON"
                      value={inlineGoogleServiceAccountJson}
                      onChange={setInlineGoogleServiceAccountJson}
                      rows={7}
                    />
                  )}
                </>
              ) : (
                <TextAreaField label="Credential Value" value={inlineSecretValue} onChange={setInlineSecretValue} rows={5} />
              )}
              {inlineSecretError && <div className="error-banner">{inlineSecretError}</div>}
              <div className="cfg-inline-actions">
                <button type="button" className="node-btn" onClick={() => void handleCreateInlineSecret()} disabled={inlineSecretBusy}>
                  {inlineSecretBusy ? "Creating..." : "Create Credential"}
                </button>
                <button type="button" className="header-btn" onClick={closeInlineSecretCreator} disabled={inlineSecretBusy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      );
    },
    [
      activeSecretFieldKey,
      availableSecrets,
      buildInlineSecretPayload,
      closeInlineSecretCreator,
      inlineGoogleAccessToken,
      inlineGoogleAuthMode,
      inlineGoogleServiceAccountJson,
      inlineSecretBusy,
      inlineSecretError,
      inlineSecretName,
      inlineSecretProvider,
      inlineSecretValue,
      onRefreshSecrets,
      openInlineSecretCreator
    ]
  );

  const discoverToolsForMcpNode = useCallback(
    async (params?: { serverId?: string; connection?: Record<string, unknown>; currentToolName?: string }) => {
      const serverId = (params?.serverId ?? toStringValue(config.serverId)).trim();
      const connection = params?.connection ?? asRecord(config.connection);
      const currentToolName = params?.currentToolName ?? toStringValue(config.toolName).trim();

      if (!serverId) {
        setDiscoverError("Set MCP Server Id before discovering tools.");
        setDiscoverMessage(null);
        setDiscoveredTools([]);
        return;
      }

      try {
        setDiscoverBusy(true);
        setDiscoverError(null);
        setDiscoverMessage(null);

        const response = await discoverMcpTools({
          serverId,
          connection,
          secretRef:
            typeof asRecord(config.secretRef).secretId === "string"
              ? { secretId: String(asRecord(config.secretRef).secretId) }
              : undefined
        });

        setDiscoveredTools(response.tools);
        setMcpToolSearchQuery("");
        setDiscoverMessage(
          response.tools.length
            ? `Discovered ${response.tools.length} tools from '${serverId}'.`
            : `No tools found for '${serverId}'.`
        );

        if (!currentToolName && response.tools[0]?.name) {
          const firstToolName = response.tools[0].name;
          setConfig((current) => ({
            ...current,
            toolName: firstToolName,
            allowedTools: [firstToolName]
          }));
        }
      } catch (error) {
        setDiscoverError(error instanceof Error ? error.message : "Failed to discover MCP tools");
        setDiscoverMessage(null);
        setDiscoveredTools([]);
        setMcpToolSearchQuery("");
      } finally {
        setDiscoverBusy(false);
      }
    },
    [config.connection, config.secretRef, config.serverId, config.toolName]
  );

  useEffect(() => {
    if (node.data.nodeType !== "mcp_tool") {
      return;
    }
    const serverId = toStringValue(config.serverId).trim();
    if (!serverId) {
      return;
    }
    if (discoveredTools.length > 0) {
      return;
    }
    void discoverToolsForMcpNode({
      serverId,
      connection: asRecord(config.connection),
      currentToolName: toStringValue(config.toolName).trim()
    });
  }, [
    config.connection,
    config.serverId,
    config.toolName,
    discoverToolsForMcpNode,
    discoveredTools.length,
    node.data.nodeType
  ]);

  const handleCodeNodeTestRun = useCallback(async () => {
    const code = toStringValue(config.code);
    if (!code.trim()) {
      setCodeTestError("Code script cannot be empty.");
      setCodeTestResult(null);
      return;
    }

    let parsedInput: Record<string, unknown> = {};
    try {
      const raw = codeTestInput.trim();
      if (raw) {
        const candidate = JSON.parse(raw);
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          parsedInput = candidate as Record<string, unknown>;
        } else {
          throw new Error("Test input must be a JSON object.");
        }
      }
    } catch (error) {
      setCodeTestError(error instanceof Error ? error.message : "Test input must be valid JSON.");
      setCodeTestResult(null);
      return;
    }

    try {
      setCodeTestBusy(true);
      setCodeTestError(null);
      const timeout = toNumberValue(config.timeout, 1500);
      const response = await testCodeNode({
        code,
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 1500,
        input: parsedInput
      });
      setCodeTestResult(response);
    } catch (error) {
      setCodeTestResult(null);
      setCodeTestError(error instanceof Error ? error.message : "Code node test failed.");
    } finally {
      setCodeTestBusy(false);
    }
  }, [codeTestInput, config.code, config.timeout]);

  const handleConnectorTestRun = useCallback(
    async (payload: { connectorId: string; connectorConfig: Record<string, unknown> }) => {
      const connectorId = payload.connectorId.trim();
      if (!connectorId) {
        setConnectorTestError("Connector ID is required.");
        setConnectorTestMessage(null);
        return;
      }

      try {
        setConnectorTestBusy(true);
        setConnectorTestError(null);
        setConnectorTestMessage(null);
        const result = await testConnector({
          connectorId,
          connectorConfig: payload.connectorConfig
        });

        if (result.ok) {
          setConnectorTestMessage(result.message || "Connection successful.");
          setConnectorTestError(null);
        } else {
          setConnectorTestError(result.message || "Connection test failed.");
          setConnectorTestMessage(null);
        }
      } catch (error) {
        setConnectorTestError(error instanceof Error ? error.message : "Connection test failed.");
        setConnectorTestMessage(null);
      } finally {
        setConnectorTestBusy(false);
      }
    },
    []
  );

  const buildProviderTestConfig = useCallback((): { provider: LLMProviderConfig; prompt?: string; systemPrompt?: string } | null => {
    if (node.data.nodeType === "llm_call") {
      const providerConfig = asRecord(config.provider);
      const providerId = toStringValue(providerConfig.providerId, "ollama").trim();
      const model = toStringValue(providerConfig.model).trim();
      if (!providerId || !model) {
        return null;
      }

      const baseUrl = toStringValue(providerConfig.baseUrl).trim();
      const secretId = toStringValue(asRecord(providerConfig.secretRef).secretId).trim();
      const extraRecord = asRecord(providerConfig.extra);
      const hasExtra = Object.keys(extraRecord).length > 0;
      const provider: LLMProviderConfig = {
        providerId,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        ...(secretId ? { secretRef: { secretId } } : {}),
        ...(typeof providerConfig.temperature === "number" && Number.isFinite(providerConfig.temperature)
          ? { temperature: providerConfig.temperature }
          : {}),
        ...(typeof providerConfig.maxTokens === "number" && Number.isFinite(providerConfig.maxTokens)
          ? { maxTokens: Math.max(1, Math.floor(providerConfig.maxTokens)) }
          : {}),
        ...(hasExtra ? { extra: extraRecord } : {})
      };
      return { provider };
    }

    if (node.data.nodeType === "azure_openai_chat_model") {
      const endpoint = toStringValue(config.endpoint).trim();
      const deployment = toStringValue(config.deployment).trim();
      if (!endpoint || !deployment) {
        return null;
      }

      const apiVersion = toStringValue(config.apiVersion, "2024-10-21").trim() || "2024-10-21";
      const secretId = toStringValue(asRecord(config.secretRef).secretId).trim();
      const provider: LLMProviderConfig = {
        providerId: "azure_openai",
        model: deployment,
        baseUrl: endpoint,
        ...(secretId ? { secretRef: { secretId } } : {}),
        ...(typeof config.temperature === "number" && Number.isFinite(config.temperature)
          ? { temperature: config.temperature }
          : {}),
        ...(typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens)
          ? { maxTokens: Math.max(1, Math.floor(config.maxTokens)) }
          : {}),
        extra: {
          deployment,
          apiVersion
        }
      };

      return {
        provider
      };
    }

    if (node.data.nodeType === "google_gemini_chat_model") {
      const model = toStringValue(config.model, "gemini-2.5-flash").trim();
      if (!model) {
        return null;
      }

      const secretId = toStringValue(asRecord(config.secretRef).secretId).trim();
      const provider: LLMProviderConfig = {
        providerId: "gemini",
        model,
        ...(secretId ? { secretRef: { secretId } } : {}),
        ...(typeof config.temperature === "number" && Number.isFinite(config.temperature)
          ? { temperature: config.temperature }
          : {}),
        ...(typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens)
          ? { maxTokens: Math.max(1, Math.floor(config.maxTokens)) }
          : {})
      };

      return { provider };
    }

    return null;
  }, [config, node.data.nodeType]);

  const handleProviderTestRun = useCallback(async () => {
    const payload = buildProviderTestConfig();
    if (!payload) {
      setProviderTestError("Provider and model/deployment are required before testing.");
      setProviderTestMessage(null);
      return;
    }

    try {
      setProviderTestBusy(true);
      setProviderTestError(null);
      setProviderTestMessage(null);

      const result = await testProvider(payload);
      if (!result.ok) {
        setProviderTestError(result.message || "Connection test failed.");
        setProviderTestMessage(null);
        return;
      }

      const latencySuffix = typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs)
        ? ` (${Math.max(1, Math.floor(result.latencyMs))} ms)`
        : "";
      const previewSuffix = typeof result.preview === "string" && result.preview.trim()
        ? ` Response: ${result.preview.trim()}`
        : "";

      setProviderTestMessage(`${result.message || "Connection successful"}${latencySuffix}.${previewSuffix}`.trim());
      setProviderTestError(null);
    } catch (error) {
      setProviderTestError(error instanceof Error ? error.message : "Connection test failed.");
      setProviderTestMessage(null);
    } finally {
      setProviderTestBusy(false);
    }
  }, [buildProviderTestConfig]);

  const renderProviderSection = () => {
    const providerId = toStringValue(provider.providerId, "ollama");
    const providerExtra = asRecord(provider.extra);
    const isAzureOpenAI = providerId === "azure_openai";
    const hideBaseUrl = providerId === "openai" || providerId === "gemini" || providerId === "anthropic";

    return (
      <div className="cfg-group">
        <h4>Model</h4>
        <SelectField
          label="Provider"
          value={providerId}
          onChange={(next) => setProvider({ providerId: next })}
          options={[
            { value: "ollama", label: "Ollama" },
            { value: "openai_compatible", label: "OpenAI Compatible" },
            { value: "openai", label: "OpenAI" },
            { value: "azure_openai", label: "Azure OpenAI" },
            { value: "gemini", label: "Gemini" },
            { value: "anthropic", label: "Anthropic" }
          ]}
        />
        {llmModels && llmModels.length > 0 && !isAzureOpenAI ? (
          <SelectField
            label={llmModelsLoading ? "Model (loading...)" : "Model"}
            value={toStringValue(provider.model)}
            options={llmModels}
            onChange={(next) => setProvider({ model: next })}
          />
        ) : (
          <TextField
            label={isAzureOpenAI ? "Deployment" : (llmModelsLoading ? "Model (loading...)" : "Model")}
            value={toStringValue(provider.model)}
            onChange={(next) => setProvider({ model: next })}
            placeholder={isAzureOpenAI ? "gpt-4o-mini" : "gpt-4.1-mini / llama3.1"}
          />
        )}
        {!hideBaseUrl && (
          <TextField
            label={isAzureOpenAI ? "Endpoint" : "Base URL"}
            value={toStringValue(provider.baseUrl)}
            onChange={(next) => setProvider({ baseUrl: next })}
            placeholder={isAzureOpenAI ? "https://<resource>.openai.azure.com" : "http://localhost:11434/v1"}
          />
        )}
        {isAzureOpenAI && (
          <TextField
            label="API Version"
            value={toStringValue(providerExtra.apiVersion, "2024-10-21")}
            onChange={(next) => setProviderExtra({ apiVersion: next })}
            placeholder="2024-10-21"
          />
        )}
        {renderCredentialSecretField({
          fieldKey: "llm_provider_secret",
          label: "API Key Secret",
          value: toStringValue(asRecord(provider.secretRef).secretId, ""),
          noneLabel: "None / Environmental Variable",
          preferredProvider: toStringValue(provider.providerId, "custom"),
          onSelect: (next) =>
            setProvider({
              secretRef: next ? { secretId: next } : undefined
            })
        })}
        <div className="cfg-grid-2">
          <NumberField
            label="Temperature"
            value={toNumberValue(provider.temperature, 0.2)}
            min={0}
            max={2}
            step={0.1}
            onChange={(next) => setProvider({ temperature: next })}
          />
          <NumberField
            label="Max Tokens"
            value={toNumberValue(provider.maxTokens, 1024)}
            min={1}
            step={1}
            onChange={(next) => setProvider({ maxTokens: next })}
          />
        </div>
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() => void handleProviderTestRun()}
            disabled={providerTestBusy}
          >
            {providerTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {providerTestMessage && <span className="muted">{providerTestMessage}</span>}
        </div>
        {providerTestError && <div className="error-banner">{providerTestError}</div>}
      </div>
    );
  };

  const renderAgentParameters = () => {
    return (
      <>
        <div className="cfg-tip">
          Tip: Attach a Chat Model on the <code>chat_model</code> port. Optionally attach Memory and one or more MCP Tool nodes on their dedicated ports.
        </div>

        <SelectField
          label="Agent Type"
          value={toStringValue(config.agentType, "tools")}
          options={[
            { value: "tools", label: "Tools Agent (Default)" },
            { value: "react", label: "ReAct (Reasoning + Acting)" },
            { value: "plan-and-execute", label: "Plan and Execute" },
            { value: "sql", label: "SQL Agent" }
          ]}
          onChange={(next) => setConfig((current) => ({ ...current, agentType: next }))}
        />

        <ExpressionField
          label="Prompt (User Message)"
          value={toStringValue(config.userPromptTemplate, "{{user_prompt}}")}
          onChange={(next) => setConfig((current) => ({ ...current, userPromptTemplate: next }))}
          rows={3}
          mode="template"
          previewContext={expressionPreviewContext}
        />

        <ExpressionField
          label="System Message"
          value={toStringValue(config.systemPromptTemplate, "{{system_prompt}}")}
          onChange={(next) => setConfig((current) => ({ ...current, systemPromptTemplate: next }))}
          rows={4}
          mode="template"
          previewContext={expressionPreviewContext}
        />

        <TextField
          label="Session Id Template"
          value={toStringValue(config.sessionIdTemplate, "{{session_id}}")}
          onChange={(next) => setConfig((current) => ({ ...current, sessionIdTemplate: next }))}
          placeholder="{{session_id}}"
        />

        <ToggleField
          label="Require Specific Output Format"
          checked={toBooleanValue(config.requireSpecificOutputFormat)}
          onChange={(next) => setConfig((current) => ({ ...current, requireSpecificOutputFormat: next }))}
        />

        <ToggleField
          label="Enable Fallback Model"
          checked={toBooleanValue(config.enableFallbackModel)}
          onChange={(next) => setConfig((current) => ({ ...current, enableFallbackModel: next }))}
        />

        <div className="cfg-grid-2">
          <NumberField
            label="Max Iterations"
            value={toNumberValue(config.maxIterations, 6)}
            min={1}
            step={1}
            onChange={(next) => setConfig((current) => ({ ...current, maxIterations: next }))}
          />
          <ToggleField
            label="Tool Calling"
            checked={toBooleanValue(config.toolCallingEnabled, true)}
            onChange={(next) => setConfig((current) => ({ ...current, toolCallingEnabled: next }))}
          />
        </div>

        <div className="cfg-group">
          <h4>Tool Output Limits (Advanced)</h4>
          <div className="cfg-tip">
            Increase these when your MCP responses are large (for example 90k+ context flows). Higher values increase
            model context usage and can hit provider limits faster.
          </div>
          <div className="cfg-grid-2">
            <NumberField
              label="Tool Message Max Chars"
              value={toNumberValue(config.toolMessageMaxChars, 6000)}
              min={500}
              step={500}
              onChange={(next) => setConfig((current) => ({ ...current, toolMessageMaxChars: next }))}
            />
            <NumberField
              label="Tool String Max Chars"
              value={toNumberValue(config.toolPayloadMaxStringChars, 400)}
              min={100}
              step={100}
              onChange={(next) => setConfig((current) => ({ ...current, toolPayloadMaxStringChars: next }))}
            />
            <NumberField
              label="Tool Object Max Keys"
              value={toNumberValue(config.toolPayloadMaxObjectKeys, 32)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, toolPayloadMaxObjectKeys: next }))}
            />
            <NumberField
              label="Tool Array Max Items"
              value={toNumberValue(config.toolPayloadMaxArrayItems, 8)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, toolPayloadMaxArrayItems: next }))}
            />
            <NumberField
              label="Tool Payload Max Depth"
              value={toNumberValue(config.toolPayloadMaxDepth, 4)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, toolPayloadMaxDepth: next }))}
            />
          </div>
        </div>
      </>
    );
  };

  const renderLocalMemoryParameters = () => {
    return (
      <>
        <div className="cfg-tip">Attach this node to AI Agent memory port to persist chat history in SQLite per session.</div>
        <TextField
          label="Namespace"
          value={toStringValue(config.namespace, "default")}
          onChange={(next) => setConfig((current) => ({ ...current, namespace: next }))}
          placeholder="default"
        />
        <TextField
          label="Session Id Template"
          value={toStringValue(config.sessionIdTemplate, "{{session_id}}")}
          onChange={(next) => setConfig((current) => ({ ...current, sessionIdTemplate: next }))}
          placeholder="{{session_id}}"
        />
        <NumberField
          label="Max Messages"
          value={toNumberValue(config.maxMessages, 20)}
          min={1}
          step={1}
          onChange={(next) => setConfig((current) => ({ ...current, maxMessages: next }))}
        />
        <ToggleField
          label="Persist Tool Messages"
          checked={toBooleanValue(config.persistToolMessages, false)}
          onChange={(next) => setConfig((current) => ({ ...current, persistToolMessages: next }))}
        />
      </>
    );
  };

  const renderMcpParameters = () => {
    const connection = asRecord(config.connection);
    const selectedServerId = toStringValue(config.serverId).trim();
    const hasKnownServerId = mcpServerIdOptions.some((option) => option.value === selectedServerId);
    const serverSelectValue = hasKnownServerId ? selectedServerId : "__custom__";
    const selectedServerLabel =
      mcpServerDefinitions.find((entry) => entry.id === selectedServerId)?.label ??
      (selectedServerId ? `Custom (${selectedServerId})` : "Custom");
    const authType = toStringValue(connection.authType, "none");
    const selectedToolName = toStringValue(config.toolName).trim();
    const includeAllDiscoveredTools = selectedToolName === "__all__";
    const normalizedAllowedTools = Array.isArray(config.allowedTools)
      ? Array.from(
          new Set(
            config.allowedTools
              .map((tool) => String(tool ?? "").trim())
              .filter((toolName) => toolName.length > 0)
          )
        )
      : [];
    const selectedToolNames = includeAllDiscoveredTools
      ? []
      : normalizedAllowedTools.length
        ? normalizedAllowedTools
        : selectedToolName
          ? [selectedToolName]
          : [];
    const selectedToolNameSet = new Set(selectedToolNames);
    const toolSelectionMode = includeAllDiscoveredTools ? "all" : selectedToolNames.length > 1 ? "multi" : "single";
    const primarySelectedToolName = selectedToolNames[0] ?? "";
    const selectedTool = primarySelectedToolName ? discoveredToolByName.get(primarySelectedToolName) : undefined;
    const normalizedToolSearchQuery = mcpToolSearchQuery.trim().toLowerCase();
    const filteredDiscoveredTools = normalizedToolSearchQuery
      ? discoveredTools.filter((tool) => {
          const name = toStringValue(tool.name).toLowerCase();
          const description = toStringValue(tool.description).toLowerCase();
          return name.includes(normalizedToolSearchQuery) || description.includes(normalizedToolSearchQuery);
        })
      : discoveredTools;
    const shouldShowToolSearch = discoveredTools.length > 10;

    return (
      <>
        <div className="cfg-tip">
          Configure MCP only on this node. Attach this MCP Tool node to an AI Agent <code>Tool</code> port to expose it.
        </div>

        <SelectField
          label="MCP Server Adapter"
          value={serverSelectValue}
          onChange={(next) => {
            setConfig((current) => ({
              ...current,
              serverId: next === "__custom__" ? "" : next,
              toolName: "__all__",
              allowedTools: undefined
            }));
            setDiscoveredTools([]);
            setDiscoverMessage(null);
            setDiscoverError(null);
          }}
          options={[...mcpServerIdOptions, { value: "__custom__", label: "Custom Adapter ID" }]}
        />

        {!hasKnownServerId && (
          <TextField
            label="Custom Adapter ID"
            value={selectedServerId}
            onChange={(next) => setConfig((current) => ({ ...current, serverId: next }))}
            placeholder="my_custom_mcp_adapter"
          />
        )}

        <div className="cfg-tip">
          Active adapter: <code>{selectedServerLabel}</code>
          {selectedServerId === "mock-mcp" ? (
            <div style={{ marginTop: "6px" }}>
              <strong>Note:</strong> Mock adapter always returns demo tools and ignores endpoint/auth values.
            </div>
          ) : null}
        </div>

        <SelectField
          label="Server Transport"
          value={toStringValue(connection.transport, "http_streamable")}
          onChange={(next) =>
            setConfig((current) => ({
              ...current,
              connection: {
                ...asRecord(current.connection),
                transport: next
              }
            }))
          }
          options={[
            { value: "http_streamable", label: "HTTP Streamable" },
            { value: "sse", label: "Server Sent Events" },
            { value: "stdio", label: "STDIO" }
          ]}
        />

        <TextField
          label="Endpoint"
          value={toStringValue(connection.endpoint, "http://127.0.0.1:7001/mcp")}
          onChange={(next) =>
            setConfig((current) => ({
              ...current,
              connection: {
                ...asRecord(current.connection),
                endpoint: next
              }
            }))
          }
        />

        <NumberField
          label="Request Timeout (ms)"
          value={toNumberValue(connection.timeoutMs, 120000)}
          min={1000}
          step={1000}
          onChange={(next) =>
            setConfig((current) => ({
              ...current,
              connection: {
                ...asRecord(current.connection),
                timeoutMs: next
              }
            }))
          }
        />

        <SelectField
          label="Authentication"
          value={authType}
          onChange={(next) =>
            setConfig((current) => ({
              ...current,
              connection: {
                ...asRecord(current.connection),
                authType: next
              }
            }))
          }
          options={[
            { value: "none", label: "None" },
            { value: "bearer", label: "Bearer Token" },
            { value: "basic", label: "Basic Auth" }
          ]}
        />

        {authType === "basic" && (
          <TextField
            label="Basic Auth Username"
            value={toStringValue(connection.username)}
            onChange={(next) =>
              setConfig((current) => ({
                ...current,
                connection: {
                  ...asRecord(current.connection),
                  username: next
                }
              }))
            }
            placeholder="api-user"
          />
        )}

        {renderCredentialSecretField({
          fieldKey: "mcp_auth_secret",
          label: "Auth Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "None",
          preferredProvider: "custom",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}

        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() =>
              void discoverToolsForMcpNode({
                serverId: toStringValue(config.serverId),
                connection: asRecord(config.connection),
                currentToolName: selectedToolName
              })
            }
            disabled={discoverBusy}
          >
            {discoverBusy ? "Discovering..." : "Discover Tools"}
          </button>
          {discoverMessage && <span className="muted">{discoverMessage}</span>}
        </div>
        {discoverError && <div className="error-banner">{discoverError}</div>}

        <SelectField
          label="Tools To Include"
          value={toolSelectionMode}
          onChange={(next) => {
            setMcpToolSearchQuery("");
            setConfig((current) => {
              if (next === "all") {
                return {
                  ...current,
                  toolName: "__all__",
                  allowedTools: undefined
                };
              }

              const existingAllowedTools = Array.isArray(current.allowedTools)
                ? Array.from(
                    new Set(
                      current.allowedTools
                        .map((tool) => String(tool ?? "").trim())
                        .filter((toolName) => toolName.length > 0)
                    )
                  )
                : [];
              const currentToolName = toStringValue(current.toolName).trim();
              const fallbackSelection =
                existingAllowedTools.length > 0
                  ? existingAllowedTools
                  : currentToolName && currentToolName !== "__all__"
                    ? [currentToolName]
                    : discoveredTools.slice(0, 2).map((tool) => tool.name);

              if (next === "multi") {
                const uniqueSelection = Array.from(new Set(fallbackSelection.filter((toolName) => toolName.length > 0)));
                return {
                  ...current,
                  toolName: uniqueSelection[0] ?? "",
                  allowedTools: uniqueSelection.length ? uniqueSelection : undefined
                };
              }

              const resolvedSingleTool = fallbackSelection[0] ?? discoveredTools[0]?.name ?? "";

              return {
                ...current,
                toolName: resolvedSingleTool,
                allowedTools: resolvedSingleTool ? [resolvedSingleTool] : undefined
              };
            });
          }}
          options={[
            { value: "all", label: "All discovered tools (agent decides)" },
            { value: "single", label: "Single tool only" },
            { value: "multi", label: "Select multiple tools" }
          ]}
        />

        {includeAllDiscoveredTools ? (
          <div className="cfg-tip">
            {discoveredTools.length
              ? (() => {
                  const preview = discoveredTools.slice(0, 10).map((tool) => tool.name).join(", ");
                  const remaining = discoveredTools.length - 10;
                  return remaining > 0
                    ? `Agent can call ${discoveredTools.length} discovered tools. Preview: ${preview}, +${remaining} more.`
                    : `Agent can call discovered tools: ${preview}`;
                })()
              : "Discover tools first to preview what will be exposed to the agent."}
          </div>
        ) : toolSelectionMode === "single" && discoveredTools.length > 0 ? (
          <div className="cfg-field">
            <span>Tool Name</span>
            <details className="cfg-multi-select">
              <summary>{primarySelectedToolName || "Choose a discovered tool"}</summary>
              {shouldShowToolSearch && (
                <div className="cfg-multi-select-search">
                  <input
                    value={mcpToolSearchQuery}
                    onChange={(event) => setMcpToolSearchQuery(event.target.value)}
                    placeholder={`Search ${discoveredTools.length} discovered tools`}
                  />
                </div>
              )}
              <div className="cfg-multi-select-menu">
                {filteredDiscoveredTools.length === 0 ? (
                  <div className="cfg-multi-select-empty">
                    No tools match "{mcpToolSearchQuery.trim()}". Clear search to view all tools.
                  </div>
                ) : (
                  filteredDiscoveredTools.map((tool) => (
                    <label key={tool.name} className="cfg-multi-option">
                      <input
                        type="radio"
                        name={`mcp-single-tool-${node.id}`}
                        checked={primarySelectedToolName === tool.name}
                        onChange={() =>
                          setConfig((current) => ({
                            ...current,
                            toolName: tool.name,
                            allowedTools: [tool.name]
                          }))
                        }
                      />
                      <span title={tool.name}>{tool.name}</span>
                    </label>
                  ))
                )}
              </div>
            </details>
          </div>
        ) : toolSelectionMode === "single" ? (
          <TextField
            label="Tool Name"
            value={toStringValue(config.toolName)}
            onChange={(next) =>
              setConfig((current) => ({
                ...current,
                toolName: next,
                allowedTools: next ? [next] : undefined
              }))
            }
          />
        ) : discoveredTools.length > 0 ? (
          <>
            <div className="cfg-field">
              <span>Select Tools</span>
              <details className="cfg-multi-select">
                <summary>
                  {selectedToolNames.length
                    ? `${selectedToolNames.length} selected`
                    : "Choose one or more discovered tools"}
                </summary>
                <div className="cfg-multi-select-menu">
                  {shouldShowToolSearch && (
                    <div className="cfg-multi-select-search">
                      <input
                        value={mcpToolSearchQuery}
                        onChange={(event) => setMcpToolSearchQuery(event.target.value)}
                        placeholder={`Search ${discoveredTools.length} discovered tools`}
                      />
                    </div>
                  )}
                  {filteredDiscoveredTools.length === 0 ? (
                    <div className="cfg-multi-select-empty">
                      No tools match "{mcpToolSearchQuery.trim()}". Clear search to view all tools.
                    </div>
                  ) : (
                    filteredDiscoveredTools.map((tool) => (
                    <label key={tool.name} className="cfg-multi-option">
                      <input
                        type="checkbox"
                        checked={selectedToolNameSet.has(tool.name)}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setConfig((current) => {
                            const currentToolName = toStringValue(current.toolName).trim();
                            const currentAllowed = Array.isArray(current.allowedTools)
                              ? Array.from(
                                  new Set(
                                    current.allowedTools
                                      .map((entry) => String(entry ?? "").trim())
                                      .filter((entryName) => entryName.length > 0)
                                  )
                                )
                              : currentToolName && currentToolName !== "__all__"
                                ? [currentToolName]
                                : [];
                            const nextSet = new Set(currentAllowed);
                            if (checked) {
                              nextSet.add(tool.name);
                            } else {
                              nextSet.delete(tool.name);
                            }
                            const nextAllowed = discoveredTools
                              .map((entry) => entry.name)
                              .filter((entryName) => nextSet.has(entryName));
                            return {
                              ...current,
                              toolName: nextAllowed[0] ?? "",
                              allowedTools: nextAllowed.length ? nextAllowed : undefined
                            };
                          });
                        }}
                      />
                      <span>{tool.name}</span>
                    </label>
                    ))
                  )}
                </div>
              </details>
            </div>
            <div className="cfg-tip">
              {selectedToolNames.length
                ? `Agent can call selected tools: ${selectedToolNames.join(", ")}`
                : "No tools selected yet. Pick one or more tools from the dropdown."}
            </div>
          </>
        ) : (
          <TextField
            label="Selected Tools (comma-separated)"
            value={selectedToolNames.join(",")}
            onChange={(next) =>
              setConfig((current) => {
                const parsed = Array.from(
                  new Set(
                    next
                      .split(",")
                      .map((tool) => tool.trim())
                      .filter((tool) => tool.length > 0)
                  )
                );
                return {
                  ...current,
                  toolName: parsed[0] ?? "",
                  allowedTools: parsed.length ? parsed : undefined
                };
              })
            }
          />
        )}

        {toolSelectionMode === "single" && selectedTool && (
          <div className="cfg-group">
            <h4>Discovered Tool Metadata</h4>
            <div className="cfg-tip">{selectedTool.description || "No description provided."}</div>
            <TextAreaField
              label="Input Schema (read-only)"
              value={JSON.stringify(selectedTool.inputSchema ?? {}, null, 2)}
              onChange={() => undefined}
              rows={5}
              readOnly
            />
          </div>
        )}

        <ExpressionField
          label="Tool Args Template"
          value={toStringValue(config.argsTemplate, "{}")}
          onChange={(next) => setConfig((current) => ({ ...current, argsTemplate: next }))}
          rows={3}
          mode="template"
          previewContext={expressionPreviewContext}
        />
      </>
    );
  };

  const renderLlmParameters = () => {
    return (
      <>
        {renderProviderSection()}
        <TextField
          label="Prompt Key"
          value={toStringValue(config.promptKey, "prompt")}
          onChange={(next) => setConfig((current) => ({ ...current, promptKey: next }))}
        />
        <TextField
          label="System Prompt Key"
          value={toStringValue(config.systemPromptKey, "system_prompt")}
          onChange={(next) => setConfig((current) => ({ ...current, systemPromptKey: next }))}
        />
      </>
    );
  };

  const renderBasicLlmChainParameters = () => (
    <>
      {renderProviderSection()}
      <SelectField
        label="Output Format"
        value={toStringValue(config.outputFormat, "text")}
        options={[
          { value: "text", label: "Text" },
          { value: "json", label: "JSON" }
        ]}
        onChange={(next) => setConfig((current) => ({ ...current, outputFormat: next }))}
      />
      <TextField
        label="Prompt Key"
        value={toStringValue(config.promptKey, "prompt")}
        onChange={(next) => setConfig((current) => ({ ...current, promptKey: next }))}
      />
      <TextField
        label="System Prompt Key"
        value={toStringValue(config.systemPromptKey, "system_prompt")}
        onChange={(next) => setConfig((current) => ({ ...current, systemPromptKey: next }))}
      />
    </>
  );

  const renderQaChainParameters = () => (
    <>
      {renderProviderSection()}
      <TextField
        label="Context Key"
        value={toStringValue(config.contextKey, "context")}
        onChange={(next) => setConfig((current) => ({ ...current, contextKey: next }))}
      />
      <TextField
        label="Question Key"
        value={toStringValue(config.questionKey, "question")}
        onChange={(next) => setConfig((current) => ({ ...current, questionKey: next }))}
      />
      <NumberField
        label="Max Context Length"
        value={toNumberValue(config.maxContextLength, 4000)}
        min={100}
        step={500}
        onChange={(next) => setConfig((current) => ({ ...current, maxContextLength: next }))}
      />
    </>
  );

  const renderSummarizationChainParameters = () => (
    <>
      {renderProviderSection()}
      <TextField
        label="Text Key"
        value={toStringValue(config.textKey, "text")}
        onChange={(next) => setConfig((current) => ({ ...current, textKey: next }))}
      />
      <SelectField
        label="Summary Style"
        value={toStringValue(config.style, "brief")}
        options={[
          { value: "brief", label: "Brief" },
          { value: "detailed", label: "Detailed" },
          { value: "bullet_points", label: "Bullet Points" },
          { value: "executive", label: "Executive Summary" }
        ]}
        onChange={(next) => setConfig((current) => ({ ...current, style: next }))}
      />
      <NumberField
        label="Max Length (chars)"
        value={toNumberValue(config.maxLength, 500)}
        min={50}
        step={50}
        onChange={(next) => setConfig((current) => ({ ...current, maxLength: next }))}
      />
    </>
  );

  const renderInformationExtractorParameters = () => (
    <>
      {renderProviderSection()}
      <TextField
        label="Text Key"
        value={toStringValue(config.textKey, "text")}
        onChange={(next) => setConfig((current) => ({ ...current, textKey: next }))}
      />
      <label className="cfg-field">
        <span>Extraction Schema (JSON)</span>
        <textarea
          className="cfg-code-editor"
          value={toStringValue(config.extractionSchema, '{ "name": "string", "email": "string" }')}
          onChange={(e) => setConfig((current) => ({ ...current, extractionSchema: e.target.value }))}
          rows={5}
          spellCheck={false}
        />
      </label>
    </>
  );

  const renderTextClassifierParameters = () => (
    <>
      {renderProviderSection()}
      <TextField
        label="Text Key"
        value={toStringValue(config.textKey, "text")}
        onChange={(next) => setConfig((current) => ({ ...current, textKey: next }))}
      />
      <TextField
        label="Categories (comma-separated)"
        value={toStringValue(config.categories, "positive, negative, neutral")}
        onChange={(next) => setConfig((current) => ({ ...current, categories: next }))}
      />
      <label className="cfg-field" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input
          type="checkbox"
          checked={config.multiLabel === true}
          onChange={(e) => setConfig((current) => ({ ...current, multiLabel: e.target.checked }))}
        />
        <span>Multi-label (allow multiple categories)</span>
      </label>
    </>
  );

  const renderSentimentAnalysisParameters = () => (
    <>
      {renderProviderSection()}
      <TextField
        label="Text Key"
        value={toStringValue(config.textKey, "text")}
        onChange={(next) => setConfig((current) => ({ ...current, textKey: next }))}
      />
    </>
  );

  const renderAiTransformParameters = () => (
    <>
      {renderProviderSection()}
      <label className="cfg-field">
        <span>Transformation Instruction</span>
        <textarea
          className="cfg-code-editor"
          value={toStringValue(config.instruction, "")}
          onChange={(e) => setConfig((current) => ({ ...current, instruction: e.target.value }))}
          rows={4}
          spellCheck={false}
          placeholder="Convert this CSV data to a markdown table..."
        />
      </label>
      <TextField
        label="Input Key"
        value={toStringValue(config.inputKey, "text")}
        onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
      />
      <SelectField
        label="Output Format"
        value={toStringValue(config.outputFormat, "text")}
        options={[
          { value: "text", label: "Text" },
          { value: "json", label: "JSON" },
          { value: "code", label: "Code" }
        ]}
        onChange={(next) => setConfig((current) => ({ ...current, outputFormat: next }))}
      />
    </>
  );

  const renderPromptTemplateParameters = () => {
    return (
      <>
        <ExpressionField
          label="Template"
          value={toStringValue(config.template)}
          onChange={(next) => setConfig((current) => ({ ...current, template: next }))}
          rows={5}
          mode="template"
          previewContext={expressionPreviewContext}
        />
        <TextField
          label="Output key"
          value={toStringValue(config.outputKey, "prompt")}
          onChange={(next) => setConfig((current) => ({ ...current, outputKey: next }))}
        />
      </>
    );
  };

  const renderCodeNodeParameters = () => {
    return (
      <>
        <label className="cfg-field">
          <span>JavaScript Code</span>
          <textarea
            className="cfg-code-editor"
            value={toStringValue(config.code)}
            onChange={(event) => setConfig((current) => ({ ...current, code: event.target.value }))}
            rows={12}
            spellCheck={false}
          />
        </label>

        <NumberField
          label="Timeout (ms)"
          value={toNumberValue(config.timeout, 1500)}
          min={1}
          step={100}
          onChange={(next) => setConfig((current) => ({ ...current, timeout: next }))}
        />

        <label className="cfg-field">
          <span>Test Input (JSON Object)</span>
          <textarea
            className="cfg-code-editor cfg-code-editor-secondary"
            value={codeTestInput}
            onChange={(event) => setCodeTestInput(event.target.value)}
            rows={7}
            spellCheck={false}
          />
        </label>

        <div className="cfg-inline-actions">
          <button type="button" className="node-btn" onClick={() => void handleCodeNodeTestRun()} disabled={codeTestBusy}>
            {codeTestBusy ? "Testing..." : "Test Run"}
          </button>
          {codeTestResult && <span className="muted">Test completed. Inspect output panel for logs/result.</span>}
        </div>
        {codeTestError && <div className="error-banner">{codeTestError}</div>}
      </>
    );
  };

  const renderWebhookParameters = () => {
    const pathValue = toStringValue(config.path, node.id);
    const normalizedPath = pathValue.trim().replace(/^\/+/, "").replace(/\/+$/, "") || node.id;
    const method = toStringValue(config.method, "POST").trim().toUpperCase() || "POST";
    const authMode = toStringValue(config.authMode, "none");
    const authHeaderName = toStringValue(config.authHeaderName, "authorization");
    const signatureHeaderName = toStringValue(config.signatureHeaderName, "x-webhook-signature");
    const timestampHeaderName = toStringValue(config.timestampHeaderName, "x-webhook-timestamp");
    const replayToleranceSeconds = toNumberValue(config.replayToleranceSeconds, 300);
    const secretId = toStringValue(asRecord(config.secretRef).secretId);
    const idempotencyEnabled = toBooleanValue(config.idempotencyEnabled, false);
    const idempotencyHeaderName = toStringValue(config.idempotencyHeaderName, "idempotency-key");
    const passThroughCsv = Array.isArray(config.passThroughFields)
      ? config.passThroughFields.map((item) => String(item)).join(",")
      : "system_prompt,user_prompt,session_id,variables";
    const apiBase = getApiBaseUrl();
    const suggestedApiBase = getSuggestedDirectApiBaseUrl(apiBase);
    const testUrl = `${apiBase}/webhook-test/${normalizedPath}`;
    const productionUrl = `${apiBase}/webhook/${normalizedPath}`;
    const suggestedTestUrl = suggestedApiBase ? `${suggestedApiBase}/webhook-test/${normalizedPath}` : null;
    const suggestedProductionUrl = suggestedApiBase ? `${suggestedApiBase}/webhook/${normalizedPath}` : null;

    return (
      <>
        <SelectField
          label="HTTP Method"
          value={method}
          onChange={(next) => setConfig((current) => ({ ...current, method: next }))}
          options={[
            { value: "POST", label: "POST" },
            { value: "GET", label: "GET" },
            { value: "PUT", label: "PUT" },
            { value: "PATCH", label: "PATCH" },
            { value: "DELETE", label: "DELETE" }
          ]}
        />
        <TextField
          label="Path"
          value={pathValue}
          onChange={(next) => setConfig((current) => ({ ...current, path: next }))}
          placeholder="agent-demo"
        />
        <TextField
          label="Pass-through Fields (comma-separated)"
          value={passThroughCsv}
          onChange={(next) =>
            setConfig((current) => ({
              ...current,
              passThroughFields: next
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            }))
          }
        />

        <SelectField
          label="Auth Mode"
          value={authMode}
          onChange={(next) => setConfig((current) => ({ ...current, authMode: next }))}
          options={[
            { value: "none", label: "None" },
            { value: "bearer_token", label: "Bearer Token" },
            { value: "hmac_sha256", label: "HMAC SHA256" }
          ]}
        />

        {authMode === "bearer_token" && (
          <>
            <TextField
              label="Auth Header Name"
              value={authHeaderName}
              onChange={(next) => setConfig((current) => ({ ...current, authHeaderName: next }))}
              placeholder="authorization"
            />
            {renderCredentialSecretField({
              fieldKey: "webhook_token_secret",
              label: "Token Secret",
              value: secretId,
              noneLabel: "Select secret",
              preferredProvider: "webhook",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
          </>
        )}

        {authMode === "hmac_sha256" && (
          <>
            <TextField
              label="Signature Header"
              value={signatureHeaderName}
              onChange={(next) => setConfig((current) => ({ ...current, signatureHeaderName: next }))}
              placeholder="x-webhook-signature"
            />
            <TextField
              label="Timestamp Header"
              value={timestampHeaderName}
              onChange={(next) => setConfig((current) => ({ ...current, timestampHeaderName: next }))}
              placeholder="x-webhook-timestamp"
            />
            <NumberField
              label="Replay Tolerance (seconds)"
              value={replayToleranceSeconds}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, replayToleranceSeconds: next }))}
            />
            {renderCredentialSecretField({
              fieldKey: "webhook_hmac_secret",
              label: "HMAC Secret",
              value: secretId,
              noneLabel: "Select secret",
              preferredProvider: "webhook",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
          </>
        )}

        <ToggleField
          label="Idempotency Enabled"
          checked={idempotencyEnabled}
          onChange={(next) => setConfig((current) => ({ ...current, idempotencyEnabled: next }))}
        />

        {idempotencyEnabled && (
          <TextField
            label="Idempotency Header"
            value={idempotencyHeaderName}
            onChange={(next) => setConfig((current) => ({ ...current, idempotencyHeaderName: next }))}
            placeholder="idempotency-key"
          />
        )}

        <SelectField
          label="Response Mode"
          value={toStringValue(config.responseMode, "lastNode")}
          onChange={(next) => setConfig((current) => ({ ...current, responseMode: next }))}
          options={[
            { value: "onReceived", label: "On Received (immediate 200)" },
            { value: "lastNode", label: "Last Node Output" },
            { value: "responseNode", label: "Wait for Response Node" }
          ]}
        />
        <NumberField
          label="Response Status Code"
          value={toNumberValue(config.responseCode, 200)}
          min={100}
          max={599}
          step={1}
          onChange={(next) => setConfig((current) => ({ ...current, responseCode: next }))}
        />
        <TextAreaField
          label="Response Body Override (optional)"
          value={toStringValue(config.responseBody)}
          onChange={(next) => setConfig((current) => ({ ...current, responseBody: next }))}
          rows={3}
        />

        <div className="cfg-tip">
          <div>
            <strong>Test URL</strong>
          </div>
          <code>{`${method} ${testUrl}`}</code>
          <div style={{ marginTop: "8px" }}>
            <strong>Production URL</strong>
          </div>
          <code>{`${method} ${productionUrl}`}</code>
          {suggestedTestUrl && suggestedProductionUrl ? (
            <div style={{ marginTop: "8px" }}>
              <div><strong>Direct API URL (fallback)</strong></div>
              <code>{`${method} ${suggestedTestUrl}`}</code>
              <div style={{ marginTop: "6px" }} />
              <code>{`${method} ${suggestedProductionUrl}`}</code>
              <div style={{ marginTop: "6px" }}>
                If app-origin URL returns 404, call direct API URL or set <code>VITE_API_BASE_URL</code>.
              </div>
            </div>
          ) : null}
        </div>

        <div className="cfg-tip">
          Send JSON body with event data. Common fields: <code>user_prompt</code> (or <code>prompt</code>),
          <code>system_prompt</code>, <code>session_id</code>, <code>variables</code>.
          {authMode === "bearer_token" ? (
            <div style={{ marginTop: "6px" }}>
              Include header <code>{authHeaderName || "authorization"}</code> with your token value.
            </div>
          ) : null}
          {authMode === "hmac_sha256" ? (
            <div style={{ marginTop: "6px" }}>
              Include <code>{timestampHeaderName || "x-webhook-timestamp"}</code> and <code>{signatureHeaderName || "x-webhook-signature"}</code> where signature is HMAC-SHA256 of
              <code>timestamp.raw_body</code>.
            </div>
          ) : null}
          {idempotencyEnabled ? (
            <div style={{ marginTop: "6px" }}>
              Include <code>{idempotencyHeaderName || "idempotency-key"}</code> to dedupe retries safely.
            </div>
          ) : null}
        </div>
      </>
    );
  };

  const renderConnectorParameters = () => {
    const connectorId = toStringValue(config.connectorId, "google-drive");
    const connectorConfig = asRecord(config.connectorConfig);

    const updateConnectorConfig = (patch: Record<string, unknown>) => {
      setConfig((current) => ({
        ...current,
        connectorConfig: {
          ...asRecord(current.connectorConfig),
          ...patch
        }
      }));
    };

    const fileIdsCsv = Array.isArray(connectorConfig.fileIds)
      ? connectorConfig.fileIds.map((value) => String(value)).join(",")
      : "";

    return (
      <>
        <SelectField
          label="Connector"
          value={connectorId}
          onChange={(next) => setConfig((current) => ({ ...current, connectorId: next }))}
          options={[
            { value: "google-drive", label: "Google Drive" },
            { value: "sql-db", label: "SQL Database" },
            { value: "nosql-db", label: "NoSQL Database" },
            { value: "azure-storage", label: "Azure Storage" },
            { value: "azure-cosmos-db", label: "Azure Cosmos DB" },
            { value: "azure-monitor", label: "Microsoft Azure Monitor" },
            { value: "azure-ai-search", label: "Azure AI Search Vector Store" }
          ]}
        />

        {connectorId === "google-drive" ? (
          <>
            {renderCredentialSecretField({
              fieldKey: "connector_google_drive_secret",
              label: "Google Drive Credentials Secret",
              value: toStringValue(asRecord(connectorConfig.secretRef).secretId),
              noneLabel: "None (demo fallback)",
              preferredProvider: "google_drive",
              onSelect: (next) =>
                updateConnectorConfig({
                  secretRef: next ? { secretId: next } : undefined
                })
            })}
            <TextField
              label="Folder ID (optional)"
              value={toStringValue(connectorConfig.folderId)}
              onChange={(next) => updateConnectorConfig({ folderId: next })}
              placeholder="1AbC...xyz"
            />
            <TextField
              label="Specific File IDs (comma separated, optional)"
              value={fileIdsCsv}
              onChange={(next) =>
                updateConnectorConfig({
                  fileIds: next
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean)
                })
              }
              placeholder="fileId1,fileId2"
            />
            <TextField
              label="Drive Query (optional)"
              value={toStringValue(connectorConfig.query)}
              onChange={(next) => updateConnectorConfig({ query: next })}
              placeholder="name contains 'policy' and mimeType = 'text/plain'"
            />
            <NumberField
              label="Max Files"
              value={toNumberValue(connectorConfig.maxFiles, 10)}
              min={1}
              max={100}
              step={1}
              onChange={(next) => updateConnectorConfig({ maxFiles: next })}
            />
            <ToggleField
              label="Include Shared Drives"
              checked={toBooleanValue(connectorConfig.includeSharedDrives, true)}
              onChange={(next) => updateConnectorConfig({ includeSharedDrives: next })}
            />
            <ToggleField
              label="Include Native Google Docs"
              checked={toBooleanValue(connectorConfig.includeNativeGoogleDocs, true)}
              onChange={(next) => updateConnectorConfig({ includeNativeGoogleDocs: next })}
            />
            <ToggleField
              label="Use Demo Fallback If Unavailable"
              checked={toBooleanValue(connectorConfig.useDemoFallback, true)}
              onChange={(next) => updateConnectorConfig({ useDemoFallback: next })}
            />
            <div className="cfg-tip">
              Secret value can be either:
              <br />
              1. OAuth access token string
              <br />
              2. Service-account JSON (client_email + private_key)
            </div>
          </>
        ) : (
          <TextAreaField
            label="Connector Config (JSON)"
            value={JSON.stringify(asRecord(config.connectorConfig), null, 2)}
            onChange={(next) => {
              try {
                const parsed = JSON.parse(next) as Record<string, unknown>;
                setConfig((current) => ({ ...current, connectorConfig: parsed }));
              } catch {
                // keep current if invalid while typing
              }
            }}
            rows={5}
          />
        )}
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() =>
              void handleConnectorTestRun({
                connectorId,
                connectorConfig: asRecord(connectorConfig)
              })
            }
            disabled={connectorTestBusy}
          >
            {connectorTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {connectorTestMessage && <span className="muted">{connectorTestMessage}</span>}
        </div>
        {connectorTestError && <div className="error-banner">{connectorTestError}</div>}
      </>
    );
  };

  const renderGoogleDriveSourceParameters = () => {
    const fileIdsCsv = Array.isArray(config.fileIds) ? config.fileIds.map((value) => String(value)).join(",") : "";

    return (
      <>
        {renderCredentialSecretField({
          fieldKey: "google_drive_source_secret",
          label: "Google Drive Credentials Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "None (demo fallback)",
          preferredProvider: "google_drive",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <TextField
          label="Folder ID (optional)"
          value={toStringValue(config.folderId)}
          onChange={(next) => setConfig((current) => ({ ...current, folderId: next }))}
          placeholder="1AbC...xyz"
        />
        <TextField
          label="Specific File IDs (comma separated, optional)"
          value={fileIdsCsv}
          onChange={(next) =>
            setConfig((current) => ({
              ...current,
              fileIds: next
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            }))
          }
          placeholder="fileId1,fileId2"
        />
        <TextField
          label="Drive Query (optional)"
          value={toStringValue(config.query)}
          onChange={(next) => setConfig((current) => ({ ...current, query: next }))}
          placeholder="name contains 'policy' and mimeType = 'text/plain'"
        />
        <NumberField
          label="Max Files"
          value={toNumberValue(config.maxFiles, 10)}
          min={1}
          max={100}
          step={1}
          onChange={(next) => setConfig((current) => ({ ...current, maxFiles: next }))}
        />
        <ToggleField
          label="Include Shared Drives"
          checked={toBooleanValue(config.includeSharedDrives, true)}
          onChange={(next) => setConfig((current) => ({ ...current, includeSharedDrives: next }))}
        />
        <ToggleField
          label="Include Native Google Docs"
          checked={toBooleanValue(config.includeNativeGoogleDocs, true)}
          onChange={(next) => setConfig((current) => ({ ...current, includeNativeGoogleDocs: next }))}
        />
        <ToggleField
          label="Use Demo Fallback If Unavailable"
          checked={toBooleanValue(config.useDemoFallback, true)}
          onChange={(next) => setConfig((current) => ({ ...current, useDemoFallback: next }))}
        />
        <div className="cfg-tip">
          Secret value can be either:
          <br />
          1. OAuth access token string
          <br />
          2. Service-account JSON (client_email + private_key)
        </div>
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() =>
              void handleConnectorTestRun({
                connectorId: "google-drive",
                connectorConfig: asRecord(config)
              })
            }
            disabled={connectorTestBusy}
          >
            {connectorTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {connectorTestMessage && <span className="muted">{connectorTestMessage}</span>}
        </div>
        {connectorTestError && <div className="error-banner">{connectorTestError}</div>}
      </>
    );
  };

  const renderAzureOpenAIChatModelParameters = () => {
    return (
      <>
        <TextField
          label="Endpoint"
          value={toStringValue(config.endpoint)}
          onChange={(next) => setConfig((current) => ({ ...current, endpoint: next }))}
          placeholder="https://<resource>.openai.azure.com"
        />
        <TextField
          label="Deployment"
          value={toStringValue(config.deployment)}
          onChange={(next) => setConfig((current) => ({ ...current, deployment: next }))}
          placeholder="gpt-4o-mini"
        />
        <TextField
          label="API Version"
          value={toStringValue(config.apiVersion, "2024-10-21")}
          onChange={(next) => setConfig((current) => ({ ...current, apiVersion: next }))}
          placeholder="2024-10-21"
        />
        {renderCredentialSecretField({
          fieldKey: "azure_openai_chat_secret",
          label: "Azure OpenAI Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "Select secret",
          preferredProvider: "azure_openai",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <div className="cfg-grid-2">
          <NumberField
            label="Temperature"
            value={toNumberValue(config.temperature, 0.2)}
            min={0}
            max={2}
            step={0.1}
            onChange={(next) => setConfig((current) => ({ ...current, temperature: next }))}
          />
          <NumberField
            label="Max Tokens"
            value={toNumberValue(config.maxTokens, 1024)}
            min={1}
            step={1}
            onChange={(next) => setConfig((current) => ({ ...current, maxTokens: next }))}
          />
        </div>
        <TextField
          label="Prompt Key"
          value={toStringValue(config.promptKey, "prompt")}
          onChange={(next) => setConfig((current) => ({ ...current, promptKey: next }))}
        />
        <TextField
          label="System Prompt Key"
          value={toStringValue(config.systemPromptKey, "system_prompt")}
          onChange={(next) => setConfig((current) => ({ ...current, systemPromptKey: next }))}
        />
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() => void handleProviderTestRun()}
            disabled={providerTestBusy}
          >
            {providerTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {providerTestMessage && <span className="muted">{providerTestMessage}</span>}
        </div>
        {providerTestError && <div className="error-banner">{providerTestError}</div>}
      </>
    );
  };

  const renderGoogleGeminiChatModelParameters = () => {
    const fallbackModels = [
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { value: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
      { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash" }
    ];
    const modelOptions = geminiModels && geminiModels.length > 0 ? geminiModels : fallbackModels;

    return (
      <>
        {renderCredentialSecretField({
          fieldKey: "gemini_chat_secret",
          label: "Google Gemini API Key",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "Select secret",
          preferredProvider: "gemini",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <SelectField
          label={geminiModelsLoading ? "Model (loading...)" : "Model"}
          value={toStringValue(config.model, "gemini-2.5-flash")}
          options={modelOptions}
          onChange={(next) => setConfig((current) => ({ ...current, model: next }))}
        />
        <div className="cfg-grid-2">
          <NumberField
            label="Temperature"
            value={toNumberValue(config.temperature, 0.2)}
            min={0}
            max={2}
            step={0.1}
            onChange={(next) => setConfig((current) => ({ ...current, temperature: next }))}
          />
          <NumberField
            label="Max Tokens"
            value={toNumberValue(config.maxTokens, 1024)}
            min={1}
            step={1}
            onChange={(next) => setConfig((current) => ({ ...current, maxTokens: next }))}
          />
        </div>
        <TextField
          label="Prompt Key"
          value={toStringValue(config.promptKey, "prompt")}
          onChange={(next) => setConfig((current) => ({ ...current, promptKey: next }))}
        />
        <TextField
          label="System Prompt Key"
          value={toStringValue(config.systemPromptKey, "system_prompt")}
          onChange={(next) => setConfig((current) => ({ ...current, systemPromptKey: next }))}
        />
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() => void handleProviderTestRun()}
            disabled={providerTestBusy}
          >
            {providerTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {providerTestMessage && <span className="muted">{providerTestMessage}</span>}
        </div>
        {providerTestError && <div className="error-banner">{providerTestError}</div>}
      </>
    );
  };

  const renderEmbeddingsAzureOpenAIParameters = () => {
    return (
      <>
        <TextField
          label="Endpoint"
          value={toStringValue(config.endpoint)}
          onChange={(next) => setConfig((current) => ({ ...current, endpoint: next }))}
          placeholder="https://<resource>.openai.azure.com"
        />
        <TextField
          label="Deployment"
          value={toStringValue(config.deployment)}
          onChange={(next) => setConfig((current) => ({ ...current, deployment: next }))}
          placeholder="text-embedding-3-small"
        />
        <TextField
          label="API Version"
          value={toStringValue(config.apiVersion, "2024-10-21")}
          onChange={(next) => setConfig((current) => ({ ...current, apiVersion: next }))}
          placeholder="2024-10-21"
        />
        {renderCredentialSecretField({
          fieldKey: "azure_openai_embedding_secret",
          label: "Azure OpenAI Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "Select secret",
          preferredProvider: "azure_openai",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <TextField
          label="Input Key"
          value={toStringValue(config.inputKey, "user_prompt")}
          onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
          placeholder="user_prompt"
        />
        <TextField
          label="Output Key"
          value={toStringValue(config.outputKey, "embedding")}
          onChange={(next) => setConfig((current) => ({ ...current, outputKey: next }))}
          placeholder="embedding"
        />
      </>
    );
  };

  const renderAzureStorageParameters = () => {
    const operation = toStringValue(config.operation, "list_blobs");

    return (
      <>
        <SelectField
          label="Operation"
          value={operation}
          onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
          options={[
            { value: "list_containers", label: "List Containers" },
            { value: "list_blobs", label: "List Blobs" },
            { value: "get_blob_text", label: "Get Blob Text" },
            { value: "put_blob_text", label: "Put Blob Text" },
            { value: "delete_blob", label: "Delete Blob" }
          ]}
        />
        <TextField
          label="Account Name"
          value={toStringValue(config.accountName)}
          onChange={(next) => setConfig((current) => ({ ...current, accountName: next }))}
          placeholder="myaccount"
        />
        <TextField
          label="Endpoint (optional)"
          value={toStringValue(config.endpoint)}
          onChange={(next) => setConfig((current) => ({ ...current, endpoint: next }))}
          placeholder="https://myaccount.blob.core.windows.net"
        />
        {(operation === "list_blobs" || operation === "get_blob_text" || operation === "put_blob_text" || operation === "delete_blob") && (
          <TextField
            label="Container Name"
            value={toStringValue(config.containerName)}
            onChange={(next) => setConfig((current) => ({ ...current, containerName: next }))}
            placeholder="my-container"
          />
        )}
        {(operation === "get_blob_text" || operation === "put_blob_text" || operation === "delete_blob") && (
          <TextField
            label="Blob Name"
            value={toStringValue(config.blobName)}
            onChange={(next) => setConfig((current) => ({ ...current, blobName: next }))}
            placeholder="reports/today.txt"
          />
        )}
        {operation === "list_blobs" && (
          <TextField
            label="Prefix (optional)"
            value={toStringValue(config.prefix)}
            onChange={(next) => setConfig((current) => ({ ...current, prefix: next }))}
            placeholder="reports/"
          />
        )}
        {operation === "put_blob_text" && (
          <TextAreaField
            label="Blob Content Template"
            value={toStringValue(config.blobContentTemplate)}
            onChange={(next) => setConfig((current) => ({ ...current, blobContentTemplate: next }))}
            rows={4}
          />
        )}
        {(operation === "list_containers" || operation === "list_blobs") && (
          <NumberField
            label="Max Results"
            value={toNumberValue(config.maxResults, 100)}
            min={1}
            max={5000}
            step={1}
            onChange={(next) => setConfig((current) => ({ ...current, maxResults: next }))}
          />
        )}
        {renderCredentialSecretField({
          fieldKey: "azure_storage_secret",
          label: "Azure Storage Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "None (demo fallback)",
          preferredProvider: "azure_storage",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <ToggleField
          label="Use Demo Fallback If Unavailable"
          checked={toBooleanValue(config.useDemoFallback, true)}
          onChange={(next) => setConfig((current) => ({ ...current, useDemoFallback: next }))}
        />
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() =>
              void handleConnectorTestRun({
                connectorId: "azure-storage",
                connectorConfig: asRecord(config)
              })
            }
            disabled={connectorTestBusy}
          >
            {connectorTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {connectorTestMessage && <span className="muted">{connectorTestMessage}</span>}
        </div>
        {connectorTestError && <div className="error-banner">{connectorTestError}</div>}
      </>
    );
  };

  const renderAzureCosmosDbParameters = () => {
    const operation = toStringValue(config.operation, "query_items");

    return (
      <>
        <SelectField
          label="Operation"
          value={operation}
          onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
          options={[
            { value: "query_items", label: "Query Items" },
            { value: "read_item", label: "Read Item" },
            { value: "create_item", label: "Create Item" },
            { value: "upsert_item", label: "Upsert Item" },
            { value: "delete_item", label: "Delete Item" }
          ]}
        />
        <TextField
          label="Endpoint"
          value={toStringValue(config.endpoint)}
          onChange={(next) => setConfig((current) => ({ ...current, endpoint: next }))}
          placeholder="https://<account>.documents.azure.com:443/"
        />
        <TextField
          label="Database ID"
          value={toStringValue(config.databaseId)}
          onChange={(next) => setConfig((current) => ({ ...current, databaseId: next }))}
          placeholder="db1"
        />
        <TextField
          label="Container ID"
          value={toStringValue(config.containerId)}
          onChange={(next) => setConfig((current) => ({ ...current, containerId: next }))}
          placeholder="items"
        />
        {(operation === "query_items") && (
          <>
            <TextAreaField
              label="Query Text"
              value={toStringValue(config.queryText, "SELECT TOP 10 * FROM c")}
              onChange={(next) => setConfig((current) => ({ ...current, queryText: next }))}
              rows={4}
            />
            <NumberField
              label="Max Items"
              value={toNumberValue(config.maxItems, 50)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, maxItems: next }))}
            />
          </>
        )}
        {(operation === "read_item" || operation === "delete_item") && (
          <TextField
            label="Item ID"
            value={toStringValue(config.itemId)}
            onChange={(next) => setConfig((current) => ({ ...current, itemId: next }))}
            placeholder="item-123"
          />
        )}
        {(operation === "read_item" || operation === "delete_item" || operation === "create_item" || operation === "upsert_item") && (
          <TextField
            label="Partition Key (optional)"
            value={toStringValue(config.partitionKey)}
            onChange={(next) => setConfig((current) => ({ ...current, partitionKey: next }))}
            placeholder="/tenantId value"
          />
        )}
        {(operation === "create_item" || operation === "upsert_item") && (
          <TextAreaField
            label="Item JSON"
            value={toStringValue(config.itemJson, "{\n  \"id\": \"item-1\"\n}")}
            onChange={(next) => setConfig((current) => ({ ...current, itemJson: next }))}
            rows={6}
          />
        )}
        {renderCredentialSecretField({
          fieldKey: "azure_cosmos_secret",
          label: "Cosmos Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "None (demo fallback)",
          preferredProvider: "azure_cosmos_db",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <ToggleField
          label="Use Demo Fallback If Unavailable"
          checked={toBooleanValue(config.useDemoFallback, true)}
          onChange={(next) => setConfig((current) => ({ ...current, useDemoFallback: next }))}
        />
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() =>
              void handleConnectorTestRun({
                connectorId: "azure-cosmos-db",
                connectorConfig: asRecord(config)
              })
            }
            disabled={connectorTestBusy}
          >
            {connectorTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {connectorTestMessage && <span className="muted">{connectorTestMessage}</span>}
        </div>
        {connectorTestError && <div className="error-banner">{connectorTestError}</div>}
      </>
    );
  };

  const renderAzureMonitorParameters = () => {
    const operation = toStringValue(config.operation, "query_logs");

    return (
      <>
        <SelectField
          label="Operation"
          value={operation}
          onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
          options={[
            { value: "query_logs", label: "Query Logs" },
            { value: "query_metrics", label: "Query Metrics" },
            { value: "custom_request", label: "Custom Request" }
          ]}
        />
        {operation === "query_logs" && (
          <>
            <TextField
              label="Workspace ID"
              value={toStringValue(config.workspaceId)}
              onChange={(next) => setConfig((current) => ({ ...current, workspaceId: next }))}
              placeholder="workspace-guid"
            />
            <TextAreaField
              label="Query Text"
              value={toStringValue(config.queryText, "Heartbeat | take 5")}
              onChange={(next) => setConfig((current) => ({ ...current, queryText: next }))}
              rows={4}
            />
          </>
        )}
        {operation === "query_metrics" && (
          <>
            <TextField
              label="Resource ID"
              value={toStringValue(config.resourceId)}
              onChange={(next) => setConfig((current) => ({ ...current, resourceId: next }))}
              placeholder="/subscriptions/.../resourceGroups/.../providers/..."
            />
            <TextField
              label="Metric Names"
              value={toStringValue(config.metricNames)}
              onChange={(next) => setConfig((current) => ({ ...current, metricNames: next }))}
              placeholder="Percentage CPU,Requests"
            />
          </>
        )}
        {operation === "custom_request" && (
          <>
            <SelectField
              label="Method"
              value={toStringValue(config.method, "GET").toUpperCase()}
              onChange={(next) => setConfig((current) => ({ ...current, method: next }))}
              options={[
                { value: "GET", label: "GET" },
                { value: "POST", label: "POST" },
                { value: "PUT", label: "PUT" },
                { value: "PATCH", label: "PATCH" },
                { value: "DELETE", label: "DELETE" }
              ]}
            />
            <TextField
              label="Path / URL"
              value={toStringValue(config.path)}
              onChange={(next) => setConfig((current) => ({ ...current, path: next }))}
              placeholder="/subscriptions?api-version=2020-01-01"
            />
            <TextAreaField
              label="Body (JSON, optional)"
              value={toStringValue(config.bodyTemplate, "")}
              onChange={(next) => setConfig((current) => ({ ...current, bodyTemplate: next }))}
              rows={4}
            />
          </>
        )}
        <TextField
          label="Timespan (optional)"
          value={toStringValue(config.timespan)}
          onChange={(next) => setConfig((current) => ({ ...current, timespan: next }))}
          placeholder="PT1H"
        />
        <NumberField
          label="Max Rows"
          value={toNumberValue(config.maxRows, 200)}
          min={1}
          step={1}
          onChange={(next) => setConfig((current) => ({ ...current, maxRows: next }))}
        />
        {renderCredentialSecretField({
          fieldKey: "azure_monitor_secret",
          label: "Azure Bearer Token Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "None (demo fallback)",
          preferredProvider: "azure_monitor",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <ToggleField
          label="Use Demo Fallback If Unavailable"
          checked={toBooleanValue(config.useDemoFallback, true)}
          onChange={(next) => setConfig((current) => ({ ...current, useDemoFallback: next }))}
        />
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() =>
              void handleConnectorTestRun({
                connectorId: "azure-monitor",
                connectorConfig: asRecord(config)
              })
            }
            disabled={connectorTestBusy}
          >
            {connectorTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {connectorTestMessage && <span className="muted">{connectorTestMessage}</span>}
        </div>
        {connectorTestError && <div className="error-banner">{connectorTestError}</div>}
      </>
    );
  };

  const renderAzureAiSearchParameters = () => {
    const operation = toStringValue(config.operation, "vector_search");

    return (
      <>
        <SelectField
          label="Operation"
          value={operation}
          onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
          options={[
            { value: "vector_search", label: "Vector Search" },
            { value: "upsert_documents", label: "Upsert Documents" },
            { value: "delete_documents", label: "Delete Documents" }
          ]}
        />
        <TextField
          label="Endpoint"
          value={toStringValue(config.endpoint)}
          onChange={(next) => setConfig((current) => ({ ...current, endpoint: next }))}
          placeholder="https://<service>.search.windows.net"
        />
        <TextField
          label="Index Name"
          value={toStringValue(config.indexName)}
          onChange={(next) => setConfig((current) => ({ ...current, indexName: next }))}
          placeholder="documents"
        />
        <TextField
          label="API Version"
          value={toStringValue(config.apiVersion, "2024-07-01")}
          onChange={(next) => setConfig((current) => ({ ...current, apiVersion: next }))}
          placeholder="2024-07-01"
        />
        {renderCredentialSecretField({
          fieldKey: "azure_ai_search_secret",
          label: "Azure AI Search API Key Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "None (demo fallback)",
          preferredProvider: "azure_ai_search",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <div className="cfg-grid-2">
          <TextField
            label="ID Field"
            value={toStringValue(config.idField, "id")}
            onChange={(next) => setConfig((current) => ({ ...current, idField: next }))}
          />
          <TextField
            label="Content Field"
            value={toStringValue(config.contentField, "content")}
            onChange={(next) => setConfig((current) => ({ ...current, contentField: next }))}
          />
          <TextField
            label="Vector Field"
            value={toStringValue(config.vectorField, "embedding")}
            onChange={(next) => setConfig((current) => ({ ...current, vectorField: next }))}
          />
          <TextField
            label="Metadata Field"
            value={toStringValue(config.metadataField, "metadata")}
            onChange={(next) => setConfig((current) => ({ ...current, metadataField: next }))}
          />
        </div>
        {operation === "vector_search" && (
          <>
            <TextField
              label="Query Text"
              value={toStringValue(config.queryText, "{{user_prompt}}")}
              onChange={(next) => setConfig((current) => ({ ...current, queryText: next }))}
            />
            <TextAreaField
              label="Query Vector JSON (optional)"
              value={toStringValue(config.queryVectorJson)}
              onChange={(next) => setConfig((current) => ({ ...current, queryVectorJson: next }))}
              rows={4}
            />
            <NumberField
              label="Top K"
              value={toNumberValue(config.topK, 5)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, topK: next }))}
            />
          </>
        )}
        {(operation === "upsert_documents" || operation === "delete_documents") && (
          <TextAreaField
            label="Documents JSON Array"
            value={toStringValue(config.documentsJson, "[\n  { \"id\": \"doc-1\", \"content\": \"hello\" }\n]")}
            onChange={(next) => setConfig((current) => ({ ...current, documentsJson: next }))}
            rows={6}
          />
        )}
        <ToggleField
          label="Use Demo Fallback If Unavailable"
          checked={toBooleanValue(config.useDemoFallback, true)}
          onChange={(next) => setConfig((current) => ({ ...current, useDemoFallback: next }))}
        />
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() =>
              void handleConnectorTestRun({
                connectorId: "azure-ai-search",
                connectorConfig: asRecord(config)
              })
            }
            disabled={connectorTestBusy}
          >
            {connectorTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {connectorTestMessage && <span className="muted">{connectorTestMessage}</span>}
        </div>
        {connectorTestError && <div className="error-banner">{connectorTestError}</div>}
      </>
    );
  };

  const renderQdrantParameters = () => {
    const operation = toStringValue(config.operation, "get_ranked_documents");
    const retrievalMode =
      operation === "get_ranked_documents" ||
      operation === "retrieve_for_chain_tool" ||
      operation === "retrieve_for_ai_agent_tool";

    return (
      <>
        <SelectField
          label="Operation"
          value={operation}
          onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
          options={[
            { value: "get_ranked_documents", label: "Get Ranked Documents From Vector Store" },
            { value: "add_documents", label: "Add Documents To Vector Store" },
            { value: "retrieve_for_chain_tool", label: "Retrieve Documents For Chain/Tool As Vector Store" },
            { value: "retrieve_for_ai_agent_tool", label: "Retrieve Documents For AI Agent As Tool" }
          ]}
        />
        <TextField
          label="Endpoint"
          value={toStringValue(config.endpoint)}
          onChange={(next) => setConfig((current) => ({ ...current, endpoint: next }))}
          placeholder="http://localhost:6333"
        />
        <TextField
          label="Collection Name"
          value={toStringValue(config.collectionName)}
          onChange={(next) => setConfig((current) => ({ ...current, collectionName: next }))}
          placeholder="documents"
        />
        <TextField
          label="API Key Header Name"
          value={toStringValue(config.apiKeyHeaderName, "api-key")}
          onChange={(next) => setConfig((current) => ({ ...current, apiKeyHeaderName: next }))}
          placeholder="api-key"
        />
        {renderCredentialSecretField({
          fieldKey: "qdrant_secret",
          label: "Qdrant API Key Secret",
          value: toStringValue(asRecord(config.secretRef).secretId),
          noneLabel: "None (demo fallback)",
          preferredProvider: "qdrant",
          onSelect: (next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
        })}
        <div className="cfg-grid-2">
          <TextField
            label="Content Field"
            value={toStringValue(config.contentField, "content")}
            onChange={(next) => setConfig((current) => ({ ...current, contentField: next }))}
          />
          <TextField
            label="Metadata Field"
            value={toStringValue(config.metadataField, "metadata")}
            onChange={(next) => setConfig((current) => ({ ...current, metadataField: next }))}
          />
        </div>
        {retrievalMode && (
          <>
            <TextField
              label="Query Text (optional)"
              value={toStringValue(config.queryText, "{{user_prompt}}")}
              onChange={(next) => setConfig((current) => ({ ...current, queryText: next }))}
            />
            <TextAreaField
              label="Query Vector JSON (optional)"
              value={toStringValue(config.queryVectorJson)}
              onChange={(next) => setConfig((current) => ({ ...current, queryVectorJson: next }))}
              rows={4}
            />
            <TextAreaField
              label="Filter JSON (optional)"
              value={toStringValue(config.filterJson)}
              onChange={(next) => setConfig((current) => ({ ...current, filterJson: next }))}
              rows={4}
            />
            <NumberField
              label="Top K"
              value={toNumberValue(config.topK, 5)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, topK: next }))}
            />
          </>
        )}
        {operation === "add_documents" && (
          <TextAreaField
            label="Documents JSON Array"
            value={toStringValue(
              config.documentsJson,
              "[\n  { \"id\": \"doc-1\", \"text\": \"hello\", \"metadata\": { \"source\": \"manual\" } }\n]"
            )}
            onChange={(next) => setConfig((current) => ({ ...current, documentsJson: next }))}
            rows={8}
          />
        )}
        <ToggleField
          label="Use Demo Fallback If Unavailable"
          checked={toBooleanValue(config.useDemoFallback, true)}
          onChange={(next) => setConfig((current) => ({ ...current, useDemoFallback: next }))}
        />
        <div className="cfg-inline-actions">
          <button
            type="button"
            className="node-btn"
            onClick={() =>
              void handleConnectorTestRun({
                connectorId: "qdrant",
                connectorConfig: asRecord(config)
              })
            }
            disabled={connectorTestBusy}
          >
            {connectorTestBusy ? "Testing..." : "Test Connection"}
          </button>
          {connectorTestMessage && <span className="muted">{connectorTestMessage}</span>}
        </div>
        {connectorTestError && <div className="error-banner">{connectorTestError}</div>}
      </>
    );
  };

  const renderParameters = () => {
    switch (node.data.nodeType) {
      case "schedule_trigger":
        return (
          <>
            <TextField
              label="Cron Expression"
              value={toStringValue(config.cronExpression, "0 9 * * *")}
              onChange={(next) => setConfig((current) => ({ ...current, cronExpression: next }))}
              placeholder="*/15 * * * *"
            />
            <TextField
              label="Timezone"
              value={toStringValue(config.timezone, "America/Toronto")}
              onChange={(next) => setConfig((current) => ({ ...current, timezone: next }))}
              placeholder="America/Toronto"
            />
            <SelectField
              label="Active"
              value={String(config.active !== false)}
              onChange={(next) => setConfig((current) => ({ ...current, active: next === "true" }))}
              options={[
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" }
              ]}
            />
            <div className="cfg-tip">
              The scheduler only runs this workflow when this node is an entry point and connected to downstream execution nodes.
            </div>
          </>
        );
      case "webhook_input":
        return renderWebhookParameters();
      case "agent_orchestrator":
        return renderAgentParameters();
      case "mcp_tool":
        return renderMcpParameters();
      case "local_memory":
        return renderLocalMemoryParameters();
      case "llm_call":
        return renderLlmParameters();
      case "basic_llm_chain":
        return renderBasicLlmChainParameters();
      case "qa_chain":
        return renderQaChainParameters();
      case "summarization_chain":
        return renderSummarizationChainParameters();
      case "information_extractor":
        return renderInformationExtractorParameters();
      case "text_classifier":
        return renderTextClassifierParameters();
      case "sentiment_analysis":
        return renderSentimentAnalysisParameters();
      case "ai_transform":
        return renderAiTransformParameters();
      case "azure_openai_chat_model":
        return renderAzureOpenAIChatModelParameters();
      case "google_gemini_chat_model":
        return renderGoogleGeminiChatModelParameters();
      case "prompt_template":
        return renderPromptTemplateParameters();
      case "code_node":
        return renderCodeNodeParameters();
      case "loop_node":
        return (
          <>
            <TextField
              label="Input Key"
              value={toStringValue(config.inputKey, "items")}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
              placeholder="items"
            />
            <TextField
              label="Item Variable"
              value={toStringValue(config.itemVariable, "item")}
              onChange={(next) => setConfig((current) => ({ ...current, itemVariable: next }))}
              placeholder="item"
            />
            <NumberField
              label="Max Iterations"
              value={toNumberValue(config.maxIterations, 100)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, maxIterations: next }))}
            />
          </>
        );
      case "merge_node":
        return (
          <>
            <SelectField
              label="Merge Mode"
              value={toStringValue(config.mode, "append")}
              onChange={(next) => setConfig((current) => ({ ...current, mode: next }))}
              options={[
                { value: "append", label: "Append (flat merge)" },
                { value: "combine_by_key", label: "Combine by Key" },
                { value: "choose_branch", label: "Choose First Success Branch" }
              ]}
            />
            {toStringValue(config.mode, "append") === "combine_by_key" && (
              <TextField
                label="Combine Key"
                value={toStringValue(config.combineKey, "id")}
                onChange={(next) => setConfig((current) => ({ ...current, combineKey: next }))}
                placeholder="id"
              />
            )}
          </>
        );
      case "execute_workflow":
        return (
          <>
            <SelectField
              label="Workflow"
              value={toStringValue(config.workflowId)}
              onChange={(next) => setConfig((current) => ({ ...current, workflowId: next }))}
              options={[
                { value: "", label: workflowOptions.length ? "Select workflow" : "No workflows available" },
                ...workflowOptions.map((workflow) => ({
                  value: workflow.id,
                  label: `${workflow.name} (${workflow.id})`
                }))
              ]}
            />
            {workflowOptionsError ? <div className="cfg-tip">Failed to load workflows: {workflowOptionsError}</div> : null}
            <SelectField
              label="Execution Mode"
              value={toStringValue(config.mode, "sync")}
              onChange={(next) => setConfig((current) => ({ ...current, mode: next }))}
              options={[
                { value: "sync", label: "Synchronous (wait for result)" },
                { value: "async", label: "Asynchronous (fire and forget)" }
              ]}
            />
            <TextAreaField
              label="Input Mapping (JSON object)"
              value={JSON.stringify(asRecord(config.inputMapping), null, 2)}
              onChange={(next) => {
                try {
                  const parsed = JSON.parse(next) as Record<string, unknown>;
                  setConfig((current) => ({ ...current, inputMapping: parsed }));
                } catch {
                  // ignore typing errors
                }
              }}
              rows={5}
            />
            <TextAreaField
              label="Output Mapping (JSON object)"
              value={JSON.stringify(asRecord(config.outputMapping), null, 2)}
              onChange={(next) => {
                try {
                  const parsed = JSON.parse(next) as Record<string, unknown>;
                  setConfig((current) => ({ ...current, outputMapping: parsed }));
                } catch {
                  // ignore typing errors
                }
              }}
              rows={5}
            />
            <div className="cfg-tip">
              Map sub-workflow output keys back to parent context. Example: <code>{`{ "child_result": "parent_key" }`}</code>.
            </div>
          </>
        );
      case "wait_node": {
        const resumeMode = toStringValue(config.resumeMode, "timer");
        return (
          <>
            <SelectField
              label="Resume Mode"
              value={resumeMode}
              onChange={(next) => setConfig((current) => ({ ...current, resumeMode: next }))}
              options={[
                { value: "timer", label: "Timer (delay)" },
                { value: "webhook", label: "Webhook callback" },
                { value: "datetime", label: "At specific datetime" }
              ]}
            />
            {resumeMode === "timer" && (
              <>
                <NumberField
                  label="Delay (ms)"
                  value={toNumberValue(config.delayMs, 1000)}
                  min={0}
                  step={100}
                  onChange={(next) => setConfig((current) => ({ ...current, delayMs: next }))}
                />
                <NumberField
                  label="Max Delay (ms)"
                  value={toNumberValue(config.maxDelayMs, 30000)}
                  min={1}
                  step={100}
                  onChange={(next) => setConfig((current) => ({ ...current, maxDelayMs: next }))}
                />
              </>
            )}
            {resumeMode === "webhook" && (
              <TextField
                label="Resume Webhook Path"
                value={toStringValue(config.resumeWebhookPath)}
                onChange={(next) => setConfig((current) => ({ ...current, resumeWebhookPath: next }))}
                placeholder="/resume/abc-123"
              />
            )}
            {resumeMode === "datetime" && (
              <label className="cfg-field">
                <span>Resume At</span>
                <input
                  type="datetime-local"
                  value={toStringValue(config.resumeAt)}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, resumeAt: event.target.value }))
                  }
                />
              </label>
            )}
          </>
        );
      }
      case "http_request":
        return (
          <>
            <SelectField
              label="Method"
              value={toStringValue(config.method, "GET")}
              onChange={(next) => setConfig((current) => ({ ...current, method: next }))}
              options={[
                { value: "GET", label: "GET" },
                { value: "POST", label: "POST" },
                { value: "PUT", label: "PUT" },
                { value: "PATCH", label: "PATCH" },
                { value: "DELETE", label: "DELETE" }
              ]}
            />
            <ExpressionField
              label="URL Template"
              value={toStringValue(config.urlTemplate, "https://api.example.com/resource/{{id}}")}
              onChange={(next) => setConfig((current) => ({ ...current, urlTemplate: next }))}
              rows={2}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            {renderCredentialSecretField({
              fieldKey: "http_request_secret",
              label: "Authorization Secret (Bearer)",
              value: toStringValue(asRecord(config.secretRef).secretId),
              noneLabel: "None",
              preferredProvider: "custom",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
            <ExpressionField
              label="Headers Template (JSON)"
              value={toStringValue(config.headersTemplate, "{\n  \"Accept\": \"application/json\"\n}")}
              onChange={(next) => setConfig((current) => ({ ...current, headersTemplate: next }))}
              rows={5}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            <ExpressionField
              label="Body Template"
              value={toStringValue(config.bodyTemplate, "")}
              onChange={(next) => setConfig((current) => ({ ...current, bodyTemplate: next }))}
              rows={5}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            <div className="cfg-grid-2">
              <SelectField
                label="Response Type"
                value={toStringValue(config.responseType, "json")}
                onChange={(next) => setConfig((current) => ({ ...current, responseType: next }))}
                options={[
                  { value: "json", label: "JSON" },
                  { value: "text", label: "Text" }
                ]}
              />
              <NumberField
                label="Timeout (ms)"
                value={toNumberValue(config.timeoutMs, 15000)}
                min={1}
                step={100}
                onChange={(next) => setConfig((current) => ({ ...current, timeoutMs: next }))}
              />
            </div>
            <div className="cfg-tip">
              Templates support handlebars syntax like <code>{`{{user_prompt}}`}</code> and <code>{`{{vars.API_URL}}`}</code>.
            </div>
          </>
        );
      case "set_node": {
        const assignments = Array.isArray(config.assignments)
          ? config.assignments.map((entry) => asRecord(entry))
          : [];

        return (
          <>
            <div className="cfg-group">
              <h4>Assignments</h4>
              {assignments.length === 0 && (
                <div className="cfg-tip">
                  No assignments yet. Add one row to shape the output payload.
                </div>
              )}
              {assignments.map((assignment, index) => (
                <div key={`assignment-${index}`} className="cfg-assignment-row">
                  <div className="cfg-grid-2">
                    <TextField
                      label="Key"
                      value={toStringValue(assignment.key)}
                      onChange={(next) =>
                        setConfig((current) => {
                          const currentAssignments = Array.isArray(current.assignments)
                            ? current.assignments.map((item) => asRecord(item))
                            : [];
                          currentAssignments[index] = {
                            ...asRecord(currentAssignments[index]),
                            key: next
                          };
                          return {
                            ...current,
                            assignments: currentAssignments
                          };
                        })
                      }
                      placeholder="customerId"
                    />
                    <TextAreaField
                      label="Value Template"
                      value={toStringValue(assignment.valueTemplate)}
                      onChange={(next) =>
                        setConfig((current) => {
                          const currentAssignments = Array.isArray(current.assignments)
                            ? current.assignments.map((item) => asRecord(item))
                            : [];
                          currentAssignments[index] = {
                            ...asRecord(currentAssignments[index]),
                            valueTemplate: next
                          };
                          return {
                            ...current,
                            assignments: currentAssignments
                          };
                        })
                      }
                      rows={3}
                    />
                  </div>
                  <div className="cfg-inline-actions">
                    <button
                      type="button"
                      className="header-btn danger"
                      onClick={() =>
                        setConfig((current) => {
                          const currentAssignments = Array.isArray(current.assignments)
                            ? current.assignments.map((item) => asRecord(item))
                            : [];
                          currentAssignments.splice(index, 1);
                          return {
                            ...current,
                            assignments: currentAssignments
                          };
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <div className="cfg-inline-actions">
                <button
                  type="button"
                  className="header-btn"
                  onClick={() =>
                    setConfig((current) => {
                      const currentAssignments = Array.isArray(current.assignments)
                        ? current.assignments.map((item) => asRecord(item))
                        : [];
                      currentAssignments.push({
                        key: "",
                        valueTemplate: ""
                      });
                      return {
                        ...current,
                        assignments: currentAssignments
                      };
                    })
                  }
                >
                  Add Assignment
                </button>
              </div>
            </div>
          </>
        );
      }
      case "webhook_response":
        return (
          <>
            <NumberField
              label="Status Code"
              value={toNumberValue(config.statusCode, 200)}
              min={100}
              max={599}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, statusCode: next }))}
            />
            <ExpressionField
              label="Headers Template (JSON)"
              value={toStringValue(config.headersTemplate, "{\n  \"content-type\": \"application/json\"\n}")}
              onChange={(next) => setConfig((current) => ({ ...current, headersTemplate: next }))}
              rows={5}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            <ExpressionField
              label="Body Template"
              value={toStringValue(config.bodyTemplate, "{\"ok\":true,\"result\":\"{{result}}\"}")}
              onChange={(next) => setConfig((current) => ({ ...current, bodyTemplate: next }))}
              rows={5}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            <div className="cfg-tip">
              This node only affects responses for webhook-triggered executions.
            </div>
          </>
        );
      case "connector_source":
        return renderConnectorParameters();
      case "google_drive_source":
        return renderGoogleDriveSourceParameters();
      case "azure_storage":
        return renderAzureStorageParameters();
      case "azure_cosmos_db":
        return renderAzureCosmosDbParameters();
      case "azure_monitor_http":
        return renderAzureMonitorParameters();
      case "azure_ai_search_vector_store":
        return renderAzureAiSearchParameters();
      case "qdrant_vector_store":
        return renderQdrantParameters();
      case "text_input":
      case "system_prompt":
      case "user_prompt":
        return (
          <TextAreaField
            label="Text"
            value={toStringValue(config.text)}
            onChange={(next) => setConfig((current) => ({ ...current, text: next }))}
            rows={4}
          />
        );
      case "rag_retrieve":
        {
          const embedderId = toStringValue(config.embedderId, "openai-embedder");
          const vectorStoreId = toStringValue(config.vectorStoreId, "pinecone-vector-store");
          const preferredProvider =
            embedderId === "openai-embedder"
              ? "openai"
              : embedderId === "azure-openai-embedder"
                ? "azure_openai"
              : vectorStoreId === "pinecone-vector-store"
                ? "pinecone"
                : vectorStoreId === "pgvector-store"
                  ? "postgres"
                  : vectorStoreId === "azure-ai-search-vector-store"
                    ? "azure_ai_search"
                    : vectorStoreId === "qdrant-vector-store"
                      ? "qdrant"
                    : "custom";

        return (
          <>
            <ExpressionField
              label="Query Template"
              value={toStringValue(config.queryTemplate, "{{user_prompt}}")}
              onChange={(next) => setConfig((current) => ({ ...current, queryTemplate: next }))}
              rows={2}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            <NumberField
              label="Top K"
              value={toNumberValue(config.topK, 3)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, topK: next }))}
            />
            <SelectField
              label="Embedder"
              value={toStringValue(config.embedderId, "openai-embedder")}
              onChange={(next) => setConfig((current) => ({ ...current, embedderId: next }))}
              options={[
                { value: "openai-embedder", label: "OpenAI Embeddings" },
                { value: "azure-openai-embedder", label: "Azure OpenAI Embeddings" },
                { value: "token-embedder", label: "Token Based (Local Demo)" }
              ]}
            />
            <SelectField
              label="Vector Store"
              value={toStringValue(config.vectorStoreId, "pinecone-vector-store")}
              onChange={(next) => setConfig((current) => ({ ...current, vectorStoreId: next }))}
              options={[
                { value: "pinecone-vector-store", label: "Pinecone Vector Store" },
                { value: "azure-ai-search-vector-store", label: "Azure AI Search Vector Store" },
                { value: "qdrant-vector-store", label: "Qdrant Vector Store" },
                { value: "pgvector-store", label: "Postgres PGVector Store" },
                { value: "in-memory-vector-store", label: "In Memory (Local Demo)" }
              ]}
            />
            {renderCredentialSecretField({
              fieldKey: "rag_embedding_secret",
              label: "API Key / Connection String Secret",
              value: toStringValue(asRecord(config.embeddingSecretRef).secretId),
              noneLabel: "None / Env Var",
              preferredProvider,
              onSelect: (next) =>
                setConfig((current) => ({ ...current, embeddingSecretRef: next ? { secretId: next } : undefined }))
            })}
            <TextAreaField
              label="Vector Store Extra Config (JSON)"
              value={JSON.stringify(asRecord(config.vectorStoreConfig), null, 2)}
              onChange={(next) => {
                try {
                   const parsed = JSON.parse(next);
                   setConfig(current => ({...current, vectorStoreConfig: parsed}));
                } catch { /* ignore typing errors */ }
              }}
              rows={3}
            />
          </>
        );
        }
      case "embeddings_azure_openai":
        return renderEmbeddingsAzureOpenAIParameters();
      case "document_chunker":
        return (
          <>
            <SelectField
              label="Split Strategy"
              value={toStringValue(config.strategy, "separator")}
              options={[
                { value: "separator", label: "By Separator" },
                { value: "character", label: "By Character Count" },
                { value: "recursive", label: "Recursive (Multi-separator)" },
                { value: "token", label: "By Token Count (Approximate)" }
              ]}
              onChange={(next) => setConfig((current) => ({ ...current, strategy: next }))}
            />
            <NumberField
              label="Chunk Size"
              value={toNumberValue(config.chunkSize, 500)}
              min={10}
              step={50}
              onChange={(next) => setConfig((current) => ({ ...current, chunkSize: next }))}
            />
            <NumberField
              label="Chunk Overlap"
              value={toNumberValue(config.chunkOverlap, 50)}
              min={0}
              step={10}
              onChange={(next) => setConfig((current) => ({ ...current, chunkOverlap: next }))}
            />
            <TextField
              label="Separator"
              value={toStringValue(config.separator, "\\n\\n")}
              onChange={(next) => setConfig((current) => ({ ...current, separator: next }))}
            />
          </>
        );
      case "output_parser":
        return (
          <>
            <SelectField
              label="Parser Mode"
              value={toStringValue(config.mode, "json_schema")}
              onChange={(next) => setConfig((current) => ({ ...current, mode: next }))}
              options={[
                { value: "json_schema", label: "Strict JSON Schema" },
                { value: "item_list", label: "Item List" },
                { value: "auto_fix", label: "Auto Fix JSON" }
              ]}
            />
            <SelectField
              label="Parsing Strictness"
              value={toStringValue(config.parsingMode, "strict")}
              onChange={(next) => setConfig((current) => ({ ...current, parsingMode: next }))}
              options={[
                { value: "strict", label: "Strict (JSON only)" },
                { value: "lenient", label: "Lenient (JSON repair)" },
                { value: "anything_goes", label: "Anything Goes (best effort)" }
              ]}
            />
            <div className="cfg-tip">
              Strict only accepts valid JSON. Lenient repairs common JSON-like formats. Anything Goes also supports
              best-effort extraction from mixed text and simple key-value blocks.
            </div>
            <TextField
              label="Input Key"
              value={toStringValue(config.inputKey, "answer")}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
            />
            {config.mode === "item_list" && (
              <TextField
                label="Item Separator"
                value={toStringValue(config.itemSeparator, "\\n")}
                onChange={(next) => setConfig((current) => ({ ...current, itemSeparator: next }))}
              />
            )}
            {(config.mode === "json_schema" || config.mode === "auto_fix") && (
              <>
                <NumberField
                  label="LLM Max Auto-Retries"
                  value={toNumberValue(config.maxRetries, 2)}
                  min={0}
                  step={1}
                  onChange={(next) => setConfig((current) => ({ ...current, maxRetries: next }))}
                />
                <TextAreaField
                  label="JSON Schema (Required for strict mode)"
                  value={toStringValue(config.jsonSchema, "{}")}
                  onChange={(next) => setConfig((current) => ({ ...current, jsonSchema: next }))}
                  rows={8}
                />
              </>
            )}
          </>
        );
      case "human_approval":
        return (
          <>
            <TextAreaField
              label="Approval Message"
              value={toStringValue(config.approvalMessage, "Approve this action?")}
              onChange={(next) => setConfig((current) => ({ ...current, approvalMessage: next }))}
              rows={3}
            />
            <NumberField
              label="Timeout (minutes)"
              value={toNumberValue(config.timeoutMinutes, 60)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, timeoutMinutes: next }))}
            />
          </>
        );
      case "input_validator":
        return (
          <>
            <SelectField
              label="On Fail"
              value={toStringValue(config.onFail, "error")}
              onChange={(next) => setConfig((current) => ({ ...current, onFail: next }))}
              options={[
                { value: "error", label: "Stop with Error" },
                { value: "branch", label: "Return valid=false for branching" }
              ]}
            />
            <TextAreaField
              label="Rules (JSON Array)"
              value={JSON.stringify(Array.isArray(config.rules) ? config.rules : [], null, 2)}
              onChange={(next) => {
                try {
                  const parsed = JSON.parse(next);
                  if (Array.isArray(parsed)) {
                    setConfig((current) => ({ ...current, rules: parsed }));
                  }
                } catch {
                  // ignore JSON parsing while typing
                }
              }}
              rows={8}
            />
          </>
        );
      case "output_guardrail":
        return (
          <>
            <SelectField
              label="On Fail"
              value={toStringValue(config.onFail, "error")}
              onChange={(next) => setConfig((current) => ({ ...current, onFail: next }))}
              options={[
                { value: "error", label: "Stop with Error" },
                { value: "retry", label: "Retry with LLM (max 3)" }
              ]}
            />
            <TextField
              label="Input Key"
              value={toStringValue(config.inputKey, "answer")}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
              placeholder="answer"
            />
            <TextField
              label="Checks (comma-separated)"
              value={Array.isArray(config.checks) ? config.checks.map(String).join(", ") : "no_pii"}
              onChange={(next) =>
                setConfig((current) => ({
                  ...current,
                  checks: next
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean)
                }))
              }
              placeholder="no_pii, no_profanity, must_contain_json"
            />
          </>
        );
      case "if_node":
        return (
          <>
            <ExpressionField
              label="Condition Statement"
              value={toStringValue(config.condition, "{{answer}} === 'true'")}
              onChange={(next) => setConfig((current) => ({ ...current, condition: next }))}
              rows={2}
              mode="expression"
              previewContext={expressionPreviewContext}
            />
            <div className="cfg-tip">A javascript expression that returns true or false. Example: <code>{`{{userScore}} > 90`}</code></div>
          </>
        );
      case "switch_node":
        return (
          <>
            <ExpressionField
              label="Switch Evaluation Value"
              value={toStringValue(config.switchValue, "{{answer}}")}
              onChange={(next) => setConfig((current) => ({ ...current, switchValue: next }))}
              rows={2}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            <TextAreaField
              label="Cases array (JSON)"
              value={JSON.stringify(Array.isArray(config.cases) ? config.cases : [], null, 2)}
              onChange={(next) => {
                try {
                  const arr = JSON.parse(next);
                  if (Array.isArray(arr)) {
                     setConfig(current => ({ ...current, cases: arr }));
                  }
                } catch { /* typing error ignore */ }
              }}
              rows={5}
            />
            <TextField
              label="Default Output Label"
              value={toStringValue(config.defaultLabel, "default")}
              onChange={(next) => setConfig((current) => ({ ...current, defaultLabel: next }))}
            />
            <div className="cfg-tip">
              Define JSON array entries like
              <code>[{`{\"value\":\"complete\",\"label\":\"complete\"}`}, {`{\"value\":\"needs_more_info\",\"label\":\"needs_more_info\"}`}]</code>.
              Branch handles use each case <code>label</code>.
            </div>
          </>
        );
      case "output":
        return (
          <>
            <ExpressionField
              label="Response Template"
              value={toStringValue(config.responseTemplate, "{{answer}}")}
              onChange={(next) => setConfig((current) => ({ ...current, responseTemplate: next }))}
              rows={4}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            <TextField
              label="Output Key"
              value={toStringValue(config.outputKey, "result")}
              onChange={(next) => setConfig((current) => ({ ...current, outputKey: next }))}
            />
          </>
        );
      case "pdf_output":
        return (
          <>
            <SelectField
              label="Render Mode"
              value={toStringValue(config.renderMode, "text")}
              onChange={(next) => setConfig((current) => ({ ...current, renderMode: next }))}
              options={[
                { value: "text", label: "Text (simple PDF)" },
                { value: "html", label: "HTML (rich PDF with images)" }
              ]}
            />
            <TextField
              label="Input Key"
              value={toStringValue(config.inputKey, "result")}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
              placeholder="result"
            />
            {toStringValue(config.renderMode, "text") === "html" ? (
              <>
                <ExpressionField
                  label="HTML Template (optional)"
                  value={toStringValue(config.htmlTemplate, "")}
                  onChange={(next) => setConfig((current) => ({ ...current, htmlTemplate: next }))}
                  rows={8}
                  mode="template"
                  previewContext={expressionPreviewContext}
                />
                <div className="cfg-grid-2">
                  <SelectField
                    label="Page Format"
                    value={toStringValue(config.pageFormat, "A4")}
                    onChange={(next) => setConfig((current) => ({ ...current, pageFormat: next }))}
                    options={[
                      { value: "A4", label: "A4" },
                      { value: "Letter", label: "Letter" },
                      { value: "Legal", label: "Legal" },
                      { value: "A3", label: "A3" },
                      { value: "A5", label: "A5" }
                    ]}
                  />
                  <NumberField
                    label="HTML Render Timeout (ms)"
                    value={toNumberValue(config.htmlRenderTimeoutMs, 45000)}
                    min={1000}
                    step={1000}
                    onChange={(next) => setConfig((current) => ({ ...current, htmlRenderTimeoutMs: next }))}
                  />
                </div>
                <ToggleField
                  label="Print Background"
                  checked={toBooleanValue(config.printBackground, true)}
                  onChange={(next) => setConfig((current) => ({ ...current, printBackground: next }))}
                />
              </>
            ) : (
              <ExpressionField
                label="Text Template (optional)"
                value={toStringValue(config.textTemplate, "")}
                onChange={(next) => setConfig((current) => ({ ...current, textTemplate: next }))}
                rows={4}
                mode="template"
                previewContext={expressionPreviewContext}
              />
            )}
            <ExpressionField
              label="Filename Template"
              value={toStringValue(config.filenameTemplate, "workflow-output-{{session_id}}.pdf")}
              onChange={(next) => setConfig((current) => ({ ...current, filenameTemplate: next }))}
              rows={2}
              mode="template"
              previewContext={expressionPreviewContext}
            />
            <TextField
              label="Output Key"
              value={toStringValue(config.outputKey, "pdf")}
              onChange={(next) => setConfig((current) => ({ ...current, outputKey: next }))}
              placeholder="pdf"
            />
            <div className="cfg-tip">
              Generates a PDF and returns a downloadable data URL in the node output. HTML mode supports rich layout,
              CSS, and images.
            </div>
          </>
        );
      case "sub_workflow_trigger":
        return (
          <div className="cfg-tip">
            This node receives input from a parent workflow's <code>execute_workflow</code> call. Place it as the
            entry point of a child workflow; the input mapping defined on the parent flows directly into this
            node's output context.
          </div>
        );
      case "error_trigger":
        return (
          <div className="cfg-tip">
            Fires when an associated workflow errors. The error payload exposes:
            <ul>
              <li><code>trigger_type</code></li>
              <li><code>source_workflow_id</code></li>
              <li><code>source_workflow_name</code></li>
              <li><code>execution_id</code></li>
              <li><code>error</code></li>
              <li><code>error_stack</code></li>
              <li><code>timestamp</code></li>
            </ul>
          </div>
        );
      case "noop_node":
        return (
          <div className="cfg-tip">
            Pass-through node. Useful as a placeholder, visual marker, or graph join point. Output equals input.
          </div>
        );
      case "stop_and_error":
        return (
          <>
            <TextAreaField
              label="Error Message"
              value={toStringValue(config.message, "Workflow stopped")}
              onChange={(next) => setConfig((current) => ({ ...current, message: next }))}
              rows={3}
            />
            <TextField
              label="Error Code (optional)"
              value={toStringValue(config.errorCode)}
              onChange={(next) => setConfig((current) => ({ ...current, errorCode: next }))}
              placeholder="VALIDATION_ERROR"
            />
            <div className="cfg-tip">
              Templates support handlebars syntax like <code>{`{{error_message}}`}</code>.
            </div>
          </>
        );
      case "filter_node": {
        const conditions = Array.isArray(config.conditions)
          ? config.conditions.map((entry) => asRecord(entry))
          : [];
        const updateConditions = (mutator: (rows: Record<string, unknown>[]) => void) => {
          setConfig((current) => {
            const rows = Array.isArray(current.conditions)
              ? current.conditions.map((item) => asRecord(item))
              : [];
            mutator(rows);
            return { ...current, conditions: rows };
          });
        };
        const operatorOptions = [
          { value: "eq", label: "Equals" },
          { value: "neq", label: "Not Equals" },
          { value: "contains", label: "Contains" },
          { value: "not_contains", label: "Not Contains" },
          { value: "starts_with", label: "Starts With" },
          { value: "ends_with", label: "Ends With" },
          { value: "gt", label: "Greater Than" },
          { value: "gte", label: "Greater or Equal" },
          { value: "lt", label: "Less Than" },
          { value: "lte", label: "Less or Equal" },
          { value: "is_empty", label: "Is Empty" },
          { value: "is_not_empty", label: "Is Not Empty" },
          { value: "regex", label: "Matches Regex" }
        ];
        return (
          <>
            <SelectField
              label="Combine With"
              value={toStringValue(config.combineWith, "AND").toUpperCase()}
              onChange={(next) => setConfig((current) => ({ ...current, combineWith: next }))}
              options={[
                { value: "AND", label: "AND (all match)" },
                { value: "OR", label: "OR (any match)" }
              ]}
            />
            <SelectField
              label="Pass Mode"
              value={toStringValue(config.passMode, "pass")}
              onChange={(next) => setConfig((current) => ({ ...current, passMode: next }))}
              options={[
                { value: "pass", label: "Pass items that match" },
                { value: "reject", label: "Reject items that match" }
              ]}
            />
            <div className="cfg-group">
              <h4>Conditions</h4>
              {conditions.length === 0 && (
                <div className="cfg-tip">No conditions defined. Add at least one to filter items.</div>
              )}
              {conditions.map((condition, index) => (
                <div key={`filter-cond-${index}`} className="cfg-assignment-row">
                  <div className="cfg-grid-2">
                    <TextField
                      label="Field"
                      value={toStringValue(condition.field)}
                      onChange={(next) =>
                        updateConditions((rows) => {
                          rows[index] = { ...rows[index], field: next };
                        })
                      }
                      placeholder="status"
                    />
                    <SelectField
                      label="Operator"
                      value={toStringValue(condition.operator, "eq")}
                      onChange={(next) =>
                        updateConditions((rows) => {
                          rows[index] = { ...rows[index], operator: next };
                        })
                      }
                      options={operatorOptions}
                    />
                  </div>
                  <TextField
                    label="Value"
                    value={toStringValue(condition.value)}
                    onChange={(next) =>
                      updateConditions((rows) => {
                        rows[index] = { ...rows[index], value: next };
                      })
                    }
                    placeholder="active"
                  />
                  <div className="cfg-inline-actions">
                    <button
                      type="button"
                      className="header-btn danger"
                      onClick={() =>
                        updateConditions((rows) => {
                          rows.splice(index, 1);
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <div className="cfg-inline-actions">
                <button
                  type="button"
                  className="header-btn"
                  onClick={() =>
                    updateConditions((rows) => {
                      rows.push({ field: "", operator: "eq", value: "" });
                    })
                  }
                >
                  Add Condition
                </button>
              </div>
            </div>
          </>
        );
      }
      case "aggregate_node":
        return (
          <>
            <SelectField
              label="Operation"
              value={toStringValue(config.operation, "sum")}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "sum", label: "Sum" },
                { value: "avg", label: "Average" },
                { value: "min", label: "Min" },
                { value: "max", label: "Max" },
                { value: "count", label: "Count" },
                { value: "concatenate", label: "Concatenate" }
              ]}
            />
            <TextField
              label="Field"
              value={toStringValue(config.field)}
              onChange={(next) => setConfig((current) => ({ ...current, field: next }))}
              placeholder="amount"
            />
            <TextField
              label="Group By (optional)"
              value={toStringValue(config.groupBy)}
              onChange={(next) => setConfig((current) => ({ ...current, groupBy: next }))}
              placeholder="region"
            />
            <TextField
              label="Input Key (optional)"
              value={toStringValue(config.inputKey)}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
              placeholder="items"
            />
          </>
        );
      case "split_out_node":
        return (
          <>
            <TextField
              label="Field (array source)"
              value={toStringValue(config.field)}
              onChange={(next) => setConfig((current) => ({ ...current, field: next }))}
              placeholder="items"
            />
            <TextField
              label="Destination Field (optional)"
              value={toStringValue(config.destinationField)}
              onChange={(next) => setConfig((current) => ({ ...current, destinationField: next }))}
              placeholder="item"
            />
            <TextField
              label="Input Key (optional)"
              value={toStringValue(config.inputKey)}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
            />
          </>
        );
      case "sort_node": {
        const order = toStringValue(config.order, "asc");
        return (
          <>
            <TextField
              label="Field"
              value={toStringValue(config.field)}
              onChange={(next) => setConfig((current) => ({ ...current, field: next }))}
              placeholder="name"
            />
            <SelectField
              label="Order"
              value={order}
              onChange={(next) => setConfig((current) => ({ ...current, order: next }))}
              options={[
                { value: "asc", label: "Ascending" },
                { value: "desc", label: "Descending" },
                { value: "random", label: "Random" }
              ]}
            />
            {order !== "random" && (
              <ExpressionField
                label="Custom Expression (optional)"
                value={toStringValue(config.expression)}
                onChange={(next) => setConfig((current) => ({ ...current, expression: next }))}
                rows={3}
                mode="expression"
                previewContext={expressionPreviewContext}
              />
            )}
            <TextField
              label="Input Key (optional)"
              value={toStringValue(config.inputKey)}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
              placeholder="items"
            />
          </>
        );
      }
      case "limit_node":
        return (
          <>
            <NumberField
              label="Max Items"
              value={toNumberValue(config.maxItems, 10)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, maxItems: next }))}
            />
            <SelectField
              label="Keep"
              value={toStringValue(config.keep, "first")}
              onChange={(next) => setConfig((current) => ({ ...current, keep: next }))}
              options={[
                { value: "first", label: "First N" },
                { value: "last", label: "Last N" }
              ]}
            />
            <TextField
              label="Input Key (optional)"
              value={toStringValue(config.inputKey)}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
            />
          </>
        );
      case "remove_duplicates_node": {
        const fields = Array.isArray(config.fields) ? config.fields.map(String) : [];
        const updateFields = (mutator: (rows: string[]) => void) => {
          setConfig((current) => {
            const rows = Array.isArray(current.fields) ? current.fields.map(String) : [];
            mutator(rows);
            return { ...current, fields: rows };
          });
        };
        return (
          <>
            <div className="cfg-group">
              <h4>Compare Fields (empty = all keys)</h4>
              {fields.map((field, index) => (
                <div key={`dedup-${index}`} className="cfg-assignment-row">
                  <TextField
                    label={`Field ${index + 1}`}
                    value={field}
                    onChange={(next) =>
                      updateFields((rows) => {
                        rows[index] = next;
                      })
                    }
                    placeholder="id"
                  />
                  <div className="cfg-inline-actions">
                    <button
                      type="button"
                      className="header-btn danger"
                      onClick={() =>
                        updateFields((rows) => {
                          rows.splice(index, 1);
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <div className="cfg-inline-actions">
                <button
                  type="button"
                  className="header-btn"
                  onClick={() => updateFields((rows) => rows.push(""))}
                >
                  Add Field
                </button>
              </div>
            </div>
            <TextField
              label="Input Key (optional)"
              value={toStringValue(config.inputKey)}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
            />
          </>
        );
      }
      case "summarize_node": {
        const summaries = Array.isArray(config.fieldsToSummarize)
          ? config.fieldsToSummarize.map((entry) => asRecord(entry))
          : [];
        const groupBys = Array.isArray(config.fieldsToGroupBy)
          ? config.fieldsToGroupBy.map(String)
          : [];
        const aggOptions = [
          { value: "sum", label: "Sum" },
          { value: "avg", label: "Average" },
          { value: "min", label: "Min" },
          { value: "max", label: "Max" },
          { value: "count", label: "Count" },
          { value: "concatenate", label: "Concatenate" }
        ];
        return (
          <>
            <div className="cfg-group">
              <h4>Fields to Summarize</h4>
              {summaries.map((row, index) => (
                <div key={`sum-${index}`} className="cfg-assignment-row">
                  <div className="cfg-grid-2">
                    <TextField
                      label="Field"
                      value={toStringValue(row.field)}
                      onChange={(next) =>
                        setConfig((current) => {
                          const rows = Array.isArray(current.fieldsToSummarize)
                            ? current.fieldsToSummarize.map((item) => asRecord(item))
                            : [];
                          rows[index] = { ...rows[index], field: next };
                          return { ...current, fieldsToSummarize: rows };
                        })
                      }
                    />
                    <SelectField
                      label="Aggregation"
                      value={toStringValue(row.aggregation, "sum")}
                      onChange={(next) =>
                        setConfig((current) => {
                          const rows = Array.isArray(current.fieldsToSummarize)
                            ? current.fieldsToSummarize.map((item) => asRecord(item))
                            : [];
                          rows[index] = { ...rows[index], aggregation: next };
                          return { ...current, fieldsToSummarize: rows };
                        })
                      }
                      options={aggOptions}
                    />
                  </div>
                  <div className="cfg-inline-actions">
                    <button
                      type="button"
                      className="header-btn danger"
                      onClick={() =>
                        setConfig((current) => {
                          const rows = Array.isArray(current.fieldsToSummarize)
                            ? current.fieldsToSummarize.map((item) => asRecord(item))
                            : [];
                          rows.splice(index, 1);
                          return { ...current, fieldsToSummarize: rows };
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <div className="cfg-inline-actions">
                <button
                  type="button"
                  className="header-btn"
                  onClick={() =>
                    setConfig((current) => {
                      const rows = Array.isArray(current.fieldsToSummarize)
                        ? current.fieldsToSummarize.map((item) => asRecord(item))
                        : [];
                      rows.push({ field: "", aggregation: "sum" });
                      return { ...current, fieldsToSummarize: rows };
                    })
                  }
                >
                  Add Summary
                </button>
              </div>
            </div>
            <div className="cfg-group">
              <h4>Group By Fields</h4>
              {groupBys.map((field, index) => (
                <div key={`grpby-${index}`} className="cfg-assignment-row">
                  <TextField
                    label={`Field ${index + 1}`}
                    value={field}
                    onChange={(next) =>
                      setConfig((current) => {
                        const rows = Array.isArray(current.fieldsToGroupBy)
                          ? current.fieldsToGroupBy.map(String)
                          : [];
                        rows[index] = next;
                        return { ...current, fieldsToGroupBy: rows };
                      })
                    }
                  />
                  <div className="cfg-inline-actions">
                    <button
                      type="button"
                      className="header-btn danger"
                      onClick={() =>
                        setConfig((current) => {
                          const rows = Array.isArray(current.fieldsToGroupBy)
                            ? current.fieldsToGroupBy.map(String)
                            : [];
                          rows.splice(index, 1);
                          return { ...current, fieldsToGroupBy: rows };
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <div className="cfg-inline-actions">
                <button
                  type="button"
                  className="header-btn"
                  onClick={() =>
                    setConfig((current) => {
                      const rows = Array.isArray(current.fieldsToGroupBy)
                        ? current.fieldsToGroupBy.map(String)
                        : [];
                      rows.push("");
                      return { ...current, fieldsToGroupBy: rows };
                    })
                  }
                >
                  Add Group-By Field
                </button>
              </div>
            </div>
          </>
        );
      }
      case "compare_datasets_node":
        return (
          <>
            <TextField
              label="Input A"
              value={toStringValue(config.inputA)}
              onChange={(next) => setConfig((current) => ({ ...current, inputA: next }))}
              placeholder="datasetA"
            />
            <TextField
              label="Input B"
              value={toStringValue(config.inputB)}
              onChange={(next) => setConfig((current) => ({ ...current, inputB: next }))}
              placeholder="datasetB"
            />
            <TextField
              label="Key Field"
              value={toStringValue(config.keyField)}
              onChange={(next) => setConfig((current) => ({ ...current, keyField: next }))}
              placeholder="id"
            />
          </>
        );
      case "rename_keys_node": {
        const renames = Array.isArray(config.renames)
          ? config.renames.map((entry) => asRecord(entry))
          : [];
        const update = (mutator: (rows: Record<string, unknown>[]) => void) => {
          setConfig((current) => {
            const rows = Array.isArray(current.renames)
              ? current.renames.map((item) => asRecord(item))
              : [];
            mutator(rows);
            return { ...current, renames: rows };
          });
        };
        return (
          <>
            <div className="cfg-group">
              <h4>Renames</h4>
              {renames.map((row, index) => (
                <div key={`rename-${index}`} className="cfg-assignment-row">
                  <div className="cfg-grid-2">
                    <TextField
                      label="From"
                      value={toStringValue(row.from)}
                      onChange={(next) => update((rows) => { rows[index] = { ...rows[index], from: next }; })}
                    />
                    <TextField
                      label="To"
                      value={toStringValue(row.to)}
                      onChange={(next) => update((rows) => { rows[index] = { ...rows[index], to: next }; })}
                    />
                  </div>
                  <div className="cfg-inline-actions">
                    <button
                      type="button"
                      className="header-btn danger"
                      onClick={() => update((rows) => { rows.splice(index, 1); })}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <div className="cfg-inline-actions">
                <button
                  type="button"
                  className="header-btn"
                  onClick={() => update((rows) => { rows.push({ from: "", to: "" }); })}
                >
                  Add Rename
                </button>
              </div>
            </div>
            <TextField
              label="Input Key (optional)"
              value={toStringValue(config.inputKey)}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
            />
          </>
        );
      }
      case "edit_fields_node": {
        const operations = Array.isArray(config.operations)
          ? config.operations.map((entry) => asRecord(entry))
          : [];
        const update = (mutator: (rows: Record<string, unknown>[]) => void) => {
          setConfig((current) => {
            const rows = Array.isArray(current.operations)
              ? current.operations.map((item) => asRecord(item))
              : [];
            mutator(rows);
            return { ...current, operations: rows };
          });
        };
        return (
          <>
            <div className="cfg-group">
              <h4>Operations</h4>
              {operations.map((row, index) => {
                const op = toStringValue(row.op, "set");
                return (
                  <div key={`edit-${index}`} className="cfg-assignment-row">
                    <div className="cfg-grid-2">
                      <SelectField
                        label="Operation"
                        value={op}
                        onChange={(next) => update((rows) => { rows[index] = { ...rows[index], op: next }; })}
                        options={[
                          { value: "set", label: "Set" },
                          { value: "remove", label: "Remove" },
                          { value: "rename", label: "Rename" }
                        ]}
                      />
                      <TextField
                        label="Field"
                        value={toStringValue(row.field)}
                        onChange={(next) => update((rows) => { rows[index] = { ...rows[index], field: next }; })}
                      />
                    </div>
                    {op === "set" && (
                      <TextField
                        label="Value"
                        value={toStringValue(row.value)}
                        onChange={(next) => update((rows) => { rows[index] = { ...rows[index], value: next }; })}
                      />
                    )}
                    {op === "rename" && (
                      <TextField
                        label="New Name"
                        value={toStringValue(row.newName)}
                        onChange={(next) => update((rows) => { rows[index] = { ...rows[index], newName: next }; })}
                      />
                    )}
                    <div className="cfg-inline-actions">
                      <button
                        type="button"
                        className="header-btn danger"
                        onClick={() => update((rows) => { rows.splice(index, 1); })}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="cfg-inline-actions">
                <button
                  type="button"
                  className="header-btn"
                  onClick={() => update((rows) => { rows.push({ op: "set", field: "", value: "" }); })}
                >
                  Add Operation
                </button>
              </div>
            </div>
            <TextField
              label="Input Key (optional)"
              value={toStringValue(config.inputKey)}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
            />
          </>
        );
      }
      case "date_time_node": {
        const operation = toStringValue(config.operation, "format");
        return (
          <>
            <SelectField
              label="Operation"
              value={operation}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "format", label: "Format" },
                { value: "parse", label: "Parse" },
                { value: "add", label: "Add" },
                { value: "subtract", label: "Subtract" },
                { value: "compare", label: "Compare" },
                { value: "now", label: "Now" }
              ]}
            />
            {operation !== "now" && (
              <TextField
                label="Value"
                value={toStringValue(config.value)}
                onChange={(next) => setConfig((current) => ({ ...current, value: next }))}
                placeholder="{{now}}"
              />
            )}
            {(operation === "format" || operation === "parse") && (
              <TextField
                label="Format"
                value={toStringValue(config.format, "iso")}
                onChange={(next) => setConfig((current) => ({ ...current, format: next }))}
                placeholder="iso"
              />
            )}
            {(operation === "add" || operation === "subtract") && (
              <>
                <SelectField
                  label="Unit"
                  value={toStringValue(config.unit, "second")}
                  onChange={(next) => setConfig((current) => ({ ...current, unit: next }))}
                  options={[
                    { value: "ms", label: "Milliseconds" },
                    { value: "second", label: "Seconds" },
                    { value: "minute", label: "Minutes" },
                    { value: "hour", label: "Hours" },
                    { value: "day", label: "Days" },
                    { value: "week", label: "Weeks" },
                    { value: "month", label: "Months" },
                    { value: "year", label: "Years" }
                  ]}
                />
                <NumberField
                  label="Amount"
                  value={toNumberValue(config.amount, 1)}
                  step={1}
                  onChange={(next) => setConfig((current) => ({ ...current, amount: next }))}
                />
              </>
            )}
            {operation === "compare" && (
              <TextField
                label="Compare To"
                value={toStringValue(config.compareTo)}
                onChange={(next) => setConfig((current) => ({ ...current, compareTo: next }))}
              />
            )}
          </>
        );
      }
      case "crypto_node":
        return (
          <>
            <SelectField
              label="Operation"
              value={toStringValue(config.operation, "hash")}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "hash", label: "Hash" },
                { value: "hmac", label: "HMAC" },
                { value: "encrypt", label: "Encrypt" },
                { value: "decrypt", label: "Decrypt" },
                { value: "sign", label: "Sign" },
                { value: "verify", label: "Verify" },
                { value: "random", label: "Random Bytes" }
              ]}
            />
            <TextField
              label="Algorithm"
              value={toStringValue(config.algorithm, "sha256")}
              onChange={(next) => setConfig((current) => ({ ...current, algorithm: next }))}
              placeholder="sha256"
            />
            <label className="cfg-field">
              <span>Key (secret)</span>
              <input
                type="password"
                value={toStringValue(config.key)}
                onChange={(event) => setConfig((current) => ({ ...current, key: event.target.value }))}
              />
            </label>
            <TextAreaField
              label="Data"
              value={toStringValue(config.data)}
              onChange={(next) => setConfig((current) => ({ ...current, data: next }))}
              rows={4}
            />
            <SelectField
              label="Encoding"
              value={toStringValue(config.encoding, "hex")}
              onChange={(next) => setConfig((current) => ({ ...current, encoding: next }))}
              options={[
                { value: "hex", label: "Hex" },
                { value: "base64", label: "Base64" },
                { value: "utf8", label: "UTF-8" }
              ]}
            />
          </>
        );
      case "jwt_node": {
        const operation = toStringValue(config.operation, "sign");
        return (
          <>
            <SelectField
              label="Operation"
              value={operation}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "sign", label: "Sign" },
                { value: "decode", label: "Decode" },
                { value: "verify", label: "Verify" }
              ]}
            />
            <SelectField
              label="Algorithm"
              value={toStringValue(config.algorithm, "HS256")}
              onChange={(next) => setConfig((current) => ({ ...current, algorithm: next }))}
              options={[
                { value: "HS256", label: "HS256" },
                { value: "HS384", label: "HS384" },
                { value: "HS512", label: "HS512" }
              ]}
            />
            {operation !== "decode" && (
              <label className="cfg-field">
                <span>Secret</span>
                <input
                  type="password"
                  value={toStringValue(config.secret)}
                  onChange={(event) => setConfig((current) => ({ ...current, secret: event.target.value }))}
                />
              </label>
            )}
            {operation === "sign" && (
              <TextAreaField
                label="Payload (JSON)"
                value={JSON.stringify(asRecord(config.payload), null, 2)}
                onChange={(next) => {
                  try {
                    const parsed = JSON.parse(next);
                    setConfig((current) => ({ ...current, payload: parsed }));
                  } catch {
                    // ignore
                  }
                }}
                rows={6}
              />
            )}
            {(operation === "decode" || operation === "verify") && (
              <TextField
                label="Token"
                value={toStringValue(config.token)}
                onChange={(next) => setConfig((current) => ({ ...current, token: next }))}
              />
            )}
          </>
        );
      }
      case "xml_node":
        return (
          <>
            <SelectField
              label="Operation"
              value={toStringValue(config.operation, "toJson")}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "toJson", label: "XML to JSON" },
                { value: "toXml", label: "JSON to XML" }
              ]}
            />
            <TextAreaField
              label="Data"
              value={toStringValue(config.data)}
              onChange={(next) => setConfig((current) => ({ ...current, data: next }))}
              rows={6}
            />
          </>
        );
      case "html_node": {
        const operation = toStringValue(config.operation, "extract");
        const selectors = Array.isArray(config.selectors)
          ? config.selectors.map((entry) => asRecord(entry))
          : [];
        const update = (mutator: (rows: Record<string, unknown>[]) => void) => {
          setConfig((current) => {
            const rows = Array.isArray(current.selectors)
              ? current.selectors.map((item) => asRecord(item))
              : [];
            mutator(rows);
            return { ...current, selectors: rows };
          });
        };
        return (
          <>
            <SelectField
              label="Operation"
              value={operation}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "extract", label: "Extract" },
                { value: "generate", label: "Generate" }
              ]}
            />
            <TextAreaField
              label="HTML"
              value={toStringValue(config.html)}
              onChange={(next) => setConfig((current) => ({ ...current, html: next }))}
              rows={6}
            />
            {operation === "extract" && (
              <div className="cfg-group">
                <h4>Selectors</h4>
                {selectors.map((row, index) => (
                  <div key={`sel-${index}`} className="cfg-assignment-row">
                    <div className="cfg-grid-2">
                      <TextField
                        label="Key"
                        value={toStringValue(row.key)}
                        onChange={(next) => update((rows) => { rows[index] = { ...rows[index], key: next }; })}
                      />
                      <TextField
                        label="Selector"
                        value={toStringValue(row.selector)}
                        onChange={(next) => update((rows) => { rows[index] = { ...rows[index], selector: next }; })}
                      />
                    </div>
                    <div className="cfg-inline-actions">
                      <button
                        type="button"
                        className="header-btn danger"
                        onClick={() => update((rows) => { rows.splice(index, 1); })}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                <div className="cfg-inline-actions">
                  <button
                    type="button"
                    className="header-btn"
                    onClick={() => update((rows) => { rows.push({ key: "", selector: "" }); })}
                  >
                    Add Selector
                  </button>
                </div>
              </div>
            )}
          </>
        );
      }
      case "convert_to_file_node":
        return (
          <>
            <SelectField
              label="Format"
              value={toStringValue(config.format, "json")}
              onChange={(next) => setConfig((current) => ({ ...current, format: next }))}
              options={[
                { value: "csv", label: "CSV" },
                { value: "json", label: "JSON" },
                { value: "html", label: "HTML" },
                { value: "text", label: "Text" }
              ]}
            />
            <TextField
              label="Filename"
              value={toStringValue(config.filename, "out.json")}
              onChange={(next) => setConfig((current) => ({ ...current, filename: next }))}
            />
            <TextField
              label="Input Key (optional)"
              value={toStringValue(config.inputKey)}
              onChange={(next) => setConfig((current) => ({ ...current, inputKey: next }))}
            />
          </>
        );
      case "extract_from_file_node": {
        const format = toStringValue(config.format, "csv");
        return (
          <>
            <SelectField
              label="Format"
              value={format}
              onChange={(next) => setConfig((current) => ({ ...current, format: next }))}
              options={[
                { value: "csv", label: "CSV" },
                { value: "json", label: "JSON" },
                { value: "xml", label: "XML" },
                { value: "pdf", label: "PDF" },
                { value: "excel", label: "Excel" }
              ]}
            />
            <TextAreaField
              label="Data"
              value={toStringValue(config.data)}
              onChange={(next) => setConfig((current) => ({ ...current, data: next }))}
              rows={6}
            />
            {(format === "pdf" || format === "excel") && (
              <div className="cfg-tip">
                Note: <strong>{format.toUpperCase()}</strong> extraction is not yet implemented in the core executor.
              </div>
            )}
          </>
        );
      }
      case "compression_node": {
        const operation = toStringValue(config.operation, "gzip");
        return (
          <>
            <SelectField
              label="Operation"
              value={operation}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "gzip", label: "Gzip" },
                { value: "gunzip", label: "Gunzip" },
                { value: "zip", label: "Zip" },
                { value: "unzip", label: "Unzip" }
              ]}
            />
            <TextAreaField
              label="Data"
              value={toStringValue(config.data)}
              onChange={(next) => setConfig((current) => ({ ...current, data: next }))}
              rows={5}
            />
            {(operation === "zip" || operation === "unzip") && (
              <div className="cfg-tip">
                Note: <strong>zip/unzip</strong> are not yet supported. Use gzip/gunzip for now.
              </div>
            )}
          </>
        );
      }
      case "edit_image_node":
        return (
          <div className="cfg-tip">
            Image editing requires optional native dependencies and currently returns
            <code> NOT_IMPLEMENTED</code>. This editor is a placeholder until image support lands.
          </div>
        );
      case "slack_send_message": {
        const authType = toStringValue(config.authType, "webhook");
        return (
          <>
            <SelectField
              label="Auth Type"
              value={authType}
              onChange={(next) => setConfig((current) => ({ ...current, authType: next }))}
              options={[
                { value: "webhook", label: "Incoming Webhook" },
                { value: "bot", label: "Bot Token" }
              ]}
            />
            {authType === "webhook" ? (
              <TextField
                label="Webhook URL"
                value={toStringValue(config.webhookUrl)}
                onChange={(next) => setConfig((current) => ({ ...current, webhookUrl: next }))}
                placeholder="https://hooks.slack.com/services/..."
              />
            ) : (
              renderCredentialSecretField({
                fieldKey: "slack_bot_token",
                label: "Slack Bot Token Secret",
                value: toStringValue(asRecord(config.secretRef).secretId),
                noneLabel: "Select token",
                preferredProvider: "slack",
                onSelect: (next) =>
                  setConfig((current) => ({
                    ...current,
                    secretRef: next ? { secretId: next } : undefined
                  }))
              })
            )}
            <TextField
              label="Channel"
              value={toStringValue(config.channel)}
              onChange={(next) => setConfig((current) => ({ ...current, channel: next }))}
              placeholder="#general"
            />
            <TextAreaField
              label="Text"
              value={toStringValue(config.text)}
              onChange={(next) => setConfig((current) => ({ ...current, text: next }))}
              rows={3}
            />
            <TextAreaField
              label="Blocks (JSON, optional)"
              value={toStringValue(config.blocks)}
              onChange={(next) => setConfig((current) => ({ ...current, blocks: next }))}
              rows={4}
            />
            <TextField
              label="Thread TS (optional)"
              value={toStringValue(config.threadTs)}
              onChange={(next) => setConfig((current) => ({ ...current, threadTs: next }))}
            />
          </>
        );
      }
      case "slack_trigger":
        return (
          <>
            <TextField
              label="Path (informational)"
              value={toStringValue(config.path, "slack-events")}
              onChange={(next) => setConfig((current) => ({ ...current, path: next }))}
            />
            {renderCredentialSecretField({
              fieldKey: "slack_signing_secret",
              label: "Slack Signing Secret",
              value: toStringValue(asRecord(config.signingSecretRef).secretId),
              noneLabel: "Select secret",
              preferredProvider: "slack",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  signingSecretRef: next ? { secretId: next } : undefined
                }))
            })}
            <NumberField
              label="Replay Tolerance (seconds)"
              value={toNumberValue(config.replayToleranceSeconds, 300)}
              min={30}
              step={30}
              onChange={(next) => setConfig((current) => ({ ...current, replayToleranceSeconds: next }))}
            />
            <div className="cfg-tip">
              Point Slack Events at <code>/api/webhooks/slack/&lt;workflowId&gt;</code>. The signing secret is used to validate <code>X-Slack-Signature</code>.
            </div>
          </>
        );
      case "smtp_send_email":
        return (
          <>
            <div className="cfg-grid-2">
              <TextField
                label="Host"
                value={toStringValue(config.host)}
                onChange={(next) => setConfig((current) => ({ ...current, host: next }))}
                placeholder="smtp.example.com"
              />
              <NumberField
                label="Port"
                value={toNumberValue(config.port, 587)}
                min={1}
                max={65535}
                onChange={(next) => setConfig((current) => ({ ...current, port: next }))}
              />
            </div>
            <ToggleField
              label="Secure (TLS)"
              checked={toBooleanValue(config.secure, false)}
              onChange={(next) => setConfig((current) => ({ ...current, secure: next }))}
            />
            <TextField
              label="User"
              value={toStringValue(config.user)}
              onChange={(next) => setConfig((current) => ({ ...current, user: next }))}
            />
            {renderCredentialSecretField({
              fieldKey: "smtp_password",
              label: "SMTP Password",
              value: toStringValue(asRecord(config.secretRef).secretId),
              noneLabel: "Select secret",
              preferredProvider: "smtp",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
            <TextField
              label="From"
              value={toStringValue(config.from)}
              onChange={(next) => setConfig((current) => ({ ...current, from: next }))}
            />
            <TextField
              label="To"
              value={toStringValue(config.to)}
              onChange={(next) => setConfig((current) => ({ ...current, to: next }))}
            />
            <TextField
              label="Subject"
              value={toStringValue(config.subject)}
              onChange={(next) => setConfig((current) => ({ ...current, subject: next }))}
            />
            <TextAreaField
              label="Text Body"
              value={toStringValue(config.text)}
              onChange={(next) => setConfig((current) => ({ ...current, text: next }))}
              rows={4}
            />
            <TextAreaField
              label="HTML Body (optional)"
              value={toStringValue(config.html)}
              onChange={(next) => setConfig((current) => ({ ...current, html: next }))}
              rows={4}
            />
          </>
        );
      case "imap_email_trigger":
        return (
          <>
            <div className="cfg-grid-2">
              <TextField
                label="Host"
                value={toStringValue(config.host)}
                onChange={(next) => setConfig((current) => ({ ...current, host: next }))}
              />
              <NumberField
                label="Port"
                value={toNumberValue(config.port, 993)}
                min={1}
                max={65535}
                onChange={(next) => setConfig((current) => ({ ...current, port: next }))}
              />
            </div>
            <ToggleField
              label="Secure (TLS)"
              checked={toBooleanValue(config.secure, true)}
              onChange={(next) => setConfig((current) => ({ ...current, secure: next }))}
            />
            <TextField
              label="User"
              value={toStringValue(config.user)}
              onChange={(next) => setConfig((current) => ({ ...current, user: next }))}
            />
            {renderCredentialSecretField({
              fieldKey: "imap_password",
              label: "IMAP Password",
              value: toStringValue(asRecord(config.secretRef).secretId),
              noneLabel: "Select secret",
              preferredProvider: "imap",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
            <TextField
              label="Mailbox"
              value={toStringValue(config.mailbox, "INBOX")}
              onChange={(next) => setConfig((current) => ({ ...current, mailbox: next }))}
            />
            <NumberField
              label="Poll Interval (seconds)"
              value={toNumberValue(config.pollIntervalSeconds, 60)}
              min={5}
              step={5}
              onChange={(next) => setConfig((current) => ({ ...current, pollIntervalSeconds: next }))}
            />
            <div className="cfg-tip">
              IMAP polling requires <code>imapflow</code>. When not installed this trigger emits a <code>NOT_IMPLEMENTED</code> error.
            </div>
          </>
        );
      case "google_sheets_read":
      case "google_sheets_append":
      case "google_sheets_update":
      case "google_sheets_trigger":
        return (
          <>
            <TextField
              label="Spreadsheet ID"
              value={toStringValue(config.spreadsheetId)}
              onChange={(next) => setConfig((current) => ({ ...current, spreadsheetId: next }))}
            />
            <TextField
              label="Range (A1 notation)"
              value={toStringValue(config.range)}
              onChange={(next) => setConfig((current) => ({ ...current, range: next }))}
              placeholder="Sheet1!A1:D100"
            />
            <SelectField
              label="Auth Type"
              value={toStringValue(config.authType, "accessToken")}
              onChange={(next) => setConfig((current) => ({ ...current, authType: next }))}
              options={[
                { value: "accessToken", label: "OAuth2 Access Token" },
                { value: "apiKey", label: "API Key (public sheets)" }
              ]}
            />
            {renderCredentialSecretField({
              fieldKey: "gsheets_secret",
              label: "Token / API Key Secret",
              value: toStringValue(asRecord(config.secretRef).secretId),
              noneLabel: "Select secret",
              preferredProvider: "google",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
            {(node.data.nodeType === "google_sheets_append" || node.data.nodeType === "google_sheets_update") && (
              <>
                <SelectField
                  label="Value Input Option"
                  value={toStringValue(config.valueInputOption, "USER_ENTERED")}
                  onChange={(next) => setConfig((current) => ({ ...current, valueInputOption: next }))}
                  options={[
                    { value: "USER_ENTERED", label: "USER_ENTERED" },
                    { value: "RAW", label: "RAW" }
                  ]}
                />
                <TextAreaField
                  label="Values (JSON 2D array)"
                  value={
                    typeof config.values === "string"
                      ? (config.values as string)
                      : JSON.stringify(config.values ?? [], null, 2)
                  }
                  onChange={(next) => {
                    try {
                      const parsed = JSON.parse(next);
                      setConfig((current) => ({ ...current, values: parsed }));
                    } catch {
                      setConfig((current) => ({ ...current, values: next }));
                    }
                  }}
                  rows={4}
                />
              </>
            )}
          </>
        );
      case "postgres_query":
      case "postgres_trigger":
      case "mysql_query":
        return (
          <>
            <div className="cfg-grid-2">
              <TextField
                label="Host"
                value={toStringValue(config.host)}
                onChange={(next) => setConfig((current) => ({ ...current, host: next }))}
              />
              <NumberField
                label="Port"
                value={toNumberValue(
                  config.port,
                  node.data.nodeType === "mysql_query" ? 3306 : 5432
                )}
                min={1}
                max={65535}
                onChange={(next) => setConfig((current) => ({ ...current, port: next }))}
              />
            </div>
            <TextField
              label="Database"
              value={toStringValue(config.database)}
              onChange={(next) => setConfig((current) => ({ ...current, database: next }))}
            />
            <TextField
              label="User"
              value={toStringValue(config.user)}
              onChange={(next) => setConfig((current) => ({ ...current, user: next }))}
            />
            {renderCredentialSecretField({
              fieldKey: "db_password",
              label: "Password Secret",
              value: toStringValue(asRecord(config.secretRef).secretId),
              noneLabel: "Select secret",
              preferredProvider: "database",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
            <ToggleField
              label="SSL"
              checked={toBooleanValue(config.ssl, false)}
              onChange={(next) => setConfig((current) => ({ ...current, ssl: next }))}
            />
            <TextAreaField
              label="SQL Query"
              value={toStringValue(config.query)}
              onChange={(next) => setConfig((current) => ({ ...current, query: next }))}
              rows={5}
            />
            <TextAreaField
              label="Params (JSON array)"
              value={
                typeof config.params === "string"
                  ? (config.params as string)
                  : JSON.stringify(config.params ?? [], null, 2)
              }
              onChange={(next) => {
                try {
                  const parsed = JSON.parse(next);
                  setConfig((current) => ({ ...current, params: parsed }));
                } catch {
                  setConfig((current) => ({ ...current, params: next }));
                }
              }}
              rows={2}
            />
            {node.data.nodeType === "postgres_trigger" && (
              <NumberField
                label="Poll Interval (seconds)"
                value={toNumberValue(config.pollIntervalSeconds, 60)}
                min={5}
                step={5}
                onChange={(next) => setConfig((current) => ({ ...current, pollIntervalSeconds: next }))}
              />
            )}
          </>
        );
      case "mongo_operation":
        return (
          <>
            <TextField
              label="Connection URI"
              value={toStringValue(config.uri)}
              onChange={(next) => setConfig((current) => ({ ...current, uri: next }))}
              placeholder="mongodb://localhost:27017"
            />
            {renderCredentialSecretField({
              fieldKey: "mongo_uri",
              label: "Connection String Secret (optional override)",
              value: toStringValue(asRecord(config.secretRef).secretId),
              noneLabel: "Use URI above",
              preferredProvider: "mongodb",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
            <div className="cfg-grid-2">
              <TextField
                label="Database"
                value={toStringValue(config.database)}
                onChange={(next) => setConfig((current) => ({ ...current, database: next }))}
              />
              <TextField
                label="Collection"
                value={toStringValue(config.collection)}
                onChange={(next) => setConfig((current) => ({ ...current, collection: next }))}
              />
            </div>
            <SelectField
              label="Operation"
              value={toStringValue(config.operation, "find")}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "find", label: "find" },
                { value: "insert", label: "insert" },
                { value: "update", label: "update" },
                { value: "aggregate", label: "aggregate" }
              ]}
            />
            <TextAreaField
              label="Query / Filter (JSON)"
              value={
                typeof config.query === "string"
                  ? (config.query as string)
                  : JSON.stringify(config.query ?? {}, null, 2)
              }
              onChange={(next) => {
                try {
                  const parsed = JSON.parse(next);
                  setConfig((current) => ({ ...current, query: parsed }));
                } catch {
                  setConfig((current) => ({ ...current, query: next }));
                }
              }}
              rows={4}
            />
            <TextAreaField
              label="Document / Update / Pipeline (JSON)"
              value={JSON.stringify(
                config.document ?? config.update ?? config.pipeline ?? {},
                null,
                2
              )}
              onChange={(next) => {
                try {
                  const parsed = JSON.parse(next);
                  const op = toStringValue(config.operation, "find");
                  if (op === "insert") {
                    setConfig((current) => ({ ...current, document: parsed }));
                  } else if (op === "update") {
                    setConfig((current) => ({ ...current, update: parsed }));
                  } else if (op === "aggregate") {
                    setConfig((current) => ({ ...current, pipeline: parsed }));
                  }
                } catch {
                  /* keep typing */
                }
              }}
              rows={4}
            />
          </>
        );
      case "redis_command":
        return (
          <>
            <TextField
              label="Redis URL"
              value={toStringValue(config.url, "redis://localhost:6379")}
              onChange={(next) => setConfig((current) => ({ ...current, url: next }))}
            />
            <SelectField
              label="Command"
              value={toStringValue(config.command, "GET")}
              onChange={(next) => setConfig((current) => ({ ...current, command: next }))}
              options={[
                { value: "GET", label: "GET" },
                { value: "SET", label: "SET" },
                { value: "DEL", label: "DEL" },
                { value: "PUBLISH", label: "PUBLISH" },
                { value: "LPUSH", label: "LPUSH" },
                { value: "RPUSH", label: "RPUSH" },
                { value: "HSET", label: "HSET" },
                { value: "HGET", label: "HGET" },
                { value: "EXPIRE", label: "EXPIRE" },
                { value: "INCR", label: "INCR" },
                { value: "DECR", label: "DECR" }
              ]}
            />
            <TextAreaField
              label="Arguments (JSON array)"
              value={
                typeof config.args === "string"
                  ? (config.args as string)
                  : JSON.stringify(config.args ?? [], null, 2)
              }
              onChange={(next) => {
                try {
                  const parsed = JSON.parse(next);
                  setConfig((current) => ({ ...current, args: parsed }));
                } catch {
                  setConfig((current) => ({ ...current, args: next }));
                }
              }}
              rows={3}
            />
          </>
        );
      case "redis_trigger":
        return (
          <>
            <TextField
              label="Redis URL"
              value={toStringValue(config.url, "redis://localhost:6379")}
              onChange={(next) => setConfig((current) => ({ ...current, url: next }))}
            />
            <SelectField
              label="Mode"
              value={toStringValue(config.mode, "subscribe")}
              onChange={(next) => setConfig((current) => ({ ...current, mode: next }))}
              options={[
                { value: "subscribe", label: "Subscribe (pub/sub)" },
                { value: "blpop", label: "Blocking List Pop (BLPOP)" }
              ]}
            />
            {toStringValue(config.mode, "subscribe") === "subscribe" ? (
              <TextField
                label="Channel"
                value={toStringValue(config.channel)}
                onChange={(next) => setConfig((current) => ({ ...current, channel: next }))}
              />
            ) : (
              <>
                <TextField
                  label="List Key"
                  value={toStringValue(config.key)}
                  onChange={(next) => setConfig((current) => ({ ...current, key: next }))}
                />
                <NumberField
                  label="Timeout (seconds)"
                  value={toNumberValue(config.timeoutSeconds, 5)}
                  min={0}
                  onChange={(next) => setConfig((current) => ({ ...current, timeoutSeconds: next }))}
                />
              </>
            )}
          </>
        );
      case "github_action":
        return (
          <>
            {renderCredentialSecretField({
              fieldKey: "github_pat",
              label: "GitHub Personal Access Token",
              value: toStringValue(asRecord(config.secretRef).secretId),
              noneLabel: "Select secret",
              preferredProvider: "github",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
            <div className="cfg-grid-2">
              <TextField
                label="Owner"
                value={toStringValue(config.owner)}
                onChange={(next) => setConfig((current) => ({ ...current, owner: next }))}
              />
              <TextField
                label="Repo"
                value={toStringValue(config.repo)}
                onChange={(next) => setConfig((current) => ({ ...current, repo: next }))}
              />
            </div>
            <SelectField
              label="Operation"
              value={toStringValue(config.operation, "listIssues")}
              onChange={(next) => setConfig((current) => ({ ...current, operation: next }))}
              options={[
                { value: "createIssue", label: "createIssue" },
                { value: "commentIssue", label: "commentIssue" },
                { value: "closeIssue", label: "closeIssue" },
                { value: "createPr", label: "createPr" },
                { value: "listIssues", label: "listIssues" },
                { value: "getFile", label: "getFile" },
                { value: "createOrUpdateFile", label: "createOrUpdateFile" },
                { value: "listCommits", label: "listCommits" }
              ]}
            />
            <TextField
              label="Title (optional)"
              value={toStringValue(config.title)}
              onChange={(next) => setConfig((current) => ({ ...current, title: next }))}
            />
            <TextAreaField
              label="Body / Content (optional)"
              value={toStringValue(config.body)}
              onChange={(next) => setConfig((current) => ({ ...current, body: next }))}
              rows={4}
            />
            <div className="cfg-grid-2">
              <NumberField
                label="Issue Number"
                value={toNumberValue(config.issueNumber, 0)}
                min={0}
                onChange={(next) => setConfig((current) => ({ ...current, issueNumber: next }))}
              />
              <TextField
                label="Base Branch"
                value={toStringValue(config.base, "main")}
                onChange={(next) => setConfig((current) => ({ ...current, base: next }))}
              />
            </div>
            <TextField
              label="Head Branch (for PRs)"
              value={toStringValue(config.head)}
              onChange={(next) => setConfig((current) => ({ ...current, head: next }))}
            />
            <TextField
              label="Path (for file operations)"
              value={toStringValue(config.path)}
              onChange={(next) => setConfig((current) => ({ ...current, path: next }))}
            />
            <TextField
              label="Commit Message"
              value={toStringValue(config.commitMessage)}
              onChange={(next) => setConfig((current) => ({ ...current, commitMessage: next }))}
            />
            <TextAreaField
              label="File Content"
              value={toStringValue(config.content)}
              onChange={(next) => setConfig((current) => ({ ...current, content: next }))}
              rows={4}
            />
            <div className="cfg-grid-2">
              <TextField
                label="File SHA (update)"
                value={toStringValue(config.sha)}
                onChange={(next) => setConfig((current) => ({ ...current, sha: next }))}
              />
              <TextField
                label="Branch"
                value={toStringValue(config.branch)}
                onChange={(next) => setConfig((current) => ({ ...current, branch: next }))}
              />
            </div>
          </>
        );
      case "github_webhook_trigger":
        return (
          <>
            <TextField
              label="Path (informational)"
              value={toStringValue(config.path, "github-events")}
              onChange={(next) => setConfig((current) => ({ ...current, path: next }))}
            />
            {renderCredentialSecretField({
              fieldKey: "github_webhook_secret",
              label: "GitHub Webhook Secret",
              value: toStringValue(asRecord(config.secretRef).secretId),
              noneLabel: "Select secret",
              preferredProvider: "github",
              onSelect: (next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
            })}
            <div className="cfg-tip">
              Point your GitHub webhook to <code>/api/webhooks/github/&lt;workflowId&gt;</code>. The secret is used to verify
              <code> X-Hub-Signature-256</code>.
            </div>
          </>
        );
      case "manual_trigger":
        return (
          <>
            <TextField
              label="Label"
              value={toStringValue(config.label, "Run manually")}
              onChange={(next) => setConfig((current) => ({ ...current, label: next }))}
            />
            <TextAreaField
              label="Test Data (JSON)"
              value={toStringValue(
                typeof config.testData === "string"
                  ? config.testData
                  : JSON.stringify(config.testData ?? {}, null, 2)
              )}
              onChange={(next) => {
                let parsed: unknown = next;
                try {
                  parsed = JSON.parse(next);
                } catch {
                  /* store as string until valid */
                }
                setConfig((current) => ({ ...current, testData: parsed }));
              }}
              rows={4}
            />
            <div className="cfg-tip">
              Trigger from the editor or POST to <code>/api/triggers/manual/&lt;workflowId&gt;</code> (builder role).
            </div>
          </>
        );
      case "form_trigger":
        return (
          <>
            <TextField
              label="Form Path"
              value={toStringValue(config.path, "feedback")}
              onChange={(next) => setConfig((current) => ({ ...current, path: next }))}
              placeholder="feedback"
            />
            <TextField
              label="Title"
              value={toStringValue(config.title, "Submit")}
              onChange={(next) => setConfig((current) => ({ ...current, title: next }))}
            />
            <TextAreaField
              label="Description"
              value={toStringValue(config.description)}
              onChange={(next) => setConfig((current) => ({ ...current, description: next }))}
              rows={2}
            />
            <TextField
              label="Submit Label"
              value={toStringValue(config.submitLabel, "Submit")}
              onChange={(next) => setConfig((current) => ({ ...current, submitLabel: next }))}
            />
            <SelectField
              label="Auth Mode"
              value={toStringValue(config.authMode, "public")}
              onChange={(next) => setConfig((current) => ({ ...current, authMode: next }))}
              options={[
                { value: "public", label: "Public (no auth)" },
                { value: "session", label: "Session (logged-in user)" }
              ]}
            />
            <TextAreaField
              label="Success Message"
              value={toStringValue(config.successMessage)}
              onChange={(next) => setConfig((current) => ({ ...current, successMessage: next }))}
              rows={2}
            />
            <TextAreaField
              label="Fields (JSON array)"
              value={toStringValue(
                typeof config.fields === "string"
                  ? config.fields
                  : JSON.stringify(config.fields ?? [], null, 2)
              )}
              onChange={(next) => {
                let parsed: unknown = next;
                try {
                  parsed = JSON.parse(next);
                } catch {
                  /* keep string */
                }
                setConfig((current) => ({ ...current, fields: parsed }));
              }}
              rows={8}
            />
            <div className="cfg-tip">
              Form is served at <code>/api/forms/&lt;path&gt;</code>. POST submissions trigger the workflow with fields as input.
            </div>
          </>
        );
      case "chat_trigger":
        return (
          <>
            <TextField
              label="Path (informational)"
              value={toStringValue(config.path, "chat")}
              onChange={(next) => setConfig((current) => ({ ...current, path: next }))}
            />
            <SelectField
              label="Auth Mode"
              value={toStringValue(config.authMode, "public")}
              onChange={(next) => setConfig((current) => ({ ...current, authMode: next }))}
              options={[
                { value: "public", label: "Public" },
                { value: "session", label: "Session (logged-in user)" },
                { value: "bearer", label: "Bearer token" }
              ]}
            />
            {toStringValue(config.authMode, "public") === "bearer" &&
              renderCredentialSecretField({
                fieldKey: "chat_bearer",
                label: "Bearer Token Secret",
                value: toStringValue(asRecord(config.secretRef).secretId),
                noneLabel: "Select secret",
                preferredProvider: "chat",
                onSelect: (next) =>
                  setConfig((current) => ({
                    ...current,
                    secretRef: next ? { secretId: next } : undefined
                  }))
              })}
            <TextField
              label="Session Namespace"
              value={toStringValue(config.sessionNamespace, "chat")}
              onChange={(next) => setConfig((current) => ({ ...current, sessionNamespace: next }))}
            />
            <ToggleField
              label="Persist messages to session memory"
              checked={toBooleanValue(config.persistMessages, true)}
              onChange={(next) => setConfig((current) => ({ ...current, persistMessages: next }))}
            />
            <TextAreaField
              label="Welcome Message"
              value={toStringValue(config.welcomeMessage)}
              onChange={(next) => setConfig((current) => ({ ...current, welcomeMessage: next }))}
              rows={2}
            />
            <div className="cfg-tip">
              POST messages to <code>/api/chat/&lt;workflowId&gt;</code> with body <code>{'{ message, session_id }'}</code>.
            </div>
          </>
        );
      case "file_trigger":
        return (
          <>
            <TextField
              label="Watch Path"
              value={toStringValue(config.watchPath)}
              onChange={(next) => setConfig((current) => ({ ...current, watchPath: next }))}
              placeholder="./data/inbox"
            />
            <TextField
              label="Filename Pattern (glob)"
              value={toStringValue(config.pattern)}
              onChange={(next) => setConfig((current) => ({ ...current, pattern: next }))}
              placeholder="*.csv"
            />
            <ToggleField
              label="Recursive"
              checked={toBooleanValue(config.recursive, false)}
              onChange={(next) => setConfig((current) => ({ ...current, recursive: next }))}
            />
            <NumberField
              label="Poll Interval (seconds)"
              value={toNumberValue(config.pollIntervalSeconds, 30)}
              min={1}
              step={1}
              onChange={(next) => setConfig((current) => ({ ...current, pollIntervalSeconds: next }))}
            />
            <ToggleField
              label="Active"
              checked={toBooleanValue(config.active, true)}
              onChange={(next) => setConfig((current) => ({ ...current, active: next }))}
            />
            <div className="cfg-tip">
              Events are polled by the trigger service. First run establishes a baseline and does not fire.
            </div>
          </>
        );
      case "rss_trigger":
        return (
          <>
            <TextField
              label="Feed URL"
              value={toStringValue(config.feedUrl)}
              onChange={(next) => setConfig((current) => ({ ...current, feedUrl: next }))}
              placeholder="https://example.com/feed.xml"
            />
            <NumberField
              label="Poll Interval (seconds)"
              value={toNumberValue(config.pollIntervalSeconds, 300)}
              min={30}
              step={30}
              onChange={(next) => setConfig((current) => ({ ...current, pollIntervalSeconds: next }))}
            />
            <NumberField
              label="Max Items Per Tick"
              value={toNumberValue(config.maxItemsPerTick, 20)}
              min={1}
              onChange={(next) => setConfig((current) => ({ ...current, maxItemsPerTick: next }))}
            />
            <ToggleField
              label="Active"
              checked={toBooleanValue(config.active, true)}
              onChange={(next) => setConfig((current) => ({ ...current, active: next }))}
            />
            <div className="cfg-tip">New items are deduped by GUID (or link/title fallback) against a persisted window of the last 500 seen IDs.</div>
          </>
        );
      case "sse_trigger":
        return (
          <>
            <TextField
              label="SSE URL"
              value={toStringValue(config.url)}
              onChange={(next) => setConfig((current) => ({ ...current, url: next }))}
              placeholder="https://example.com/sse"
            />
            <TextField
              label="Event Name Filter (optional)"
              value={toStringValue(config.eventName)}
              onChange={(next) => setConfig((current) => ({ ...current, eventName: next }))}
            />
            <SelectField
              label="Auth Mode"
              value={toStringValue(config.authMode, "none")}
              onChange={(next) => setConfig((current) => ({ ...current, authMode: next }))}
              options={[
                { value: "none", label: "None" },
                { value: "bearer", label: "Bearer token" }
              ]}
            />
            {toStringValue(config.authMode, "none") === "bearer" &&
              renderCredentialSecretField({
                fieldKey: "sse_bearer",
                label: "Bearer Token Secret",
                value: toStringValue(asRecord(config.secretRef).secretId),
                noneLabel: "Select secret",
                preferredProvider: "sse",
                onSelect: (next) =>
                  setConfig((current) => ({
                    ...current,
                    secretRef: next ? { secretId: next } : undefined
                  }))
              })}
            <NumberField
              label="Reconnect Delay (seconds)"
              value={toNumberValue(config.reconnectDelaySeconds, 5)}
              min={1}
              onChange={(next) => setConfig((current) => ({ ...current, reconnectDelaySeconds: next }))}
            />
            <NumberField
              label="Max Events Per Minute"
              value={toNumberValue(config.maxEventsPerMinute, 120)}
              min={1}
              onChange={(next) => setConfig((current) => ({ ...current, maxEventsPerMinute: next }))}
            />
            <ToggleField
              label="Active"
              checked={toBooleanValue(config.active, true)}
              onChange={(next) => setConfig((current) => ({ ...current, active: next }))}
            />
          </>
        );
      case "mcp_server_trigger":
        return (
          <>
            <TextField
              label="Server Path"
              value={toStringValue(config.path)}
              onChange={(next) => setConfig((current) => ({ ...current, path: next }))}
              placeholder="helper"
            />
            <TextField
              label="Tool Name"
              value={toStringValue(config.toolName)}
              onChange={(next) => setConfig((current) => ({ ...current, toolName: next }))}
              placeholder="query_knowledge_base"
            />
            <TextAreaField
              label="Tool Description"
              value={toStringValue(config.toolDescription)}
              onChange={(next) => setConfig((current) => ({ ...current, toolDescription: next }))}
              rows={2}
            />
            <TextAreaField
              label="Input Schema (JSON)"
              value={toStringValue(
                typeof config.inputSchema === "string"
                  ? config.inputSchema
                  : JSON.stringify(config.inputSchema ?? { type: "object" }, null, 2)
              )}
              onChange={(next) => {
                let parsed: unknown = next;
                try {
                  parsed = JSON.parse(next);
                } catch {
                  /* keep string */
                }
                setConfig((current) => ({ ...current, inputSchema: parsed }));
              }}
              rows={6}
            />
            <SelectField
              label="Auth Mode"
              value={toStringValue(config.authMode, "public")}
              onChange={(next) => setConfig((current) => ({ ...current, authMode: next }))}
              options={[
                { value: "public", label: "Public" },
                { value: "bearer", label: "Bearer token" }
              ]}
            />
            {toStringValue(config.authMode, "public") === "bearer" &&
              renderCredentialSecretField({
                fieldKey: "mcp_server_bearer",
                label: "Bearer Token Secret",
                value: toStringValue(asRecord(config.secretRef).secretId),
                noneLabel: "Select secret",
                preferredProvider: "mcp_server",
                onSelect: (next) =>
                  setConfig((current) => ({
                    ...current,
                    secretRef: next ? { secretId: next } : undefined
                  }))
              })}
            <div className="cfg-tip">
              Invoke at <code>/api/mcp-server/&lt;path&gt;/invoke</code>; manifest at <code>/api/mcp-server/&lt;path&gt;/manifest</code>.
            </div>
          </>
        );
      case "kafka_trigger":
        return (
          <>
            <TextAreaField
              label="Brokers (one per line)"
              value={toStringValue(
                Array.isArray(config.brokers) ? (config.brokers as string[]).join("\n") : ""
              )}
              onChange={(next) =>
                setConfig((current) => ({
                  ...current,
                  brokers: next.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
                }))
              }
              rows={3}
            />
            <TextField
              label="Topic"
              value={toStringValue(config.topic)}
              onChange={(next) => setConfig((current) => ({ ...current, topic: next }))}
            />
            <TextField
              label="Consumer Group ID"
              value={toStringValue(config.groupId)}
              onChange={(next) => setConfig((current) => ({ ...current, groupId: next }))}
            />
            <ToggleField
              label="From Beginning"
              checked={toBooleanValue(config.fromBeginning, false)}
              onChange={(next) => setConfig((current) => ({ ...current, fromBeginning: next }))}
            />
            <ToggleField
              label="Active"
              checked={toBooleanValue(config.active, true)}
              onChange={(next) => setConfig((current) => ({ ...current, active: next }))}
            />
            <div className="cfg-tip">
              Requires optional <code>kafkajs</code> npm package. The long-lived consumer is a stub in this build.
            </div>
          </>
        );
      case "rabbitmq_trigger":
        return (
          <>
            <TextField
              label="AMQP URL"
              value={toStringValue(config.url)}
              onChange={(next) => setConfig((current) => ({ ...current, url: next }))}
              placeholder="amqp://localhost"
            />
            <TextField
              label="Queue"
              value={toStringValue(config.queue)}
              onChange={(next) => setConfig((current) => ({ ...current, queue: next }))}
            />
            <NumberField
              label="Prefetch"
              value={toNumberValue(config.prefetch, 1)}
              min={1}
              onChange={(next) => setConfig((current) => ({ ...current, prefetch: next }))}
            />
            <ToggleField
              label="Active"
              checked={toBooleanValue(config.active, true)}
              onChange={(next) => setConfig((current) => ({ ...current, active: next }))}
            />
            <div className="cfg-tip">
              Requires optional <code>amqplib</code> npm package. The long-lived consumer is a stub in this build.
            </div>
          </>
        );
      case "mqtt_trigger":
        return (
          <>
            <TextField
              label="Broker URL"
              value={toStringValue(config.brokerUrl)}
              onChange={(next) => setConfig((current) => ({ ...current, brokerUrl: next }))}
              placeholder="mqtt://localhost:1883"
            />
            <TextField
              label="Topic"
              value={toStringValue(config.topic)}
              onChange={(next) => setConfig((current) => ({ ...current, topic: next }))}
            />
            <NumberField
              label="QoS"
              value={toNumberValue(config.qos, 1)}
              min={0}
              max={2}
              onChange={(next) => setConfig((current) => ({ ...current, qos: next }))}
            />
            <TextField
              label="Client ID (optional)"
              value={toStringValue(config.clientId)}
              onChange={(next) => setConfig((current) => ({ ...current, clientId: next }))}
            />
            <ToggleField
              label="Active"
              checked={toBooleanValue(config.active, true)}
              onChange={(next) => setConfig((current) => ({ ...current, active: next }))}
            />
            <div className="cfg-tip">
              Requires optional <code>mqtt</code> npm package. The long-lived subscriber is a stub in this build.
            </div>
          </>
        );
      default:
        return (
          <div className="cfg-tip">Structured fields are not defined for this node yet. Add parameters in its dedicated editor in a future update.</div>
        );
    }
  };

  const inputMappingRows = useMemo(() => {
    const raw = asRecord(config.inputMapping);
    return Object.entries(raw)
      .filter(([key]) => key.trim())
      .map(([sourceKey, targetKeyValue], index) => ({
        id: `mapping-${index}`,
        sourceKey,
        targetKey: String(targetKeyValue ?? "")
      }));
  }, [config.inputMapping]);

  const availableUpstreamKeys = useMemo(() => {
    if (resolvedInputPreview === undefined || resolvedInputPreview === null) {
      return [];
    }
    if (typeof resolvedInputPreview === "object" && !Array.isArray(resolvedInputPreview)) {
      return Object.keys(resolvedInputPreview as Record<string, unknown>).filter((key) => key !== "parent_outputs");
    }
    return [];
  }, [resolvedInputPreview]);

  const handleAddInputMapping = useCallback(() => {
    setConfig((current) => {
      const currentMapping = asRecord(current.inputMapping);
      const newKey = `source_key_${Object.keys(currentMapping).length + 1}`;
      return { ...current, inputMapping: { ...currentMapping, [newKey]: "user_prompt" } };
    });
  }, []);

  const handleRemoveInputMapping = useCallback((keyToRemove: string) => {
    setConfig((current) => {
      const currentMapping = { ...asRecord(current.inputMapping) };
      delete currentMapping[keyToRemove];
      return { ...current, inputMapping: Object.keys(currentMapping).length > 0 ? currentMapping : undefined };
    });
  }, []);

  const handleUpdateInputMapping = useCallback(
    (oldSourceKey: string, field: "sourceKey" | "targetKey", value: string) => {
      setConfig((current) => {
        const currentMapping = asRecord(current.inputMapping);
        if (field === "sourceKey") {
          const targetKey = String(currentMapping[oldSourceKey] ?? "");
          const updated = { ...currentMapping };
          delete updated[oldSourceKey];
          updated[value] = targetKey;
          return { ...current, inputMapping: updated };
        }
        return { ...current, inputMapping: { ...currentMapping, [oldSourceKey]: value } };
      });
    },
    []
  );

  const renderSettings = () => {
    const COLOR_OPTIONS: Array<{ key: EditorNodeData["color"]; label: string; swatch: string }> = [
      { key: undefined, label: "None", swatch: "transparent" },
      { key: "gray", label: "Gray", swatch: "#94a3b8" },
      { key: "red", label: "Red", swatch: "#ef4444" },
      { key: "orange", label: "Orange", swatch: "#f97316" },
      { key: "yellow", label: "Yellow", swatch: "#eab308" },
      { key: "green", label: "Green", swatch: "#10b981" },
      { key: "blue", label: "Blue", swatch: "#3b82f6" },
      { key: "purple", label: "Purple", swatch: "#8b5cf6" },
      { key: "pink", label: "Pink", swatch: "#ec4899" }
    ];

    return (
      <>
        <TextField label="Node Label" value={label} onChange={setLabel} />
        <div className="cfg-tip">
          Node ID: <code>{node.id}</code>
        </div>
        <div style={{ marginTop: 14 }}>
          <ToggleField
            label="Disabled (executor skips this node and passes parent outputs through)"
            checked={nodeDisabled}
            onChange={setNodeDisabled}
          />
        </div>
        <div style={{ marginTop: 14 }}>
          <label className="cfg-field">
            <span>Accent color</span>
            <div className="wf-color-swatch-row">
              {COLOR_OPTIONS.map((option) => (
                <button
                  key={option.key ?? "none"}
                  type="button"
                  className={`wf-color-swatch${nodeColor === option.key ? " selected" : ""}`}
                  style={{ background: option.swatch === "transparent" ? undefined : option.swatch }}
                  title={option.label}
                  aria-label={`Set color ${option.label}`}
                  onClick={() => setNodeColor(option.key)}
                >
                  {option.swatch === "transparent" ? "∅" : ""}
                </button>
              ))}
            </div>
          </label>
        </div>
        <div style={{ marginTop: 14 }}>
          <h3>Input Mapping</h3>
          <div className="cfg-tip">
            Map output keys from a previous node to input keys this node expects.
            Example: mapping <code>answer</code> to <code>user_prompt</code> means
            the upstream <code>answer</code> becomes <code>{"{{user_prompt}}"}</code>.
          </div>
          {availableUpstreamKeys.length > 0 && (
            <div className="cfg-tip" style={{ marginTop: 6 }}>
              Available keys from last run:{" "}
              {availableUpstreamKeys.slice(0, 20).map((key, index) => (
                <span key={key}>{index > 0 ? ", " : ""}<code>{key}</code></span>
              ))}
            </div>
          )}
          {inputMappingRows.length === 0 && (
            <div className="cfg-tip" style={{ opacity: 0.7, fontStyle: "italic" }}>
              No mappings configured. Parent node outputs are merged into context as-is.
            </div>
          )}
          {inputMappingRows.map((row) => (
            <div key={row.id} className="cfg-assignment-row">
              <div className="cfg-grid-2">
                {availableUpstreamKeys.length > 0 ? (
                  <SelectField
                    label="Source Key (from upstream)"
                    value={row.sourceKey}
                    onChange={(next) => handleUpdateInputMapping(row.sourceKey, "sourceKey", next)}
                    options={[
                      ...availableUpstreamKeys.map((key) => ({ value: key, label: key })),
                      ...(availableUpstreamKeys.includes(row.sourceKey)
                        ? []
                        : [{ value: row.sourceKey, label: row.sourceKey + " (custom)" }])
                    ]}
                  />
                ) : (
                  <TextField
                    label="Source Key (from upstream)"
                    value={row.sourceKey}
                    onChange={(next) => handleUpdateInputMapping(row.sourceKey, "sourceKey", next)}
                    placeholder="answer"
                  />
                )}
                <TextField
                  label="Maps to"
                  value={row.targetKey}
                  onChange={(next) => handleUpdateInputMapping(row.sourceKey, "targetKey", next)}
                  placeholder="user_prompt"
                />
              </div>
              <div className="cfg-inline-actions">
                <button type="button" className="header-btn danger" onClick={() => handleRemoveInputMapping(row.sourceKey)}>Remove</button>
              </div>
            </div>
          ))}
          <div className="cfg-inline-actions" style={{ marginTop: 6 }}>
            <button type="button" className="header-btn" onClick={handleAddInputMapping}>Add Mapping</button>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
            <h3>Advanced Resiliency</h3>
            <NumberField
               label="Retries on Failure"
               value={toNumberValue(config.retryCount, 0)}
               min={0}
               step={1}
               onChange={(next) => setConfig(current => ({ ...current, retryCount: next }))}
            />
            <NumberField
               label="Delay between Retries (ms)"
               value={toNumberValue(config.retryDelayMs, 1000)}
               min={0}
               step={500}
               onChange={(next) => setConfig(current => ({ ...current, retryDelayMs: next }))}
            />
            <SelectField
              label="On Error Behavior"
              value={toStringValue(config.onError, "stop")}
              onChange={(next) => setConfig((current) => ({ ...current, onError: next }))}
              options={[
                { value: "stop", label: "Stop Execution" },
                { value: "continue", label: "Continue Anyway" },
                { value: "branch", label: "Execute Fallback Branch" }
              ]}
            />
        </div>
      </>
    );
  };

  const getConfigForSave = () => {
    const nextConfig: Record<string, unknown> = { ...config };
    if (node.data.nodeType === "agent_orchestrator") {
      delete nextConfig.provider;
      delete nextConfig.sourceUserPrompt;
    }
    return nextConfig;
  };

  return (
    <div className="node-modal-backdrop" role="dialog" aria-modal="true">
      <div className="node-modal-shell">
        <div className="node-modal-header">
          <div className="node-modal-title">
            <span className="node-modal-icon">{node.data.nodeType === "agent_orchestrator" ? "AG" : "ND"}</span>
            <strong>{label || node.data.label}</strong>
          </div>
          <button type="button" className="node-modal-close" onClick={onClose}>
            x
          </button>
        </div>

        <div className={showRuntimeInspection ? "node-modal-grid" : "node-modal-grid node-modal-grid-single"}>
          {showRuntimeInspection && (
            <section className="node-modal-panel">
              <h3>INPUT</h3>
              <SelectField
                label="Input Source"
                value={selectedInputId}
                onChange={setSelectedInputId}
                options={[
                  { value: NODE_INPUT_OPTION_ID, label: "This node input (last run)" },
                  ...inputOptions.map((option) => ({ value: option.id, label: option.label }))
                ]}
              />
              {resolvedInputPreview === undefined ? (
                <div className="node-modal-placeholder">No input data yet. Execute the workflow to inspect payload.</div>
              ) : (
                <KeyValueTable
                  label={selectedInputId === NODE_INPUT_OPTION_ID ? "Resolved Input" : "Selected Source Output"}
                  value={resolvedInputPreview}
                />
              )}
            </section>
          )}

          <section className={showRuntimeInspection ? "node-modal-panel center" : "node-modal-panel center node-modal-panel-full"}>
            <div className="node-modal-tabs">
              <div>
                <button
                  className={activeTab === "parameters" ? "node-tab active" : "node-tab"}
                  type="button"
                  onClick={() => setActiveTab("parameters")}
                >
                  Parameters
                </button>
                <button
                  className={activeTab === "settings" ? "node-tab active" : "node-tab"}
                  type="button"
                  onClick={() => setActiveTab("settings")}
                >
                  Settings
                </button>
              </div>
              <div className="node-modal-debug-actions">
                {currentNodePinned ? (
                  <button
                    className="node-exec-btn secondary"
                    type="button"
                    onClick={() => void onUnpinNodeOutput?.(node.id)}
                  >
                    Unpin output
                  </button>
                ) : (
                  <button
                    className="node-exec-btn secondary"
                    type="button"
                    onClick={() => void onPinNodeOutput?.(node.id)}
                    disabled={!currentNodeResult || currentNodeResult.output === undefined}
                  >
                    Pin output
                  </button>
                )}
                <button className="node-exec-btn" type="button" onClick={onExecuteStep}>
                  Execute node
                </button>
              </div>
            </div>

            <div className="node-modal-content">{activeTab === "parameters" ? renderParameters() : renderSettings()}</div>

            {node.data.nodeType === "agent_orchestrator" && (
              <div className="node-modal-port-preview">
                <div>Chat Model*</div>
                <div>Memory</div>
                <div>Tool</div>
              </div>
            )}
          </section>

          {showRuntimeInspection && (
            <section className="node-modal-panel">
              <h3>OUTPUT</h3>
              {resolvedOutputPreview !== undefined || currentPinnedOutput !== undefined ? (
                <div className="cfg-group">
                  <div className="cfg-tip">
                    {currentPinnedOutput !== undefined && resolvedOutputPreview === undefined ? (
                      <>
                        Using pinned output. <code>Execute node</code> will reuse this data until unpinned.
                      </>
                    ) : (
                      <>
                        Last run status: <code>{currentNodeResult?.status ?? "unknown"}</code>
                        {currentNodePinned ? " (pinned)" : ""}
                      </>
                    )}
                  </div>
                  <KeyValueTable label="Output" value={resolvedOutputPreview ?? currentPinnedOutput} />
                </div>
              ) : node.data.nodeType === "code_node" && codeTestResult ? (
                <div className="cfg-group">
                  <TextAreaField
                    label="Result"
                    value={JSON.stringify(codeTestResult.result, null, 2)}
                    onChange={() => undefined}
                    rows={8}
                    readOnly
                  />
                  <TextAreaField
                    label="Console Logs"
                    value={codeTestResult.logs.length ? codeTestResult.logs.join("\n") : "No logs"}
                    onChange={() => undefined}
                    rows={6}
                    readOnly
                  />
                </div>
              ) : (
                <div className="node-modal-placeholder">Output appears after executing this step.</div>
              )}
            </section>
          )}
        </div>

        <div className="node-modal-actions">
          <button type="button" className="node-btn subtle" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="node-btn primary"
            onClick={() =>
              onSave({
                label,
                config: getConfigForSave(),
                disabled: nodeDisabled || undefined,
                color: nodeColor
              })
            }
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
