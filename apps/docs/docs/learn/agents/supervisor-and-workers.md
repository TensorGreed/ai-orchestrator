---
title: "Multi-agent systems: supervisor and worker agents"
sidebarTitle: "Supervisor and workers"
description: "How a supervisor agent delegates to worker agents exposed as tools: when it helps, what it costs, how to test it, and a sample that runs with no API key."
level: intermediate
about: supervisor-agent
demo: wf-demo-research-swarm
demoRecorded: true
related: [supervisor-agent, worker-agent, ai-agent, tool-calling, agent-loop]
socialCard: true
---

# Multi-agent systems: supervisor and worker agents

The supervisor and worker pattern is one way to build a multi-agent system, also called the orchestrator-worker pattern. One agent (the <Term id="supervisor-agent">supervisor</Term>) splits a task and hands each part to a specialist agent (a <Term id="worker-agent">worker</Term>). The supervisor sees each worker as a tool: calling it starts the worker's own agent loop, with its own model, tools and prompt, and the worker's result comes back as the tool result. The supervisor then combines the answers into one reply.

## The pattern

A single <Term id="ai-agent">agent</Term> with every tool and every instruction works until it doesn't. Its system prompt grows to cover billing, search and arithmetic at once, its tool list gets long, and it starts picking the wrong tool. The supervisor pattern splits that one agent by job:

- The **supervisor** knows the overall goal and which specialist handles what. It usually has few or no tools of its own.
- Each **worker** has a narrow job, a short prompt for it, and only the tools that job needs.

Anthropic's guide to building agents describes it as the orchestrator-workers workflow: "a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results." The guide says it fits "complex tasks where you can't predict the subtasks needed". That is the difference from a fixed pipeline: the supervisor decides at run time which workers to call, in what order and how often.

<figure class="recipe-diagram">
<svg viewBox="0 0 660 330" role="img" aria-labelledby="sw-title sw-desc" xmlns="http://www.w3.org/2000/svg"><title id="sw-title">A supervisor with two workers</title><desc id="sw-desc">The supervisor has a chat model and two workers, a researcher and an analyst. The researcher has its own chat model and a knowledge-base tool. The analyst has its own chat model and a calculator tool. The supervisor calls each worker through a delegate tool.</desc><path class="rd-edge is-port" d="M330 74 L330 100 L160 100 L160 128"/><path class="rd-edge is-port" d="M330 100 L500 100 L500 128"/><path class="rd-edge is-port" d="M405 47 L470 47"/><path class="rd-edge is-port" d="M110 182 L110 236"/><path class="rd-edge is-port" d="M210 182 L210 236"/><path class="rd-edge is-port" d="M450 182 L450 236"/><path class="rd-edge is-port" d="M550 182 L550 236"/><g class="rd-node" data-kind="agent" transform="translate(255 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Supervisor</text><text class="rd-type" x="12" y="40">splits and combines</text></g><g class="rd-node" data-kind="model" transform="translate(470 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat model</text><text class="rd-type" x="12" y="40">chat_model</text></g><g class="rd-node" data-kind="agent" transform="translate(70 128)"><rect width="180" height="54" rx="10"/><text class="rd-name" x="12" y="22">researcher</text><text class="rd-type" x="12" y="40">delegate_to_researcher</text></g><g class="rd-node" data-kind="agent" transform="translate(410 128)"><rect width="180" height="54" rx="10"/><text class="rd-name" x="12" y="22">analyst</text><text class="rd-type" x="12" y="40">delegate_to_analyst</text></g><g class="rd-node" data-kind="model" transform="translate(40 236)"><rect width="120" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat model</text><text class="rd-type" x="12" y="40">its own</text></g><g class="rd-node" data-kind="tool" transform="translate(170 236)"><rect width="120" height="54" rx="10"/><text class="rd-name" x="12" y="22">lookup_kb</text><text class="rd-type" x="12" y="40">MCP tool</text></g><g class="rd-node" data-kind="model" transform="translate(380 236)"><rect width="120" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat model</text><text class="rd-type" x="12" y="40">its own</text></g><g class="rd-node" data-kind="tool" transform="translate(510 236)"><rect width="120" height="54" rx="10"/><text class="rd-name" x="12" y="22">calculator</text><text class="rd-type" x="12" y="40">MCP tool</text></g></svg>
<figcaption>The demo's research team. Dashed lines are attachments: the supervisor's workers, and each agent's model and tools.</figcaption>
</figure>

## Workers as tools: what the supervisor sees

The supervisor does not need a special protocol to delegate. It already knows how to call tools, so each worker is presented to its model as one more tool. In L2M a worker named `researcher` whose system prompt starts "Answer factual questions with the lookup_kb tool." becomes this tool (the demo's own worker prompt starts with a `[researcher]` tag used by its scripted model):

```json
{
  "name": "delegate_to_researcher",
  "description": "Delegate task to researcher. Hint: Answer factual questions with the lookup_kb tool.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task_prompt": {
        "type": "string",
        "description": "The explicit prompt, context, or task instructions to give this worker."
      }
    },
    "required": ["task_prompt"]
  }
}
```

The hint is the first 100 characters of the worker's system prompt as written, with placeholders not filled in, so start that prompt with what the worker is for. A worker left on the default prompt template gives the supervisor a useless hint. When the supervisor's model calls the tool, the `task_prompt` it wrote becomes the worker's user prompt, and the worker runs a full agent loop. The worker's output goes back to the supervisor as the tool result.

Two things follow from this design:

- **The worker starts from the task it was given.** With the usual user prompt template, the worker's user message is the `task_prompt`, not the user's original message, and it does not see the supervisor's conversation in this run. If the worker needs a customer id or a date, the supervisor must put it in `task_prompt`; say so in the supervisor's system prompt. (A worker with no system prompt of its own gets the run's system prompt, so give each worker one.)
- **The supervisor sees the worker's whole output.** In L2M that is not just the final answer: the tool result carries the worker's answer, its steps, its tool calls and their results, and its messages, including its system prompt, cut to the agent's tool message limit. The supervisor can check the worker's working, but every delegation adds that output to the supervisor's context, and the worker's prompt and tool results reach the supervisor's model.

## A recorded run, call by call

The live demo's research team got this request: "Brief the team: what is RAG, and how many uncached retrievals a day at 1,250 queries and an 18% miss rate?" The recorded run went like this:

1. The supervisor's model called `delegate_to_researcher` with "Look up what RAG is in the knowledge base."
2. The researcher called `lookup_kb` with `{"topic": "rag"}`, read the entry, and answered in one sentence.
3. The supervisor's model called `delegate_to_analyst` with "Compute 1250 * 0.18 for the daily uncached retrievals."
4. The analyst called `calculator` with `1250*0.18` and answered "1250 × 0.18 = 225."
5. The supervisor wrote the summary: what RAG is, and about 225 uncached retrievals a day.

That run made seven model calls: three by the supervisor (two delegations and the summary) and two by each worker (one tool call and one answer). The recording used a scripted stand-in model so the demo needs no key, but the count is what the structure implies: every delegation costs at least one extra model call in the worker, plus a supervisor call to read its result.

## Giving each worker its own model, tools and memory

Because each worker is a full agent, you can tune it on its own:

- **Model.** A narrow worker with a clear job often does well on a smaller, cheaper model. Keep the stronger model for the supervisor, which has to plan and combine.
- **Tools.** Give each worker only its tools. A worker that can only read cannot be talked into writing, whatever its input says. Put write tools on one worker, and require approval on that one.
- **Prompt.** Short and specific: what the worker does, which tools to use, and what its answer should look like.
- **Memory and limits.** Each worker has its own iteration limit and, if it needs one, its own memory. Give each worker its own session id or Simple Memory namespace: agents that share a session id and namespace share the stored conversation on later turns. Give the supervisor a higher limit than the workers, since one supervisor turn can span several delegations.

## When one agent is enough

The pattern adds model calls, latency and moving parts. Anthropic's guide recommends "finding the simplest solution possible, and only increasing complexity when needed." Prefer a single agent when:

- the whole task fits in one short prompt, and the agent needs fewer than a handful of tools;
- the steps are always the same: a fixed workflow is cheaper and easier to test than a supervisor that must rediscover the order every run;
- the parts depend tightly on each other's details, so the supervisor would have to pass almost the whole conversation to each worker anyway.

Reach for workers when you can name distinct jobs with distinct tools, when one agent's tool list has grown long enough to cause wrong picks, or when parts of the task need different models or different permissions.

## Cost and latency

A rough way to estimate a supervisor run:

- **Model calls.** The supervisor's calls (one per round of delegation, plus one to answer) plus each worker's own loop (at least one call to answer, plus one per round of tool calls). The demo run above: 3 + 2 + 2 = 7.
- **Tokens.** Every one of those calls sends a system prompt and a tool list, and each worker's output lands in the supervisor's context. Short worker prompts, small tool lists and compact tool results pay off directly.
- **Latency.** In L2M, tool calls from one model reply run one after another, so workers run one at a time. A supervisor run takes at least as long as all its workers' loops added together.
- **Runaway risk.** A confused supervisor can call the same worker repeatedly. Iteration limits on every agent cap one run. Across runs, a [budget](/product/budgets) caps spend per day, week or month, and a blocking budget refuses new runs once it is used up. Budgets are optional.

## Testing a multi-agent run

More agents mean more places for a change to break something. The supervisor might stop delegating to a worker after a prompt edit, or a worker might start returning a different format the supervisor misreads. Test the parts and the whole:

- **Test each worker alone.** A worker is an ordinary agent. Run it with a fixed task prompt and check its answer before you wire it in.
- **Check the delegation, not just the final text.** In a good run, which workers were called, in what order, with what task? The run trace answers that: worker activity appears in the supervisor's trace, marked with the worker it came from.
- **Keep a known-good run.** Record a run's MCP calls and save it as a [golden run](/product/golden-runs). After a prompt or model change, <Term id="replay">replay</Term> against it: MCP calls are answered from the recording, so the replay has no live side effects, and you see what changed in the output, the tool calls and the cost.
- **Gate releases on it.** A [release gate](/product/release-gate) can require replays to pass before a new version is published. See [CI for AI agents](/guides/ci-for-ai-agents).

[Regression testing AI agents](/learn/testing/regression-testing-agents) explains golden runs and replay in more depth. These testing features are optional. A supervisor workflow runs without any of them.

## The pattern in L2M

- The **Supervisor** node has the same `chat_model`, `tool` and `memory` ports as the Agent Orchestrator, plus a `worker` port.
- A worker is an Agent Orchestrator node, or another Supervisor, attached to that port. Each one becomes a `delegate_to_<worker name>` tool, with characters other than letters, digits, `_` and `-` replaced by `_`. The resulting tool names must be unique on one supervisor, so `a b` and `a_b` clash too; validation reports a clash as `duplicate_agent_tool_name`.
- A worker runs with its own chat model, tools, memory and `maxIterations`, and its user prompt is the `task_prompt` the supervisor wrote.
- [Tool policy](/product/mcp-tool-policy) and approvals apply inside workers too. If a worker's tool call waits for a person's [approval](/product/approvals), the supervisor's run pauses with it.

## Try it in L2M

**Watch it in your browser.** The demo link on this page opens the research team in the studio and plays the recorded run above, worker by worker.

**Run the sample locally with no API key.** The [supervisor and worker recipe](/recipes/supervisor-worker-agents) is a supervisor with a researcher and a "computer" worker, all on the built-in echo provider and the bundled mock MCP server. Echo never asks for a tool, so the supervisor answers on its first turn and delegates nothing. That checks the wiring. Attach a real chat model to each agent to see it delegate.

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic): the orchestrator-workers pattern, and when not to build agents
- [What is an AI agent?](/learn/agents/what-is-an-ai-agent): the loop every worker runs
- [Pattern library: Supervisor + Worker swarm](/patterns/)
- [Agent loop: attachment ports](/runtime/agent-loop#attachment-ports)
- [Golden runs and replay](/product/golden-runs)
