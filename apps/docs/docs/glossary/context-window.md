---
title: "Context window: the token limit of a model call"
term: "Context window"
topic: agents
definition: "The most text, counted in tokens, that a model can take into account in one call: system prompt, conversation, tool definitions and tool results, plus the answer it writes."
description: "The context window is how many tokens a model reads in one call: prompt, history, tool definitions and results. Why agents run out of it."
related: [token-llm, agent-memory, agent-loop, session-tool-cache, max-iterations]
guide: [/learn/agents/too-many-tools, /learn/agents/agent-memory, /learn/agents/what-is-an-ai-agent]
---

# Context window

**The most text, counted in tokens, that a model can take into account in one call: system prompt, conversation, tool definitions and tool results, plus the answer it writes.**

A model has no memory between calls. Everything it should know for this call has to be sent again, and it all has to fit. Provider documentation lists what counts: the system prompt, every message including tool results, the tool definitions, and the output. Send more than fits and the request fails.

## Why agents run out of it

An agent's context grows on every turn of its loop. Each iteration adds the model's tool call and the tool's result, and the whole history is sent again on the next call. Three things usually fill it:

- **Tool definitions.** Every tool's name, description and schema is sent on every call, whether it is used or not. Fifty tools can cost more tokens than the task itself.
- **Large tool results.** A tool that returns a whole table or web page pushes everything else out.
- **Long memory.** Replaying a long conversation in full on every turn.

## Example

An agent with a 32,000-token window reads a 30,000-token log file through a tool. On the next call the log, the tool list and the history no longer fit, and the request fails, although the agent has made only one tool call.

## Common confusion

A bigger window is not free accuracy. Anthropic's documentation notes that "as token count grows, accuracy and recall degrade", which it calls context rot. Sending less, and only what is relevant, usually works better than sending everything.

## In L2M

The Simple Memory node keeps only the last `maxMessages` messages (20 by default) and leaves tool results out of memory unless you turn on **Persist Tool Messages**. The [session tool cache](/runtime/agent-loop#session-tool-cache-multi-turn-reuse) keeps full tool outputs outside the prompt so a later turn can fetch them on demand. For overflow fixes, see [Common issues](/troubleshooting/common-issues#context-length-token-overflow).

## Further reading

- [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) (platform.claude.com)
