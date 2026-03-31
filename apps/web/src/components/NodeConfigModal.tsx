import { useEffect, useMemo, useState } from "react";
import type { EditorNode } from "../lib/workflow";
import type { SecretListItem } from "../lib/api";

export interface NodeInputOption {
  id: string;
  label: string;
}

interface NodeConfigModalProps {
  node: EditorNode;
  inputOptions: NodeInputOption[];
  secrets: SecretListItem[];
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
  rows = 4
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
}) {
  return (
    <label className="cfg-field">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={rows} />
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

export function NodeConfigModal({ node, inputOptions, secrets, onClose, onSave, onExecuteStep }: NodeConfigModalProps) {
  const [label, setLabel] = useState(node.data.label);
  const [config, setConfig] = useState<Record<string, unknown>>(asRecord(node.data.config));
  const [activeTab, setActiveTab] = useState<"parameters" | "settings">("parameters");
  const [selectedInputId, setSelectedInputId] = useState(inputOptions[0]?.id ?? "none");

  useEffect(() => {
    setLabel(node.data.label);
    setConfig(asRecord(node.data.config));
    setActiveTab("parameters");
    setSelectedInputId(inputOptions[0]?.id ?? "none");
  }, [inputOptions, node]);

  const provider = useMemo(() => asRecord(config.provider), [config.provider]);

  const setProvider = (patch: Record<string, unknown>) => {
    setConfig((current) => ({
      ...current,
      provider: {
        ...asRecord(current.provider),
        ...patch
      }
    }));
  };

  const setPrimaryMcpServer = (patch: Record<string, unknown>) => {
    setConfig((current) => {
      const existingServers = Array.isArray(current.mcpServers) ? [...current.mcpServers] : [];
      const first = asRecord(existingServers[0]);
      existingServers[0] = {
        ...first,
        ...patch
      };

      return {
        ...current,
        mcpServers: existingServers
      };
    });
  };

  const primaryMcpServer = useMemo(() => {
    const servers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
    return asRecord(servers[0]);
  }, [config.mcpServers]);

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
    const toolsCsv = Array.isArray(primaryMcpServer.allowedTools)
      ? primaryMcpServer.allowedTools.map((item) => String(item)).join(",")
      : "";

    return (
      <>
        <div className="cfg-tip">Tip: Define prompts and attach Chat Model, Memory, and Tools using dedicated ports.</div>

        <SelectField
          label="Source for Prompt (User Message)"
          value={toStringValue(config.sourceUserPrompt, "define")}
          onChange={(next) => setConfig((current) => ({ ...current, sourceUserPrompt: next }))}
          options={[
            { value: "define", label: "Define below" },
            { value: "webhook", label: "From webhook input" }
          ]}
        />

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

        {renderProviderSection()}

        <div className="cfg-group">
          <h4>Tool Connector (MCP)</h4>
          <TextField
            label="MCP Server Id"
            value={toStringValue(primaryMcpServer.serverId, "mock-mcp")}
            onChange={(next) => setPrimaryMcpServer({ serverId: next })}
          />
          <TextField
            label="Endpoint"
            value={toStringValue(asRecord(primaryMcpServer.connection).endpoint, "http://127.0.0.1:7001/mcp")}
            onChange={(next) =>
              setPrimaryMcpServer({
                connection: {
                  ...asRecord(primaryMcpServer.connection),
                  endpoint: next
                }
              })
            }
          />
          <TextField
            label="Tools to include (comma-separated)"
            value={toolsCsv}
            onChange={(next) =>
              setPrimaryMcpServer({
                allowedTools: next
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              })
            }
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

    return (
      <>
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
          value={toStringValue(connection.authType, "none")}
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

        <TextField
          label="MCP Server Id"
          value={toStringValue(config.serverId, "mock-mcp")}
          onChange={(next) => setConfig((current) => ({ ...current, serverId: next }))}
        />

        <TextField
          label="Tool Name"
          value={toStringValue(config.toolName)}
          onChange={(next) => setConfig((current) => ({ ...current, toolName: next }))}
        />

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
            onClick={() => onSave({ label, config })}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
