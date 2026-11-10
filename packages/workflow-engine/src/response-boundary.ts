import { profileChecksResponses, profileChecksTriggerInput, type ProvenanceLabel } from "@ai-orchestrator/guard-sdk";
import {
  orderedProvenance,
  withheldResponseOutput,
  type DataLabels,
  type McpToolPolicySubject,
  type ResponseBoundary,
  type ResponseCheckSummary,
  type SecretReference,
  type WorkflowExecutionResult
} from "@ai-orchestrator/shared";
import {
  describeGuardVerdict,
  needsApproval,
  profilesUsePropagatedLabels,
  resolveGuardRun,
  runGuardCheck,
  runVerdictMemoOf,
  type GuardCheckResult,
  type GuardEvalScope,
  type GuardRuntimeDependencies,
  type ResolvedGuardProfile
} from "./guard-runtime";

/**
 * Phase 12 coverage — the response boundary (D4-D7). A run started by a trigger whose caller receives its output (a
 * webhook or chat widget, `/api/chat`, an MCP trigger's invoke) is checked once at its end, on the `response` channel,
 * by the profiles of the run's stack that configure that channel. With none (the zero-config case, and the built-in
 * rule set) the result is returned untouched.
 *
 * The check rewrites `result.output`, so the run's stored output, the idempotency store and the reply all hold what
 * the caller may see. A block withholds the output; `review` and `require_approval` withhold it too, since the caller
 * cannot wait for a person. The run still ends `success`; the rule event (placement `response`) records why.
 * Node results are left as they ran: they are the builder's record of each step, as on every other run.
 */

/** The dependencies' `mayCheckChannel` shortcut, failing open (absent or failing: the profiles are resolved). */
async function mayCheckChannel(guard: GuardRuntimeDependencies, channel: "response" | "trigger_input"): Promise<boolean> {
  if (!guard.mayCheckChannel) return true;
  try {
    return await guard.mayCheckChannel(channel);
  } catch {
    return true;
  }
}

/** The profiles of the run's stack that check responses; empty when none does (nothing to do). */
export async function responseProfilesFor(guard: GuardRuntimeDependencies | undefined): Promise<ResolvedGuardProfile[]> {
  if (!guard || !(await mayCheckChannel(guard, "response"))) return [];
  const resolution = await resolveGuardRun(guard);
  return resolution.stack.filter((entry) => profileChecksResponses(entry.profile));
}

/** The profiles of the run's stack that check incoming payloads at the route (`trigger_input`, D12). */
export async function triggerInputProfilesFor(guard: GuardRuntimeDependencies | undefined): Promise<ResolvedGuardProfile[]> {
  if (!guard || !(await mayCheckChannel(guard, "trigger_input"))) return [];
  const resolution = await resolveGuardRun(guard);
  return resolution.stack.filter((entry) => profileChecksTriggerInput(entry.profile));
}

/** Labels the check sees: none by default (like an agent's final answer), the propagated ones when a profile asks. */
function boundaryLabels(profiles: ResolvedGuardProfile[], propagated: DataLabels | undefined): ProvenanceLabel[] {
  if (!propagated || !profilesUsePropagatedLabels(profiles)) return [];
  return orderedProvenance([...propagated.provenance]) as ProvenanceLabel[];
}

/** The check's outcome as the result carries it. */
function summaryOf(result: GuardCheckResult, withheld: boolean): ResponseCheckSummary {
  return { action: result.action, withheld, transformed: !withheld && result.transformed, reason: describeGuardVerdict(result) };
}

export interface ResponseCheckInput {
  result: WorkflowExecutionResult;
  boundary: ResponseBoundary | undefined;
  guard: GuardRuntimeDependencies | undefined;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  executionId: string;
  workflowId: string;
  /** The node whose output is the run's output (the rule event's node). */
  nodeId: string;
  subject?: McpToolPolicySubject;
  /** The output's propagated labels, when the run tracked them. */
  labels?: DataLabels;
  logger?: (message: string, metadata?: unknown) => void;
}

/**
 * Checks a finished run's output at the response boundary and returns the result the caller and history get. Only a
 * `success` or `partial` run with an output is checked. A check that cannot run (its rule sets could not be resolved,
 * a detector failed) withholds the output: the boundary fails closed, like a latency budget set to fail closed.
 */
export async function checkRunResponse(input: ResponseCheckInput): Promise<WorkflowExecutionResult> {
  const { result } = input;
  if (!input.boundary || !input.guard) return result;
  if (result.status !== "success" && result.status !== "partial") return result;
  if (result.output === undefined) return result;
  let profiles: ResolvedGuardProfile[];
  try {
    profiles = await responseProfilesFor(input.guard);
  } catch (error) {
    input.logger?.("The response check could not resolve its rule sets; the response is withheld", {
      error: error instanceof Error ? error.message : String(error)
    });
    return withhold(result, { action: "block", withheld: true, transformed: false, reason: "block: the response check could not run" });
  }
  if (profiles.length === 0) return result;
  const scope: GuardEvalScope = {
    guard: input.guard,
    // One memo per run (the API builds the dependencies per run): a clean check of the same content earlier is reused.
    memo: runVerdictMemoOf(input.guard),
    resolveSecret: input.resolveSecret,
    executionId: input.executionId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    placement: "response",
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.logger ? { logger: input.logger } : {})
  };
  // A webhook caller with a Webhook Response node receives only its headers and body; everything else receives the
  // whole output.
  const sent = input.boundary.surface === "webhook" ? webhookResponseOf(result.output) : undefined;
  const content = sent ? { headers: sent.headers, body: sent.body } : result.output;
  let checked: GuardCheckResult;
  try {
    checked = await runGuardCheck(scope, profiles, { content, channel: "response", labels: boundaryLabels(profiles, input.labels) });
  } catch (error) {
    input.logger?.("The response check failed; the response is withheld", { error: error instanceof Error ? error.message : String(error) });
    return withhold(result, { action: "block", withheld: true, transformed: false, reason: "block: the response check could not run" });
  }
  if (checked.action === "block" || needsApproval(checked.action)) return withhold(result, summaryOf(checked, true));
  const summary = summaryOf(checked, false);
  if (!checked.transformed) return { ...result, responseCheck: summary };
  if (!sent) return { ...result, output: checked.content, responseCheck: summary };
  // The stored output becomes what was sent, so no other field of it keeps an unchecked copy of the body.
  const rewritten = checked.content && typeof checked.content === "object" && !Array.isArray(checked.content) ? (checked.content as Record<string, unknown>) : {};
  return {
    ...result,
    output: { __webhookResponse: { statusCode: sent.statusCode, headers: stringHeaders(rewritten.headers), body: "body" in rewritten ? rewritten.body : checked.content } },
    responseCheck: summary
  };
}

/** A Webhook Response node's reply inside the run's output (the shape the webhook route sends), or undefined. */
function webhookResponseOf(output: unknown): { statusCode: unknown; headers: Record<string, string>; body: unknown } | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const raw = (output as Record<string, unknown>).__webhookResponse;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return { statusCode: record.statusCode, headers: stringHeaders(record.headers), body: record.body };
}

function stringHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return headers;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) headers[key] = String(entry);
  return headers;
}

function withhold(result: WorkflowExecutionResult, summary: ResponseCheckSummary): WorkflowExecutionResult {
  return { ...result, output: withheldResponseOutput(), responseCheck: summary };
}

export interface TriggerInputCheckOutcome {
  /** `refused`: block, review or approval (the caller cannot wait), or the check could not run. */
  refused: boolean;
  /** The payload the run starts with (rewritten when a rule rewrote it). */
  payload: unknown;
  transformed: boolean;
  reason: string;
}

/**
 * D12 — the opt-in check of an incoming payload at the route, before the run is dispatched (`trigger_input`). Null
 * when no profile of the run's stack configures the channel. Fails closed like the response check.
 */
export async function checkTriggerInput(input: {
  payload: unknown;
  guard: GuardRuntimeDependencies;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  executionId: string;
  workflowId: string;
  /** The trigger node (the rule event's node). */
  nodeId: string;
  /** The payload's provenance (the trigger's trust). */
  labels: readonly ProvenanceLabel[];
  logger?: (message: string, metadata?: unknown) => void;
}): Promise<TriggerInputCheckOutcome | null> {
  let profiles: ResolvedGuardProfile[];
  try {
    profiles = await triggerInputProfilesFor(input.guard);
  } catch (error) {
    input.logger?.("The incoming payload check could not resolve its rule sets; the request is refused", {
      error: error instanceof Error ? error.message : String(error)
    });
    return { refused: true, payload: input.payload, transformed: false, reason: "block: the request check could not run" };
  }
  if (profiles.length === 0) return null;
  const scope: GuardEvalScope = {
    guard: input.guard,
    resolveSecret: input.resolveSecret,
    executionId: input.executionId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    placement: "response",
    ...(input.logger ? { logger: input.logger } : {})
  };
  let checked: GuardCheckResult;
  try {
    checked = await runGuardCheck(scope, profiles, { content: input.payload, channel: "trigger_input", labels: [...input.labels] });
  } catch (error) {
    input.logger?.("The incoming payload check failed; the request is refused", { error: error instanceof Error ? error.message : String(error) });
    return { refused: true, payload: input.payload, transformed: false, reason: "block: the request check could not run" };
  }
  const refused = checked.action === "block" || needsApproval(checked.action);
  return {
    refused,
    payload: !refused && checked.transformed ? checked.content : input.payload,
    transformed: !refused && checked.transformed,
    reason: describeGuardVerdict(checked)
  };
}
