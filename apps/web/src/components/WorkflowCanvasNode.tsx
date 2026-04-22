import { Handle, Position, type NodeProps } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import { NodeTypeIcon } from "./node-icons";

function toTitle(nodeType: string): string {
  return nodeType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function nodeVariant(nodeType: string): "terminal" | "resource" | "primary" | "agent" {
  if (nodeType === "agent_orchestrator" || nodeType === "supervisor_node") {
    return "agent";
  }

  if (
    nodeType === "schedule_trigger" ||
    nodeType === "webhook_input" ||
    nodeType === "output" ||
    nodeType === "webhook_response"
  ) {
    return "terminal";
  }

  if (
    nodeType === "mcp_tool" ||
    nodeType === "connector_source" ||
    nodeType === "google_drive_source" ||
    nodeType === "azure_storage" ||
    nodeType === "azure_cosmos_db" ||
    nodeType === "azure_monitor_http" ||
    nodeType === "azure_ai_search_vector_store" ||
    nodeType === "qdrant_vector_store" ||
    nodeType === "embeddings_azure_openai" ||
    nodeType === "http_request" ||
    nodeType === "llm_call" ||
    nodeType === "openai_chat_model" ||
    nodeType === "anthropic_chat_model" ||
    nodeType === "ollama_chat_model" ||
    nodeType === "openai_compatible_chat_model" ||
    nodeType === "ai_gateway_chat_model" ||
    nodeType === "azure_openai_chat_model" ||
    nodeType === "google_gemini_chat_model" ||
    nodeType === "local_memory"
  ) {
    return "resource";
  }

  return "primary";
}

function statusClass(status: EditorNodeData["executionStatus"]): string {
  if (!status) {
    return "status-idle";
  }

  return `status-${status}`;
}

export function WorkflowCanvasNode({ data, selected }: NodeProps<EditorNodeData>) {
  const variant = nodeVariant(data.nodeType);
  const subtitle = toTitle(data.nodeType);
  const currentStatus = data.executionStatus;
  const showSuccessBadge = currentStatus === "success";
  const showRunningBadge = currentStatus === "running";
  const preview = data.executionPreview;
  const disabledClass = data.disabled ? " wf-node-disabled" : "";
  const colorClass = data.color ? ` wf-node-color-${data.color}` : "";
  const renderAgentPlus = (sourceHandle: "chat_model" | "memory" | "tool" | "worker", label: string) => {
    if (!data.onOpenAgentAttachmentDrawer) {
      return <span className="wf-agent-plus">+</span>;
    }

    return (
      <button
        type="button"
        className="wf-agent-plus"
        aria-label={`Add ${label}`}
        title={`Add ${label}`}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          data.onOpenAgentAttachmentDrawer?.(sourceHandle);
        }}
      >
        +
      </button>
    );
  };

  return (
    <div
      className={`wf-node wf-node-${variant} ${statusClass(data.executionStatus)} ${selected ? "selected" : ""}${disabledClass}${colorClass}`}
    >
      {data.disabled && (
        <span className="wf-node-disabled-badge" title="Disabled" aria-label="Disabled">⏸</span>
      )}
      {data.pinned && (
        <span className="wf-node-pinned-badge" title="Pinned data" aria-label="Pinned data">PIN</span>
      )}
      {showSuccessBadge && (
        <span className="wf-node-status-badge wf-node-status-success" title="Completed" aria-label="Completed">
          ✓
        </span>
      )}
      {showRunningBadge && (
        <span className="wf-node-status-badge wf-node-status-running" title="Running" aria-label="Running">
          ●
        </span>
      )}

      {variant === "agent" ? (
        <>
          <Handle type="target" position={Position.Left} className="wf-handle wf-handle-main" />
          <div className="wf-node-icon wf-node-agent-icon">
            <NodeTypeIcon nodeType={data.nodeType} fallbackIcon="ai" />
          </div>
          <div className="wf-node-main">
            <div className="wf-node-title">{data.label}</div>
            <div className="wf-node-subtitle">AI Agent</div>
          </div>
          <Handle type="source" position={Position.Right} className="wf-handle wf-handle-main" />

          <div className="wf-agent-ports">
            <div className="wf-agent-port">
              <span>Chat Model*</span>
              <Handle
                id="chat_model"
                type="source"
                position={Position.Bottom}
                className="wf-handle wf-handle-diamond"
                style={{ left: data.nodeType === "supervisor_node" ? "16%" : "24%" }}
              />
              {renderAgentPlus("chat_model", "chat model")}
            </div>
            <div className="wf-agent-port">
              <span>Memory</span>
              <Handle
                id="memory"
                type="source"
                position={Position.Bottom}
                className="wf-handle wf-handle-diamond"
                style={{ left: data.nodeType === "supervisor_node" ? "38%" : "52%" }}
              />
              {renderAgentPlus("memory", "memory")}
            </div>
            <div className="wf-agent-port">
              <span>Tool</span>
              <Handle
                id="tool"
                type="source"
                position={Position.Bottom}
                className="wf-handle wf-handle-diamond"
                style={{ left: data.nodeType === "supervisor_node" ? "62%" : "80%" }}
              />
              {renderAgentPlus("tool", "tool")}
            </div>
            {data.nodeType === "supervisor_node" && (
              <div className="wf-agent-port">
                <span>Worker</span>
                <Handle
                  id="worker"
                  type="source"
                  position={Position.Bottom}
                  className="wf-handle wf-handle-diamond"
                  style={{ left: "86%" }}
                />
                {renderAgentPlus("worker", "worker")}
              </div>
            )}
          </div>
        </>
      ) : variant === "resource" ? (
        <>
          <Handle type="target" position={Position.Top} className="wf-handle wf-handle-main" />
          <div className="wf-node-resource-icon">
            <NodeTypeIcon nodeType={data.nodeType} fallbackIcon="core" />
          </div>
          <Handle type="source" position={Position.Bottom} className="wf-handle wf-handle-main" />
          <div className="wf-node-resource-title">{data.label}</div>
        </>
      ) : (
        <>
          <Handle type="target" position={Position.Left} className="wf-handle wf-handle-main" />
          <div className="wf-node-icon">
            <NodeTypeIcon nodeType={data.nodeType} fallbackIcon="core" />
          </div>
          <div className="wf-node-main">
            <div className="wf-node-title">{data.label}</div>
            <div className="wf-node-subtitle">{subtitle}</div>
          </div>
          {data.nodeType === "if_node" ? (
             <div className="wf-structural-ports">
               <div className="wf-structural-port" style={{ marginTop: 2 }}>
                  <span className="port-label">True</span>
                  <Handle id="true" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: "30%" }} />
               </div>
               <div className="wf-structural-port" style={{ marginBottom: 2 }}>
                  <span className="port-label">False</span>
                  <Handle id="false" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: "70%" }} />
               </div>
             </div>
          ) : data.nodeType === "try_catch" ? (
             <div className="wf-structural-ports">
               <div className="wf-structural-port" style={{ marginTop: 2 }}>
                  <span className="port-label">Try</span>
                  <Handle id="success" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: "30%" }} />
               </div>
               <div className="wf-structural-port" style={{ marginBottom: 2 }}>
                  <span className="port-label">Catch</span>
                  <Handle id="error" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: "70%" }} />
               </div>
             </div>
          ) : data.nodeType === "switch_node" ? (
             <div className="wf-structural-ports">
               {(Array.isArray(data.config?.cases) ? data.config.cases : []).map((c: any, i: number) => {
                  const lbl = typeof c === "string" ? c : (c?.label || c?.value || `Case ${i+1}`);
                  const normalizedHandleId = String(lbl ?? "").trim() || `case_${i}`;
                  return (
                  <div key={i} className="wf-structural-port">
                     <span className="port-label" title={lbl}>{lbl.length > 8 ? lbl.substring(0,6) + ".." : lbl}</span>
                     <Handle id={normalizedHandleId} type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: (20 + (i * 15)) + "%" }} />
                  </div>
               )})}
               <div className="wf-structural-port">
                  <span className="port-label">Default</span>
                  <Handle id="default" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: (20 + ((Array.isArray(data.config?.cases) ? data.config.cases.length : 0) * 15)) + "%" }} />
               </div>
             </div>
          ) : (
             <Handle type="source" position={Position.Right} className="wf-handle wf-handle-main" />
          )}
        </>
      )}
      {preview && (preview.input || preview.output || preview.error) && (
        <div className="wf-node-debug-preview">
          {preview.input && (
            <div>
              <strong>In</strong> {preview.input}
            </div>
          )}
          {preview.output && (
            <div>
              <strong>Out</strong> {preview.output}
            </div>
          )}
          {preview.error && (
            <div className="wf-node-debug-error">
              <strong>Err</strong> {preview.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
