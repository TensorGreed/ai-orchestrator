---
title: "Too many tools: keeping an agent's tool list small"
sidebarTitle: "Too many tools"
description: "Why long MCP tool lists hurt agents (context, wrong picks, cost), and practical fixes: shortlisting, toolsets, per-agent servers and rules that hide tools."
level: intermediate
about: mcp-tool
demo: wf-demo-research-swarm
demoRecorded: true
related: [mcp-tool, context-window, toolset, tool-calling, mcp-tool-policy, token-llm]
---

# Too many tools

Every <Term id="mcp-tool">tool</Term> an agent can use is described to the model on every request, so a long tool list costs <Term id="token-llm">tokens</Term> on every turn, leaves less room for the task, and makes wrong picks more likely. The fix is to decide which tools each agent really needs and to send only those: connect each agent to its own servers, select tools rather than taking whole servers, publish small <Term id="toolset">toolsets</Term> to outside clients, and let deny rules hide what nobody should call. Then measure which tools are actually used, and remove the rest.

## What a tool list costs

A model cannot call a tool it has not been told about. So before each request, the runtime sends the model the full description of every tool it may use: the name, a description in plain words, and a JSON Schema for the arguments. The model reads all of it to decide on a <Term id="tool-calling">tool call</Term>.

That description is not sent once. An agent calls the model once per iteration of its loop, and each call carries the whole list again. A run that takes five iterations sends the list five times; a chat with ten turns sends it on every turn of every run. The definitions count as input tokens each time, and they share the model's <Term id="context-window">context window</Term> with the system prompt, the conversation and the tool results.

MCP makes adding tools easy, which is how lists grow. Connect a code hosting server, a ticket tracker and a docs search server to one agent and it may hold a hundred tools, most of which a given task never touches. Each server was designed on its own, so none of them knows how long the combined list has become.

The spec recognises that this list sits in the prompt. The 2026-07-28 revision adds that servers should return tools from `tools/list` "in a deterministic order to enable client-side caching and improve LLM prompt cache hit rates". A stable order helps prompt caching; it does not make the list any shorter.

## Symptoms

- **Wrong picks.** Three servers each offer a `search` tool, or two tools have near-identical descriptions, and the model calls the wrong one, or fills one tool's arguments with another's fields. Anthropic's guide on tool design asks for "clear boundaries from other tools" in each definition and notes that this "is especially important when using many similar tools."
- **Ignored tools.** The right tool is in the list, but buried among dozens of others, and the model answers from memory instead.
- **Cost per request goes up** even when the agent calls nothing, because the definitions are paid for on every model call.
- **Long runs hit the context limit.** Tool results pile up on top of a large fixed block of definitions, and a run that worked with a short list fails or gets cut off with a long one.
- **More to secure.** Every listed tool is one the model can be talked into calling. OWASP lists "Excessive Functionality" first among the causes of <Term id="excessive-agency">excessive agency</Term>: an agent with access to "functions that are not needed for the intended operation of the system."

## Fix 1: give each agent only its servers

The cheapest token is the definition you never send. Start from the task, not from the servers you happen to have:

- Connect an agent only to the servers its job needs. A billing agent needs the billing server, not the code host.
- Within a server, select the tools you need instead of taking all of them. A docs server may offer `search`, `get_page`, `create_page` and `delete_page`; a question-answering agent needs the first two.
- When one agent needs many unrelated tools, it usually has more than one job. Split it: a <Term id="supervisor-agent">supervisor agent</Term> with workers, each holding a short list of its own. The supervisor sees each worker as a single tool.

OWASP's first mitigation for excessive agency says the same thing from the security side: "Limit the extensions that LLM agents are allowed to call to only the minimum necessary."

## Fix 2: shortlist by prompt relevance

When an agent truly needs a large catalogue, the runtime can pick a shortlist per request: score each tool against the user's message, by keywords or by embeddings, and send only the best matches.

It helps when the request names its subject clearly ("open a ticket for the billing bug"). It has sharp edges:

- A request can use different words from the tool. "Refund this order" may not match a tool described as "issue a credit".
- Follow-ups carry no keywords. "Do the same for the next one" scores nothing against any tool.
- A shortlist chosen once, from the first message, cannot follow the agent when a tool result shows it needs a tool it was not given.

A shortlist is a fallback for large catalogues, not a replacement for choosing tools. If you can name the tools an agent needs, name them.

## Fix 3: toolsets for clients

Agents you build are not the only callers. A desktop chat app, an IDE or another team's agent may connect to your tools through an MCP gateway. Give each such client a toolset: a named group of tools served at its own endpoint. A support assistant connects to the support toolset; IDE agents connect to the engineering one. Each client's `tools/list` then returns its own short list, and its credential can call nothing else.

## Fix 4: deny rules hide tools

A deny rule usually means "refuse this call". It is more useful when it also removes the tool from the list before the model sees it: the model cannot pick a tool it was never shown, and you stop paying for its definition. Rules that depend on a call's arguments cannot do this, because there are no arguments yet when the list is built; they can only refuse the call when it comes.

Hiding is not a security boundary by itself. A model can still ask for a tool by name, from a prompt or a poisoned result, so the same rule must also be checked on every call.

## Name collisions across servers

The MCP spec says tool names "SHOULD be unique within a server". Nothing makes them unique across servers. Connect a docs server and a tracker that both offer `search`, and a client that passes names straight through gives the model two tools with one name. Neither the model nor anything that checks the call can then tell which one was meant.

Clients usually fix this with a prefix: the server's name before the tool's name. That helps the model too, as long as the description says which system the tool reaches. Keep the result within the length your model providers accept.

## Measure it

Treat the tool list like any other cost:

- **Count what is offered.** For each agent, list the tools it was given on a typical run.
- **Count what is called.** Over a week of real runs, which of those tools were called at all? A tool that was never called is a candidate to drop.
- **Watch input tokens per model call**, before and after a change. Trimming a list shows up there first.
- **Check the wrong picks.** Runs where the agent called a tool and then called a different one for the same step point at names or descriptions that need work.

Then remove the unused tools, or hide them with a rule, and measure again.

## Keeping tool lists small in L2M

In L2M, an agent's tools come from **MCP Tool** and **Workflow Tool** nodes attached to its `tool` port. Each MCP Tool node has a **Tools To Include** setting: **All discovered tools (agent decides)**, **Single tool only**, or **Select multiple tools**. Every tool those nodes select is sent to the model; picking a subset is the main way to keep the list short.

- **Per-agent tools.** Each agent and each worker of a Supervisor has its own `tool` port, so two agents can use the same server and see different tools. In the demo's research team, the researcher's only MCP tool is the knowledge-base lookup and the analyst's is the calculator, both from one MCP server.
- **Compact definitions.** When an agent starts, the runtime shortens what it will send: descriptions are cut to 280 characters, and each input schema keeps at most 8 top-level arguments, each with its type, a description cut to 120 characters and up to 10 enum values. The inner structure of nested objects and arrays is dropped. Keep arguments flat and few, and put the important words first in a description. The runtime's own tools, such as `agent_clarify`, are always added.
- **A narrow shortlist.** Prompt-relevance shortlisting applies only to an agent with no MCP Tool or Workflow Tool node attached. Its tools then come from servers listed in the node's JSON config (`mcpServers`) and, on a Supervisor, from its workers. They are scored once per run against the user's message: one point for each word of four or more characters (each time it appears) that occurs anywhere in a tool's name or description. If the best tool scores two or more, up to 6 tools with that top score are kept; otherwise up to 6 tools with any score; if none scores, the first 8. The kept definitions must also fit in about 18,000 characters. Agents built with tool nodes skip this step.
- **Names.** A tool reaches the model as `<adapter>__<tool>`; when two servers on one agent serve the same name, both are renamed after their server and their descriptions name it ([tool names the model sees](/runtime/agent-loop#tool-names-the-model-sees)). Names you choose, such as two Workflow Tools with one tool name, must be unique, and the agent fails until they are.
- **Toolsets.** Optionally, the [MCP gateway](/product/mcp-gateway#toolsets) serves toolsets at `/mcp/<slug>`; a server member can be narrowed with a glob such as `read_*`, and each client token lists the toolsets it may call.
- **Deny rules.** Optionally, a [tool policy](/product/mcp-tool-policy#how-it-is-enforced) deny rule, or a workflow's **No write tools** switch, takes tools out of an agent's list at the start, and each call is still checked when it is made. A gateway toolset's preview shows which tools a rule hides for each role, and the agent's trace lists its hidden tools.
- **Measure.** The node's activity shows the tool names an agent was given. The **Tools** table on an MCP server's page counts calls per tool, across every workflow and client that uses the server, over 24 hours, 7 or 30 days, and shows a dash for tools with no calls ([tool telemetry](/product/mcp-server-registry#tool-telemetry); for what each call records, see [MCP tool-call telemetry](/product/mcp-tool-call-telemetry)). Optionally, an admin can ask for [rule suggestions from real runs](/guides/least-privilege-from-real-runs): for each workflow or gateway client, an allow for every tool it called and a deny covering the rest of that server's tools, added in shadow mode first.

The live demo's research team shows per-agent tools: a supervisor with two workers, each holding one tool from the same server.

<TryInDemo workflow="wf-demo-research-swarm" recorded />

To build the same shape yourself, follow the [supervisor and worker agents recipe](/recipes/supervisor-worker-agents).

See also: [LLM cost control](/learn/operations/llm-cost-control) covers where agent spend comes from and how to cap it with budgets.

## Further reading

- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io): tool definitions, `tools/list` and the tool name rules
- [MCP specification 2026-07-28: Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io): deterministic tool order for prompt caching
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering): Appendix 2, "Prompt engineering your tools"
- [OWASP LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) (genai.owasp.org): excessive functionality and minimising extensions
- In L2M: [Agent loop: tool names](/runtime/agent-loop#tool-names-the-model-sees), [MCP gateway: toolsets](/product/mcp-gateway#toolsets), [MCP tool policy](/product/mcp-tool-policy#how-it-is-enforced)
