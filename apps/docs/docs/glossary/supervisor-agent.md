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

The supervisor is the coordinator in a multi-agent system. It knows the overall goal and which specialist handles what, and it usually has few tools of its own. Each <Term id="worker-agent">worker</Term> has a narrow job, a short prompt and only the tools that job needs. Delegating is an ordinary <Term id="tool-calling">tool call</Term>, and the worker's answer comes back as the tool result.

Anthropic's guide to building agents calls this the orchestrator-workers workflow, in which "a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results". The supervisor decides at run time which workers to call, in what order and how often.

The pattern has costs. Every delegation starts a whole <Term id="agent-loop">agent loop</Term>, so one request can turn into many model calls. Each worker's output is added to the supervisor's context. Mistakes stack up too: a worker's wrong answer is passed on as fact.

## Example

A support supervisor gets "Why was I charged twice, and where is my parcel?". It calls the billing worker with "Explain the two charges on account 4417", then the shipping worker with "Find the status of the latest order on account 4417". The billing worker uses invoice tools, the shipping worker uses a tracking tool, and neither can touch the other's systems. The supervisor merges both answers into one reply.

## Common confusion

A supervisor agent is not a router. A router picks one fixed path from the input and stops there. A supervisor can call several workers, call one twice, and change plan after reading a result. It is also not a person supervising the agent: approving an agent's actions is <Term id="human-in-the-loop">human in the loop</Term>.

## In L2M

The Supervisor node takes agent nodes on its `worker` port. Each worker reaches the supervisor's model as a tool named `delegate_to_<worker name>` with one `task_prompt` argument. The worker then runs its own loop with its own chat model and tools, and the task prompt becomes its `user_prompt`: it does not see the original request unless the supervisor passes it on. Build one with no API key in the [supervisor and worker agents recipe](/recipes/supervisor-worker-agents), or read the [agent loop](/runtime/agent-loop#attachment-ports) reference.

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering, December 2024)
