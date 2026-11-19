import fs from "node:fs";
import path from "node:path";
import { importWorkflowFromJson } from "@ai-orchestrator/workflow-engine";
import type { Store } from "../db/store.js";

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
  "conditional-flow.json": "Demonstrates conditional branching with webhook triggers. Runs on the built-in Echo model with no setup; pick a real provider on the LLM Call when you are ready.",
  "rag-flow.json": "Retrieval-Augmented Generation over a few built-in documents. Runs on the built-in Echo model with no setup; pick a real provider on the LLM Call for real answers.",
  "rag-pinecone-flow.json": "RAG pipeline using Pinecone as the vector store.",
  "structured-output-flow.json": "Needs a chat model: the output parser expects real JSON from the model, so set a provider on the LLM Call first. Extracts structured data from LLM responses with an output parser.",
  "agentic-mcp-flow.json": "Agent orchestrator with MCP tool calling and session memory. Runs on the built-in Echo model with no setup (Echo does not call tools); attach a real model to see tool calls.",
  "supervisor-worker-swarm-flow.json": "Multi-agent swarm: a Supervisor coordinates two specialist Worker agents (researcher + computer), each with their own MCP tools. Workers appear to the Supervisor as synthetic tools.",
  "workflow-as-mcp-tool-flow.json": "Compose-by-MCP: mcp_server_trigger exposes the whole workflow as an MCP tool at /api/mcp-server/kb-helper. Other agents wire it in as a callable tool — no HTTP plumbing required.",
  "two-turn-report-code-helper-flow.json": "Needs a chat model and an MCP server: set a provider on the chat model node first. Helper-chat workflow that saves an exact MCP-backed report artifact on the first turn and reuses it for follow-up Python code.",
  "vscode-l2m-coding-agent-flow.json": "Needs a chat model: set a provider on the chat model node first. L2M webhook workflow for the VS Code agent extension with structured messages, patch actions, command actions, code blocks, attachments, and memory updates.",
  "azure-openai-flow.json": "Basic LLM flow using Azure OpenAI as the provider.",
  "azure-connectors-demo-flow.json": "Demo of Azure Storage, Cosmos DB, Monitor, and AI Search connectors."
};

/** The gallery category of the starter templates (samples/starters). */
export const STARTER_TEMPLATE_CATEGORY = "Starters";

/**
 * Starter templates call the API's own sample data (sample-data-routes.ts). Their HTTP Request URLs name it with this
 * token, replaced with the API's base URL when the templates are seeded.
 */
export const STARTER_API_BASE_TOKEN = "$L2M_API_BASE";

/**
 * The base URL a workflow running in this API reaches the API itself at: the bound host (loopback when it binds every
 * interface) and port.
 */
export function selfApiBaseUrl(config: { API_HOST: string; API_PORT: number }): string {
  const host = config.API_HOST.trim();
  const reachable = !host || host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
  const bracketed = reachable.includes(":") && !reachable.startsWith("[") ? `[${reachable}]` : reachable;
  return `http://${bracketed}:${config.API_PORT}`;
}

export interface SeedTemplateOptions {
  /** What the starters' `$L2M_API_BASE` becomes (default http://127.0.0.1:4000). */
  apiBaseUrl?: string;
}

function builtInTemplateId(fileName: string): string {
  return `builtin-${fileName.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Templates that should appear first in the gallery and carry a "Featured"
 * badge. The first card a new user sees must run without setup: the MCP agent
 * quickstart runs on the built-in Echo model and the in-process sample MCP server.
 */
export const FEATURED_TEMPLATE_IDS = new Set<string>([
  builtInTemplateId("mcp-agent-quickstart-flow.json")
]);

export async function seedWorkflowsIfEmpty(store: Store, workspaceRoot: string): Promise<void> {
  if (await store.countWorkflows() > 0) {
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
    await store.upsertWorkflow(workflow);
  }
}

export async function seedTemplatesIfEmpty(store: Store, workspaceRoot: string, options: SeedTemplateOptions = {}): Promise<void> {
  const existingTemplatesByName = new Map((await store.listTemplates()).map((template) => [template.name, template.id]));

  const sampleDir = path.resolve(workspaceRoot, "samples", "workflows");
  if (fs.existsSync(sampleDir)) {
    const files = fs.readdirSync(sampleDir).filter((file) => file.endsWith(".json"));
    for (const fileName of files) {
      const fullPath = path.join(sampleDir, fileName);
      const raw = fs.readFileSync(fullPath, "utf8");
      const workflow = importWorkflowFromJson(raw);
      const category = TEMPLATE_CATEGORY_MAP[fileName] ?? "General";
      const description = TEMPLATE_DESCRIPTION_MAP[fileName] ?? "";
      const tags: string[] = [category.toLowerCase().replace(/ & /g, "-").replace(/ /g, "-")];

      await store.upsertTemplate({
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

  // Starter templates: everyday automations that run on built-in sample data, with no model, key or service to set up.
  const starterDir = path.resolve(workspaceRoot, "samples", "starters");
  if (fs.existsSync(starterDir)) {
    const apiBaseUrl = (options.apiBaseUrl ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
    const files = fs.readdirSync(starterDir).filter((file) => file.endsWith(".json")).sort();
    for (const fileName of files) {
      const raw = fs.readFileSync(path.join(starterDir, fileName), "utf8").split(STARTER_API_BASE_TOKEN).join(apiBaseUrl);
      const workflow = importWorkflowFromJson(raw);
      // Matched by its built-in id only, so a user's own template with the same name is never overwritten.
      await store.upsertTemplate({
        id: builtInTemplateId(fileName),
        name: workflow.name,
        description: workflow.description ?? "",
        category: STARTER_TEMPLATE_CATEGORY,
        tags: ["starter"],
        author: "ai-orchestrator",
        workflowJson: raw,
        nodeCount: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0
      });
    }
  }
}
