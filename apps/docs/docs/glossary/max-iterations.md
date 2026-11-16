---
title: "Max iterations: the stop limit of an agent loop"
term: "Max iterations"
topic: agents
definition: "The most rounds of model call and tool calls an agent may take in one run. When it is reached, the agent stops instead of looping on."
description: "Max iterations caps how many model and tool rounds an agent may take, so a confused agent stops instead of looping and spending. How to pick a value."
related: [agent-loop, ai-agent, budget, unbounded-consumption, context-window]
guide: [/learn/agents/what-is-an-ai-agent]
---

# Max iterations

**The most rounds of model call and tool calls an agent may take in one run. When it is reached, the agent stops instead of looping on.**

An <Term id="agent-loop">agent loop</Term> has no natural end except the model deciding it is done. Most of the time it is. But a model can also call the same search again and again, retry a tool that keeps failing, or chase a question its tools cannot answer. Each round is another model call, so the cost and the <Term id="context-window">context</Term> grow with it. Max iterations is the hard stop for that case.

One iteration is one model call plus the tool calls that model asked for. A run that answers straight away uses one. A run that looks something up, then answers, uses two.

## Picking a value

Count the rounds a good run needs, then leave some room:

- A lookup-then-answer agent needs two or three.
- An agent that searches, reads a result and maybe searches again needs four to six.
- A <Term id="supervisor-agent">supervisor</Term> often spends a round on each delegation and one more to answer, so it usually gets a higher limit than its workers.

A limit that is too low cuts good runs short. A limit that is too high mostly costs money on the runs that were going wrong anyway. When runs keep hitting the limit, raising it is rarely the fix: a shorter tool list or a clearer prompt usually is.

## Example

An agent with `maxIterations: 4` is asked for a parcel's status. On each call the model asks for `track_parcel`, and the tool returns "carrier timeout". After the fourth round the loop stops and the agent returns what it has, rather than retrying for minutes.

## Common confusion

Max iterations limits rounds, not money or tokens. Two runs with the same limit can cost very different amounts, depending on the model and the size of the tool results. To cap spend, set a <Term id="budget">budget</Term> as well. A run timeout is different again: it limits wall-clock time for the whole workflow.

## In L2M

The Agent Orchestrator and Supervisor nodes both have `maxIterations`. On the Agent Orchestrator it is required: validation rejects a missing value or one below 1. A new Agent Orchestrator starts at 6 and a new Supervisor at 10; a Supervisor whose value has been removed runs with 4. When the limit is reached, the node returns the text of the model's last reply, or "Agent stopped after reaching iteration limit." if that reply had none, and its output has `stopReason: "max_iterations"` (a normal answer has `final_answer`), so a later step can check it and route those runs elsewhere. The run trace shows each round as "Step 2 of 6". The Loop / ForEach node also has a `maxIterations` field, but there it caps how many items the loop runs over. See [agent hits max iterations](/troubleshooting/common-issues#agent-hits-max-iterations).

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering, December 2024): stopping conditions such as a maximum number of iterations
