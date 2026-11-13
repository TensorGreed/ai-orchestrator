---
title: "Supervisor agent: an agent that delegates to others"
term: "Supervisor agent"
topic: agents
definition: "An agent whose tools include other agents: it splits a task, hands each part to a worker agent, and combines the answers into one reply."
description: "A supervisor agent breaks a task down and hands parts to worker agents it sees as tools. When the pattern helps and what it costs."
related: [worker-agent, ai-agent, agent-loop, tool-calling, max-iterations]
guide: [/learn/agents/supervisor-and-workers]
---

# Supervisor agent

**An agent whose tools include other agents: it splits a task, hands each part to a worker agent, and combines the answers into one reply.**

The supervisor is the coordinator in a multi-agent system. It holds the goal and the plan, and usually few tools of its own; each <Term id="worker-agent">worker</Term> is a specialist with its own prompt and tools. Delegating is an ordinary <Term id="tool-calling">tool call</Term>, and the worker's answer comes back as the tool result.

Anthropic's guide to building agents names this pattern orchestrator-workers: "a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results". The split is not fixed in advance: the supervisor plans it for each request.

The pattern has costs. Every delegation starts a whole <Term id="agent-loop">agent loop</Term>, so one request can turn into many model calls. Each worker's output is added to the supervisor's context. Mistakes stack up too: a worker's wrong answer is passed on as fact.

## Example

A support supervisor gets "Why was I charged twice, and where is my parcel?". It calls the billing worker with "Explain the two charges on account 4417", then the shipping worker with "Find the status of the latest order on account 4417". Each worker has only its own tools, so neither can touch the other's systems. The supervisor merges both answers into one reply.

## Common confusion

A supervisor agent is not a router. A router picks one fixed path from the input and stops there. A supervisor can call several workers, call one twice, and change plan after reading a result. It is also not a person supervising the agent: approving an agent's actions is <Term id="human-in-the-loop">human in the loop</Term>.

## In L2M

The Supervisor node takes agent nodes on its `worker` port. Each worker reaches the supervisor's model as a tool named `delegate_to_<worker name>` with one `task_prompt` argument. The worker runs its own loop with its own chat model and tools, and the task prompt becomes its `user_prompt`, so it does not see the original request unless the supervisor passes it on. Wire one up with no API key in the [supervisor and worker agents recipe](/recipes/supervisor-worker-agents); with the built-in echo model the supervisor never delegates, so attach a tool-calling model to watch it hand work off. Details: [agent loop](/runtime/agent-loop#attachment-ports).

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering, December 2024)
