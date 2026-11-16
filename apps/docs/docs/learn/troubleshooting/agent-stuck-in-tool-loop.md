---
title: "AI agent stuck calling the same tool in a loop"
sidebarTitle: "Agent stuck in a tool loop"
description: "Why an agent repeats one tool call until it hits max iterations: errors it cannot act on, results it cannot use, no stop rule. How to break the loop."
level: intermediate
about: agent-loop
related: [agent-loop, max-iterations, tool-calling, mcp-tool, budget, unbounded-consumption]
---

# AI agent stuck calling the same tool in a loop

The agent keeps asking for the same tool because nothing it gets back tells it to stop or to try something else, and the loop ends only when it reaches its iteration limit. Fix what the model sees: errors that say what to change, results that answer the question or say plainly that there is nothing, and a prompt that says when to give up. Keep the iteration limit as the backstop, not the fix.

## What it means

An <Term id="agent-loop">agent loop</Term> has two ways out. The model answers without asking for a tool, or the run reaches its <Term id="max-iterations">max iterations</Term>. Every round in between is the same: the model sees the conversation so far, asks for one or more tool calls, the tools run, and their results are added to the conversation for the next round.

So a loop is not a crash. Each model call looked at the conversation and decided that one more call was the best next step. Something in the conversation keeps that decision the same: a result that does not contain what the model is looking for, an error it cannot act on, or an instruction that never lets it stop.

The MCP specification separates two kinds of failure. A protocol error, such as an unknown tool or a malformed request, comes back as a JSON-RPC error. A tool execution error, such as an API failure, bad input or a business rule, comes back as a normal result with `isError: true`. The spec says tool execution errors "contain actionable feedback that language models can use to self-correct and retry with adjusted parameters", and that clients SHOULD give them to the model. That only helps when the feedback is actually actionable.

## Causes (most to least likely)

1. **An error the model cannot act on.** The tool returns "Internal error", "Request failed" or a stack trace. The model cannot tell what to change, so it sends the same call again, perhaps after rewording it slightly.
2. **A result that does not answer.** A search returns nothing, or returns results that do not match, and the model rephrases the query again and again. A result that was cut to fit the context can do the same: the field the model needs was in the part that was removed.
3. **No stop rule.** The task is open-ended ("find every customer who…"), or the prompt never says what to do when the tools come up empty, so the model keeps trying.
4. **Success that does not look like success.** A write tool returns `{}` or `"ok"`, the model is not sure the record was created, and it creates it again. This loop is the dangerous one, because each round has an effect outside the run.
5. **Lost context.** The earlier results are no longer in the conversation, because memory kept only the last few messages or a long run was trimmed, so the model does not know it already made the call.
6. **Two tools that overlap.** Two search tools with similar descriptions, and the model alternates between them because neither result is what it expected.
7. **A weak model for the job.** Smaller models repeat themselves more often. Swap the model in a test before rewriting everything else.

## How to check

Read the trace of one looping run, round by round, and write down for each round the tool name, the arguments and the first line of the result.

- **Identical arguments every round**: causes 1, 4 or 5. The model is not learning anything from the result.
- **Arguments that change a little each round** (a new search phrase, another date): causes 2 or 3. The model is searching for something the tool cannot give it.
- **Two tools taking turns**: cause 6.

Then call the tool by hand with the arguments from the first round, and read the result as the model would. If you cannot tell from the result what to do next, neither can the model. Where results are trimmed before they reach the model, read the trimmed version, not the full one.

## Fix

**Write errors the model can act on.** Say what was wrong, what a valid value looks like, and whether trying again can help:

```json
{
  "content": [{ "type": "text", "text": "No order 'A-1009'. Order ids look like 'ORD-123456'. Ask the user for the order id; do not retry with the same value." }],
  "isError": true
}
```

**Make empty results explicit.** "No tickets match 'printer jam lobby'. Try fewer words, or search by ticket key" gives the model a next step. An empty array gives it none.

**Make writes confirm themselves.** Return the new record's id and its state ("created ticket T-4471, status open"). Where the API allows it, accept an idempotency key, so a repeated call does not create a second record. For writes, an approval step before the call protects you better than any prompt (in L2M, optionally, [approval before write tools](/product/approvals#approval-before-write-tools)).

**Give the prompt a stop rule.** For example: "If two searches return nothing, tell the user you could not find it and ask for more detail. Never call the same tool with the same arguments twice." Name the tool to use for each kind of question, so the model does not shop between similar tools.

**Keep the results the model needs.** If results are being trimmed, return less from the tool so the important fields survive. [Tool result too large](/learn/troubleshooting/mcp-tool-result-too-large) covers how.

**Cap the loop.** Set max iterations to what a good run needs plus a little room. OWASP lists unbounded consumption among the top risks for LLM applications and, among its preventions, "Implement restrictions on the number of queued actions and total actions". An iteration cap does that for one agent. A spend <Term id="budget">budget</Term> caps cost across runs.

**Turn the loop into a test.** Once fixed, keep the looping input as a regression case and check the number of tool calls, not only the answer. [Regression testing AI agents](/learn/testing/regression-testing-agents) explains the approach.

## If you run agents in L2M

**The limit.** The Agent Orchestrator and Supervisor nodes have `maxIterations`. A new Agent Orchestrator starts at 6 and a new Supervisor at 10. When the limit is reached, the node returns the text of the model's last reply, or `Agent stopped after reaching iteration limit.` when there was none, and its output has `stopReason: "max_iterations"` instead of `final_answer`. A later step can check that field and route those runs elsewhere. The run trace shows each round as "Step 2 of 6", with the tool calls of each step.

**Built-in loop breakers.** The runtime already stops some loops:

- **A tool that keeps failing is disabled.** When one tool fails twice in a run with no success in between, the runtime removes it from the tool list for the rest of that run, and a call to it gets `Tool '<name>' has been disabled due to repeated failures.` Failures here are errors from the tool, including MCP results with `isError: true`, and calls with missing required arguments. Calls that a tool policy or content rules block are not counted.
- **Missing arguments are named.** A call without a required argument does not reach the server. The model gets `Tool call '<name>' is missing required arguments: <names>.`, followed by the keys it did send and a request to call again with all required fields.
- **Unknown tools are listed.** A call to a tool that does not exist gets `Tool '<name>' does not exist. Available tools: ...`, with up to 20 names.
- **A round where every call failed gets a nudge.** The runtime adds: `All tool calls in this iteration failed. Please reconsider your approach, verify tool names and arguments, or provide a final answer without tools.`

**What it does not catch.** A tool that succeeds every time with the same unhelpful result is never disabled, and the runtime does not compare one round's arguments with the last. That loop runs to `maxIterations`, so the fixes above still matter. An empty model reply also uses a round: the runtime asks the model to try again, up to the limit.

**Related settings:**

- The registry's [circuit breaker](/product/mcp-server-registry#rate-limits-concurrency-and-the-circuit-breaker) opens on transport, protocol and timeout failures. A tool that returns an error counts as a success there, so it does not stop an `isError` loop.
- The optional [Think tool](/runtime/built-in-agent-tools#think-tool) gives the model a place to check a result against the request before its next call.
- With a `session_id`, earlier tool results stay available through `session_cache_list` and `session_cache_get`, so a follow-up turn can reuse them instead of calling again ([session tool cache](/runtime/agent-loop#session-tool-cache-multi-turn-reuse)).
- Optionally, [budgets](/product/budgets) cap spend, and [golden runs](/product/golden-runs) replay a changed workflow against a known-good run and compare its tool calls.

The [agent hits max iterations](/troubleshooting/common-issues#agent-hits-max-iterations) entry lists the short version.

Related errors: [model won't call tools](/learn/troubleshooting/model-does-not-call-tools) (the opposite problem), [-32602 Invalid params](/learn/troubleshooting/json-rpc-32602-invalid-params) (arguments a tool keeps rejecting), [Request timed out](/learn/troubleshooting/mcp-request-timed-out) (a slow tool retried), and [too many tools](/learn/agents/too-many-tools) for overlapping tools.

## Further reading

- [MCP specification, 2025-11-25: Tools, error handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling) (modelcontextprotocol.io): protocol errors and `isError` results
- [OWASP LLM10:2025 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/) (genai.owasp.org): limits on actions, timeouts and throttling
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering): stopping conditions such as a maximum number of iterations
- In L2M: [Agent loop](/runtime/agent-loop), [Max iterations](/glossary/max-iterations), [Built-in agent tools](/runtime/built-in-agent-tools), [Common issues: agent hits max iterations](/troubleshooting/common-issues#agent-hits-max-iterations)
