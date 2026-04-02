import { Handle, Position, type NodeProps } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";

function toTitle(nodeType: string): string {
  return nodeType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function nodeToken(nodeType: string): string {
  const map: Record<string, string> = {
    schedule_trigger: "CRON",
    webhook_input: "WH",
    text_input: "TXT",
    system_prompt: "SYS",
    user_prompt: "USR",
    loop_node: "LOOP",
    merge_node: "MRG",
    execute_workflow: "SUB",
    wait_node: "WAIT",
    code_node: "CODE",
    prompt_template: "TPL",
    llm_call: "LLM",
    agent_orchestrator: "AG",
    local_memory: "MEM",
    mcp_tool: "MCP",
    rag_retrieve: "RAG",
    connector_source: "DB",
    output: "OUT",
    output_parser: "PRS",
    human_approval: "APP",
    input_validator: "VAL",
    output_guardrail: "GRD",
    if_node: "IF",
    switch_node: "SW",
    try_catch: "TC",
    document_chunker: "CHK"
  };

  return map[nodeType] ?? "ND";
}

function nodeVariant(nodeType: string): "terminal" | "resource" | "primary" | "agent" {
  if (nodeType === "agent_orchestrator") {
    return "agent";
  }

  if (nodeType === "schedule_trigger" || nodeType === "webhook_input" || nodeType === "output") {
    return "terminal";
  }

  if (nodeType === "mcp_tool" || nodeType === "connector_source" || nodeType === "llm_call" || nodeType === "local_memory") {
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
  const badge = nodeToken(data.nodeType);
  const subtitle = toTitle(data.nodeType);
  const currentStatus = data.executionStatus;
  const showSuccessBadge = currentStatus === "success";
  const showRunningBadge = currentStatus === "running";

  return (
    <div className={`wf-node wf-node-${variant} ${statusClass(data.executionStatus)} ${selected ? "selected" : ""}`}>
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
          <div className="wf-node-icon wf-node-agent-icon">{badge}</div>
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
                style={{ left: "24%" }}
              />
            </div>
            <div className="wf-agent-port">
              <span>Memory</span>
              <Handle
                id="memory"
                type="source"
                position={Position.Bottom}
                className="wf-handle wf-handle-diamond"
                style={{ left: "52%" }}
              />
            </div>
            <div className="wf-agent-port">
              <span>Tool</span>
              <Handle
                id="tool"
                type="source"
                position={Position.Bottom}
                className="wf-handle wf-handle-diamond"
                style={{ left: "80%" }}
              />
              <span className="wf-agent-plus">+</span>
            </div>
          </div>
        </>
      ) : variant === "resource" ? (
        <>
          <Handle type="target" position={Position.Top} className="wf-handle wf-handle-main" />
          <div className="wf-node-resource-icon">{badge}</div>
          <Handle type="source" position={Position.Bottom} className="wf-handle wf-handle-main" />
          <div className="wf-node-resource-title">{data.label}</div>
        </>
      ) : (
        <>
          <Handle type="target" position={Position.Left} className="wf-handle wf-handle-main" />
          <div className="wf-node-icon">{badge}</div>
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
                  return (
                  <div key={i} className="wf-structural-port">
                     <span className="port-label" title={lbl}>{lbl.length > 8 ? lbl.substring(0,6) + ".." : lbl}</span>
                     <Handle id={`case_${i}`} type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: (20 + (i * 15)) + "%" }} />
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
    </div>
  );
}
