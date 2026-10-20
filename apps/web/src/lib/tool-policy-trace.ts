import type { McpHiddenTool, McpToolPolicySubject, McpToolPolicyTrace } from "@ai-orchestrator/shared";

/** Phase 10.2 — human-readable lines for the inspector Trace tab's "Tool policy" block. */
export interface ToolPolicyTraceView {
  subject: string;
  lines: string[];
  noWriteTools: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Reads `_toolPolicy` from an agent or supervisor output, if the run recorded one. */
export function readToolPolicyTrace(output: unknown): McpToolPolicyTrace | undefined {
  const record = asRecord(output);
  const raw = asRecord(record?._toolPolicy);
  const subject = asRecord(raw?.subject);
  if (!raw || !subject || typeof subject.role !== "string") return undefined;
  return raw as unknown as McpToolPolicyTrace;
}

export function describeToolPolicySubject(subject: McpToolPolicySubject): string {
  const who = subject.email ?? subject.userId;
  if (subject.source === "user") {
    return who
      ? `Evaluated as ${subject.role} — triggered by ${who}`
      : `Evaluated as ${subject.role} — triggered by a signed-in user`;
  }
  if (subject.source === "owner") {
    return who ? `Evaluated as ${subject.role} — workflow owner ${who}` : `Evaluated as ${subject.role} — workflow owner`;
  }
  const reason = subject.fallbackReason ?? "";
  if (/no longer exists/i.test(reason)) return `Evaluated as ${subject.role} — workflow owner no longer exists`;
  if (!reason || /no recorded owner/i.test(reason)) return `Evaluated as ${subject.role} — workflow owner unknown`;
  return `Evaluated as ${subject.role} — ${reason}`;
}

export function describeHiddenTool(entry: McpHiddenTool): string {
  if (entry.reason === "no_write_tools") {
    return `${entry.tool} hidden: write tool and this workflow allows no write tools`;
  }
  const rule = entry.ruleName ?? entry.ruleId;
  return rule ? `${entry.tool} hidden by policy ${rule}` : `${entry.tool} hidden by policy`;
}

export function buildToolPolicyTraceView(trace: McpToolPolicyTrace): ToolPolicyTraceView {
  const hidden = Array.isArray(trace.hidden) ? trace.hidden : [];
  return {
    subject: describeToolPolicySubject(trace.subject),
    lines: hidden.map(describeHiddenTool),
    noWriteTools: Boolean(trace.noWriteTools)
  };
}
