/**
 * Phase 12.4 — safe argument summaries for MCP tool-call telemetry.
 *
 * Binds the mcp-sdk summariser to the detectors production capture masks
 * with: the guard SDK's DLP patterns plus the international phone detector
 * (`scanForCapture`), read over the decoded view of each string, so a
 * URL-encoded or JSON-escaped value is found as well. A value they flag is
 * kept only as its data class.
 *
 * Returns null when summaries are switched off (MCP_TOOL_ARGUMENT_SUMMARIES=false)
 * and when the arguments cannot be summarised; a summary never fails a call
 * or its telemetry row.
 */

import { decodeView, scanForCapture } from "@ai-orchestrator/guard-sdk";
import { summarizeToolArguments, type ToolArgumentDetector } from "@ai-orchestrator/mcp-sdk";
import type { ToolArgumentSummary } from "@ai-orchestrator/shared";

export type ToolArgumentSummarizer = (args: unknown, inputSchema?: unknown) => ToolArgumentSummary | null;

/** Data classes the production-capture scan finds in `text`. */
export const captureDetector: ToolArgumentDetector = (text) => {
  const classes = new Set<string>();
  for (const match of scanForCapture(decodeView(text).text)) classes.add(String(match.dataClass));
  return [...classes];
};

export function createToolArgumentSummarizer(options: { enabled: boolean; detect?: ToolArgumentDetector }): ToolArgumentSummarizer | undefined {
  if (!options.enabled) return undefined;
  const detect = options.detect ?? captureDetector;
  return (args, inputSchema) => {
    try {
      return summarizeToolArguments(args, { detect, ...(inputSchema !== undefined ? { inputSchema } : {}) });
    } catch {
      return null;
    }
  };
}
