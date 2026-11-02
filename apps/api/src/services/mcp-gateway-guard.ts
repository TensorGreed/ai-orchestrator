/**
 * 12.6 — Guard on MCP gateway server tool calls.
 *
 * A toolset's or client's Guard binding turns these checks on (`GuardService.resolveGateway`); with neither, the
 * gateway runs no Guard, exactly as before. Two checkpoints per server tool call:
 *   - `tool_arguments` before the call goes to the server (the client's arguments, never seen by the server when
 *     blocked);
 *   - `tool_result` on what the server answered (a result or its error text), after the gateway has scrubbed the
 *     secret values it injected, so Guard never sees or records them.
 * Verdicts go to `guard_events` under the call's synthetic `mcpgw_*` execution id, with the tool name as node id
 * and placement `gateway`. Shadow profiles only record. The latency budget and fail-closed setting are each
 * profile's own, as in runs.
 */

import { DESTINATION_RULES_DETECTOR_ID, type GuardChannel, type ProvenanceLabel } from "@ai-orchestrator/guard-sdk";
import { orderedProvenance, type DataLabels, type DestinationRef, type McpToolPolicySubject, type SecretReference } from "@ai-orchestrator/shared";
import {
  needsApproval,
  profilesHaveDestinationRules,
  profilesUsePropagatedLabels,
  resolveDestinationRefs,
  runGuardCheck,
  type GuardCheckResult,
  type GuardRunResolution
} from "@ai-orchestrator/workflow-engine";
import type { GatewayGuardContext, GuardService } from "./guard-service.js";

/** At most this many reasons name a block; the rest are left out. */
const MAX_REASONS = 3;

export type GatewayGuardChannel = Extract<GuardChannel, "tool_arguments" | "tool_result">;

export type GatewayGuardOutcome =
  /** Nothing to change (shadow findings are recorded only). */
  | { action: "allow" }
  /** A profile redacted, masked or protected part of the content: send this instead. */
  | { action: "rewrite"; content: unknown }
  /** The call stops here: `reason` is short and names categories only, never evidence. */
  | { action: "block"; reason: string; categories: string[]; profiles: Array<{ profileId: string; version: number }> };

function readable(category: string): string {
  return category.replace(/[_-]+/g, " ").trim();
}

/**
 * The short reason a blocked gateway call answers with: the categories that stopped it (`prompt injection`), the
 * engine's own reason for a latency budget or detector failure, or "destination rule". Never evidence or values.
 */
export function gatewayBlockReason(result: GuardCheckResult): { reason: string; categories: string[] } {
  const categories = new Set<string>();
  for (const { summary } of result.verdicts) {
    for (const action of summary.actions) {
      if (action.shadow) continue;
      if (action.effective !== "block" && !needsApproval(action.effective)) continue;
      if (action.detectorId === "<engine>") categories.add(action.reason ?? readable(action.category));
      else if (action.detectorId === DESTINATION_RULES_DETECTOR_ID) categories.add("destination rule");
      else categories.add(readable(action.category));
    }
  }
  const list = [...categories];
  const named = list.slice(0, MAX_REASONS).join(", ") || "policy";
  const review = needsApproval(result.action) ? " (needs a review, which gateway calls cannot wait for)" : "";
  return { reason: `Blocked by Guard: ${named}${review}`, categories: list };
}

/**
 * One Guard check of a gateway server tool call. `review` and `require_approval` block too: a gateway call has no
 * person waiting on it to approve. A rewrite of the arguments that is no longer an object blocks as well.
 */
export async function checkGatewayCall(input: {
  guard: GuardService;
  context: GatewayGuardContext;
  resolution: GuardRunResolution;
  channel: GatewayGuardChannel;
  /** The gateway tool name: the event's node id. */
  toolName: string;
  tool: { serverId: string; toolName: string; inputSchema?: Record<string, unknown> };
  content: unknown;
  subject: McpToolPolicySubject;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  /** Where the call goes (its MCP server), for destination rules on `tool_arguments`; null when it sends nothing out. */
  destination?: DestinationRef | null;
  /** The session's labels on a toolset that tracks outside content; absent otherwise. */
  callLabels?: DataLabels;
  logger?: (message: string, metadata?: unknown) => void;
}): Promise<GatewayGuardOutcome> {
  const profiles = input.resolution.stack;
  if (profiles.length === 0) return { action: "allow" };
  const deps = input.guard.gatewayRuntime(input.context, input.resolution);
  const fixed: ProvenanceLabel[] = input.channel === "tool_result" ? ["untrusted_external"] : [];
  // As in runs: the session's labels add to the checkpoint's fixed ones only when a profile asks for propagated labels.
  const labels =
    profilesUsePropagatedLabels(profiles) && input.callLabels ? (orderedProvenance([...fixed, ...input.callLabels.provenance]) as ProvenanceLabel[]) : fixed;
  const destination =
    input.channel === "tool_arguments" && input.destination && profilesHaveDestinationRules(profiles)
      ? await resolveDestinationRefs(deps, [input.destination])
      : undefined;
  const dataLabels: DataLabels = input.callLabels ?? { provenance: ["user"], dataClasses: [], source: "propagated" };
  const result = await runGuardCheck(
    {
      guard: deps,
      resolveSecret: input.resolveSecret,
      executionId: input.context.executionId,
      workflowId: "",
      nodeId: input.toolName,
      placement: "gateway",
      subject: input.subject,
      ...(input.logger ? { logger: input.logger } : {})
    },
    profiles,
    {
      content: input.content,
      channel: input.channel,
      labels,
      tool: { serverId: input.tool.serverId, toolName: input.tool.toolName, ...(input.tool.inputSchema ? { inputSchema: input.tool.inputSchema } : {}) },
      ...(destination ? { destination, dataLabels } : {})
    },
    { toolName: input.tool.toolName }
  );
  const blockOutcome = () => ({
    action: "block" as const,
    ...gatewayBlockReason(result),
    profiles: result.verdicts.map((entry) => ({ profileId: entry.profile.profileId, version: entry.profile.version }))
  });
  if (result.action === "block" || needsApproval(result.action)) return blockOutcome();
  if (!result.transformed) return { action: "allow" };
  if (input.channel === "tool_arguments" && (!result.content || typeof result.content !== "object" || Array.isArray(result.content))) {
    return { action: "block", reason: "Blocked by Guard: the rewritten arguments are not an object", categories: [], profiles: blockOutcome().profiles };
  }
  return { action: "rewrite", content: result.content };
}
