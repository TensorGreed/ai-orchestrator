import { effectiveModelName, type Workflow } from "@ai-orchestrator/shared";
import { buildProviderFromModelNode, isChatModelNodeType } from "./executor";

/** 12.6 — one model a node of a workflow is configured to call. */
export interface WorkflowModelReference {
  nodeId: string;
  nodeName: string;
  providerId: string;
  /** The model name the provider is sent (the deployment name for Azure OpenAI). */
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The models a workflow's nodes name in their saved config: each chat model
 * node (LLM Call and the provider-specific chat model nodes, attached to an
 * agent or not) and each node with a `provider` config. A model chosen by an
 * expression (`{{...}}`) is only known at run time and is left out, as is a
 * node whose provider config is incomplete.
 */
export function workflowModelReferences(workflow: Pick<Workflow, "nodes">): WorkflowModelReference[] {
  const references: WorkflowModelReference[] = [];
  for (const node of workflow.nodes ?? []) {
    const config = isRecord(node.config) ? node.config : {};
    let provider = isChatModelNodeType(node.type) ? buildProviderFromModelNode(node) : undefined;
    if (!provider && isRecord(config.provider) && typeof config.provider.providerId === "string" && typeof config.provider.model === "string") {
      provider = config.provider as unknown as NonNullable<typeof provider>;
    }
    if (!provider || typeof provider.providerId !== "string" || !provider.providerId.trim()) continue;
    const model = effectiveModelName(provider);
    if (!model || model.includes("{{") || provider.providerId.includes("{{")) continue;
    references.push({ nodeId: node.id, nodeName: node.name?.trim() || node.type, providerId: provider.providerId, model });
  }
  return references;
}
