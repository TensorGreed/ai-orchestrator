---
title: "Agent loop: what it is and when it stops"
term: "Agent loop"
description: "The cycle an AI agent repeats: call the model, run the tools it asks for, add the results to the conversation, then call the model again until it answers."
related: [tool-call]
---

# Agent loop

**The cycle an AI agent repeats: call the model, run the tools it asks for, add the results to the conversation, then call the model again until it answers.**

The loop ends in one of two ways: the model writes a final answer and asks for no more tools, or the loop reaches its iteration limit.

## Example

Asked "What is 17% of 2,340?", an agent with a calculator tool calls the model, which asks for `calculator` with the expression. The runtime runs it and adds the result. On the second call the model answers with the number. Two iterations.

## In L2M

The Agent Orchestrator node runs the loop. `maxIterations` sets the limit. See [Agent loop](/runtime/agent-loop) and the guide [How a tool-calling agent loop works](/learn/how-agent-loops-work).
