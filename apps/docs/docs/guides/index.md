---
title: "Guides: run and govern MCP agents, self-hosted"
description: "Task guides for self-hosted L2M: run an MCP gateway, govern MCP tools, test MCP servers and agents in CI, and require human approval for agent tool calls."
---

# Guides

Each guide answers one question end to end, with L2M as the worked example: what the technique is and when you need it, a walkthrough with real settings and commands, how it works, and what it does not do. Everything runs on your own deployment.

| Guide | When you need it |
| --- | --- |
| [Run a self-hosted MCP gateway](./self-hosted-mcp-gateway.md) | Several people or agents call the same MCP servers, and you want one endpoint, per-client tokens and one place to switch a tool off. |
| [Govern MCP tools](./govern-mcp-tools.md) | MCP servers offer tools that change things, and different roles should get different tools. |
| [Least privilege from real runs](./least-privilege-from-real-runs.md) | You want rules that give each agent only the tools it really uses, checked against recorded calls before they apply. |
| [Test MCP servers in CI](./test-mcp-servers-in-ci.md) | Servers change their schemas or go down, and you want tests that don't depend on them and a build that fails on breaking changes. |
| [CI for AI agents](./ci-for-ai-agents.md) | Prompt, model and tool changes should be regression-tested and gated before they reach production. |
| [Human approval for agent tool calls](./human-approval-for-agent-tool-calls.md) | An agent's write-tool calls should wait for a person, with the decision on record. |

New to L2M? Start with [Build your first MCP agent](../getting-started/build-your-first-mcp-agent.md), or look around the [live demo](https://lsquarem.com/demo/){target="_self"} first.
