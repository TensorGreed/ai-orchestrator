import { workflowSchema, type Workflow, type WorkflowValidationIssue, type WorkflowValidationResult } from "@ai-orchestrator/shared";
import { isAgentAttachmentEdge, isExecutionEdge } from "./graph";

interface GraphMetadata {
  inDegree: Map<string, number>;
  outgoing: Map<string, string[]>;
}

const allowedWebhookMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const allowedWebhookAuthModes = new Set(["none", "bearer_token", "hmac_sha256"]);
const allowedHttpRequestMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const allowedOutputParserParsingModes = new Set(["strict", "lenient", "anything_goes"]);
const agentPrimaryInputNodeTypes = new Set(["webhook_input", "text_input", "user_prompt"]);
const chatModelNodeTypes = new Set([
  "llm_call",
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model"
]);

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

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
  let head = 0;
  while (head < queue.length) {
    const nodeId = queue[head++];
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
  const incomingExecutionCount = new Map<string, number>();

  for (const node of workflow.nodes) {
    incomingExecutionCount.set(node.id, 0);
  }
  for (const edge of workflow.edges.filter(isExecutionEdge)) {
    incomingExecutionCount.set(edge.target, (incomingExecutionCount.get(edge.target) ?? 0) + 1);
  }

  for (const node of workflow.nodes) {
    const config = (node.config ?? {}) as Record<string, unknown>;

    if (node.type === "schedule_trigger") {
      const cronExpression = typeof config.cronExpression === "string" ? config.cronExpression.trim() : "";
      const timezone = typeof config.timezone === "string" ? config.timezone.trim() : "";

      if (!cronExpression) {
        issues.push({
          code: "missing_schedule_cron_expression",
          message: "Schedule Trigger node requires a non-empty cronExpression.",
          nodeId: node.id
        });
      } else {
        const tokenCount = cronExpression.split(/\s+/).filter(Boolean).length;
        if (tokenCount < 5 || tokenCount > 6) {
          issues.push({
            code: "invalid_schedule_cron_expression",
            message: "Schedule Trigger node cronExpression must use 5 or 6 cron fields.",
            nodeId: node.id
          });
        }
      }

      if (!timezone || !isValidTimeZone(timezone)) {
        issues.push({
          code: "invalid_schedule_timezone",
          message: "Schedule Trigger node requires a valid IANA timezone.",
          nodeId: node.id
        });
      }

      if (config.active !== undefined && typeof config.active !== "boolean") {
        issues.push({
          code: "invalid_schedule_active",
          message: "Schedule Trigger node active must be a boolean when provided.",
          nodeId: node.id
        });
      }
    }

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

    if (node.type === "http_request") {
      const method = typeof config.method === "string" ? config.method.trim().toUpperCase() : "";
      if (!allowedHttpRequestMethods.has(method)) {
        issues.push({
          code: "invalid_http_request_method",
          message: "HTTP Request node method must be one of GET, POST, PUT, PATCH, DELETE.",
          nodeId: node.id
        });
      }

      if (typeof config.urlTemplate !== "string" || !config.urlTemplate.trim()) {
        issues.push({
          code: "missing_http_request_url_template",
          message: "HTTP Request node requires a non-empty urlTemplate.",
          nodeId: node.id
        });
      }

      if (config.responseType !== undefined && config.responseType !== "json" && config.responseType !== "text") {
        issues.push({
          code: "invalid_http_request_response_type",
          message: "HTTP Request node responseType must be either 'json' or 'text'.",
          nodeId: node.id
        });
      }

      if (
        config.timeoutMs !== undefined &&
        (typeof config.timeoutMs !== "number" || !Number.isFinite(config.timeoutMs) || config.timeoutMs < 1)
      ) {
        issues.push({
          code: "invalid_http_request_timeout_ms",
          message: "HTTP Request node timeoutMs must be a number >= 1.",
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

    if (
      node.type === "openai_chat_model" ||
      node.type === "anthropic_chat_model" ||
      node.type === "ollama_chat_model" ||
      node.type === "openai_compatible_chat_model" ||
      node.type === "ai_gateway_chat_model"
    ) {
      const model = typeof config.model === "string" ? config.model.trim() : "";
      if (!model) {
        issues.push({
          code: "missing_chat_model_model",
          message: `${node.name || node.type} requires model.`,
          nodeId: node.id
        });
      }

      if (node.type === "openai_compatible_chat_model" || node.type === "ai_gateway_chat_model") {
        const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
        if (!baseUrl) {
          issues.push({
            code: "missing_chat_gateway_base_url",
            message: `${node.name || node.type} requires baseUrl.`,
            nodeId: node.id
          });
        }
      }

      if (node.type === "ai_gateway_chat_model") {
        const apiProvider = typeof config.apiProvider === "string" ? config.apiProvider.trim() : "";
        if (!["openai_compatible", "openai", "anthropic"].includes(apiProvider)) {
          issues.push({
            code: "invalid_chat_gateway_provider",
            message: "AI Gateway Chat Model apiProvider must be openai_compatible, openai, or anthropic.",
            nodeId: node.id
          });
        }
      }
    }

    if (node.type === "azure_openai_chat_model") {
      const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
      const deployment = typeof config.deployment === "string" ? config.deployment.trim() : "";
      const secretRef = toRecord(config.secretRef);
      const secretId = typeof secretRef.secretId === "string" ? secretRef.secretId.trim() : "";

      if (!endpoint) {
        issues.push({
          code: "missing_azure_openai_endpoint",
          message: "Azure OpenAI Chat Model node requires endpoint.",
          nodeId: node.id
        });
      }

      if (!deployment) {
        issues.push({
          code: "missing_azure_openai_deployment",
          message: "Azure OpenAI Chat Model node requires deployment.",
          nodeId: node.id
        });
      }

      if (!secretId) {
        issues.push({
          code: "missing_azure_openai_secret",
          message: "Azure OpenAI Chat Model node requires secretRef.secretId.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "google_gemini_chat_model") {
      const model = typeof config.model === "string" ? config.model.trim() : "";

      if (!model) {
        issues.push({
          code: "missing_gemini_model",
          message: "Google Gemini Chat Model node requires model.",
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
      const toolLimitRules = [
        {
          key: "toolMessageMaxChars",
          min: 500,
          max: 1_000_000,
          code: "invalid_tool_message_max_chars",
          message: "Agent Orchestrator toolMessageMaxChars must be between 500 and 1000000."
        },
        {
          key: "toolPayloadMaxDepth",
          min: 1,
          max: 16,
          code: "invalid_tool_payload_max_depth",
          message: "Agent Orchestrator toolPayloadMaxDepth must be between 1 and 16."
        },
        {
          key: "toolPayloadMaxObjectKeys",
          min: 1,
          max: 5000,
          code: "invalid_tool_payload_max_object_keys",
          message: "Agent Orchestrator toolPayloadMaxObjectKeys must be between 1 and 5000."
        },
        {
          key: "toolPayloadMaxArrayItems",
          min: 1,
          max: 5000,
          code: "invalid_tool_payload_max_array_items",
          message: "Agent Orchestrator toolPayloadMaxArrayItems must be between 1 and 5000."
        },
        {
          key: "toolPayloadMaxStringChars",
          min: 100,
          max: 1_000_000,
          code: "invalid_tool_payload_max_string_chars",
          message: "Agent Orchestrator toolPayloadMaxStringChars must be between 100 and 1000000."
        }
      ] as const;

      for (const rule of toolLimitRules) {
        const rawValue = config[rule.key];
        if (rawValue === undefined) {
          continue;
        }
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed) || parsed < rule.min || parsed > rule.max) {
          issues.push({
            code: rule.code,
            message: rule.message,
            nodeId: node.id
          });
        }
      }

      const incomingPrimaryInputTypes = new Set<string>();
      for (const edge of workflow.edges.filter(isExecutionEdge)) {
        if (edge.target !== node.id) {
          continue;
        }
        const sourceType = nodeById.get(edge.source)?.type;
        if (sourceType && agentPrimaryInputNodeTypes.has(sourceType)) {
          incomingPrimaryInputTypes.add(sourceType);
        }
      }

      if (incomingPrimaryInputTypes.size > 1) {
        issues.push({
          code: "mixed_agent_primary_inputs",
          message: `Agent Orchestrator node can only use one primary input type. Found: ${[...incomingPrimaryInputTypes]
            .sort()
            .join(", ")}.`,
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

      const connection = toRecord(config.connection);
      if (connection.timeoutMs !== undefined) {
        const timeoutMs = Number(connection.timeoutMs);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
          issues.push({
            code: "invalid_mcp_timeout_ms",
            message: "MCP Tool node connection.timeoutMs must be a number >= 1000 when set.",
            nodeId: node.id
          });
        }
      }
    }

    if (node.type === "connector_source" && typeof config.connectorId !== "string") {
      issues.push({
        code: "missing_connector_id",
        message: "Connector Source node requires connectorId.",
        nodeId: node.id
      });
    }

    if (node.type === "google_drive_source" && config.maxFiles !== undefined) {
      const parsed = Number(config.maxFiles);
      if (!Number.isFinite(parsed) || parsed < 1) {
        issues.push({
          code: "invalid_google_drive_max_files",
          message: "Google Drive Source node maxFiles must be >= 1 when set.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "azure_storage") {
      const operation = typeof config.operation === "string" ? config.operation.trim() : "";
      if (!operation) {
        issues.push({
          code: "missing_azure_storage_operation",
          message: "Azure Storage node requires operation.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "azure_cosmos_db") {
      const operation = typeof config.operation === "string" ? config.operation.trim() : "";
      if (!operation) {
        issues.push({
          code: "missing_azure_cosmos_operation",
          message: "Azure Cosmos DB node requires operation.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "azure_monitor_http") {
      const operation = typeof config.operation === "string" ? config.operation.trim() : "";
      if (!operation) {
        issues.push({
          code: "missing_azure_monitor_operation",
          message: "Microsoft Azure Monitor node requires operation.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "azure_ai_search_vector_store") {
      const operation = typeof config.operation === "string" ? config.operation.trim() : "";
      if (!operation) {
        issues.push({
          code: "missing_azure_ai_search_operation",
          message: "Azure AI Search Vector Store node requires operation.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "qdrant_vector_store") {
      const operation = typeof config.operation === "string" ? config.operation.trim() : "";
      if (!operation) {
        issues.push({
          code: "missing_qdrant_operation",
          message: "Qdrant Vector Store node requires operation.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "embeddings_azure_openai") {
      const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
      const deployment = typeof config.deployment === "string" ? config.deployment.trim() : "";
      if (!endpoint || !deployment) {
        issues.push({
          code: "missing_azure_embedding_config",
          message: "Embeddings Azure OpenAI node requires endpoint and deployment.",
          nodeId: node.id
        });
      }
      const secretRef = toRecord(config.secretRef);
      if (typeof secretRef.secretId !== "string" || !secretRef.secretId.trim()) {
        issues.push({
          code: "missing_azure_embedding_secret",
          message: "Embeddings Azure OpenAI node requires secretRef.secretId.",
          nodeId: node.id
        });
      }
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
      if (
        config.parsingMode !== undefined &&
        (typeof config.parsingMode !== "string" || !allowedOutputParserParsingModes.has(config.parsingMode))
      ) {
        issues.push({
          code: "invalid_output_parser_parsing_mode",
          message: "Output Parser parsingMode must be one of strict, lenient, anything_goes.",
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

    if (node.type === "loop_node") {
      if (typeof config.inputKey !== "string" || !config.inputKey.trim()) {
        issues.push({
          code: "missing_loop_input_key",
          message: "Loop / ForEach node requires a non-empty inputKey.",
          nodeId: node.id
        });
      }

      if (typeof config.itemVariable !== "string" || !config.itemVariable.trim()) {
        issues.push({
          code: "missing_loop_item_variable",
          message: "Loop / ForEach node requires a non-empty itemVariable.",
          nodeId: node.id
        });
      }

      if (
        config.maxIterations !== undefined &&
        (typeof config.maxIterations !== "number" || !Number.isFinite(config.maxIterations) || config.maxIterations < 1)
      ) {
        issues.push({
          code: "invalid_loop_max_iterations",
          message: "Loop / ForEach node maxIterations must be >= 1 when provided.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "merge_node") {
      if (config.mode !== "append" && config.mode !== "combine_by_key" && config.mode !== "choose_branch") {
        issues.push({
          code: "invalid_merge_mode",
          message: "Merge node mode must be one of append, combine_by_key, choose_branch.",
          nodeId: node.id
        });
      }

      if (config.mode === "combine_by_key" && (typeof config.combineKey !== "string" || !config.combineKey.trim())) {
        issues.push({
          code: "missing_merge_combine_key",
          message: "Merge node in combine_by_key mode requires combineKey.",
          nodeId: node.id
        });
      }

      if ((incomingExecutionCount.get(node.id) ?? 0) < 2) {
        issues.push({
          code: "merge_requires_multiple_parents",
          message: "Merge node requires at least two incoming execution edges.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "execute_workflow") {
      if (typeof config.workflowId !== "string" || !config.workflowId.trim()) {
        issues.push({
          code: "missing_execute_workflow_id",
          message: "Execute Workflow node requires workflowId.",
          nodeId: node.id
        });
      }

      if (config.inputMapping !== undefined) {
        const mapping = config.inputMapping;
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
          issues.push({
            code: "invalid_execute_workflow_input_mapping",
            message: "Execute Workflow node inputMapping must be an object map of parentKey -> childKey.",
            nodeId: node.id
          });
        } else {
          for (const [parentKey, childKey] of Object.entries(mapping as Record<string, unknown>)) {
            if (!parentKey.trim() || typeof childKey !== "string" || !childKey.trim()) {
              issues.push({
                code: "invalid_execute_workflow_mapping_entry",
                message: "Execute Workflow inputMapping entries must be non-empty parentKey -> childKey string pairs.",
                nodeId: node.id
              });
              break;
            }
          }
        }
      }
    }

    if (node.type === "wait_node") {
      const delayMs = Number(config.delayMs ?? 1000);
      const maxDelayMs = Number(config.maxDelayMs ?? 30000);
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        issues.push({
          code: "invalid_wait_delay_ms",
          message: "Wait node delayMs must be a number >= 0.",
          nodeId: node.id
        });
      }
      if (!Number.isFinite(maxDelayMs) || maxDelayMs < 1) {
        issues.push({
          code: "invalid_wait_max_delay_ms",
          message: "Wait node maxDelayMs must be a number >= 1.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "set_node") {
      if (!Array.isArray(config.assignments) || config.assignments.length === 0) {
        issues.push({
          code: "missing_set_node_assignments",
          message: "Set / Transform node requires at least one assignment.",
          nodeId: node.id
        });
      } else {
        for (const [assignmentIndex, assignment] of config.assignments.entries()) {
          const entry = (assignment ?? {}) as Record<string, unknown>;
          if (typeof entry.key !== "string" || !entry.key.trim()) {
            issues.push({
              code: "invalid_set_node_assignment_key",
              message: `Set / Transform assignment #${assignmentIndex + 1} requires a non-empty key.`,
              nodeId: node.id
            });
            break;
          }
          if (typeof entry.valueTemplate !== "string") {
            issues.push({
              code: "invalid_set_node_assignment_template",
              message: `Set / Transform assignment #${assignmentIndex + 1} requires a valueTemplate string.`,
              nodeId: node.id
            });
            break;
          }
        }
      }
    }

    if (node.type === "webhook_response") {
      if (
        config.statusCode !== undefined &&
        (typeof config.statusCode !== "number" || !Number.isFinite(config.statusCode) || config.statusCode < 100 || config.statusCode > 599)
      ) {
        issues.push({
          code: "invalid_webhook_response_status_code",
          message: "Webhook Response node statusCode must be between 100 and 599.",
          nodeId: node.id
        });
      }
      if (config.headersTemplate !== undefined && typeof config.headersTemplate !== "string") {
        issues.push({
          code: "invalid_webhook_response_headers_template",
          message: "Webhook Response node headersTemplate must be a string.",
          nodeId: node.id
        });
      }
      if (config.bodyTemplate !== undefined && typeof config.bodyTemplate !== "string") {
        issues.push({
          code: "invalid_webhook_response_body_template",
          message: "Webhook Response node bodyTemplate must be a string.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "pdf_output") {
      if (
        config.renderMode !== undefined &&
        config.renderMode !== "text" &&
        config.renderMode !== "html"
      ) {
        issues.push({
          code: "invalid_pdf_output_render_mode",
          message: "PDF Output node renderMode must be either 'text' or 'html'.",
          nodeId: node.id
        });
      }
      if (config.inputKey !== undefined && (typeof config.inputKey !== "string" || !config.inputKey.trim())) {
        issues.push({
          code: "invalid_pdf_output_input_key",
          message: "PDF Output node inputKey must be a non-empty string when provided.",
          nodeId: node.id
        });
      }
      if (config.textTemplate !== undefined && typeof config.textTemplate !== "string") {
        issues.push({
          code: "invalid_pdf_output_text_template",
          message: "PDF Output node textTemplate must be a string when provided.",
          nodeId: node.id
        });
      }
      if (config.htmlTemplate !== undefined && typeof config.htmlTemplate !== "string") {
        issues.push({
          code: "invalid_pdf_output_html_template",
          message: "PDF Output node htmlTemplate must be a string when provided.",
          nodeId: node.id
        });
      }
      if (
        config.pageFormat !== undefined &&
        config.pageFormat !== "A4" &&
        config.pageFormat !== "Letter" &&
        config.pageFormat !== "Legal" &&
        config.pageFormat !== "A3" &&
        config.pageFormat !== "A5"
      ) {
        issues.push({
          code: "invalid_pdf_output_page_format",
          message: "PDF Output node pageFormat must be one of: A4, Letter, Legal, A3, A5.",
          nodeId: node.id
        });
      }
      if (config.printBackground !== undefined && typeof config.printBackground !== "boolean") {
        issues.push({
          code: "invalid_pdf_output_print_background",
          message: "PDF Output node printBackground must be a boolean when provided.",
          nodeId: node.id
        });
      }
      if (
        config.htmlRenderTimeoutMs !== undefined &&
        (typeof config.htmlRenderTimeoutMs !== "number" ||
          !Number.isFinite(config.htmlRenderTimeoutMs) ||
          config.htmlRenderTimeoutMs < 1000)
      ) {
        issues.push({
          code: "invalid_pdf_output_html_render_timeout",
          message: "PDF Output node htmlRenderTimeoutMs must be a number >= 1000 when provided.",
          nodeId: node.id
        });
      }
      if (
        config.filenameTemplate !== undefined &&
        (typeof config.filenameTemplate !== "string" || !config.filenameTemplate.trim())
      ) {
        issues.push({
          code: "invalid_pdf_output_filename_template",
          message: "PDF Output node filenameTemplate must be a non-empty string when provided.",
          nodeId: node.id
        });
      }
      if (config.outputKey !== undefined && (typeof config.outputKey !== "string" || !config.outputKey.trim())) {
        issues.push({
          code: "invalid_pdf_output_output_key",
          message: "PDF Output node outputKey must be a non-empty string when provided.",
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

    if (sourceNode.type !== "agent_orchestrator" && sourceNode.type !== "supervisor_node") {
      issues.push({
        code: "invalid_attachment_source",
        message: "Attachment handles chat_model/memory/tool/worker are only valid when source is an Agent Orchestrator or Supervisor node.",
        edgeId: edge.id
      });
      continue;
    }

    if (edge.sourceHandle === "chat_model" && !chatModelNodeTypes.has(targetNode.type)) {
      issues.push({
        code: "invalid_chat_model_attachment",
        message: "Agent chat_model attachment must target a Chat Model node.",
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

    if (
      edge.sourceHandle === "worker" &&
      targetNode.type !== "agent_orchestrator" &&
      targetNode.type !== "supervisor_node"
    ) {
      issues.push({
        code: "invalid_worker_attachment",
        message: "Supervisor worker attachment must target an Agent Orchestrator or Supervisor node.",
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

export function computeDepthLevels(
  order: string[],
  incomingExecution: Map<string, string[]>
): string[][] {
  const depth = new Map<string, number>();
  const levels: string[][] = [];

  for (const nodeId of order) {
    const parents = incomingExecution.get(nodeId) ?? [];
    let maxParentDepth = -1;
    for (const p of parents) {
      maxParentDepth = Math.max(maxParentDepth, depth.get(p) ?? -1);
    }
    const d = maxParentDepth + 1;
    depth.set(nodeId, d);
    while (levels.length <= d) levels.push([]);
    levels[d].push(nodeId);
  }
  return levels;
}
