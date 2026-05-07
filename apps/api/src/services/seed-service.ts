import fs from "node:fs";
import path from "node:path";
import { importWorkflowFromJson } from "@ai-orchestrator/workflow-engine";
import { SqliteStore } from "../db/database";

const TEMPLATE_CATEGORY_MAP: Record<string, string> = {
  "basic-flow.json": "Getting Started",
  "mcp-agent-quickstart-flow.json": "Getting Started",
  "conditional-flow.json": "Logic & Control",
  "rag-flow.json": "RAG & AI",
  "rag-pinecone-flow.json": "RAG & AI",
  "structured-output-flow.json": "RAG & AI",
  "agentic-mcp-flow.json": "Agents",
  "supervisor-worker-swarm-flow.json": "Agents",
  "workflow-as-mcp-tool-flow.json": "Agents",
  "two-turn-report-code-helper-flow.json": "Agents",
  "vscode-l2m-coding-agent-flow.json": "Agents",
  "azure-openai-flow.json": "Cloud Integrations",
  "azure-connectors-demo-flow.json": "Cloud Integrations"
};

const TEMPLATE_DESCRIPTION_MAP: Record<string, string> = {
  "basic-flow.json": "Text-in, LLM-call, text-out pipeline. Runs out-of-the-box with the built-in echo provider — no Ollama, no API keys, no setup required. Swap to a real provider when you're ready.",
  "mcp-agent-quickstart-flow.json": "Manual Trigger -> Agent -> Output with the bundled echo provider and the in-process mock-mcp adapter exposing get_current_time + calculator. Zero-key target for the 5-minute MCP agent tutorial.",
  "conditional-flow.json": "Demonstrates conditional branching with webhook triggers.",
  "rag-flow.json": "Retrieval-Augmented Generation with Google Drive and vector search.",
  "rag-pinecone-flow.json": "RAG pipeline using Pinecone as the vector store.",
  "structured-output-flow.json": "Extract structured data from LLM responses with an output parser.",
  "agentic-mcp-flow.json": "Agent orchestrator with MCP tool calling and session memory.",
  "supervisor-worker-swarm-flow.json": "Multi-agent swarm: a Supervisor coordinates two specialist Worker agents (researcher + computer), each with their own MCP tools. Workers appear to the Supervisor as synthetic tools.",
  "workflow-as-mcp-tool-flow.json": "Compose-by-MCP: mcp_server_trigger exposes the whole workflow as an MCP tool at /api/mcp-server/kb-helper. Other agents wire it in as a callable tool — no HTTP plumbing required.",
  "two-turn-report-code-helper-flow.json": "Helper-chat workflow that saves an exact MCP-backed report artifact on the first turn and reuses it for follow-up Python code.",
  "vscode-l2m-coding-agent-flow.json": "L2M webhook workflow for the VS Code agent extension with structured messages, patch actions, command actions, code blocks, attachments, and memory updates.",
  "azure-openai-flow.json": "Basic LLM flow using Azure OpenAI as the provider.",
  "azure-connectors-demo-flow.json": "Demo of Azure Storage, Cosmos DB, Monitor, and AI Search connectors."
};

function builtInTemplateId(fileName: string): string {
  return `builtin-${fileName.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Templates that should appear first in the gallery and carry a "Featured"
 * badge. Used to promote hero use cases (the VS Code coding-agent flow is the
 * canonical L2M+IDE story) above the long tail of demo flows.
 */
export const FEATURED_TEMPLATE_IDS = new Set<string>([
  builtInTemplateId("vscode-l2m-coding-agent-flow.json")
]);

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
  const sampleDir = path.resolve(workspaceRoot, "samples", "workflows");
  if (!fs.existsSync(sampleDir)) {
    return;
  }

  const existingTemplatesByName = new Map(store.listTemplates().map((template) => [template.name, template.id]));
  const files = fs.readdirSync(sampleDir).filter((file) => file.endsWith(".json"));
  for (const fileName of files) {
    const fullPath = path.join(sampleDir, fileName);
    const raw = fs.readFileSync(fullPath, "utf8");
    const workflow = importWorkflowFromJson(raw);
    const category = TEMPLATE_CATEGORY_MAP[fileName] ?? "General";
    const description = TEMPLATE_DESCRIPTION_MAP[fileName] ?? "";
    const tags: string[] = [category.toLowerCase().replace(/ & /g, "-").replace(/ /g, "-")];

    store.upsertTemplate({
      id: existingTemplatesByName.get(workflow.name) ?? builtInTemplateId(fileName),
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
