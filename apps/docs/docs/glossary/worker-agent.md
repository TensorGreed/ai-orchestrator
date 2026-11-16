---
title: "Worker agent: a specialist called by a supervisor"
term: "Worker agent"
topic: agents
definition: "A specialist agent, with its own model, tools and instructions, that a supervisor agent calls like a tool for one part of a task."
description: "A worker agent is a specialist with its own model, tools and memory that a supervisor calls like a tool. What it sees, what it returns, and its limits."
related: [supervisor-agent, ai-agent, agent-loop, tool-calling, max-iterations, least-privilege]
guide: [/learn/agents/supervisor-and-workers]
---

# Worker agent

**A specialist agent, with its own model, tools and instructions, that a supervisor agent calls like a tool for one part of a task.**

A worker is an ordinary agent placed under a <Term id="supervisor-agent">supervisor</Term>. From the supervisor's side it is one more tool: a name, a short description and one argument for the task. From the worker's side, that task is the whole request. It runs its own <Term id="agent-loop">agent loop</Term> to the end, with its own model and tools, and its answer goes back to the supervisor as the tool result.

Three things follow from that design.

- **The worker sees only what it is handed.** It does not read the supervisor's conversation. If the task says "summarise the refund policy" but leaves out the customer's country, the worker cannot know it.
- **The worker can be narrow.** Give it a short prompt and only the tools for its job. A worker that can read the billing system but not send email is <Term id="least-privilege">least privilege</Term> applied to one part of the task.
- **The worker can use a different model.** A small, cheap model may be enough for a lookup worker, while the supervisor uses a stronger one to plan.

## Example

A research supervisor gets "Compare our refund window with the legal minimum in Germany". It writes two tasks:

1. To the policy worker, which has a document search tool: "Find our refund window for orders shipped to Germany."
2. To the legal worker, which has a web search tool: "What is the statutory withdrawal period for online purchases in Germany?"

Each worker searches, perhaps several times, and returns a short answer. The supervisor compares the two answers. Neither worker knows the other exists.

## Common confusion

A worker agent is not a fixed step in a pipeline. A step runs every time the flow reaches it; a worker runs only when the supervisor decides to call it, and it may be called twice or not at all. A worker is also not a tool in the usual sense: one call to it can mean many model calls and tool calls inside, so it costs more and takes longer than a single API call.

## In L2M

A worker is an Agent Orchestrator node, or another Supervisor node, attached to a Supervisor's `worker` port; validation refuses any other node type there. The supervisor's model sees it as a tool named `delegate_to_<worker name>` whose description quotes the first 100 characters of the worker's system prompt template as written, before any placeholders are filled, so start that template with plain text saying what the worker is for. Attachment edges are not steps, so the worker does not run on its own as part of the graph. When the supervisor calls it, the worker runs as a full agent node with its own `chat_model`, `tool` and `memory` attachments and its own `maxIterations`, and the supervisor's `task_prompt` is passed in as `user_prompt`, which a new worker's user prompt template uses. The worker's templates can also read the same upstream results the supervisor can, so it is not limited to the task text. Tool policy and approvals apply inside it, and an approval a worker waits for pauses the supervisor's run too. See [the pattern in L2M](/learn/agents/supervisor-and-workers#the-pattern-in-l2m) and the [supervisor and worker agents recipe](/recipes/supervisor-worker-agents).

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering, December 2024): the orchestrator-workers pattern
