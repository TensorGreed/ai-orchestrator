---
title: "What is an AI agent? The tool-calling loop explained"
sidebarTitle: "What is an AI agent?"
description: "An AI agent is a model in a loop that calls tools until it can answer. See the loop step by step, where it fails, and run one locally with no API key."
level: beginner
about: agent-loop
demo: wf-demo-support-agent
demoRecorded: true
related: [ai-agent, agent-loop, tool-calling, context-window, max-iterations]
socialCard: true
---

# What is an AI agent?

An <Term id="ai-agent">AI agent</Term> is a language model running in a loop: it reads the task, decides whether a tool would help, asks for that <Term id="tool-calling">tool call</Term>, reads the result, and repeats until it can answer. The model chooses the steps; the runtime around it runs the tools and decides when to stop. That loop, the <Term id="agent-loop">agent loop</Term>, is what separates an agent from a single model call.

## The loop, step by step

<figure class="recipe-diagram">
<svg viewBox="0 0 680 290" role="img" aria-labelledby="agent-loop-title agent-loop-desc" xmlns="http://www.w3.org/2000/svg"><title id="agent-loop-title">The agent loop</title><desc id="agent-loop-desc">The runtime sends messages and tool definitions to the model. If the model asks for tools, the runtime runs them, adds the results to the messages and calls the model again. If the model answers in text, or the iteration limit is reached, the loop ends.</desc><defs><marker id="agent-loop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><g class="rd-node" data-kind="step" transform="translate(10 40)"><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Messages + tools</text><text class="rd-type" x="12" y="40">prompt, history, schemas</text></g><g class="rd-node" data-kind="model" transform="translate(250 40)"><rect width="170" height="54" rx="10"/><text class="rd-name" x="12" y="22">Call the model</text><text class="rd-type" x="12" y="40">one iteration</text></g><g class="rd-node" data-kind="step" transform="translate(480 40)"><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Final answer</text><text class="rd-type" x="12" y="40">text, no tool calls</text></g><g class="rd-node" data-kind="tool" transform="translate(235 200)"><rect width="200" height="54" rx="10"/><text class="rd-name" x="12" y="22">Run the tools</text><text class="rd-type" x="12" y="40">add results as messages</text></g><path class="rd-edge" d="M200 67 L247 67" marker-end="url(#agent-loop-arrow)"/><path class="rd-edge" d="M420 67 L477 67" marker-end="url(#agent-loop-arrow)"/><path class="rd-edge" d="M365 94 L365 197" marker-end="url(#agent-loop-arrow)"/><path class="rd-edge" d="M305 200 L305 97" marker-end="url(#agent-loop-arrow)"/><text class="rd-type" x="375" y="150">tool calls</text><text class="rd-type" x="295" y="150" text-anchor="end">results</text><text class="rd-type" x="449" y="58" text-anchor="middle">answer</text><text class="rd-type" x="480" y="114">or: iteration limit reached</text></svg>
<figcaption>Each pass down and back up is one iteration: one model call, then the tools that call asked for.</figcaption>
</figure>

1. **Collect the messages.** The system prompt, the user's message and, if the agent has memory, the earlier conversation.
2. **Call the model with the tool definitions.** Each tool has a name, a description and a JSON Schema for its arguments.
3. **Read the reply.** The model either answers in text, or asks for one or more tool calls: a tool name plus arguments.
4. **Run the tools.** The runtime calls each tool and adds its result to the conversation as a tool message.
5. **Call the model again**, now with the results in view, and go back to step 3.

The loop ends when the model replies with text and asks for no tools (its final answer), or when it reaches the iteration limit you set.

A worked example. Asked "A customer has 49 seats at $12 per seat per month. What is the yearly cost?", an agent with a calculator tool might:

- **Iteration 1:** the model asks for `calculator` with `49 seats * $12 * 12 months`. The calculator only takes digits and operators, so it returns an error.
- **Iteration 2:** the model reads the error and asks again with `49*12*12`. The calculator returns `7056`.
- **Iteration 3:** the model answers: "$7,056 a year."

Nobody has to write "retry with plain arithmetic" into the program: a capable model reads the error and adjusts. That is the point of a loop.

## What makes it an agent

A single model call answers from what it already knows and what is in the prompt. An agent can look things up, compute, or change something in another system, and it decides the order itself.

A useful line comes from Anthropic's guide to building agents: workflows are "systems where LLMs and tools are orchestrated through predefined code paths", while agents are "systems where LLMs dynamically direct their own processes and tool usage". A fixed workflow runs the same steps every time; an agent picks its next step from what it just learned.

That freedom has a price. The same guide notes that agentic systems "often trade latency and cost for better task performance", and recommends the simplest solution that works: often a single, well-prompted model call is enough. Many real systems mix both: a fixed workflow with one agent step inside it.

## Zero, one or many tool calls per turn

A model reply is not limited to one tool call:

- **Zero.** The model answers straight away. "What is 2 + 2?" rarely needs a calculator.
- **One.** The common case: look something up, then answer.
- **Many.** The model can ask for several calls in one reply, for example the weather in three cities. The runtime runs each one and adds every result before the next model call.

Across iterations the calls can depend on each other: look up a customer's plan first, then compute the price from it. The model sees each result before it decides the next step.

## How it stops

An agent stops in one of these ways:

- **A final answer.** The model replies with text and no tool calls. This is the normal ending.
- **The iteration limit.** A cap on model calls, often called <Term id="max-iterations">max iterations</Term>. Anthropic's guide names stopping conditions such as "a maximum number of iterations" as a common way to keep control. Pick a limit that fits the task: a lookup-then-answer agent needs only a few, a research task more.
- **A question for the person.** Some runtimes let the agent pause and ask for missing information instead of guessing, then carry on when the person replies.
- **An error or a block.** A model error, a timeout, or a rule that stops a tool call.

## How it goes wrong

- **It never stops.** The model keeps asking for tools, often the same one with the same arguments. The iteration limit ends the run instead of letting it spend forever.
- **The wrong tool.** Two tools with similar names or vague descriptions get mixed up. Tool descriptions are prompts: write them as carefully as the system prompt.
- **Too many tools.** Every tool definition takes room in the model's <Term id="context-window">context window</Term>. A long tool list crowds out the task, and the model picks the wrong tool more often. Give each agent only the tools it needs.
- **Results too large.** A tool that returns a whole database table can overflow the context on the next call. Return what the model needs, not everything.
- **Made-up arguments.** The model invents an id or a date. Tools should validate input and return a clear error the model can act on.
- **Instructions inside data.** Text a tool returns can contain instructions ("ignore your previous task"). The model may follow them. This is prompt injection, and the main reason to limit what an agent's tools can do.

## Memory in one paragraph

A model remembers nothing between calls; the runtime sends the history each time. Within one run, the growing message list is the agent's short-term memory. Across runs, a memory store keeps the conversation under a session id, so the next question in the same chat starts with the earlier ones. Memory is bounded by the context window, so runtimes keep the last N messages or a summary, and it holds whatever users typed, so treat it as personal data with a retention period.

## The same loop in L2M

In L2M, the **Agent Orchestrator** node runs this loop. Its ports say what it works with:

- `chat_model`: the model it calls, for example an OpenAI, Anthropic or Ollama chat model node;
- `tool`: one or more MCP Tool or Workflow Tool nodes, whose tools it offers to the model;
- `memory`: an optional Simple Memory node that sets where the conversation is kept (its namespace) and how many messages. With a session id the agent keeps its conversation even without one, in a default namespace.

These attachments are not steps in the workflow; the agent uses them while it runs. Tools come from MCP servers (see [What is MCP?](/learn/mcp/what-is-mcp)), and each usually reaches the model as `<adapter>__<tool>`, such as `http_mcp__calculator` (tools with clashing names are renamed after their server).

What the runtime does at each edge of the loop:

- Tool calls from one reply run one after another, and every result is added before the next model call. A tool that fails returns its error to the model as the tool's result, so the model can retry. After two failures in a row, that tool is disabled for the rest of the run.
- `maxIterations` on the node is the limit. It is required (validation rejects an agent without it), and new nodes start at 6. If the model is still asking for tools when the limit is reached, the run stops with the text of the model's last reply, or with "Agent stopped after reaching iteration limit." if that reply had none.
- If the model sends back an empty reply while iterations remain, the runtime asks it to answer or call a tool instead of accepting the empty reply.
- The agent can call a built-in `agent_clarify` tool to ask the person a question. The run then stops and returns the question, and the next message in the same session is fed back as the answer.
- With a session id, full tool results are kept outside the prompt, and the agent gets `session_cache_list` and `session_cache_get` tools to read them again on later turns instead of calling the server twice.

Every iteration, model call and tool call shows on the run's trace. Governance is optional and off until you set it up: [tool policy](/product/mcp-tool-policy), [approval before write tools](/guides/human-approval-for-agent-tool-calls) and [budgets](/product/budgets).

When one agent has too many jobs, split it: a supervisor agent can hand parts of the task to worker agents, each with its own model and tools. See [supervisor and worker agents](/learn/agents/supervisor-and-workers).

## Try it in L2M

**Watch the loop in your browser.** The live demo's support agent has a knowledge-base tool and a calculator on a small MCP server. Its recorded run shows the same pattern as the worked example, with a knowledge-base lookup first: a calculator call that fails, a retry that works, then the answer. It was recorded with a scripted stand-in model, so no key is needed to replay it; the stand-in's retry is scripted, where a real model would decide it on its own.

**Run one locally with no API key.** The [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) is a ready workflow: one agent, two MCP tools from a bundled mock MCP server, and the built-in echo provider as its model. Echo is not a real model: it repeats the prompt and never asks for a tool, so a local run ends after one model call. That proves the wiring works. Attach a real chat model to run the loop yourself.

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic)
- [MCP specification, 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [Agent loop in L2M](/runtime/agent-loop): ports, tool names, the session tool cache
- [Build your first MCP agent in 5 minutes](/getting-started/build-your-first-mcp-agent)
- [Common issues: agent hits max iterations](/troubleshooting/common-issues#agent-hits-max-iterations)
