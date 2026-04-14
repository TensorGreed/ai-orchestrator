/**
 * Phase 3.5 Trigger System Expansion — node executors.
 *
 * Each trigger node, when reached in a running DAG, returns the payload it
 * received from its external activation layer (API webhook, polling scheduler,
 * SSE consumer, etc.). The activation layer lives in `apps/api` and is
 * responsible for invoking `runWorkflowExecution` with the payload surfaced
 * as either `webhookPayload`, `directInput`, or workflow globals.
 *
 * The executor here reads those globals/inputs off the runtime context and
 * produces a normalized `{ triggered: true, ... }` shape for downstream nodes.
 */
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";

export interface TriggerContext {
  templateData: Record<string, unknown>;
  globals: Record<string, unknown>;
  webhookPayload?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const v = config[key];
  return typeof v === "string" ? v : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pickPayload(ctx: TriggerContext): Record<string, unknown> {
  if (ctx.webhookPayload && Object.keys(ctx.webhookPayload).length > 0) {
    return ctx.webhookPayload;
  }
  // Fall back to globals minus the internal reserved keys that the engine sets.
  const reserved = new Set([
    "webhook",
    "vars",
    "trigger_type",
    "scheduled_at",
    "system_prompt",
    "user_prompt",
    "session_id",
    "execution_id",
    "source_workflow_id",
    "source_workflow_name",
    "error",
    "error_stack",
    "timestamp"
  ]);
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.globals)) {
    if (!reserved.has(k)) payload[k] = v;
  }
  return payload;
}

export function executeManualTrigger(
  config: Record<string, unknown>,
  ctx: TriggerContext
): unknown {
  const payload = pickPayload(ctx);
  const testData = asRecord(config.testData);
  return {
    triggered: true,
    trigger_type: "manual",
    label: getString(config, "label", "Manual Trigger"),
    firedAt: nowIso(),
    ...testData,
    ...payload
  };
}

export function executeFormTrigger(
  _config: Record<string, unknown>,
  ctx: TriggerContext
): unknown {
  const submission = asRecord(ctx.globals.form_submission ?? ctx.webhookPayload);
  return {
    triggered: true,
    trigger_type: "form",
    submittedAt: typeof ctx.globals.submitted_at === "string" ? ctx.globals.submitted_at : nowIso(),
    fields: submission,
    ...submission
  };
}

export function executeChatTrigger(
  config: Record<string, unknown>,
  ctx: TriggerContext
): unknown {
  const payload = asRecord(ctx.webhookPayload ?? pickPayload(ctx));
  const message = typeof payload.message === "string"
    ? payload.message
    : typeof payload.text === "string"
      ? payload.text
      : typeof ctx.globals.user_prompt === "string"
        ? ctx.globals.user_prompt
        : "";
  const sessionId =
    typeof payload.session_id === "string"
      ? payload.session_id
      : typeof ctx.globals.session_id === "string"
        ? ctx.globals.session_id
        : "";
  return {
    triggered: true,
    trigger_type: "chat",
    message,
    user_prompt: message,
    session_id: sessionId,
    namespace: getString(config, "sessionNamespace", "chat"),
    user: payload.user ?? null,
    metadata: payload.metadata ?? {}
  };
}

export function executeFileTrigger(
  _config: Record<string, unknown>,
  ctx: TriggerContext
): unknown {
  // The polling service injects: file_events (array), watch_path.
  const events = Array.isArray(ctx.globals.file_events)
    ? (ctx.globals.file_events as unknown[])
    : [];
  return {
    triggered: true,
    trigger_type: "file",
    watchPath: ctx.globals.watch_path ?? "",
    eventCount: events.length,
    events
  };
}

export function executeRssTrigger(
  _config: Record<string, unknown>,
  ctx: TriggerContext
): unknown {
  const items = Array.isArray(ctx.globals.rss_items) ? (ctx.globals.rss_items as unknown[]) : [];
  return {
    triggered: true,
    trigger_type: "rss",
    feedUrl: ctx.globals.feed_url ?? "",
    newItemCount: items.length,
    items
  };
}

export function executeSseTrigger(
  _config: Record<string, unknown>,
  ctx: TriggerContext
): unknown {
  const payload = asRecord(ctx.globals.sse_event ?? ctx.webhookPayload ?? {});
  return {
    triggered: true,
    trigger_type: "sse",
    url: ctx.globals.sse_url ?? "",
    eventName: payload.event ?? "message",
    eventId: payload.id ?? null,
    data: payload.data ?? payload
  };
}

export function executeMcpServerTrigger(
  config: Record<string, unknown>,
  ctx: TriggerContext
): unknown {
  const payload = asRecord(ctx.webhookPayload ?? pickPayload(ctx));
  const args = asRecord(payload.arguments ?? payload.args ?? payload);
  return {
    triggered: true,
    trigger_type: "mcp_server",
    toolName: getString(config, "toolName"),
    callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
    arguments: args,
    ...args
  };
}

function mqTriggerExecutor(kind: "kafka" | "rabbitmq" | "mqtt") {
  return function executeMqTrigger(
    _config: Record<string, unknown>,
    ctx: TriggerContext
  ): unknown {
    // When the polling/consumer framework activates the workflow, it
    // injects `mq_message` into globals. If the node is executed manually
    // without the consumer, return a clear NOT_IMPLEMENTED error.
    const message = ctx.globals.mq_message;
    if (message === undefined || message === null) {
      throw new WorkflowError(
        `${kind}_trigger: no message delivered — the ${kind} consumer must be active and deliver a message before this node can run.`,
        ErrorCategory.NOT_IMPLEMENTED,
        false
      );
    }
    return {
      triggered: true,
      trigger_type: kind,
      message,
      metadata: ctx.globals.mq_metadata ?? {}
    };
  };
}

export const executeKafkaTrigger = mqTriggerExecutor("kafka");
export const executeRabbitmqTrigger = mqTriggerExecutor("rabbitmq");
export const executeMqttTrigger = mqTriggerExecutor("mqtt");
