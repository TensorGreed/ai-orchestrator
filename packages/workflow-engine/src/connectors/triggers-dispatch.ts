/**
 * Dispatcher for Phase 3.5 trigger nodes.
 * Keeps the executor switch focused by routing to the triggers module.
 */
import type { WorkflowNode, WorkflowNodeType } from "@ai-orchestrator/shared";
import {
  executeChatTrigger,
  executeFileTrigger,
  executeFormTrigger,
  executeKafkaTrigger,
  executeManualTrigger,
  executeMcpServerTrigger,
  executeMqttTrigger,
  executeRabbitmqTrigger,
  executeRssTrigger,
  executeSseTrigger,
  type TriggerContext
} from "./triggers";

export const PHASE35_TRIGGER_NODE_TYPES: ReadonlySet<WorkflowNodeType> = new Set<WorkflowNodeType>([
  "manual_trigger",
  "form_trigger",
  "chat_trigger",
  "file_trigger",
  "rss_trigger",
  "sse_trigger",
  "mcp_server_trigger",
  "kafka_trigger",
  "rabbitmq_trigger",
  "mqtt_trigger"
]);

export function isPhase35TriggerNode(type: string): boolean {
  return PHASE35_TRIGGER_NODE_TYPES.has(type as WorkflowNodeType);
}

export function executePhase35TriggerNode(
  node: WorkflowNode,
  config: Record<string, unknown>,
  ctx: TriggerContext
): unknown {
  switch (node.type) {
    case "manual_trigger":
      return executeManualTrigger(config, ctx);
    case "form_trigger":
      return executeFormTrigger(config, ctx);
    case "chat_trigger":
      return executeChatTrigger(config, ctx);
    case "file_trigger":
      return executeFileTrigger(config, ctx);
    case "rss_trigger":
      return executeRssTrigger(config, ctx);
    case "sse_trigger":
      return executeSseTrigger(config, ctx);
    case "mcp_server_trigger":
      return executeMcpServerTrigger(config, ctx);
    case "kafka_trigger":
      return executeKafkaTrigger(config, ctx);
    case "rabbitmq_trigger":
      return executeRabbitmqTrigger(config, ctx);
    case "mqtt_trigger":
      return executeMqttTrigger(config, ctx);
    default:
      throw new Error(`triggers-dispatch: unhandled node type '${node.type}'`);
  }
}
