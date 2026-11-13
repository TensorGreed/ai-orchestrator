---
title: "Workflows vs agents: when to let the model decide"
sidebarTitle: "Workflows vs agents"
description: "Fixed workflows and model-driven agents compared: cost, control and testability, the common patterns between them, and how to mix both in one graph."
level: beginner
about: ai-agent
demo: wf-conditional
related: [workflow-dag, ai-agent, agent-loop, tool-calling, supervisor-agent, approval-gate]
---

# Workflows vs agents

In a workflow, you decide the steps: the order is written down before the run starts, and a model fills in text at fixed points. In an agent, the model decides the steps: it picks which tool to call next, and when it is done, from what it has seen so far. Use a workflow when you can draw the steps in advance, and an agent when the steps depend on what the run finds. Many real systems are a workflow with one or two agent steps inside it.

## Two definitions

Anthropic's engineering guide "Building effective agents" draws the line by who controls the path. In a workflow, models and tools run through "predefined code paths". In an agent, the models "dynamically direct their own processes and tool usage". The guide calls both kinds "agentic systems" and draws "an important architectural distinction" between them: neither is better in general. A shorter definition from Simon Willison matches the loop: "An LLM agent runs tools in a loop to achieve a goal."

Picture both as a diagram. A workflow is a <Term id="workflow-dag">workflow DAG</Term>: boxes joined by arrows that never point back, run in the order the arrows allow. Branches exist, but every branch was drawn by a person. An <Term id="ai-agent">AI agent</Term> is a single box with a loop inside: call the model, run the tools it asked for, call the model again. That loop, the <Term id="agent-loop">agent loop</Term>, has no fixed length and no fixed order. The model writes the path as it goes, choosing each <Term id="tool-calling">tool call</Term> after reading the last result.

Two questions tell them apart on a real system:

- **Could you list every step before the run starts?** If yes, it is a workflow, even if a model writes the text in each step.
- **Can the model call a different tool, or the same tool again, because of what it just read?** If yes, that part is an agent.

## Patterns in between

Between a single model call and a free-running agent sits a ladder of patterns. The same guide names five workflow patterns. Each one adds a little structure around model calls. In the first three, a person fixes the path in advance:

| Pattern | What it does | Fits when |
|---|---|---|
| Prompt chaining | Each model call works on the output of the one before | The task splits into fixed steps; the guide says it is "ideal for situations where the task can be easily and cleanly decomposed into fixed subtasks" |
| Routing | One step classifies the input; each class goes down its own path | There are "distinct categories that are better handled separately" and the classification is reliable |
| Parallelization | Several calls work on parts of the task, or on the same task, and the results are combined in code | Independent parts, or several opinions on one question |
| Orchestrator-workers | A central model splits the task and hands parts to worker models | You cannot know the subtasks before you see the input |
| Evaluator-optimizer | One call drafts, another critiques, and the draft is revised | There are "clear evaluation criteria" and revision measurably helps |

The last two are where control starts to move to the model. In orchestrator-workers, the orchestrator decides which subtasks exist, so the shape of the run changes with each input. An evaluator-optimizer loop runs until the evaluator is satisfied, so its length is decided at run time too.

A chain can also carry checks in code between its steps. The guide suggests such programmatic checks on intermediate results, shown as a "gate" in its diagram: a step that stops or reroutes the run when a result is not on track. A gate costs no model call and behaves the same way every time.

## What you give up with an agent

Handing the path to the model buys flexibility. You pay for it in four places.

**Cost.** A workflow makes a known number of model calls. An agent makes as many as it decides to, up to its limit, and every call resends the conversation and the tool definitions. The guide is plain about it: "The autonomous nature of agents means higher costs, and the potential for compounding errors."

**Latency.** Each iteration waits for a full model reply before the next tool call can start. A three-step chain has three model calls; an agent answering the same question might take six.

**Predictability.** A wrong turn early in an agent run is carried into every later step, because each step builds on the last. A workflow fails at a known step, with a known input, which is easier to explain to the person who reported it.

**Testability.** You can test each step of a workflow alone and expect the same structure on every run. An agent may reach the right answer by different paths on different runs, so a test has to check the outcome, and often the tools called, over many inputs rather than one. The guide recommends "extensive testing in sandboxed environments, along with the appropriate guardrails."

None of this argues against agents. It argues for paying these costs only where the flexibility earns them.

## A rule of thumb

Start from the simplest thing that could work, and move down this list only when the step above fails on real inputs:

1. **One model call**, with good instructions and any context it needs (retrieval, examples).
2. **A fixed chain** of calls, with checks in code between them.
3. **Routing**: classify first, then run a fixed path per class.
4. **An agent** for the part that needs it, with a short tool list and a low iteration limit.
5. **Several agents**, such as a <Term id="supervisor-agent">supervisor</Term> with workers, when one agent has too many jobs.

A quick test: write down the steps for ten real inputs. If most of them share one flowchart, build that flowchart as a workflow and send the odd ones to a person or to a fallback path. If the ten flowcharts all differ, because each depends on what a lookup returned, that is the job for an agent.

## Mixing both: a DAG with an agent step

The choice is rarely all or nothing. A common design keeps the outer flow fixed and puts an agent only where the open-ended work is:

- **Fixed edges around the agent.** A trigger, input clean-up and output formatting stay as ordinary steps. They run the same way every time and are easy to test.
- **Routing in front of the agent.** A classifier and a branch send only the open-ended cases to the agent. Simple cases take a short, cheap path.
- **Fixed procedures behind the agent.** When the agent needs to do something that must always happen the same way, such as filing a refund request, give it that procedure as one tool. The agent decides whether and when to call it; the steps inside stay fixed.
- **A person at the risky step.** An <Term id="approval-gate">approval gate</Term> on the write path holds the run until someone decides, whatever the agent concluded.

This keeps the agent's freedom small and visible. The workflow around it limits what can happen; the agent decides only what to look up and how to answer.

## Example: a support inbox

Messages arrive from a web form. Most are refund requests, some are bug reports, and the rest are product questions.

<figure class="recipe-diagram">
<svg viewBox="0 0 680 400" role="img" aria-labelledby="wva-title wva-desc" xmlns="http://www.w3.org/2000/svg"><title id="wva-title">A support workflow with one agent step</title><desc id="wva-desc">A webhook passes the message to a model call that classifies it. A switch sends refunds to an approval gate, bugs to an HTTP request, and questions to an agent. The agent has a chat model and an MCP tool attached to its ports.</desc><defs><marker id="wva-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><g class="rd-node" data-kind="step" transform="translate(10 130)"><rect width="110" height="54" rx="10"/><text class="rd-name" x="12" y="22">Webhook</text><text class="rd-type" x="12" y="40">the message</text></g><g class="rd-node" data-kind="model" transform="translate(145 130)"><rect width="120" height="54" rx="10"/><text class="rd-name" x="12" y="22">Classify</text><text class="rd-type" x="12" y="40">one model call</text></g><g class="rd-node" data-kind="step" transform="translate(290 130)"><rect width="110" height="54" rx="10"/><text class="rd-name" x="12" y="22">Switch</text><text class="rd-type" x="12" y="40">on the class</text></g><g class="rd-node" data-kind="step" transform="translate(460 20)"><rect width="200" height="54" rx="10"/><text class="rd-name" x="12" y="22">Approval Gate</text><text class="rd-type" x="12" y="40">case: refund</text></g><g class="rd-node" data-kind="step" transform="translate(460 130)"><rect width="200" height="54" rx="10"/><text class="rd-name" x="12" y="22">Create issue</text><text class="rd-type" x="12" y="40">case: bug</text></g><g class="rd-node" data-kind="agent" transform="translate(460 240)"><rect width="200" height="54" rx="10"/><text class="rd-name" x="12" y="22">Agent</text><text class="rd-type" x="12" y="40">case: question</text></g><g class="rd-node" data-kind="model" transform="translate(410 336)"><rect width="120" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat model</text><text class="rd-type" x="12" y="40">chat_model</text></g><g class="rd-node" data-kind="tool" transform="translate(550 336)"><rect width="120" height="54" rx="10"/><text class="rd-name" x="12" y="22">Docs search</text><text class="rd-type" x="12" y="40">tool</text></g><path class="rd-edge" d="M120 157 L142 157" marker-end="url(#wva-arrow)"/><path class="rd-edge" d="M265 157 L287 157" marker-end="url(#wva-arrow)"/><path class="rd-edge" d="M400 157 L457 157" marker-end="url(#wva-arrow)"/><path class="rd-edge" d="M430 157 L430 47 L457 47" marker-end="url(#wva-arrow)"/><path class="rd-edge" d="M430 157 L430 267 L457 267" marker-end="url(#wva-arrow)"/><path class="rd-edge is-port" d="M510 294 L470 336"/><path class="rd-edge is-port" d="M610 294 L610 336"/></svg>
<figcaption>Solid arrows are steps in the graph; dashed lines are attachments the agent uses while it runs. Steps after each branch, and the default branch to a human queue, are left out.</figcaption>
</figure>

1. **Classify.** One model call reads the message and answers with one word: `refund`, `bug` or `question`. This is the only model call on two of the three paths.
2. **Route.** A switch sends each word down its own branch. Anything else, such as an empty or odd reply, goes to a default branch that puts the message in a human queue. Switch matches the text exactly, so ask the classifier for the exact lower-case word.
3. **Refunds** follow a fixed procedure: look up the order, draft the reply from a template, then stop at an approval gate. A person approves or rejects every refund. No agent is needed: the steps are the same every time.
4. **Bug reports** become an issue in the tracker through one HTTP request. Again, nothing to decide.
5. **Questions** go to an agent with a documentation search tool and a limit of four iterations. Questions vary, the number of searches needed varies, and this is where an agent earns its cost.

If the questions later turn out to include "where is my order?", give the agent an order-status lookup as one more tool, built as its own small workflow, rather than turning the whole inbox into one agent with every tool.

The result costs one model call for most messages, keeps refunds under a person's control, and confines the unpredictable part to one branch, which you can test on its own.

## Workflows and agents in L2M

In L2M, fixed steps and agents share one canvas. The [workflow editor](/product/workflow-editor) builds a graph of nodes; the engine runs them one at a time in an order their connections allow, and validation refuses a graph with a cycle. The [core nodes](/nodes/core-nodes) cover the fixed parts:

- **IF** sends the run down its true or false branch from a condition template. **Switch** compares a value with a list of cases and takes the matching branch, or its default branch when none matches. Steps on the branch not taken are skipped.
- **Merge / Join** brings branches back together (append, combine by key, or choose one branch). Several branches with a model call each give you sectioning or voting; they run one after another, so they buy focus, not speed.
- **Execute Workflow** runs another workflow as a step, every time the run reaches it.
- **Approval Gate** pauses the run until a person approves or rejects.

The model-driven parts are the **Agent Orchestrator** and **Supervisor Node**. On the canvas an agent is one step in the graph, but it also has attachment ports: `chat_model` for its model, `memory`, `tool` for its tools, and on a supervisor `worker` for other agents. Nodes on a port are not steps; the agent uses them while its loop runs ([attachment ports](/runtime/agent-loop#attachment-ports)). Its `maxIterations` is required: a new Agent Orchestrator starts at 6, a new Supervisor Node at 10.

The **Workflow Tool** node is the bridge between the two. Attached to an agent's `tool` port, it turns another workflow into one tool: the agent decides when to call it, and the child workflow runs its fixed steps with the call's arguments as input ([Workflow Tool](/runtime/workflow-tool)). Unless the child declares itself read-only, it counts as a write tool, so optional write-tool approval asks before each call. That is how to build the order-status lookup from the example. Execute Workflow is the other half: the same child, run as a fixed step rather than offered as a choice.

The [pattern library](/patterns/) has runnable samples of these shapes, including conditional branching from a webhook and a supervisor with workers. To serve a fixed workflow to MCP clients outside L2M, see the [workflow as an MCP tool recipe](/recipes/workflow-as-mcp-tool).

In the live demo, the conditional branching sample is a small fixed workflow: a webhook, one LLM Call, then an IF node that checks the answer is not empty and picks **Success Output** or **Error Output**.

<TryInDemo workflow="wf-conditional" />

See also: [regression testing for AI agents](/learn/testing/regression-testing-agents) shows how to catch a change that breaks an agent step, by saving known-good runs and replaying changes against them.

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering, December 2024): workflows and agents, the five workflow patterns, and when each fits
- [Agent definition](https://simonwillison.net/2025/Sep/18/agents/) (Simon Willison, September 2025): "tools in a loop" as a working definition
- In L2M: [Workflow editor](/product/workflow-editor), [Workflow Tool](/runtime/workflow-tool), [Pattern library](/patterns/)
