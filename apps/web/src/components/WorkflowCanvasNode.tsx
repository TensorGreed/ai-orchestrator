import { Handle, Position, type NodeProps } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import { runningElapsedMs } from "../lib/run-trace";
import { useNow } from "../lib/use-now";
import { AGENT_ATTACHMENT_STYLES, type AgentAttachmentHandle } from "../lib/agent-attachments";
import { ORBIT, emptySlots, isHubType, ringGeometry, summarizeNode } from "../lib/stages";
import type { McpCanvasMarker, McpNavTarget } from "../lib/mcp-control-plane";
import { NodeTypeIcon } from "./node-icons";

const TERMINAL_TYPES = new Set([
  "schedule_trigger",
  "webhook_input",
  "form_trigger",
  "chat_trigger",
  "file_trigger",
  "rss_trigger",
  "sse_trigger",
  "manual_trigger",
  "error_trigger",
  "mcp_server_trigger",
  "sub_workflow_trigger",
  "output",
  "helper_chat_response",
  "webhook_response",
  "pdf_output"
]);

const SLOT_LABEL: Record<AgentAttachmentHandle, string> = {
  chat_model: "+ model",
  memory: "+ memory",
  tool: "+ tool",
  worker: "+ worker",
  guard: "+ guard",
  protection: "+ protect"
};

function statusClass(status: EditorNodeData["executionStatus"]): string {
  return status ? `status-${status}` : "status-idle";
}

function statusTitle(status: EditorNodeData["executionStatus"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "success":
      return "Completed";
    case "error":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "canceled":
      return "Canceled";
    case "pending":
      return "Pending";
    default:
      return "Idle";
  }
}

export function WorkflowCanvasNode({ data, selected }: NodeProps<EditorNodeData>) {
  const nodeType = data.nodeType;
  if (isHubType(nodeType)) {
    return <HubNode data={data} selected={selected} />;
  }
  if (data.attachedTo && data.attachedAs) {
    return <SatelliteNode data={data} selected={selected} />;
  }
  return <CardNode data={data} selected={selected} />;
}

interface VariantProps {
  data: EditorNodeData;
  selected: boolean;
}

function Badges({ data }: { data: EditorNodeData }) {
  return (
    <>
      {data.disabled && (
        <span className="wf-node-disabled-badge" title="Disabled" aria-label="Disabled">
          ⏸
        </span>
      )}
      {data.pinned && (
        <span className="wf-node-pinned-badge" title="Pinned data" aria-label="Pinned data">
          PIN
        </span>
      )}
    </>
  );
}

/** Ticking "how long has this been running" label; the only thing that re-renders each second. */
export function LiveElapsed({ result, className }: { result: { startedAt?: string; liveStartedAtMs?: number }; className?: string }) {
  const now = useNow(true);
  return <span className={className}>{formatLatency(Math.floor(runningElapsedMs(result, now) / 1000) * 1000)}</span>;
}

function RunningPill({ data }: { data: EditorNodeData }) {
  if (data.executionStatus !== "running" || typeof data.liveStartedAtMs !== "number") return null;
  return (
    <div className="wf-node-telemetry">
      <span className="wf-telemetry-pill wf-telemetry-pill-running">
        Running <LiveElapsed result={{ liveStartedAtMs: data.liveStartedAtMs }} />
      </span>
    </div>
  );
}

function DebugPreview({ data }: { data: EditorNodeData }) {
  const preview = data.executionPreview;
  if (!preview || !(preview.input || preview.output || preview.error || preview.live)) return null;
  return (
    <div className="wf-node-debug-preview">
      {preview.input && (
        <div>
          <strong>In</strong> {preview.input}
        </div>
      )}
      {preview.live && (
        <div className="wf-node-debug-live">
          <strong>Live</strong> {preview.live}
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
          {preview.errorRemediation && (
            <div className="wf-node-debug-remediation">
              <strong>Fix:</strong> {preview.errorRemediation}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Telemetry({ data }: { data: EditorNodeData }) {
  const t = data.telemetry;
  if (!t || !hasMeaningfulTelemetry(t)) return null;
  const tokens = formatTokens(t);
  return (
    <div className="wf-node-telemetry" title={telemetryTooltip(t)}>
      {tokens && <span className="wf-telemetry-pill">{tokens}</span>}
      {typeof t.latencyMs === "number" && <span className="wf-telemetry-pill">{formatLatency(t.latencyMs)}</span>}
      {typeof t.llmCallCount === "number" && t.llmCallCount > 1 && (
        <span className="wf-telemetry-pill wf-telemetry-pill-faint">×{t.llmCallCount}</span>
      )}
    </div>
  );
}

function rootClass(kind: "card" | "hub" | "satellite", data: EditorNodeData, selected: boolean): string {
  const parts = ["wf-node", `wf-node-${kind}`, statusClass(data.executionStatus)];
  if (selected) parts.push("selected");
  if (data.disabled) parts.push("wf-node-disabled");
  if (data.color) parts.push(`wf-node-color-${data.color}`);
  return parts.join(" ");
}

function CardNode({ data, selected }: VariantProps) {
  const nodeType = data.nodeType;
  const summary = summarizeNode({ type: nodeType, config: data.config });
  const terminal = TERMINAL_TYPES.has(nodeType);
  const status = data.executionStatus;

  return (
    <div className={`${rootClass("card", data, selected)}${terminal ? " wf-node-terminal" : ""}`} style={{ width: ORBIT.cardWidth }}>
      <Badges data={data} />
      <Handle type="target" position={Position.Left} className="wf-handle wf-handle-main" />
      <div className="wf-card-glyph">
        <NodeTypeIcon nodeType={nodeType} fallbackIcon="core" />
      </div>
      <div className="wf-card-body">
        <div className="wf-card-name" title={data.label}>
          {data.label}
        </div>
        <div className="wf-card-type">{nodeType}</div>
        <div className="wf-card-summary" title={summary}>
          {summary}
        </div>
        {data.mcpMarker && <McpMarker marker={data.mcpMarker} onOpen={data.onOpenMcpTarget} variant="card" />}
      </div>
      <span className={`wf-status-ring wf-status-${status ?? "idle"}`} title={statusTitle(status)} aria-label={statusTitle(status)} />
      <StructuralPorts data={data} />
      <DebugPreview data={data} />
      <RunningPill data={data} />
      <Telemetry data={data} />
    </div>
  );
}

function StructuralPorts({ data }: { data: EditorNodeData }) {
  const nodeType = data.nodeType;
  if (nodeType === "if_node") {
    return (
      <div className="wf-structural-ports">
        <div className="wf-structural-port">
          <span className="port-label">True</span>
          <Handle id="true" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: "32%" }} />
        </div>
        <div className="wf-structural-port">
          <span className="port-label">False</span>
          <Handle id="false" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: "68%" }} />
        </div>
      </div>
    );
  }
  if (nodeType === "try_catch") {
    return (
      <div className="wf-structural-ports">
        <div className="wf-structural-port">
          <span className="port-label">Try</span>
          <Handle id="success" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: "32%" }} />
        </div>
        <div className="wf-structural-port">
          <span className="port-label">Catch</span>
          <Handle id="error" type="source" position={Position.Right} className="wf-handle wf-handle-main wf-handle-err" style={{ top: "68%" }} />
        </div>
      </div>
    );
  }
  if (nodeType === "switch_node") {
    const cases = Array.isArray(data.config?.cases) ? (data.config.cases as unknown[]) : [];
    const total = cases.length + 1;
    const topFor = (index: number) => `${((index + 1) / (total + 1)) * 100}%`;
    return (
      <div className="wf-structural-ports">
        {cases.map((c, i) => {
          const raw = typeof c === "string" ? c : ((c as Record<string, unknown> | null)?.label ?? (c as Record<string, unknown> | null)?.value ?? `Case ${i + 1}`);
          const lbl = String(raw ?? "");
          const normalizedHandleId = lbl.trim() || `case_${i}`;
          return (
            <div key={i} className="wf-structural-port">
              <span className="port-label" title={lbl}>
                {lbl.length > 8 ? `${lbl.substring(0, 6)}..` : lbl}
              </span>
              <Handle id={normalizedHandleId} type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: topFor(i) }} />
            </div>
          );
        })}
        <div className="wf-structural-port">
          <span className="port-label">Default</span>
          <Handle id="default" type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: topFor(cases.length) }} />
        </div>
      </div>
    );
  }
  if (nodeType === "guard") {
    // Phase 12.1 — items are routed, not failed: pass carries the (rewritten)
    // item, blocked and review carry the verdict summary. An unconnected
    // review output falls back to blocked.
    const ports = [
      { id: "pass", label: "Pass", top: "26%", className: "" },
      { id: "blocked", label: "Blocked", top: "50%", className: " wf-handle-err" },
      { id: "review", label: "Review", top: "74%", className: " wf-handle-review" }
    ];
    const protection = data.slots?.protection ?? [];
    const onOpen = data.onOpenAgentAttachmentDrawer;
    return (
      <>
        <div className="wf-structural-ports wf-guard-ports">
          {ports.map((port) => (
            <div key={port.id} className={`wf-structural-port wf-guard-port wf-guard-port-${port.id}`}>
              {/* Outside the card, just above the edge that leaves this handle. */}
              <span className="port-label" style={{ top: port.top }}>
                {port.label}
              </span>
              <Handle id={port.id} type="source" position={Position.Right} className={`wf-handle wf-handle-main${port.className}`} style={{ top: port.top }} />
            </div>
          ))}
        </div>
        <Handle id="protection" type="source" position={Position.Bottom} className="wf-handle-hidden" />
        {protection.length === 0 && (
          <button
            type="button"
            className="wf-slot wf-slot-protection wf-guard-protect-slot nodrag nopan"
            title={`Add protection — ${AGENT_ATTACHMENT_STYLES.protection.description}`}
            aria-label={`Add protection — ${AGENT_ATTACHMENT_STYLES.protection.description}`}
            disabled={!onOpen}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpen?.("protection");
            }}
          >
            <span className="wf-slot-glyph">+</span>
            <span className="wf-slot-label">{SLOT_LABEL.protection}</span>
          </button>
        )}
      </>
    );
  }
  if (nodeType === "chat_intent_router") {
    const ports = [
      { id: "report", label: "Report", top: "20%" },
      { id: "code", label: "Code", top: "40%" },
      { id: "message", label: "Message", top: "60%" },
      { id: "missing_context", label: "Missing", top: "80%" }
    ];
    return (
      <div className="wf-structural-ports">
        {ports.map((port) => (
          <div key={port.id} className="wf-structural-port">
            <span className="port-label" title={port.label}>
              {port.label}
            </span>
            <Handle id={port.id} type="source" position={Position.Right} className="wf-handle wf-handle-main" style={{ top: port.top }} />
          </div>
        ))}
      </div>
    );
  }
  return <Handle type="source" position={Position.Right} className="wf-handle wf-handle-main" />;
}

function HubNode({ data, selected }: VariantProps) {
  const nodeType = data.nodeType;
  const isSupervisor = nodeType === "supervisor_node";
  const isWorker = data.attachedAs === "worker";
  const slots = data.slots ?? emptySlots();
  const scale = isWorker ? ORBIT.miniRadius / ORBIT.innerRadius : 1;
  const geometry = ringGeometry(slots, { allowWorkers: isSupervisor });
  const summary = summarizeNode({ type: nodeType, config: data.config });
  const status = data.executionStatus;
  const rings = [ORBIT.innerRadius * scale, ORBIT.outerRadius * scale];
  if (isSupervisor && !isWorker) rings.push(ORBIT.workerRadius);

  return (
    <div
      className={`${rootClass("hub", data, selected)}${isSupervisor ? " wf-node-hub-supervisor" : ""}${isWorker ? " wf-node-hub-worker" : ""}`}
      style={{ width: ORBIT.hubSize, height: ORBIT.hubSize }}
    >
      <div className="wf-hub-rings" aria-hidden="true">
        {rings.map((radius, index) => (
          <span key={index} className={`wf-ring wf-ring-${index}`} style={{ width: radius * 2, height: radius * 2 }} />
        ))}
      </div>
      <Badges data={data} />
      <Handle type="target" position={Position.Left} className="wf-handle wf-handle-main" />
      <Handle type="source" position={Position.Right} className="wf-handle wf-handle-main" />
      <Handle id="chat_model" type="source" position={Position.Bottom} className="wf-handle-hidden" />
      <Handle id="memory" type="source" position={Position.Bottom} className="wf-handle-hidden" />
      <Handle id="tool" type="source" position={Position.Bottom} className="wf-handle-hidden" />
      {isSupervisor && <Handle id="worker" type="source" position={Position.Bottom} className="wf-handle-hidden" />}
      <Handle id="guard" type="source" position={Position.Bottom} className="wf-handle-hidden" />

      <div className="wf-hub-core">
        <div className="wf-hub-glyph">
          <NodeTypeIcon nodeType={nodeType} fallbackIcon="ai" />
        </div>
        <div className="wf-hub-title" title={data.label}>
          {data.label}
        </div>
        <div className="wf-hub-type">{isWorker ? "worker" : nodeType}</div>
        <div className="wf-hub-summary" title={summary}>
          {summary}
        </div>
      </div>
      <span className={`wf-status-ring wf-status-${status ?? "idle"} wf-hub-status`} title={statusTitle(status)} aria-label={statusTitle(status)} />

      {geometry
        .filter((slot) => slot.nodeId === null)
        .map((slot) => {
          const radius = slot.port === "worker" ? slot.radius : slot.radius * scale;
          const dx = Math.cos(slot.angle) * radius;
          const dy = Math.sin(slot.angle) * radius;
          const required = slot.port === "chat_model";
          const style = AGENT_ATTACHMENT_STYLES[slot.port];
          const label = SLOT_LABEL[slot.port];
          const title = required ? `Add chat model (required) — ${style.description}` : `Add ${style.label.toLowerCase()} — ${style.description}`;
          const onOpen = data.onOpenAgentAttachmentDrawer;
          return (
            <button
              key={`${slot.port}-${slot.angle.toFixed(3)}`}
              type="button"
              className={`wf-slot wf-slot-${slot.port}${required ? " wf-slot-required" : ""} nodrag nopan`}
              style={{ left: `calc(50% + ${dx}px)`, top: `calc(50% + ${dy}px)` }}
              title={title}
              aria-label={title}
              disabled={!onOpen}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onOpen?.(slot.port);
              }}
            >
              <span className="wf-slot-glyph">+</span>
              <span className="wf-slot-label">{label}</span>
            </button>
          );
        })}

      <DebugPreview data={data} />
      <RunningPill data={data} />
      <Telemetry data={data} />
    </div>
  );
}

function SatelliteNode({ data, selected }: VariantProps) {
  const port = data.attachedAs ?? "tool";
  const summary = summarizeNode({ type: data.nodeType, config: data.config });
  const status = data.executionStatus;
  return (
    <div
      className={`${rootClass("satellite", data, selected)} wf-node-satellite-${port}`}
      style={{ width: ORBIT.satelliteSize, height: ORBIT.satelliteSize }}
      title={`${AGENT_ATTACHMENT_STYLES[port].label} · ${data.label}`}
    >
      <Handle type="target" position={Position.Top} className="wf-handle-hidden" />
      <Handle type="source" position={Position.Bottom} className="wf-handle-hidden" />
      {data.nodeType === "guard" && <Handle id="protection" type="source" position={Position.Bottom} className="wf-handle-hidden" />}
      <Badges data={data} />
      <div className="wf-satellite-glyph">
        <NodeTypeIcon nodeType={data.nodeType} fallbackIcon="ai" />
      </div>
      <span className={`wf-status-ring wf-status-${status ?? "idle"} wf-satellite-status`} title={statusTitle(status)} aria-label={statusTitle(status)} />
      {data.mcpMarker && <McpMarker marker={data.mcpMarker} onOpen={data.onOpenMcpTarget} variant="satellite" />}
      <div className={`wf-satellite-label wf-satellite-label-${data.labelSide ?? "bottom"}`}>
        <span className="wf-satellite-port">{AGENT_ATTACHMENT_STYLES[port].label}</span>
        <span className="wf-satellite-name" title={data.label}>
          {data.label}
        </span>
        <span className="wf-satellite-summary" title={summary}>
          {summary}
        </span>
      </div>
      <Telemetry data={data} />
    </div>
  );
}

const POLICY_CHIP: Record<NonNullable<McpCanvasMarker["policy"]>, { short: string; label: string }> = {
  blocked: { short: "Blocked", label: "Blocked for you by policy" },
  destructive: { short: "Destructive", label: "Destructive tool" },
  write: { short: "Write", label: "Write tool" },
  read_only: { short: "Read-only", label: "Read-only tool" }
};

/**
 * Phase 10.3 — registered server status, pending breaking change and policy state on an
 * MCP Tool node. Colour always comes with text: the dot's accessible name and tooltip
 * carry the status, and chips are labelled.
 */
function McpMarker({
  marker,
  onOpen,
  variant
}: {
  marker: McpCanvasMarker;
  onOpen?: (target: McpNavTarget) => void;
  variant: "card" | "satellite";
}) {
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const open = (target: McpNavTarget) => (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onOpen?.(target);
  };
  const serverTarget: McpNavTarget = { page: "servers", serverId: marker.serverId };
  const blockedTarget: McpNavTarget = marker.blockingRuleId
    ? { page: "policies", policyId: marker.blockingRuleId }
    : { page: "tools", serverId: marker.serverId };
  const statusName = `MCP server ${marker.serverName}: ${marker.statusLabel}`;
  const policy = marker.policy && marker.policy !== "read_only" ? POLICY_CHIP[marker.policy] : null;
  const partialBlock = marker.policy !== "blocked" && marker.blockedCount > 0;
  return (
    <div className={`wf-mcp-marker wf-mcp-marker-${variant} nodrag nopan`} title={marker.description} onMouseDown={stop}>
      <button
        type="button"
        className={`wf-mcp-status mcp-status-${marker.status}`}
        aria-label={`${statusName}. Open server`}
        title={marker.description}
        disabled={!onOpen}
        onClick={open(serverTarget)}
      >
        <span className={`mcp-dot mcp-status-${marker.status}`} aria-hidden="true" />
        {variant === "card" && <span className="wf-mcp-status-text">{marker.statusLabel}</span>}
      </button>
      {marker.breakingPending && (
        <button
          type="button"
          className="wf-mcp-chip wf-mcp-chip-breaking"
          aria-label={`Breaking change pending on ${marker.serverName}. Open server to review`}
          title={`Breaking change pending on ${marker.serverName} — open the server to review it`}
          disabled={!onOpen}
          onClick={open(serverTarget)}
        >
          {variant === "card" ? "Breaking change" : "Breaking"}
        </button>
      )}
      {marker.circuit && (
        <button
          type="button"
          className={`wf-mcp-chip wf-mcp-chip-circuit wf-mcp-chip-circuit-${marker.circuit}`}
          aria-label={`${marker.circuit === "open" ? "Circuit open" : "Circuit half-open"} on ${marker.serverName}. Open server`}
          title={
            marker.circuit === "open"
              ? `Circuit open on ${marker.serverName}: calls are paused after repeated failures`
              : `Circuit half-open on ${marker.serverName}: one trial call is let through`
          }
          disabled={!onOpen}
          onClick={open(serverTarget)}
        >
          {marker.circuit === "open" ? "Circuit open" : "Half-open"}
        </button>
      )}
      {policy &&
        (marker.policy === "blocked" ? (
          <button
            type="button"
            className="wf-mcp-chip wf-mcp-chip-blocked"
            aria-label={`${policy.label}${marker.blockingRuleName ? ` (rule ${marker.blockingRuleName})` : ""}. Open ${marker.blockingRuleId ? "the rule" : "the tool"}`}
            title={`${policy.label}${marker.blockingRuleName ? ` by rule “${marker.blockingRuleName}”` : ""}`}
            disabled={!onOpen}
            onClick={open(blockedTarget)}
          >
            {policy.short}
          </button>
        ) : (
          <span
            className={`wf-mcp-chip wf-mcp-chip-${marker.policy}`}
            role="img"
            aria-label={marker.toolCount > 1 ? `Uses ${policy.short.toLowerCase()} tools` : policy.label}
            title={marker.toolCount > 1 ? `Uses ${policy.short.toLowerCase()} tools` : policy.label}
          >
            {policy.short}
          </span>
        ))}
      {partialBlock && (
        <button
          type="button"
          className="wf-mcp-chip wf-mcp-chip-blocked"
          aria-label={`${marker.blockedCount} of ${marker.toolCount} tools blocked for you. Open ${marker.blockingRuleId ? "the rule" : "the tools"}`}
          title={`${marker.blockedCount} of ${marker.toolCount} tools blocked for you by policy`}
          disabled={!onOpen}
          onClick={open(blockedTarget)}
        >
          {variant === "card" ? `${marker.blockedCount} blocked` : `${marker.blockedCount}/${marker.toolCount} blocked`}
        </button>
      )}
    </div>
  );
}

function hasMeaningfulTelemetry(t: NonNullable<EditorNodeData["telemetry"]>): boolean {
  return (
    typeof t.totalTokens === "number" ||
    typeof t.inputTokens === "number" ||
    typeof t.outputTokens === "number" ||
    typeof t.latencyMs === "number"
  );
}

function formatTokens(t: NonNullable<EditorNodeData["telemetry"]>): string | null {
  const total = t.totalTokens ?? (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
  if (!total) return null;
  if (total >= 1000) return `${(total / 1000).toFixed(total >= 10000 ? 0 : 1)}k tok`;
  return `${total} tok`;
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function telemetryTooltip(t: NonNullable<EditorNodeData["telemetry"]>): string {
  const parts: string[] = [];
  if (t.providerId) parts.push(`provider: ${t.providerId}${t.model ? ` (${t.model})` : ""}`);
  if (typeof t.inputTokens === "number") parts.push(`input: ${t.inputTokens}`);
  if (typeof t.outputTokens === "number") parts.push(`output: ${t.outputTokens}`);
  if (typeof t.cachedInputTokens === "number" && t.cachedInputTokens > 0) parts.push(`cached: ${t.cachedInputTokens}`);
  if (typeof t.totalTokens === "number") parts.push(`total: ${t.totalTokens}`);
  if (typeof t.latencyMs === "number") parts.push(`llm latency: ${t.latencyMs}ms`);
  if (typeof t.llmCallCount === "number") parts.push(`calls: ${t.llmCallCount}`);
  return parts.join(" · ");
}
