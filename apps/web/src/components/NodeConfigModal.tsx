import { useCallback, useEffect, useMemo, useState } from "react";
import type { MCPToolDefinition, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { EditorNode } from "../lib/workflow";
import { discoverMcpTools, fetchWorkflows, testCodeNode, testConnector, type SecretListItem } from "../lib/api";

export interface NodeInputOption {
  id: string;
  label: string;
}

interface NodeConfigModalProps {
  node: EditorNode;
  inputOptions: NodeInputOption[];
  executionResult: WorkflowExecutionResult | null;
  showRuntimeInspection?: boolean;
  secrets: SecretListItem[];
  mcpServerDefinitions: Array<{ id: string; label: string; description: string }>;
  onClose: () => void;
  onSave: (payload: { label: string; config: Record<string, unknown> }) => void;
  onExecuteStep: () => void;
}

const NODE_INPUT_OPTION_ID = "__node_input__";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

function KeyValueTable({ label, value }: { label: string; value: unknown }) {
  const rows = useMemo(() => toKeyValueRows(value), [value]);
  const importantRows = useMemo(() => toImportantRows(rows), [rows]);
  const [viewMode, setViewMode] = useState<"important" | "full">("important");

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
            : `Showing all ${fullDataRowCount} fields`}
        </div>
        <div className="node-kv-view-switch" role="tablist" aria-label={`${label} preview mode`}>
          <button
            type="button"
            className={viewMode === "important" ? "active" : ""}
            onClick={() => setViewMode("important")}
          >
            Important only
          </button>
          <button type="button" className={viewMode === "full" ? "active" : ""} onClick={() => setViewMode("full")}>
            Full view
          </button>
        </div>
      </div>
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

  const suggested = `${window.location.protocol}//${hostname}:4001`;
  if (suggested.replace(/\/+$/, "") === currentBaseUrl.replace(/\/+$/, "")) {
    return null;
  }

  return suggested;
}

export function NodeConfigModal({
  node,
  inputOptions,
  executionResult,
  showRuntimeInspection = true,
  secrets,
  mcpServerDefinitions,
  onClose,
  onSave,
  onExecuteStep
}: NodeConfigModalProps) {
  const [label, setLabel] = useState(node.data.label);
  const [config, setConfig] = useState<Record<string, unknown>>(asRecord(node.data.config));
  const [activeTab, setActiveTab] = useState<"parameters" | "settings">("parameters");
  const [selectedInputId, setSelectedInputId] = useState(NODE_INPUT_OPTION_ID);
  const [discoveredTools, setDiscoveredTools] = useState<MCPToolDefinition[]>([]);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null);
  const [codeTestInput, setCodeTestInput] = useState("{\n  \"user_prompt\": \"Hello from code node\"\n}");
  const [codeTestBusy, setCodeTestBusy] = useState(false);
  const [codeTestError, setCodeTestError] = useState<string | null>(null);
  const [codeTestResult, setCodeTestResult] = useState<{ result: unknown; logs: string[] } | null>(null);
  const [connectorTestBusy, setConnectorTestBusy] = useState(false);
  const [connectorTestError, setConnectorTestError] = useState<string | null>(null);
  const [connectorTestMessage, setConnectorTestMessage] = useState<string | null>(null);
  const [workflowOptions, setWorkflowOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [workflowOptionsError, setWorkflowOptionsError] = useState<string | null>(null);

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
    setActiveTab("parameters");
    setSelectedInputId(NODE_INPUT_OPTION_ID);
    setDiscoveredTools([]);
    setDiscoverBusy(false);
    setDiscoverError(null);
    setDiscoverMessage(null);
    setCodeTestInput("{\n  \"user_prompt\": \"Hello from code node\"\n}");
    setCodeTestBusy(false);
    setCodeTestError(null);
    setCodeTestResult(null);
    setConnectorTestBusy(false);
    setConnectorTestError(null);
    setConnectorTestMessage(null);
    setWorkflowOptions([]);
    setWorkflowOptionsError(null);
  }, [inputOptions, mcpServerDefinitions, node]);

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

  const renderProviderSection = () => {
    return (
      <div className="cfg-group">
        <h4>Model</h4>
        <SelectField
          label="Provider"
          value={toStringValue(provider.providerId, "ollama")}
          onChange={(next) => setProvider({ providerId: next })}
          options={[
            { value: "ollama", label: "Ollama" },
            { value: "openai_compatible", label: "OpenAI Compatible" },
            { value: "openai", label: "OpenAI" },
            { value: "gemini", label: "Gemini" },
            { value: "anthropic", label: "Anthropic" }
          ]}
        />
        <TextField
          label="Model"
          value={toStringValue(provider.model)}
          onChange={(next) => setProvider({ model: next })}
          placeholder="gpt-4.1-mini / llama3.1"
        />
        {provider.providerId !== "openai" && provider.providerId !== "gemini" && provider.providerId !== "anthropic" && (
          <TextField
            label="Base URL"
            value={toStringValue(provider.baseUrl)}
            onChange={(next) => setProvider({ baseUrl: next })}
            placeholder="http://localhost:11434/v1"
          />
        )}
        <SelectField
          label="API Key Secret"
          value={toStringValue(asRecord(provider.secretRef).secretId, "")}
          onChange={(next) =>
            setProvider({
              secretRef: next ? { secretId: next } : undefined
            })
          }
          options={[{ value: "", label: "None / Environmental Variable" }, ...secrets.map((secret) => ({ value: secret.id, label: `${secret.name} (${secret.provider})` }))]}
        />
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
      </div>
    );
  };

  const renderAgentParameters = () => {
    return (
      <>
        <div className="cfg-tip">
          Tip: Attach a Chat Model on the <code>chat_model</code> port. Optionally attach Memory and one or more MCP Tool nodes on their dedicated ports.
        </div>

        <TextAreaField
          label="Prompt (User Message)"
          value={toStringValue(config.userPromptTemplate, "{{user_prompt}}")}
          onChange={(next) => setConfig((current) => ({ ...current, userPromptTemplate: next }))}
          rows={3}
        />

        <TextAreaField
          label="System Message"
          value={toStringValue(config.systemPromptTemplate, "{{system_prompt}}")}
          onChange={(next) => setConfig((current) => ({ ...current, systemPromptTemplate: next }))}
          rows={4}
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

        <SelectField
          label="Auth Secret"
          value={toStringValue(asRecord(config.secretRef).secretId)}
          onChange={(next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
          }
          options={[{ value: "", label: "None" }, ...secrets.map((secret) => ({ value: secret.id, label: `${secret.name} (${secret.provider})` }))]}
        />

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
          onChange={(next) =>
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
            })
          }
          options={[
            { value: "all", label: "All discovered tools (agent decides)" },
            { value: "single", label: "Single tool only" },
            { value: "multi", label: "Select multiple tools" }
          ]}
        />

        {includeAllDiscoveredTools ? (
          <div className="cfg-tip">
            {discoveredTools.length
              ? `Agent can call any of: ${discoveredTools.map((tool) => tool.name).join(", ")}`
              : "Discover tools first to preview what will be exposed to the agent."}
          </div>
        ) : toolSelectionMode === "single" && discoveredTools.length > 0 ? (
          <SelectField
            label="Tool Name"
            value={primarySelectedToolName || discoveredTools[0]?.name || ""}
            onChange={(next) =>
              setConfig((current) => ({
                ...current,
                toolName: next,
                allowedTools: next ? [next] : undefined
              }))
            }
            options={discoveredTools.map((tool) => ({ value: tool.name, label: tool.name }))}
          />
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
                  {discoveredTools.map((tool) => (
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
                  ))}
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

        <TextAreaField
          label="Tool Args Template"
          value={toStringValue(config.argsTemplate, "{}")}
          onChange={(next) => setConfig((current) => ({ ...current, argsTemplate: next }))}
          rows={3}
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

  const renderPromptTemplateParameters = () => {
    return (
      <>
        <TextAreaField
          label="Template"
          value={toStringValue(config.template)}
          onChange={(next) => setConfig((current) => ({ ...current, template: next }))}
          rows={5}
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
            <SelectField
              label="Token Secret"
              value={secretId}
              onChange={(next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
              }
              options={[{ value: "", label: "Select secret" }, ...secrets.map((secret) => ({ value: secret.id, label: `${secret.name} (${secret.provider})` }))]}
            />
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
            <SelectField
              label="HMAC Secret"
              value={secretId}
              onChange={(next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
              }
              options={[{ value: "", label: "Select secret" }, ...secrets.map((secret) => ({ value: secret.id, label: `${secret.name} (${secret.provider})` }))]}
            />
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
    const connectorSecrets = [
      { value: "", label: "None (demo fallback)" },
      ...secrets.map((secret) => ({
        value: secret.id,
        label: `${secret.name} (${secret.provider})`
      }))
    ];

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
            { value: "nosql-db", label: "NoSQL Database" }
          ]}
        />

        {connectorId === "google-drive" ? (
          <>
            <SelectField
              label="Google Drive Credentials Secret"
              value={toStringValue(asRecord(connectorConfig.secretRef).secretId)}
              onChange={(next) =>
                updateConnectorConfig({
                  secretRef: next ? { secretId: next } : undefined
                })
              }
              options={connectorSecrets}
            />
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
    const secretOptions = [
      { value: "", label: "None (demo fallback)" },
      ...secrets.map((secret) => ({
        value: secret.id,
        label: `${secret.name} (${secret.provider})`
      }))
    ];

    return (
      <>
        <SelectField
          label="Google Drive Credentials Secret"
          value={toStringValue(asRecord(config.secretRef).secretId)}
          onChange={(next) =>
            setConfig((current) => ({
              ...current,
              secretRef: next ? { secretId: next } : undefined
            }))
          }
          options={secretOptions}
        />
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
              rows={6}
            />
            <div className="cfg-tip">
              Use <code>{"{ \"parent.context.key\": \"child_input_key\" }"}</code> mapping to pass data into the sub-workflow.
            </div>
          </>
        );
      case "wait_node":
        return (
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
        );
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
            <TextField
              label="URL Template"
              value={toStringValue(config.urlTemplate, "https://api.example.com/resource/{{id}}")}
              onChange={(next) => setConfig((current) => ({ ...current, urlTemplate: next }))}
              placeholder="https://api.example.com/resource/{{id}}"
            />
            <SelectField
              label="Authorization Secret (Bearer)"
              value={toStringValue(asRecord(config.secretRef).secretId)}
              onChange={(next) =>
                setConfig((current) => ({
                  ...current,
                  secretRef: next ? { secretId: next } : undefined
                }))
              }
              options={[
                { value: "", label: "None" },
                ...secrets.map((secret) => ({
                  value: secret.id,
                  label: `${secret.name} (${secret.provider})`
                }))
              ]}
            />
            <TextAreaField
              label="Headers Template (JSON)"
              value={toStringValue(config.headersTemplate, "{\n  \"Accept\": \"application/json\"\n}")}
              onChange={(next) => setConfig((current) => ({ ...current, headersTemplate: next }))}
              rows={5}
            />
            <TextAreaField
              label="Body Template"
              value={toStringValue(config.bodyTemplate, "")}
              onChange={(next) => setConfig((current) => ({ ...current, bodyTemplate: next }))}
              rows={5}
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
            <TextAreaField
              label="Headers Template (JSON)"
              value={toStringValue(config.headersTemplate, "{\n  \"content-type\": \"application/json\"\n}")}
              onChange={(next) => setConfig((current) => ({ ...current, headersTemplate: next }))}
              rows={5}
            />
            <TextAreaField
              label="Body Template"
              value={toStringValue(config.bodyTemplate, "{\"ok\":true,\"result\":\"{{result}}\"}")}
              onChange={(next) => setConfig((current) => ({ ...current, bodyTemplate: next }))}
              rows={5}
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
        return (
          <>
            <TextField
              label="Query Template"
              value={toStringValue(config.queryTemplate, "{{user_prompt}}")}
              onChange={(next) => setConfig((current) => ({ ...current, queryTemplate: next }))}
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
                { value: "token-embedder", label: "Token Based (Local Demo)" }
              ]}
            />
            <SelectField
              label="Vector Store"
              value={toStringValue(config.vectorStoreId, "pinecone-vector-store")}
              onChange={(next) => setConfig((current) => ({ ...current, vectorStoreId: next }))}
              options={[
                { value: "pinecone-vector-store", label: "Pinecone Vector Store" },
                { value: "pgvector-store", label: "Postgres PGVector Store" },
                { value: "in-memory-vector-store", label: "In Memory (Local Demo)" }
              ]}
            />
            <SelectField
              label="API Key / Connection String Secret"
              value={toStringValue(asRecord(config.embeddingSecretRef).secretId)}
              onChange={(next) =>
                setConfig((current) => ({ ...current, embeddingSecretRef: next ? { secretId: next } : undefined }))
              }
              options={[{ value: "", label: "None / Env Var" }, ...secrets.map((secret) => ({ value: secret.id, label: `${secret.name}` }))]}
            />
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
      case "document_chunker":
        return (
          <>
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
            <TextField
              label="Condition Statement"
              value={toStringValue(config.condition, "{{answer}} === 'true'")}
              onChange={(next) => setConfig((current) => ({ ...current, condition: next }))}
            />
            <div className="cfg-tip">A javascript expression that returns true or false. Example: <code>{`{{userScore}} > 90`}</code></div>
          </>
        );
      case "switch_node":
        return (
          <>
            <TextField
              label="Switch Evaluation Value"
              value={toStringValue(config.switchValue, "{{answer}}")}
              onChange={(next) => setConfig((current) => ({ ...current, switchValue: next }))}
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
            <div className="cfg-tip">Define an array of strings in JSON to create branching outputs that match Switch Evaluation Value.</div>
          </>
        );
      case "output":
        return (
          <>
            <TextAreaField
              label="Response Template"
              value={toStringValue(config.responseTemplate, "{{answer}}")}
              onChange={(next) => setConfig((current) => ({ ...current, responseTemplate: next }))}
              rows={4}
            />
            <TextField
              label="Output Key"
              value={toStringValue(config.outputKey, "result")}
              onChange={(next) => setConfig((current) => ({ ...current, outputKey: next }))}
            />
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
    return (
      <>
        <TextField label="Node Label" value={label} onChange={setLabel} />
        <div className="cfg-tip">
          Node ID: <code>{node.id}</code>
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
              <button className="node-exec-btn" type="button" onClick={onExecuteStep}>
                Execute step
              </button>
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
              {resolvedOutputPreview !== undefined ? (
                <div className="cfg-group">
                  <div className="cfg-tip">
                    Last run status: <code>{currentNodeResult?.status ?? "unknown"}</code>
                  </div>
                  <KeyValueTable label="Output" value={resolvedOutputPreview} />
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
            onClick={() => onSave({ label, config: getConfigForSave() })}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
