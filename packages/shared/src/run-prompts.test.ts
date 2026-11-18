import { describe, expect, it } from "vitest";
import { editorRunPrompts, runPromptReads } from "./run-prompts";

describe("runPromptReads", () => {
  it("finds nothing in a workflow that never reads the prompts", () => {
    expect(
      runPromptReads([
        { type: "manual_trigger", config: {} },
        { type: "http_request", config: { url: "https://example.test/{{vars.path}}", method: "GET" } },
        { type: "code_node", config: { code: "return { total: input.items.length };" } },
        { type: "output", config: {} },
        { type: "pdf_output", config: { inputKey: "result" } }
      ])
    ).toEqual({ userPrompt: false, systemPrompt: false });
    expect(runPromptReads([])).toEqual({ userPrompt: false, systemPrompt: false });
  });

  it("counts the handlers that fall back to the run's prompts", () => {
    for (const type of ["llm_call", "azure_openai_chat_model", "google_gemini_chat_model", "anthropic_chat_model", "basic_llm_chain", "agent_orchestrator", "supervisor_node"]) {
      expect(runPromptReads([{ type, config: {} }]), type).toEqual({ userPrompt: true, systemPrompt: true });
    }
    for (const type of ["text_input", "user_prompt", "chat_trigger", "qa_chain", "embeddings_azure_openai"]) {
      expect(runPromptReads([{ type, config: {} }]), type).toEqual({ userPrompt: true, systemPrompt: false });
    }
  });

  it("counts a {{user_prompt}} template default only while the node sets none", () => {
    for (const [type, field] of [["prompt_template", "template"], ["rag_retrieve", "queryTemplate"], ["rerank", "queryTemplate"], ["chat_intent_router", "inputTemplate"]] as const) {
      expect(runPromptReads([{ type, config: {} }]).userPrompt, type).toBe(true);
      expect(runPromptReads([{ type, config: { [field]: "{{question}}" } }]).userPrompt, type).toBe(false);
    }
    // An empty input template falls back to the default too.
    expect(runPromptReads([{ type: "chat_intent_router", config: { inputTemplate: "  " } }]).userPrompt).toBe(true);
  });

  it("counts a System Prompt node only when it has no text of its own", () => {
    expect(runPromptReads([{ type: "system_prompt", config: {} }]).systemPrompt).toBe(true);
    expect(runPromptReads([{ type: "system_prompt", config: { text: "Be brief." } }]).systemPrompt).toBe(false);
  });

  it("counts any setting that names a prompt, at any depth", () => {
    expect(runPromptReads([{ type: "output", config: { responseTemplate: "You asked: {{ user_prompt }}" } }]).userPrompt).toBe(true);
    expect(runPromptReads([{ type: "slack_send_message", config: { text: "Hello {{user_prompt}}" } }]).userPrompt).toBe(true);
    expect(runPromptReads([{ type: "code_node", config: { code: "return { q: input.user_prompt }" } }]).userPrompt).toBe(true);
    expect(runPromptReads([{ type: "input_validator", config: { rules: [{ field: "system_prompt", check: "required" }] } }])).toEqual({ userPrompt: false, systemPrompt: true });
    expect(runPromptReads([{ type: "set_node", config: { fields: [{ value: { nested: ["{{webhook.user_prompt}}"] } }] } }]).userPrompt).toBe(true);
  });

  it("counts a path an input mapping reads (its keys), but not other setting names", () => {
    expect(runPromptReads([{ type: "execute_workflow", config: { inputMapping: { user_prompt: "question" } } }]).userPrompt).toBe(true);
    expect(runPromptReads([{ type: "code_node", config: { code: "return input", inputMapping: { system_prompt: "rules" } } }]).systemPrompt).toBe(true);
    expect(runPromptReads([{ type: "execute_workflow", config: { inputMapping: { answer: "user_prompt" } } }]).userPrompt).toBe(true);
    expect(runPromptReads([{ type: "set_node", config: { assignments: { user_prompt: "fixed" } } }]).userPrompt).toBe(false);
  });
});

describe("editorRunPrompts", () => {
  it("sends neither prompt to a workflow that reads none", () => {
    expect(editorRunPrompts([{ type: "http_request", config: {} }, { type: "output", config: {} }])).toEqual({ sendUserPrompt: false, sendSystemPrompt: false });
  });

  it("sends both to an agent workflow with no prompt nodes", () => {
    expect(editorRunPrompts([{ type: "agent_orchestrator", config: {} }, { type: "llm_call", config: {} }])).toEqual({ sendUserPrompt: true, sendSystemPrompt: true });
  });

  it("keeps a prompt out when a node with text supplies it", () => {
    expect(
      editorRunPrompts([
        { type: "text_input", config: { text: "Summarise the report" } },
        { type: "system_prompt", config: { text: "Be brief." } },
        { type: "llm_call", config: {} }
      ])
    ).toEqual({ sendUserPrompt: false, sendSystemPrompt: false });
    expect(editorRunPrompts([{ type: "user_prompt", config: { text: "  " } }, { type: "llm_call", config: {} }])).toEqual({ sendUserPrompt: true, sendSystemPrompt: true });
  });

  it("sends only the user prompt to a chat trigger workflow that reads no system prompt", () => {
    expect(editorRunPrompts([{ type: "chat_trigger", config: {} }, { type: "output", config: { responseTemplate: "{{message}}" } }])).toEqual({ sendUserPrompt: true, sendSystemPrompt: false });
  });
});
