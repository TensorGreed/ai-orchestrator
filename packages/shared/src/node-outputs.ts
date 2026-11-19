/**
 * What the common nodes output: the fields a later step reads with `{{field}}` (a step connected straight in) or
 * `{{results.<nodeId>.field}}` (any earlier step). The node reference docs list them, Describe it shows them to the
 * model and checks every `{{ }}` path of a draft against them, and the editor's autocomplete leaves out the older
 * aliases. Fields starting with `_` are the engine's own bookkeeping (usage, routing) and are never listed.
 *
 * The lists mirror the engine's handlers (packages/workflow-engine/src/executor.ts); a test there runs the common closed
 * nodes (template-paths.test.ts) and checks that every key they output is listed.
 */
import type { NodeDefinition, NodeOutputField, NodeOutputSpec } from "./types";

const field = (name: string, description: string): NodeOutputField => ({ name, description });

/** Every model call node (LLM Call, the chat model nodes, the AI chains): the answer and what came with it. */
const MODEL_FIELDS: NodeOutputField[] = [
  field("answer", "The model's answer as text. Read it with {{answer}}."),
  field("toolCalls", "Tools the model asked to call, when it asked for any."),
  field("raw", "The provider's raw response.")
];

/** `text` is the same value as `answer`: kept so workflows that read it keep working. */
const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({ text: "answer" });

const modelOutput = (extra: NodeOutputField[] = []): NodeOutputSpec => ({
  fields: [MODEL_FIELDS[0]!, ...extra, ...MODEL_FIELDS.slice(1)],
  closed: true,
  aliases: MODEL_ALIASES
});

const MODEL_NODE_TYPES = [
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
  "summarization_chain"
] as const;

const AGENT_OUTPUT: NodeOutputSpec = {
  fields: [
    field("answer", "The agent's final answer as text."),
    field("iterations", "How many model turns it took."),
    field("stopReason", "Why the agent stopped (final_answer, max_iterations, clarification_requested...)."),
    field("steps", "Each turn: what the model asked for and the tools it called."),
    field("messages", "The whole conversation with the model."),
    field("clarification", "The question the agent asked back, when it paused to ask one.")
  ],
  closed: true
};

export const NODE_OUTPUT_SPECS: Readonly<Record<string, NodeOutputSpec>> = Object.freeze({
  ...Object.fromEntries(MODEL_NODE_TYPES.map((type) => [type, modelOutput()])),
  information_extractor: modelOutput([field("extracted", "The extracted data (parsed JSON when the model answered JSON).")]),
  text_classifier: modelOutput([field("classification", "The classification (parsed JSON when the model answered JSON).")]),
  sentiment_analysis: modelOutput([field("sentiment", "The sentiment (parsed JSON when the model answered JSON).")]),
  ai_transform: modelOutput([field("transformed", "The transformed input (parsed JSON when the output format is json).")]),
  agent_orchestrator: AGENT_OUTPUT,
  supervisor_node: AGENT_OUTPUT,
  prompt_template: {
    fields: [field("prompt", "The rendered template.")],
    closed: true,
    note: "Also under the name set in Output Key, when one is set."
  },
  http_request: {
    fields: [
      field("status", "The HTTP status code."),
      field("ok", "true for a 2xx status."),
      field("headers", "The response headers (lower-case names)."),
      field("body", "The response body: parsed JSON when the response is JSON, else text.")
    ],
    closed: true
  },
  rag_retrieve: {
    fields: [
      field("query", "The query that was searched."),
      field("documents", "The chunks found, best first."),
      field("context", "The chunks joined as one text, ready for a prompt."),
      field("citationInstructions", "Instructions that ask the model to cite chunks as [1], [2]..."),
      field("contentRules", "What content rules did to the chunks, when they apply.")
    ],
    closed: true
  },
  set_node: {
    fields: [],
    closed: true,
    note: "One field per row, named by the row's key (only those fields)."
  },
  output: {
    fields: [field("result", "The value the workflow returns.")],
    closed: true,
    note: "Also under the name set in Output Key, when one is set."
  },
  webhook_response: {
    fields: [field("result", "The body sent to the caller.")],
    closed: true
  },
  schedule_trigger: {
    fields: [
      field("trigger_type", "How the run started (cron for a scheduled run)."),
      field("scheduled_at", "When the run started (ISO time)."),
      field("schedule", "The schedule's cron expression, time zone and on/off state.")
    ],
    closed: true
  },
  webhook_input: {
    fields: [],
    closed: false,
    note: "The request's JSON body fields (only the Pass-through fields when set). {{webhook.<field>}} reads them from any step."
  },
  manual_trigger: { fields: [], closed: false, note: "The run's input. {{user_prompt}} reads the prompt the run was given." },
  form_trigger: { fields: [], closed: false, note: "One field per form field, named by its key." },
  chat_trigger: { fields: [], closed: false, note: "The chat message: {{message}} (also {{user_prompt}}) and {{session_id}}." },
  if_node: {
    fields: [field("result", "Whether the condition was true."), field("evaluatedValue", "What the condition evaluated to.")],
    closed: false,
    note: "Also passes on the item it received."
  },
  switch_node: {
    fields: [field("matched", "The label of the case that matched (or the default label)."), field("evaluatedValue", "The value that was compared.")],
    closed: false,
    note: "Also passes on the item it received."
  },
  filter_node: { fields: [], closed: false, note: "The items that passed, as received." },
  merge_node: { fields: [], closed: false, note: "The fields of every input, combined as the mode says." },
  loop_node: { fields: [], closed: false, note: "Each pass's results, collected; inside the loop body {{item}} is the current item." },
  code_node: { fields: [], closed: false, note: "Whatever the code returns." },
  mcp_tool: {
    fields: [
      field("tool_output", "What the tool returned."),
      field("structured", "The tool's structured result, when it has an output schema."),
      field("content", "The tool's content blocks."),
      field("tool_name", "The tool that was called.")
    ],
    closed: false
  }
});

/** The definitions with their output fields (for the node types listed above). */
export function withOutputSpecs(definitions: NodeDefinition[]): NodeDefinition[] {
  return definitions.map((definition) => {
    const outputs = NODE_OUTPUT_SPECS[definition.type];
    return outputs ? { ...definition, outputs } : definition;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every field name a node of this type with this config outputs (the fields, their aliases and the fields a setting
 * names), or null when the node's output is open or not described: then any field may be there.
 */
export function nodeOutputFieldNames(type: string, config: unknown): Set<string> | null {
  const spec = NODE_OUTPUT_SPECS[type];
  if (!spec || !spec.closed) return null;
  const names = new Set(spec.fields.map((entry) => entry.name));
  for (const alias of Object.keys(spec.aliases ?? {})) names.add(alias);
  const settings = isRecord(config) ? config : {};
  if ((type === "prompt_template" || type === "output") && typeof settings.outputKey === "string" && settings.outputKey.trim()) {
    names.add(settings.outputKey.trim());
  }
  if (type === "set_node" && Array.isArray(settings.assignments)) {
    for (const row of settings.assignments) {
      if (isRecord(row) && typeof row.key === "string" && row.key.trim()) names.add(row.key.trim());
    }
  }
  return names;
}

/** The alias fields of a node type (`text` for the model nodes): older names the editor no longer offers. */
export function nodeOutputAliases(type: string): Readonly<Record<string, string>> {
  return NODE_OUTPUT_SPECS[type]?.aliases ?? {};
}
