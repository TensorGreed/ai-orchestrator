import { useCallback, useEffect, useMemo, useState } from "react";
import type { MCPToolDefinition } from "@ai-orchestrator/shared";
import type { EditorNode } from "../lib/workflow";
import { discoverMcpTools, type SecretListItem } from "../lib/api";

export interface NodeInputOption {
  id: string;
  label: string;
}

interface NodeConfigModalProps {
  node: EditorNode;
  inputOptions: NodeInputOption[];
  secrets: SecretListItem[];
  mcpServerDefinitions: Array<{ id: string; label: string; description: string }>;
  onClose: () => void;
  onSave: (payload: { label: string; config: Record<string, unknown> }) => void;
  onExecuteStep: () => void;
}

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

export function NodeConfigModal({
  node,
  inputOptions,
  secrets,
  mcpServerDefinitions,
  onClose,
  onSave,
  onExecuteStep
}: NodeConfigModalProps) {
  const [label, setLabel] = useState(node.data.label);
  const [config, setConfig] = useState<Record<string, unknown>>(asRecord(node.data.config));
  const [activeTab, setActiveTab] = useState<"parameters" | "settings">("parameters");
  const [selectedInputId, setSelectedInputId] = useState(inputOptions[0]?.id ?? "none");
  const [discoveredTools, setDiscoveredTools] = useState<MCPToolDefinition[]>([]);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null);

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
    setSelectedInputId(inputOptions[0]?.id ?? "none");
    setDiscoveredTools([]);
    setDiscoverBusy(false);
    setDiscoverError(null);
    setDiscoverMessage(null);
  }, [inputOptions, mcpServerDefinitions, node]);

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
            { value: "gemini", label: "Gemini" }
          ]}
        />
        <TextField
          label="Model"
          value={toStringValue(provider.model)}
          onChange={(next) => setProvider({ model: next })}
          placeholder="gpt-4.1-mini / llama3.1"
        />
        <TextField
          label="Base URL"
          value={toStringValue(provider.baseUrl)}
          onChange={(next) => setProvider({ baseUrl: next })}
          placeholder="http://localhost:11434/v1"
        />
        <SelectField
          label="Secret"
          value={toStringValue(asRecord(provider.secretRef).secretId, "")}
          onChange={(next) =>
            setProvider({
              secretRef: next ? { secretId: next } : undefined
            })
          }
          options={[{ value: "", label: "None" }, ...secrets.map((secret) => ({ value: secret.id, label: `${secret.name} (${secret.provider})` }))]}
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
    const selectedTool = discoveredToolByName.get(selectedToolName);

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
          value={includeAllDiscoveredTools ? "all" : "single"}
          onChange={(next) =>
            setConfig((current) => {
              if (next === "all") {
                return {
                  ...current,
                  toolName: "__all__",
                  allowedTools: undefined
                };
              }

              const currentToolName = toStringValue(current.toolName).trim();
              const resolvedSingleTool =
                currentToolName && currentToolName !== "__all__" ? currentToolName : (discoveredTools[0]?.name ?? "");

              return {
                ...current,
                toolName: resolvedSingleTool,
                allowedTools: resolvedSingleTool ? [resolvedSingleTool] : undefined
              };
            })
          }
          options={[
            { value: "all", label: "All discovered tools (agent decides)" },
            { value: "single", label: "Single tool only" }
          ]}
        />

        {includeAllDiscoveredTools ? (
          <div className="cfg-tip">
            {discoveredTools.length
              ? `Agent can call any of: ${discoveredTools.map((tool) => tool.name).join(", ")}`
              : "Discover tools first to preview what will be exposed to the agent."}
          </div>
        ) : discoveredTools.length > 0 ? (
          <SelectField
            label="Tool Name"
            value={selectedToolName || discoveredTools[0]?.name || ""}
            onChange={(next) =>
              setConfig((current) => ({
                ...current,
                toolName: next,
                allowedTools: next ? [next] : undefined
              }))
            }
            options={discoveredTools.map((tool) => ({ value: tool.name, label: tool.name }))}
          />
        ) : (
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
        )}

        {selectedTool && (
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
    const testUrl = `${apiBase}/webhook-test/${normalizedPath}`;
    const productionUrl = `${apiBase}/webhook/${normalizedPath}`;

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
        </div>

        <div className="cfg-tip">
          Send JSON body with at least <code>user_prompt</code> (or <code>prompt</code>). Optional:
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
    return (
      <>
        <SelectField
          label="Connector"
          value={toStringValue(config.connectorId, "google-drive")}
          onChange={(next) => setConfig((current) => ({ ...current, connectorId: next }))}
          options={[
            { value: "google-drive", label: "Google Drive" },
            { value: "sql-db", label: "SQL Database" },
            { value: "nosql-db", label: "NoSQL Database" }
          ]}
        />
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
      </>
    );
  };

  const renderParameters = () => {
    switch (node.data.nodeType) {
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
      case "connector_source":
        return renderConnectorParameters();
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

  const renderSettings = () => {
    return (
      <>
        <TextField label="Node Label" value={label} onChange={setLabel} />
        <div className="cfg-tip">
          Node ID: <code>{node.id}</code>
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

        <div className="node-modal-grid">
          <section className="node-modal-panel">
            <h3>INPUT</h3>
            <SelectField
              label="Input Source"
              value={selectedInputId}
              onChange={setSelectedInputId}
              options={[
                { value: "none", label: "Select previous node" },
                ...inputOptions.map((option) => ({ value: option.id, label: option.label }))
              ]}
            />
            <div className="node-modal-placeholder">No input data. Execute previous nodes to inspect payload.</div>
          </section>

          <section className="node-modal-panel center">
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

          <section className="node-modal-panel">
            <h3>OUTPUT</h3>
            <div className="node-modal-placeholder">Output appears after executing this step.</div>
          </section>
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
