<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`.
-->

# Node reference

Auto-generated from the canonical `nodeDefinitions` registry in
`packages/shared/src/definitions.ts`. Every supported node type, every
config field, every default value — kept in lock-step with the running
code by the docs build.

132 node types across 8 categories.

## Categories

- [Input](/nodes/reference/input) — Workflow entry points: triggers (cron, webhook, manual, form, chat, MCP-server) and static-input helpers. (27 nodes)
- [LLM](/nodes/reference/llm) — Chat-completion model adapters and prompt-template helpers. (15 nodes)
- [Agent](/nodes/reference/agent) — Tool-calling agent runtimes and the multi-turn memory + artifact stores that back them. (2 nodes)
- [MCP](/nodes/reference/mcp) — Model Context Protocol clients and the workflow-as-MCP-tool exposure node. (1 node)
- [RAG](/nodes/reference/rag) — Retrieval-Augmented Generation: embedders, vector stores, document loaders, retrievers. (3 nodes)
- [Connector](/nodes/reference/connector) — External system integrations — HTTP, SQL, NoSQL, cloud SDKs, SaaS APIs. (40 nodes)
- [Utility](/nodes/reference/utility) — DAG control flow: branching, looping, merging, sub-workflows, code execution, set/wait. (40 nodes)
- [Output](/nodes/reference/output) — Terminal nodes that shape the workflow's response payload. (4 nodes)
