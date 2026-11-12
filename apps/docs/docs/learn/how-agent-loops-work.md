---
title: "How a tool-calling agent loop works"
description: "What an agent loop is, step by step: the model asks for tools, the runtime runs them, results go back, and the loop ends on an answer or a limit."
level: beginner
demo: wf-mcp-agent-quickstart
demoRecorded: true
related: [agent-loop, tool-call]
---

# How a tool-calling agent loop works

A chat model on its own can only write text. An agent can also act: look something up, run a query, create a ticket. The <Term id="agent-loop">agent loop</Term> is what turns one into the other. This guide walks through one turn of that loop and shows where it runs in L2M.

## The loop, step by step

1. **Collect the messages.** The system prompt, the user's message and, if the agent has memory, the earlier conversation.
2. **Call the model with the tool definitions.** Each tool has a name, a description and a JSON Schema for its arguments.
3. **Read the reply.** The model either answers in text, or asks for one or more <Term id="tool-call">tool calls</Term>: a tool name plus arguments.
4. **Run the tools.** The runtime calls each tool and adds its result to the conversation as a tool message.
5. **Call the model again**, now with the results in view. Go back to step 3.

The loop ends when the model replies with text and asks for no tools (its final answer), or when it reaches the iteration limit you set.

## Where MCP comes in

The model never runs a tool itself. It only names one. Something has to know what each name means and how to call it. With the Model Context Protocol (MCP), that is an MCP server: the client asks the server for its tools with a `tools/list` request and runs one with a `tools/call` request. The agent runtime is that client.

## The same loop in L2M

In L2M, the **Agent Orchestrator** node runs this loop. Its ports say what it works with:

- `chat_model`: the model it calls, for example an OpenAI, Anthropic or Ollama chat model node;
- `tool`: one or more MCP Tool nodes, whose tools it offers to the model;
- `memory`: an optional memory node that keeps the conversation between runs.

`maxIterations` on the node is the limit. If the model is still asking for tools when the limit is reached, the run stops with the last text the model wrote, or with "Agent stopped after reaching iteration limit." if it wrote none. If the model sends back an empty reply while iterations remain, the runtime asks it to answer or call a tool instead of accepting the empty reply.

## What to take away

- An agent is a model plus a loop plus tools.
- The model decides which tool to call; the runtime decides whether and how it runs.
- Always set a limit: a loop without one can call tools for ever.

## Further reading

- [Agent loop in L2M](/runtime/agent-loop): ports, tool names, the session tool cache
- [Build your first MCP agent](/getting-started/build-your-first-mcp-agent)
- [MCP specification: Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) (modelcontextprotocol.io)
