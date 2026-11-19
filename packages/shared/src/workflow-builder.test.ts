import { describe, expect, it } from "vitest";
import {
  WORKFLOW_BUILDER_PROMPT_MAX_CHARS,
  builderKeywords,
  rankTemplatesForPrompt,
  workflowBuilderRequestSchema
} from "./workflow-builder";

describe("workflowBuilderRequestSchema", () => {
  it("takes a description, an optional project and an optional model", () => {
    const parsed = workflowBuilderRequestSchema.parse({
      prompt: "  When a webhook arrives, post it to Slack  ",
      projectId: "p1",
      model: { providerId: "openai_compatible", model: "local", baseUrl: "http://127.0.0.1:9000/v1", secretRef: { secretId: "s1" } }
    });
    expect(parsed.prompt).toBe("When a webhook arrives, post it to Slack");
    expect(parsed.model?.secretRef?.secretId).toBe("s1");
  });

  it("refuses an empty or too long description and unknown fields", () => {
    expect(workflowBuilderRequestSchema.safeParse({ prompt: "   " }).success).toBe(false);
    expect(workflowBuilderRequestSchema.safeParse({ prompt: "x".repeat(WORKFLOW_BUILDER_PROMPT_MAX_CHARS + 1) }).success).toBe(false);
    expect(workflowBuilderRequestSchema.safeParse({ prompt: "ok", workflowId: "wf-1" }).success).toBe(false);
    expect(workflowBuilderRequestSchema.safeParse({ prompt: "ok", model: { providerId: "openai", model: "m", apiKey: "sk" } }).success).toBe(false);
  });
});

describe("rankTemplatesForPrompt", () => {
  const templates = [
    { id: "rag", name: "RAG Flow", description: "Answer questions from documents", category: "RAG & AI", tags: ["rag", "retrieval"] },
    { id: "cond", name: "Conditional Branching Flow", description: "IF and Switch routing", category: "Logic & Control", tags: ["branching"], featured: true },
    { id: "slack", name: "Webhook to Slack", description: "Post incoming webhooks to a Slack channel", category: "Getting Started", tags: ["slack", "webhook"] },
    { id: "agent", name: "MCP Agent", description: "An agent with tools", category: "Agents", tags: ["mcp", "agent"], featured: true }
  ];

  it("puts the closest templates first", () => {
    expect(rankTemplatesForPrompt("When a webhook arrives, send a message to Slack", templates).map((t) => t.id)[0]).toBe("slack");
    expect(rankTemplatesForPrompt("answer questions about our documents", templates).map((t) => t.id)[0]).toBe("rag");
  });

  it("falls back to featured templates for a vague description, and returns at most the limit", () => {
    const ranked = rankTemplatesForPrompt("do the thing", templates);
    expect(ranked).toHaveLength(3);
    expect(ranked.slice(0, 2).map((t) => t.id).sort()).toEqual(["agent", "cond"]);
    expect(rankTemplatesForPrompt("slack", templates, 1)).toHaveLength(1);
  });

  it("ranks by closeness, and on a tie puts templates that run without a model first", () => {
    const withModel = templates.map((template) => ({ ...template, needsModel: template.id === "slack" || template.id === "cond" }));
    // The closest one still comes first even when it needs a model.
    expect(rankTemplatesForPrompt("When a webhook arrives, send a message to Slack", withModel)[0]!.id).toBe("slack");
    // A vague description ties everything: the featured template that runs without a model leads.
    expect(rankTemplatesForPrompt("do the thing", withModel)[0]!.id).toBe("agent");
  });

  it("matches words, not stop words or plurals", () => {
    expect(builderKeywords("Send the emails to my customers")).toEqual(["email", "customer"]);
  });
});
