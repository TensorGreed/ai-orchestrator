import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { importWorkflowFromJson } from "@ai-orchestrator/workflow-engine";
import { SqliteStore } from "../db/database";

const TEMPLATE_CATEGORY_MAP: Record<string, string> = {
  "basic-flow.json": "Getting Started",
  "conditional-flow.json": "Logic & Control",
  "rag-flow.json": "RAG & AI",
  "rag-pinecone-flow.json": "RAG & AI",
  "structured-output-flow.json": "RAG & AI",
  "agentic-mcp-flow.json": "Agents",
  "two-turn-report-code-helper-flow.json": "Agents",
  "azure-openai-flow.json": "Cloud Integrations",
  "azure-connectors-demo-flow.json": "Cloud Integrations"
};

const TEMPLATE_DESCRIPTION_MAP: Record<string, string> = {
  "basic-flow.json": "A simple text-in, LLM-call, text-out pipeline to get started.",
  "conditional-flow.json": "Demonstrates conditional branching with webhook triggers.",
  "rag-flow.json": "Retrieval-Augmented Generation with Google Drive and vector search.",
  "rag-pinecone-flow.json": "RAG pipeline using Pinecone as the vector store.",
  "structured-output-flow.json": "Extract structured data from LLM responses with an output parser.",
  "agentic-mcp-flow.json": "Agent orchestrator with MCP tool calling and session memory.",
  "two-turn-report-code-helper-flow.json": "Helper-chat workflow that saves an exact MCP-backed report artifact on the first turn and reuses it for follow-up Python code.",
  "azure-openai-flow.json": "Basic LLM flow using Azure OpenAI as the provider.",
  "azure-connectors-demo-flow.json": "Demo of Azure Storage, Cosmos DB, Monitor, and AI Search connectors."
};

export function seedWorkflowsIfEmpty(store: SqliteStore, workspaceRoot: string): void {
  if (store.countWorkflows() > 0) {
    return;
  }

  const sampleDir = path.resolve(workspaceRoot, "samples", "workflows");
  if (!fs.existsSync(sampleDir)) {
    return;
  }

  const files = fs.readdirSync(sampleDir).filter((file) => file.endsWith(".json"));
  for (const fileName of files) {
    const fullPath = path.join(sampleDir, fileName);
    const raw = fs.readFileSync(fullPath, "utf8");
    const workflow = importWorkflowFromJson(raw);
    store.upsertWorkflow(workflow);
  }
}

export function seedTemplatesIfEmpty(store: SqliteStore, workspaceRoot: string): void {
  if (store.countTemplates() > 0) {
    return;
  }

  const sampleDir = path.resolve(workspaceRoot, "samples", "workflows");
  if (!fs.existsSync(sampleDir)) {
    return;
  }

  const files = fs.readdirSync(sampleDir).filter((file) => file.endsWith(".json"));
  for (const fileName of files) {
    const fullPath = path.join(sampleDir, fileName);
    const raw = fs.readFileSync(fullPath, "utf8");
    const workflow = importWorkflowFromJson(raw);
    const category = TEMPLATE_CATEGORY_MAP[fileName] ?? "General";
    const description = TEMPLATE_DESCRIPTION_MAP[fileName] ?? "";
    const tags: string[] = [category.toLowerCase().replace(/ & /g, "-").replace(/ /g, "-")];

    store.upsertTemplate({
      id: randomUUID(),
      name: workflow.name,
      description,
      category,
      tags,
      author: "ai-orchestrator",
      workflowJson: raw,
      nodeCount: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0
    });
  }
}
