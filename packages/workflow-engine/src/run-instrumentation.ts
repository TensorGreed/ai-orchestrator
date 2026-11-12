/**
 * How the engine describes its work through the `RunInstrumentation` seam (no OpenTelemetry import here): a span per
 * executed DAG node, `invoke_agent` around an Agent or Supervisor loop, and `invoke_workflow` around a sub-workflow's
 * run. Attachment-port nodes (chat model, memory, tools, workers) are not DAG steps and get no node span; a worker
 * shows up as the `invoke_agent` span inside its Supervisor's `execute_tool` span.
 *
 * With no instrumentation, or the no-op, every helper here returns before allocating anything.
 */
import {
  NOOP_SCOPED_INSTRUMENTATION_SPAN,
  SPAN_OUTCOME_ATTRIBUTES,
  type AgentRunState,
  type InstrumentationSpan,
  type NodeExecutionResult,
  type RunInstrumentation,
  type ScopedInstrumentationSpan,
  type Workflow,
  type WorkflowExecutionResult,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { isAgentGuardInterrupt } from "@ai-orchestrator/agent-runtime";

/** Opens a node's span (the no-op while instrumentation is off). The caller ends it with `finishNodeSpan`. */
export function openNodeSpan(
  instrument: RunInstrumentation | undefined,
  node: WorkflowNode,
  parent?: InstrumentationSpan,
  /** A Loop body's pass. */
  loopIndex?: number
): ScopedInstrumentationSpan {
  if (!instrument?.enabled) return NOOP_SCOPED_INSTRUMENTATION_SPAN;
  const span = instrument.startNode({ nodeId: node.id, nodeType: node.type, ...(node.name ? { nodeName: node.name } : {}) }, parent);
  if (loopIndex !== undefined) span.setAttributes({ [SPAN_OUTCOME_ATTRIBUTES.NODE_LOOP_INDEX]: loopIndex });
  return span;
}

/**
 * Ends a node's span with the outcome its result recorded (the last result for the node; every exit of the node's
 * step pushes one). Canceled, paused and skipped are outcomes, not errors; only a failed node marks the span ERROR,
 * with its error category as `error.type`.
 */
export function finishNodeSpan(span: ScopedInstrumentationSpan, nodeResults: readonly NodeExecutionResult[], nodeId: string): void {
  if (span === NOOP_SCOPED_INSTRUMENTATION_SPAN) return;
  try {
    let result: NodeExecutionResult | undefined;
    for (let index = nodeResults.length - 1; index >= 0; index -= 1) {
      if (nodeResults[index]!.nodeId === nodeId) {
        result = nodeResults[index];
        break;
      }
    }
    if (result) {
      span.setAttributes({
        [SPAN_OUTCOME_ATTRIBUTES.NODE_STATUS]: result.status,
        [SPAN_OUTCOME_ATTRIBUTES.NODE_ATTEMPTS]: result.attempts
      });
      if (result.status === "error") span.recordError(result.error ?? "", { type: result.errorCategory ?? "unknown" });
    }
  } finally {
    span.end();
  }
}

/** What an agent loop's span records about its outcome: summed usage, turns and why it stopped. */
function describeAgentState(span: InstrumentationSpan, state: AgentRunState): void {
  span.setAttributes({
    [SPAN_OUTCOME_ATTRIBUTES.AGENT_ITERATIONS]: state.iterations,
    [SPAN_OUTCOME_ATTRIBUTES.AGENT_STOP_REASON]: state.stopReason,
    [SPAN_OUTCOME_ATTRIBUTES.USAGE_INPUT_TOKENS]: state.usage?.inputTokens,
    [SPAN_OUTCOME_ATTRIBUTES.USAGE_OUTPUT_TOKENS]: state.usage?.outputTokens,
    [SPAN_OUTCOME_ATTRIBUTES.USAGE_CACHE_READ_INPUT_TOKENS]: state.usage?.cachedInputTokens
  });
  // The loop turns a model failure into an `error` stop reason with the message as its answer.
  if (state.stopReason === "error") span.recordError(state.finalAnswer, { type: "agent_error" });
}

/**
 * Runs an Agent or Supervisor loop inside an `invoke_agent` span. A content-rules block or an approval pause leaves
 * the loop by throwing but is not a failure of the agent: the span records the outcome and stays unset (the node's
 * span shows whether the node failed).
 */
export async function runAgentInSpan(
  instrument: RunInstrumentation | undefined,
  info: { node: WorkflowNode; sessionId?: string },
  runAgent: () => Promise<AgentRunState>
): Promise<AgentRunState> {
  if (!instrument?.enabled) return await runAgent();
  const outcome = await instrument.agent(
    {
      agentId: info.node.id,
      ...(info.node.name ? { agentName: info.node.name } : {}),
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      supervisor: info.node.type === "supervisor_node"
    },
    async (span): Promise<{ state: AgentRunState } | { thrown: unknown }> => {
      try {
        const state = await runAgent();
        describeAgentState(span, state);
        return { state };
      } catch (error) {
        if (isAgentGuardInterrupt(error)) {
          span.setAttributes({
            [SPAN_OUTCOME_ATTRIBUTES.AGENT_STOP_REASON]: error.reason,
            [SPAN_OUTCOME_ATTRIBUTES.CONTENT_RULES_OUTCOME]: error.reason === "blocked" ? "blocked" : undefined
          });
        } else {
          span.recordError(error);
        }
        return { thrown: error };
      }
    }
  );
  if ("thrown" in outcome) throw outcome.thrown;
  return outcome.state;
}

/**
 * Runs a sub-workflow's child run inside its own `invoke_workflow` span (a child of the calling node's or tool
 * call's span). The top-level run's span belongs to the host that started it.
 */
export async function runChildInSpan(
  instrument: RunInstrumentation | undefined,
  info: { workflow: Workflow | undefined; executionId?: string; triggerType?: string },
  run: () => Promise<WorkflowExecutionResult>
): Promise<WorkflowExecutionResult> {
  if (!instrument?.enabled || !info.workflow) return await run();
  const workflow = info.workflow;
  return await instrument.run(
    {
      ...(info.executionId ? { executionId: info.executionId } : {}),
      workflowId: workflow.id,
      ...(workflow.name ? { workflowName: workflow.name } : {}),
      ...(workflow.projectId ? { projectId: workflow.projectId } : {}),
      ...(info.triggerType ? { triggerType: info.triggerType } : {})
    },
    async (span) => {
      const result = await run();
      describeRunResult(span, result);
      return result;
    }
  );
}

/** A finished run's status on its span; only a failed run marks it ERROR (canceled and paused are outcomes). */
export function describeRunResult(span: InstrumentationSpan, result: Pick<WorkflowExecutionResult, "status" | "error" | "errorCategory">): void {
  span.setAttributes({ [SPAN_OUTCOME_ATTRIBUTES.RUN_STATUS]: result.status });
  if (result.status === "error") span.recordError(result.error ?? "", { type: result.errorCategory ?? "unknown" });
}
