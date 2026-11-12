---
title: "What is an AI agent? The tool-calling loop explained"
sidebarTitle: "What is an AI agent?"
description: "An AI agent is a model in a loop that calls tools until it can answer. See the loop step by step, where it fails, and run one locally with no API key."
level: beginner
about: agent-loop
demo: wf-mcp-agent-quickstart
demoRecorded: true
related: [agent-loop, tool-calling]
socialCard: true
---

# What is an AI agent?

An AI agent is a language model running in a loop: it reads the task, decides whether a tool would help, asks for that <Term id="tool-calling">tool call</Term>, reads the result, and repeats until it can answer. The model chooses the steps; the runtime around it runs the tools and decides when to stop. That loop, the <Term id="agent-loop">agent loop</Term>, is what separates an agent from a single model call.

## The loop, step by step

1. **Collect the messages.** The system prompt, the user's message and, if the agent has memory, the earlier conversation.
2. **Call the model with the tool definitions.** Each tool has a name, a description and a JSON Schema for its arguments.
3. **Read the reply.** The model either answers in text, or asks for one or more tool calls: a tool name plus arguments.
4. **Run the tools.** The runtime calls each tool and adds its result to the conversation as a tool message.
5. **Call the model again**, now with the results in view, and go back to step 3.

The loop ends when the model replies with text and asks for no tools (its final answer), or when it reaches the iteration limit you set.

## What makes it an agent

A single model call answers from what it already knows. An agent can look things up, compute, or change something in another system, and it decides the order itself. A fixed workflow runs the same steps every time; an agent picks its next step from what it just learned. Many real systems mix both: a fixed workflow with one agent step inside it.

## Where tools come from: MCP

The model never runs a tool itself. It only names one. With the Model Context Protocol (MCP), the tools live on MCP servers: the client asks a server for its tools with a `tools/list` request and runs one with a `tools/call` request. The agent runtime is that client.

## How it goes wrong

- **It never stops.** The model keeps asking for tools. An iteration limit ends the run instead of letting it spend forever.
- **Too many tools.** Every tool definition takes room in the model's context. A long tool list crowds out the task, and the model picks the wrong tool more often.
- **Results too large.** A tool that returns a whole database table can overflow the context on the next call.
- **No model attached, or no credentials.** The loop cannot start without a model, and tools fail without the secrets they need.

## The same loop in L2M

In L2M, the **Agent Orchestrator** node runs this loop. Its ports say what it works with:

- `chat_model`: the model it calls, for example an OpenAI, Anthropic or Ollama chat model node;
- `tool`: one or more MCP Tool nodes, whose tools it offers to the model;
- `memory`: an optional memory node that keeps the conversation between runs.

`maxIterations` on the node is the limit. If the model is still asking for tools when the limit is reached, the run stops with the last text the model wrote, or with "Agent stopped after reaching iteration limit." if it wrote none. If the model sends back an empty reply while iterations remain, the runtime asks it to answer or call a tool instead of accepting the empty reply.

## Run one with no API key

The [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) is a ready workflow: one agent, two MCP tools from a bundled mock MCP server, and the built-in echo provider as its model. Echo is not a real model: it never asks for a tool, so a local run ends after one model call. The demo link on this page plays a recorded run of the full loop, with its tool calls. Attach a real chat model to run the loop yourself.

## Further reading

- [Agent loop in L2M](/runtime/agent-loop): ports, tool names, the session tool cache
- [Build your first MCP agent in 5 minutes](/getting-started/build-your-first-mcp-agent)
- [MCP specification: Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) (modelcontextprotocol.io)
