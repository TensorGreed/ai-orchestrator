---
title: "Agent loop: how an AI agent runs step by step"
term: "Agent loop"
topic: agents
definition: "The cycle an AI agent repeats: call the model, run the tools it asks for, add the results to the conversation, then call the model again until it answers."
description: "The agent loop: send messages and tools to the model, run the tool calls it asks for, add the results, repeat until a final answer or a limit."
related: [tool-calling, ai-agent, max-iterations, context-window]
---

# Agent loop

**The cycle an AI agent repeats: call the model, run the tools it asks for, add the results to the conversation, then call the model again until it answers.**

## Why it matters

The loop is what lets a model act instead of only write. Each pass through it is one iteration: one model call, then the tool calls that model asked for. The loop ends in one of two ways: the model writes a final answer and asks for no more tools, or the loop reaches its iteration limit. Without a limit, a confused model can call tools for ever and keep spending.

## Example

Asked "What is 17% of 2,340?", an agent with a calculator tool calls the model, which asks for `calculator` with the expression `2340 * 0.17`. The runtime runs it and adds the result to the conversation. On the second call the model answers with the number. That is two iterations.

## Common confusion

The loop is not the model. The model only decides what to do next; the runtime around it runs the tools, keeps the conversation and decides when to stop. Changing the model changes the decisions, not the loop.

## In L2M

The Agent Orchestrator node runs the loop, and its `maxIterations` setting is the limit. See [Agent loop](/runtime/agent-loop) and the guide [What is an AI agent?](/learn/agents/what-is-an-ai-agent).

## Further reading

- [MCP specification: Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) (modelcontextprotocol.io)
