---
title: "Controlling LLM and agent costs: budgets and caps"
sidebarTitle: "LLM and agent cost control"
description: "Why agent costs run away (loops, long tool lists), where to put spend and token budgets (user, project, client), warn vs block, and estimating usage."
level: intermediate
about: budget
related: [budget, token-llm, rate-limit, unbounded-consumption, max-iterations]
socialCard: true
---

# Controlling LLM and agent costs

Agent spend is the number of <Term id="token-llm">tokens</Term> sent to and received from models, times each model's price. Agents spend more than single model calls because they call the model several times per task and send the whole conversation again each time. You control it with three kinds of limit: a cap on steps inside one run, a <Term id="budget">budget</Term> per scope and period that warns or blocks, and a <Term id="rate-limit">rate limit</Term> on how fast one caller may go.

## Where agent spend comes from

A chat completion is billed on its input tokens and its output tokens. An <Term id="agent-loop">agent loop</Term> makes several completions per task, and each one carries more input than the last:

| Turn | What the model receives | Grows because |
| --- | --- | --- |
| 1 | System prompt, user message, every tool definition | Each tool's name, description and schema is sent on every call |
| 2 | All of turn 1, the model's tool request, the tool result | Tool results are added to the conversation |
| 3 | All of turn 2, another request, another result | The conversation keeps growing until the model answers |

So the same question can cost very different amounts. A task that needs one tool call costs two model calls. A task where the model keeps searching costs as many calls as the loop allows, each with a longer input than the one before.

The usual causes of a surprise bill:

- **Loops that do not stop.** The model keeps asking for tools without converging.
- **Long tool lists.** Fifty tool definitions on every call cost input tokens whether or not any is used ([keeping an agent's tool list small](/learn/agents/too-many-tools)).
- **Large tool results.** A tool that returns a whole table puts all of it into every later call of the run.
- **Retries.** A call that fails after the model has started answering may be billed, and the retry is billed again. A retry loop around a whole agent multiplies everything above.
- **Hidden callers.** Evals with a model as judge, sub-workflows, and other teams' scripts on a shared key.
- **Abuse.** OWASP's LLM10, <Term id="unbounded-consumption">Unbounded Consumption</Term>, includes "Denial of Wallet": an attacker initiates "a high volume of operations" to "exploit the cost-per-use model" of AI services.

## Cap the run first

The cheapest control is inside the run itself:

- **An iteration limit.** Every agent should have a <Term id="max-iterations">maximum number of iterations</Term>. When it is reached, the agent stops asking the model and returns what it has, even if the task is not finished. Pick it from the task: a lookup needs two or three; research may need ten.
- **Fewer tools per agent.** Attach the tools a task needs, not every tool a server has. Split a large agent into a <Term id="supervisor-agent">supervisor</Term> and focused workers if one agent needs too many.
- **Shorter tool results.** Trim results before they go back to the model: fields the task does not need, long lists, raw HTML.

None of these needs a budget, and all of them make the per-run cost predictable enough to budget for.

## Caps at different scopes

A budget is a limit on spend (in a currency) or on tokens, for one scope, over one period. Pick scopes that match who can cause the spend and who pays for it:

| Scope | Catches | Example |
| --- | --- | --- |
| Deployment | Everything, as a last line | 2,000 USD a month, block |
| Project or team | One team's runs, for chargeback | 300 USD a month for Support, warn at 80% |
| Workflow | One agent that misbehaves | 20 USD a day for the triage agent, block |
| User | One person's runs | 5 USD a day per user, block |
| API client | One application or IDE agent | 1 million tokens a week for the docs bot, block |

Scopes stack. A run counts toward its workflow, its project, its user and the deployment at the same time, and the first block budget that is used up stops it.

Spend is not the only unit. A model without a price, such as a local model or a server you host, adds nothing to a currency budget. Give those a token budget instead.

## Warn or block

- **Warn** never stops anything. It sends an alert as usage crosses a threshold (say 80%) and again at the cap. Use it where stopping work costs more than the overspend: a customer-facing agent, a nightly job.
- **Block** refuses new work once the cap is reached, until the period resets. Use it where a runaway is worse than a pause: experiments, per-user and per-client caps, the deployment total.

A block is a business decision, so decide in advance what the blocked caller sees and who can raise the cap.

## What a blocked caller sees

A refusal should be explicit, machine-readable and say when to retry. Silent failures turn into retries, and retries cost more. Common forms:

- An HTTP API answers `402 Payment Required` or `429 Too Many Requests`, with a `Retry-After` header set to the end of the period.
- A scheduled job records a failed run with the budget's name, so someone sees it the next morning.
- An MCP tool call returns an error the agent can read and report, instead of hanging.

## Estimating usage when the provider sends none

Budgets are only as good as the usage they count. Providers usually report token counts, but not always: some streaming endpoints leave them out unless asked, compatible servers differ, and a stream cut part way has no final usage frame. Counting those calls as zero lets a caller spend without limit. Estimate instead, lean high, and mark the number as an estimate so nobody mistakes it for a bill.

## Rate limits and budgets do different jobs

A budget limits the total over a day, week or month. A rate limit limits the pace: calls per minute, a burst, calls at once. They fail in different ways:

- A budget alone lets a loop spend the month's allowance in an hour, then blocks everyone for the rest of the month.
- A rate limit alone slows a loop down but lets it run all month.

Budgets are usually checked when work starts and counted when it ends, so calls running at the same time can together pass a cap before any of them is counted. A limit on calls at once keeps that overshoot small. Use both for any caller you do not fully control.

## Prices you control

Cost figures come from a price table: price per million input tokens, per million output tokens, and often a lower price for cached input. List prices change, and many teams pay negotiated rates. Keep the table in your own configuration, and remember that a computed cost is an estimate; the provider's invoice is the bill.

## A starting policy

1. Set an iteration limit on every agent.
2. Add a deployment budget, set to block, at a level you would accept as the worst month.
3. Add a warn budget per project at 80% of what you expect, for chargeback and early notice.
4. Give every external caller its own token, with a block budget and a rate limit.
5. Use token budgets for models without a price.
6. Review the alerts after a month and tighten what was never close.

## In L2M

[Budgets](/product/budgets) are optional; with none set, nothing is checked. Admins set them under **Settings → Cost & quality → FinOps**, with the scopes global, project, workflow, user and MCP client, a limit in USD or tokens, a day, week or month period in UTC, and the action warn or block. Warn alerts at 80% by default and at the cap, and can post to a notify webhook.

- A used-up block budget stops a run before it starts, whatever trigger started it. Editor runs, the API and webhooks get `HTTP 402` with `error: "budget_exceeded"` and a `Retry-After` header; schedules and polling triggers record one failed run naming the budget. Eval runs, tape-only <Term id="replay">replays</Term>, approval resumes and error workflows are not refused, but their spend still counts. [MCP gateway](/product/mcp-gateway#budgets-and-rate-limits) calls get JSON-RPC error `-32032`, and the [/v1 AI gateway](/product/ai-gateway#budgets-and-rate-limits) answers `429` with code `insufficient_quota`.
- A model call whose provider reports no usage is counted with an estimate of about three bytes of text per token, which leans high, and is marked `usageEstimated` on the node's trace.
- Costs come from a built-in price table; `LLM_PRICING_OVERRIDES_JSON` adds models or sets your own rates. A model without a price counts its tokens at no cost; Azure OpenAI workflow runs are unpriced this way, so give them a token budget.
- The Agent Orchestrator node's `maxIterations` caps the loop: at the limit the agent returns the last text the model wrote, or "Agent stopped after reaching iteration limit.", and the workflow goes on. Its tool payload settings (`toolMessageMaxChars` and the `toolPayloadMax*` limits) shorten tool results before they reach the model.
- Gateway clients can also get a rate limit: calls per minute with a burst, and calls at once.

## Try it in L2M

Import the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) and add a small token budget for its workflow under **Settings → Cost & quality → FinOps**. Run it and open the agent node's **Trace** tab to see the tokens it counted. The recipe uses the built-in echo provider, which never asks for tools and only reports rough token counts. Attach a real chat model and set a low `maxIterations` to watch the loop spend across several calls and stop at the limit.

## Further reading

- [OWASP LLM10:2025 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/) (genai.owasp.org): denial of wallet, rate limiting, resource allocation
- [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/) (genai.owasp.org)
- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io): servers MUST rate limit tool invocations
- L2M docs: [Budgets](/product/budgets), [Agent loop](/runtime/agent-loop), [/v1 AI gateway: budgets and rate limits](/product/ai-gateway#budgets-and-rate-limits)
