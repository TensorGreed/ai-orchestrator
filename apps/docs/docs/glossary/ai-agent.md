---
title: "AI agent: a definition with an example"
term: "AI agent"
topic: agents
definition: "A system in which a language model decides, step by step, which tools to call and in what order, reading each result before it chooses the next step, until it can answer."
description: "An AI agent is a model that decides which tools to call, in a loop, until it can answer. How it differs from a chatbot or a fixed workflow."
related: [agent-loop, tool-calling, workflow-dag, supervisor-agent, max-iterations, human-in-the-loop]
guide: [/learn/agents/what-is-an-ai-agent]
---

# AI agent

**A system in which a language model decides, step by step, which tools to call and in what order, reading each result before it chooses the next step, until it can answer.**

The word is used loosely. A useful line, drawn in Anthropic's "Building effective agents", separates *workflows*, where models and tools follow "predefined code paths", from *agents*, where models "dynamically direct their own processes and tool usage". The model's freedom to pick the next step is what makes something an agent, not the number of tools or the length of the prompt.

## Example

Asked "Is the payments service healthy, and if not, open a ticket?", an agent calls a metrics tool, reads an error rate of 12%, calls a log search tool to find the cause, then calls `create_ticket` with a summary. Asked the same question on a good day, it stops after the first call. The same agent, given the same tools, takes a different path because the results differ.

## Common confusion

- **Chatbot.** A chatbot answers from the model alone. An agent can look things up, compute or change other systems through tools.
- **Workflow.** A <Term id="workflow-dag">workflow</Term> runs the steps you drew, in that order, every time. Many useful systems are a workflow with one agent step inside.
- **Autonomy.** Being an agent does not mean acting without limits. Agents still run under an iteration cap, a tool list, access rules and, for risky actions, a <Term id="human-in-the-loop">person's approval</Term>.

Agents trade predictability for flexibility. The same source warns that their autonomy means "higher costs, and the potential for compounding errors", which is why stopping conditions and tests matter.

## In L2M

The Agent Orchestrator node runs an agent: a chat model on its `chat_model` port, MCP tools on its `tool` port, optional memory, and `maxIterations` as the limit. A <Term id="supervisor-agent">Supervisor</Term> node is an agent that hands parts of a task to worker agents, which it sees as tools. See the [agent loop](/runtime/agent-loop), and run one with no API key in the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent).

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (anthropic.com)
