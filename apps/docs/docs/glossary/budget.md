---
title: "LLM budget: capping AI spend and tokens"
term: "Budget"
topic: operations
definition: "A cap on model spend or tokens for one scope, such as a project, a user or a client, over a period, which warns or blocks new work when it is reached."
description: "A budget caps model spend or tokens per period for a scope such as a project, user or client, and warns or blocks when it is reached."
related: [unbounded-consumption, rate-limit, llm-gateway, token-llm, max-iterations]
guide: [/learn/operations/llm-cost-control]
---

# Budget

**A cap on model spend or tokens for one scope, such as a project, a user or a client, over a period, which warns or blocks new work when it is reached.**

Model calls are priced per <Term id="token-llm">token</Term>, and agents make many of them: every iteration of the loop sends the whole conversation again. A loop that does not stop, a user who scripts a thousand requests, or a prompt that pulls a huge document into context can turn a normal bill into a large one within hours. OWASP calls this <Term id="unbounded-consumption">unbounded consumption</Term> (LLM10) and lists "Denial of Wallet" among its attacks.

## The parts of a budget

- **Scope:** what is counted, such as the whole deployment, a project, a workflow, a user or an API client.
- **Measure and limit:** money (estimated from token counts and model prices) or tokens.
- **Period:** a day, a week or a month, after which the count starts again.
- **Action:** *warn* sends an alert at a threshold; *block* refuses new work until the period ends.

## Example

A project gets a $500 monthly budget that warns at 80% and blocks at 100%. On the 21st, a new agent with a bad prompt loops on a search tool. The warning reaches the team at $400; at $500 new runs are refused instead of the agent running all weekend.

## Common confusion

A budget is not a rate limit. A <Term id="rate-limit">rate limit</Term> caps how fast calls arrive; a budget caps how much they cost in total. They catch different failures, so they are often used together, along with an iteration cap on each agent run.

## In L2M

Optional [budgets](/product/budgets) cap USD or tokens per day, week or month (UTC) for the deployment, a project, a workflow, a user or an MCP gateway client. **Warn** sends an alert; **block** refuses new runs from any trigger, and gateway calls, until the period ends.

## Further reading

- [OWASP LLM10:2025 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/) (owasp.org)
