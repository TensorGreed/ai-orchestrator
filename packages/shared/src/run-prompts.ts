/**
 * Which of a run's two prompt fields, `user_prompt` and `system_prompt`, a workflow can read. The editor's Run button
 * sends its built-in prompts only to workflows that read them, so a workflow that never does (an HTTP call and an
 * Output, say) does not get a stray question in its run input, its outputs or its records.
 *
 * Mirrors the workflow engine's handlers (packages/workflow-engine/src/executor.ts and connectors/triggers.ts), and
 * errs on the side of "reads": a node counts when
 *   - it is a type whose handler falls back to the run's prompt when its own input has none (`IMPLICIT_*` below),
 *   - it is a type whose template defaults to `{{user_prompt}}` and it sets no template of its own, or
 *   - any text in its settings names `user_prompt` / `system_prompt`: a template, a key to read, code, a rule field.
 * Handlers that only pass the whole input along (an Output with no answer to show, a Code node, a Sub-workflow
 * Trigger) do not count by themselves: there the prompt is not something the workflow asked for.
 */

export interface RunPromptReads {
  userPrompt: boolean;
  systemPrompt: boolean;
}

export interface RunPromptNode {
  type: string;
  config?: unknown;
}

/** Handlers that read the run's `user_prompt` when their own input has no prompt (or always, for the input nodes). */
const IMPLICIT_USER_PROMPT_READERS: ReadonlySet<string> = new Set([
  // The run's prompt wins over the node's saved text (resolveRuntimeUserPrompt).
  "text_input",
  "user_prompt",
  // The chat message falls back to the run's prompt.
  "chat_trigger",
  // promptRead(templateData, [promptKey, "user_prompt"]).
  "llm_call",
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model",
  "basic_llm_chain",
  "qa_chain",
  // inputKey defaults to user_prompt, and falls back to it.
  "embeddings_azure_openai",
  // userPromptTemplate defaults to {{user_prompt}}, and an empty prompt falls back to the run's.
  "agent_orchestrator",
  "supervisor_node"
]);

/** Handlers that read the run's `system_prompt` when their own input has none. */
const IMPLICIT_SYSTEM_PROMPT_READERS: ReadonlySet<string> = new Set([
  // promptRead(templateData, [systemPromptKey]) with systemPromptKey defaulting to system_prompt.
  "llm_call",
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model",
  "basic_llm_chain",
  // systemPromptTemplate defaults to {{system_prompt}}.
  "agent_orchestrator",
  "supervisor_node"
]);

/** Node types whose template setting defaults to `{{user_prompt}}`, and when the default applies. */
const DEFAULT_USER_PROMPT_TEMPLATES: Readonly<Record<string, (config: Record<string, unknown>) => boolean>> = {
  prompt_template: (config) => typeof config.template !== "string",
  rag_retrieve: (config) => typeof config.queryTemplate !== "string",
  rerank: (config) => typeof config.queryTemplate !== "string",
  chat_intent_router: (config) => typeof config.inputTemplate !== "string" || !config.inputTemplate.trim()
};

const MAX_SCAN_DEPTH = 12;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Whether any text value in `value` (keys are names, not reads) contains `needle`. */
function mentions(value: unknown, needle: string, depth = 0): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (depth >= MAX_SCAN_DEPTH || !value || typeof value !== "object") return false;
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return entries.some((entry) => mentions(entry, needle, depth + 1));
}

/** Which run prompts the nodes can read. */
export function runPromptReads(nodes: ReadonlyArray<RunPromptNode>): RunPromptReads {
  let userPrompt = false;
  let systemPrompt = false;
  for (const node of nodes) {
    const config = asRecord(node.config);
    if (!userPrompt) {
      userPrompt =
        IMPLICIT_USER_PROMPT_READERS.has(node.type) ||
        DEFAULT_USER_PROMPT_TEMPLATES[node.type]?.(config) === true ||
        mentions(config, "user_prompt");
    }
    if (!systemPrompt) {
      systemPrompt =
        IMPLICIT_SYSTEM_PROMPT_READERS.has(node.type) ||
        // A System Prompt node reads the run's prompt only when it has no text of its own.
        (node.type === "system_prompt" && typeof config.text !== "string") ||
        mentions(config, "system_prompt");
    }
    if (userPrompt && systemPrompt) break;
  }
  return { userPrompt, systemPrompt };
}

function hasText(node: RunPromptNode): boolean {
  const text = asRecord(node.config).text;
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * Which of its built-in prompts the editor sends with a run. A Text Input or User Prompt node with text, or a System
 * Prompt node with text, keeps that prompt out (the run's prompt would replace the node's text); otherwise a prompt
 * is sent when the workflow can read it.
 */
export function editorRunPrompts(nodes: ReadonlyArray<RunPromptNode>): { sendUserPrompt: boolean; sendSystemPrompt: boolean } {
  const reads = runPromptReads(nodes);
  const userFromNodes = nodes.some((node) => (node.type === "text_input" || node.type === "user_prompt") && hasText(node));
  const systemFromNodes = nodes.some((node) => node.type === "system_prompt" && hasText(node));
  return { sendUserPrompt: reads.userPrompt && !userFromNodes, sendSystemPrompt: reads.systemPrompt && !systemFromNodes };
}
