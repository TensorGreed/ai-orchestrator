import { workflowSchema, type Workflow, type WorkflowValidationIssue, type WorkflowValidationResult } from "@ai-orchestrator/shared";
import { isAgentAttachmentEdge, isExecutionEdge } from "./graph";

interface GraphMetadata {
  inDegree: Map<string, number>;
  outgoing: Map<string, string[]>;
}

const allowedWebhookMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const allowedWebhookAuthModes = new Set(["none", "bearer_token", "hmac_sha256"]);

function normalizeWebhookPath(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const withFallback = raw || fallback;
  return withFallback.replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildGraph(workflow: Workflow): GraphMetadata {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of workflow.nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of workflow.edges.filter(isExecutionEdge)) {
    const sourceOut = outgoing.get(edge.source);
    if (sourceOut) {
      sourceOut.push(edge.target);
    }

    const currentDegree = inDegree.get(edge.target);
    if (currentDegree !== undefined) {
      inDegree.set(edge.target, currentDegree + 1);
    }
  }

  return { inDegree, outgoing };
}

function topoSort(workflow: Workflow): { order: string[]; cyclic: boolean } {
  const { inDegree, outgoing } = buildGraph(workflow);
  const queue: string[] = [];

  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  const order: string[] = [];
  while (queue.length) {
    const nodeId = queue.shift()!;
    order.push(nodeId);

    for (const target of outgoing.get(nodeId) ?? []) {
      const degree = inDegree.get(target);
      if (degree === undefined) {
        continue;
      }

      const nextDegree = degree - 1;
      inDegree.set(target, nextDegree);
      if (nextDegree === 0) {
        queue.push(target);
      }
    }
  }

  return {
    order,
    cyclic: order.length !== workflow.nodes.length
  };
}

function validateNodeConfig(workflow: Workflow): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const webhookRoutes = new Map<string, string>();

  for (const node of workflow.nodes) {
    const config = (node.config ?? {}) as Record<string, unknown>;

    if (node.type === "prompt_template" && typeof config.template !== "string") {
      issues.push({
        code: "missing_template",
        message: "Prompt Template node requires a string template config.",
        nodeId: node.id
      });
    }

    if (node.type === "code_node") {
      if (typeof config.code !== "string" || !config.code.trim()) {
        issues.push({
          code: "missing_code_node_script",
          message: "Code Node requires a non-empty code string.",
          nodeId: node.id
        });
      }
      if (
        config.timeout !== undefined &&
        (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout < 1)
      ) {
        issues.push({
          code: "invalid_code_node_timeout",
          message: "Code Node timeout must be a number >= 1 when provided.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "webhook_input") {
      const path = normalizeWebhookPath(config.path, node.id);
      const methodValue = typeof config.method === "string" ? config.method.trim().toUpperCase() : "POST";
      const method = methodValue || "POST";
      const authMode = typeof config.authMode === "string" ? config.authMode.trim() : "none";

      if (!allowedWebhookMethods.has(method)) {
        issues.push({
          code: "invalid_webhook_method",
          message: "Webhook Input node method must be one of GET, POST, PUT, PATCH, DELETE.",
          nodeId: node.id
        });
      }

      if (!path) {
        issues.push({
          code: "invalid_webhook_path",
          message: "Webhook Input node path cannot be empty.",
          nodeId: node.id
        });
      } else {
        const routeKey = `${method}:${path.toLowerCase()}`;
        const duplicateNodeId = webhookRoutes.get(routeKey);
        if (duplicateNodeId) {
          issues.push({
            code: "duplicate_webhook_route",
            message: `Webhook route '${method} /webhook/${path}' is duplicated by node '${duplicateNodeId}'.`,
            nodeId: node.id
          });
        } else {
          webhookRoutes.set(routeKey, node.id);
        }
      }

      if (!allowedWebhookAuthModes.has(authMode)) {
        issues.push({
          code: "invalid_webhook_auth_mode",
          message: "Webhook Input node authMode must be one of none, bearer_token, hmac_sha256.",
          nodeId: node.id
        });
      }

      if (authMode === "bearer_token" || authMode === "hmac_sha256") {
        const secretRef = (config.secretRef ?? {}) as Record<string, unknown>;
        if (typeof secretRef.secretId !== "string" || !secretRef.secretId.trim()) {
          issues.push({
            code: "missing_webhook_auth_secret",
            message: "Webhook Input node requires secretRef.secretId when authMode is bearer_token or hmac_sha256.",
            nodeId: node.id
          });
        }
      }

      if (authMode === "bearer_token") {
        const authHeaderName = typeof config.authHeaderName === "string" ? config.authHeaderName.trim() : "";
        if (!authHeaderName) {
          issues.push({
            code: "missing_webhook_auth_header_name",
            message: "Webhook Input node requires authHeaderName for bearer_token mode.",
            nodeId: node.id
          });
        }
      }

      if (authMode === "hmac_sha256") {
        const signatureHeaderName =
          typeof config.signatureHeaderName === "string" ? config.signatureHeaderName.trim() : "";
        const timestampHeaderName =
          typeof config.timestampHeaderName === "string" ? config.timestampHeaderName.trim() : "";
        if (!signatureHeaderName || !timestampHeaderName) {
          issues.push({
            code: "missing_webhook_signature_headers",
            message: "Webhook Input node requires signatureHeaderName and timestampHeaderName for hmac_sha256 mode.",
            nodeId: node.id
          });
        }

        if (config.replayToleranceSeconds !== undefined) {
          const replayTolerance = Number(config.replayToleranceSeconds);
          if (!Number.isFinite(replayTolerance) || replayTolerance < 1) {
            issues.push({
              code: "invalid_webhook_replay_tolerance",
              message: "Webhook Input node replayToleranceSeconds must be >= 1.",
              nodeId: node.id
            });
          }
        }
      }

      if (config.idempotencyEnabled === true) {
        const idempotencyHeaderName =
          typeof config.idempotencyHeaderName === "string" ? config.idempotencyHeaderName.trim() : "";
        if (!idempotencyHeaderName) {
          issues.push({
            code: "missing_idempotency_header_name",
            message: "Webhook Input node requires idempotencyHeaderName when idempotency is enabled.",
            nodeId: node.id
          });
        }
      }
    }

    if (node.type === "llm_call") {
      const provider = config.provider as Record<string, unknown> | undefined;
      if (!provider || typeof provider.providerId !== "string" || typeof provider.model !== "string") {
        issues.push({
          code: "missing_llm_provider",
          message: "LLM Call node requires provider.providerId and provider.model.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "agent_orchestrator") {
      const hasAttachedChatModel = workflow.edges.some(
        (edge) => edge.source === node.id && edge.sourceHandle === "chat_model"
      );

      if (!hasAttachedChatModel) {
        issues.push({
          code: "missing_agent_chat_model",
          message: "Agent Orchestrator node requires an attached Chat Model node on chat_model.",
          nodeId: node.id
        });
      }
      if (typeof config.maxIterations !== "number" || config.maxIterations < 1) {
        issues.push({
          code: "invalid_max_iterations",
          message: "Agent Orchestrator node requires maxIterations >= 1.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "local_memory" && config.maxMessages !== undefined) {
      const parsed = Number(config.maxMessages);
      if (!Number.isFinite(parsed) || parsed < 1) {
        issues.push({
          code: "invalid_memory_max_messages",
          message: "Simple Memory node requires maxMessages >= 1 when set.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "mcp_tool") {
      if (typeof config.serverId !== "string" || typeof config.toolName !== "string") {
        issues.push({
          code: "missing_mcp_tool_config",
          message: "MCP Tool node requires serverId and toolName.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "connector_source" && typeof config.connectorId !== "string") {
      issues.push({
        code: "missing_connector_id",
        message: "Connector Source node requires connectorId.",
        nodeId: node.id
      });
    }

    if (node.type === "output_parser") {
      const mode = config.mode;
      if (mode !== "json_schema" && mode !== "item_list" && mode !== "auto_fix") {
        issues.push({
          code: "invalid_output_parser_mode",
          message: "Output Parser node requires mode to be one of json_schema, item_list, auto_fix.",
          nodeId: node.id
        });
      }
      if (mode === "json_schema" && typeof config.jsonSchema !== "string") {
        issues.push({
          code: "missing_output_parser_schema",
          message: "Output Parser node in json_schema mode requires a jsonSchema string.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "human_approval") {
      if (typeof config.approvalMessage !== "string" || !config.approvalMessage.trim()) {
        issues.push({
          code: "missing_human_approval_message",
          message: "Human Approval node requires a non-empty approvalMessage.",
          nodeId: node.id
        });
      }
      if (typeof config.timeoutMinutes !== "number" || !Number.isFinite(config.timeoutMinutes) || config.timeoutMinutes < 1) {
        issues.push({
          code: "invalid_human_approval_timeout",
          message: "Human Approval node requires timeoutMinutes >= 1.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "input_validator") {
      if (!Array.isArray(config.rules) || config.rules.length === 0) {
        issues.push({
          code: "missing_input_validator_rules",
          message: "Input Validator node requires at least one validation rule.",
          nodeId: node.id
        });
      } else {
        for (const [ruleIndex, rawRule] of config.rules.entries()) {
          const rule = (rawRule ?? {}) as Record<string, unknown>;
          const check = typeof rule.check === "string" ? rule.check : "";
          if (typeof rule.field !== "string" || !rule.field.trim()) {
            issues.push({
              code: "invalid_input_validator_rule_field",
              message: `Input Validator rule #${ruleIndex + 1} requires a non-empty field value.`,
              nodeId: node.id
            });
          }
          if (check !== "required" && check !== "max_length" && check !== "regex") {
            issues.push({
              code: "invalid_input_validator_rule_check",
              message: `Input Validator rule #${ruleIndex + 1} check must be one of required, max_length, regex.`,
              nodeId: node.id
            });
          }
        }
      }
      if (config.onFail !== "error" && config.onFail !== "branch") {
        issues.push({
          code: "invalid_input_validator_on_fail",
          message: "Input Validator node onFail must be either 'error' or 'branch'.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "output_guardrail") {
      if (!Array.isArray(config.checks) || config.checks.length === 0) {
        issues.push({
          code: "missing_output_guardrail_checks",
          message: "Output Guardrail node requires at least one check.",
          nodeId: node.id
        });
      } else {
        for (const check of config.checks) {
          if (check !== "no_pii" && check !== "no_profanity" && check !== "must_contain_json") {
            issues.push({
              code: "invalid_output_guardrail_check",
              message: "Output Guardrail checks must be one of no_pii, no_profanity, must_contain_json.",
              nodeId: node.id
            });
            break;
          }
        }
      }
      if (config.onFail !== "retry" && config.onFail !== "error") {
        issues.push({
          code: "invalid_output_guardrail_on_fail",
          message: "Output Guardrail node onFail must be either 'retry' or 'error'.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "if_node") {
      if (typeof config.condition !== "string" || !config.condition.trim()) {
        issues.push({
          code: "missing_if_condition",
          message: "IF node requires a condition expression.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "switch_node") {
      if (typeof config.switchValue !== "string" || !config.switchValue.trim()) {
        issues.push({
          code: "missing_switch_value",
          message: "Switch node requires a switchValue expression.",
          nodeId: node.id
        });
      }
      if (!Array.isArray(config.cases) || config.cases.length === 0) {
        issues.push({
          code: "missing_switch_cases",
          message: "Switch node requires at least one case.",
          nodeId: node.id
        });
      }
    }
  }

  for (const edge of workflow.edges) {
    if (!isAgentAttachmentEdge(edge)) {
      continue;
    }

    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);

    if (!sourceNode || !targetNode) {
      continue;
    }

    if (sourceNode.type !== "agent_orchestrator") {
      issues.push({
        code: "invalid_attachment_source",
        message: "Attachment handles chat_model/memory/tool are only valid when source is an Agent Orchestrator node.",
        edgeId: edge.id
      });
      continue;
    }

    if (edge.sourceHandle === "chat_model" && targetNode.type !== "llm_call") {
      issues.push({
        code: "invalid_chat_model_attachment",
        message: "Agent chat_model attachment must target an LLM Call node.",
        edgeId: edge.id
      });
    }

    if (edge.sourceHandle === "memory" && targetNode.type !== "local_memory") {
      issues.push({
        code: "invalid_memory_attachment",
        message: "Agent memory attachment must target a Simple Memory node.",
        edgeId: edge.id
      });
    }

    if (edge.sourceHandle === "tool" && targetNode.type !== "mcp_tool") {
      issues.push({
        code: "invalid_tool_attachment",
        message: "Agent tool attachment must target an MCP Tool node.",
        edgeId: edge.id
      });
    }
  }

  return issues;
}

export function validateWorkflowGraph(rawWorkflow: unknown): WorkflowValidationResult {
  const parsed = workflowSchema.safeParse(rawWorkflow);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: `${issue.path.join(".")}: ${issue.message}`
      }))
    };
  }

  const workflow = parsed.data;
  const issues: WorkflowValidationIssue[] = [];
  const nodeIds = new Set<string>();

  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        message: `Duplicate node id '${node.id}'`,
        nodeId: node.id
      });
    }
    nodeIds.add(node.id);
  }

  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.source)) {
      issues.push({
        code: "missing_edge_source",
        message: `Edge source '${edge.source}' does not exist`,
        edgeId: edge.id
      });
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({
        code: "missing_edge_target",
        message: `Edge target '${edge.target}' does not exist`,
        edgeId: edge.id
      });
    }
    if (edge.source === edge.target) {
      issues.push({
        code: "self_edge",
        message: `Self-referencing edge '${edge.id}' is not allowed`,
        edgeId: edge.id
      });
    }
  }

  const outputNodes = workflow.nodes.filter((node) => node.type === "output");
  if (!outputNodes.length) {
    issues.push({
      code: "missing_output_node",
      message: "Workflow must include at least one Output node."
    });
  }

  issues.push(...validateNodeConfig(workflow));

  const topology = topoSort(workflow);
  if (topology.cyclic) {
    issues.push({
      code: "cycle_detected",
      message: "Workflow graph contains a cycle. V1 supports DAG execution only."
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    orderedNodeIds: topology.order
  };
}

export function sortWorkflowNodes(workflow: Workflow): string[] {
  const topology = topoSort(workflow);
  if (topology.cyclic) {
    throw new Error("Workflow graph contains a cycle");
  }
  return topology.order;
}
