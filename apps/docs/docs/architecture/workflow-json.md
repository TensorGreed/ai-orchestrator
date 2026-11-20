---
title: "Workflow JSON format and sample workflows"
description: "The stable L2M workflow export format (schemaVersion 1.0.0) and the sample workflows in samples/workflows that seed a new database."
---

# Workflow JSON and samples

## Export format

The export format is stable and explicit:

```json
{
  "schemaVersion": "1.0.0",
  "workflowVersion": 1,
  "workflow": {
    "id": "wf-basic-llm",
    "name": "Basic LLM Flow",
    "schemaVersion": "1.0.0",
    "workflowVersion": 1,
    "nodes": [],
    "edges": []
  },
  "exportedAt": "2026-03-30T00:00:00.000Z"
}
```

It includes node types and config, the edge graph, and node positions for canvas restoration. Import and export go
through the `GET /api/workflows/:id/export` and `POST /api/workflows/import` routes; see [API endpoints](../api/endpoints.md#workflows).

## Sample workflows

The files under `samples/workflows/` are the seed dataset and runnable examples:

- `basic-flow.json`: text-in / LLM / text-out, runs zero-key with the bundled echo provider.
- `mcp-agent-quickstart-flow.json`: zero-key MCP agent (the target of the [5-minute tutorial](../getting-started/build-your-first-mcp-agent.md)).
- `supervisor-worker-swarm-flow.json`: multi-agent: a Supervisor delegating to a researcher and a computer worker.
- `workflow-as-mcp-tool-flow.json`: `mcp_server_trigger` exposing a workflow as a callable MCP tool.
- `agentic-mcp-flow.json`: webhook, agent, MCP tools and memory.
- `two-turn-report-code-helper-flow.json`: multi-turn helper with deterministic session artifacts.
- `vscode-l2m-coding-agent-flow.json`: canonical wiring for the [VS Code extension](../getting-started/vscode-extension.md).
- `conditional-flow.json`: branching from a webhook trigger.
- `rag-flow.json`: RAG with Google Drive and an in-memory vector store.
- `rag-pinecone-flow.json`: RAG backed by Pinecone.
- `structured-output-flow.json`: schema-validated structured output extraction.
- `azure-openai-flow.json`: basic LLM flow using Azure OpenAI.
- `azure-connectors-demo-flow.json`: Azure Storage, Cosmos DB, Monitor and AI Search.

Set `SEED_SAMPLE_WORKFLOWS=true` to load these into the database when the workflow table is empty. See the
[pattern library](../patterns/index.md) for when to use which.

For full real-world reference projects (helpdesk agent, support triage, VS Code repo reviewer) with end-to-end READMEs
and production-deployment notes, see the [l2m-samples](https://github.com/TensorGreed/l2m-samples) repository.
