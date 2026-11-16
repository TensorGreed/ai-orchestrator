---
title: "Workflow DAG: steps and edges that never loop back"
term: "Workflow DAG"
topic: agents
definition: "A workflow drawn as a directed acyclic graph: steps joined by edges that never loop back, run in the order their inputs allow."
description: "A workflow DAG is a graph of steps with no cycles, run in dependency order. How it differs from an agent loop, and how repetition works without cycles."
related: [ai-agent, agent-loop, approval-gate, max-iterations]
guide: [/learn/agents/workflows-vs-agents]
---

# Workflow DAG

**A workflow drawn as a directed acyclic graph: steps joined by edges that never loop back, run in the order their inputs allow.**

The name lists the three rules. *Directed*: each edge goes one way, from the step that produces data to the step that uses it. *Acyclic*: following the edges never brings you back to a step you passed, so no step waits on its own output. *Graph*: a step can have several inputs and several outputs, so the flow can branch and join, not just run in a line.

Those rules make a DAG predictable. Before anything runs, the engine can sort the steps so that each one comes after everything it depends on (a topological sort). It knows that the run will end, which steps can be reached, and which step to blame when one fails. Branching does not break this: an IF or switch step picks one branch, and the steps on the other branches are skipped.

## Example

```
Webhook ─▶ Classify ─▶ Switch ─┬─▶ Refund steps
                               ├─▶ Create issue
                               └─▶ Agent ─▶ Output
```

A sorted order is Webhook, Classify, Switch, then the branches. If someone draws an edge from Output back to Classify, Classify now depends on a step that depends on Classify. No order satisfies that, so the graph is no longer a DAG.

## Common confusion

A DAG does not mean "nothing ever repeats". Repetition just does not come from a back-edge. A loop step can run the steps after it once per item in a list, and an <Term id="agent-loop">agent loop</Term> can repeat model and tool calls as often as its limit allows, all inside one step of the graph. The graph stays acyclic; the repetition is bounded by the list length or by <Term id="max-iterations">max iterations</Term>.

A DAG is also not the opposite of an agent. A common design keeps the outer flow as a DAG and puts an <Term id="ai-agent">agent</Term> in one step, where the work is open-ended.

## In L2M

The [workflow editor](/product/workflow-editor) builds a DAG. Validation sorts the nodes and refuses a graph with a cycle ("Workflow graph contains a cycle. V1 supports DAG execution only."), and a node may not have an edge to itself. The engine then runs the nodes one at a time in the sorted order; a node that no execution edge connects is not run. Only execution edges count: attachment edges, such as an agent's `chat_model`, `tool`, `memory` and `worker` ports, are left out of the sort, because the agent uses those nodes while it runs ([attachment ports](/runtime/agent-loop#attachment-ports)). For repetition, the Loop / ForEach node runs its direct downstream nodes once per item, up to its own `maxIterations` (100 when unset).

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering, December 2024): workflows with predefined code paths versus agents
