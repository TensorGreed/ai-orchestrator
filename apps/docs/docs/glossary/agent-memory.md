---
title: "Agent memory: what AI agents keep between turns"
term: "Agent memory"
topic: agents
definition: "What an agent stores from earlier turns or runs and feeds back into later model calls: conversation history, summaries, saved tool results or retrieved notes."
description: "Agent memory is what an agent keeps between turns or sessions: history, summaries, cached tool results. Its limits and its privacy side."
related: [context-window, session-tool-cache, data-retention, vector-store, agent-loop]
guide: [/learn/agents/agent-memory]
---

# Agent memory

**What an agent stores from earlier turns or runs and feeds back into later model calls: conversation history, summaries, saved tool results or retrieved notes.**

A language model keeps nothing between calls. Each call sees only what is in its prompt. An agent seems to remember because the application saves parts of earlier turns and puts them back into the next prompt. Anthropic's guide to building agents lists memory, with retrieval and tools, as one of the augmentations of "the basic building block of agentic systems".

Memory comes in a few kinds:

- **Conversation history**: the last messages of a session, reloaded on the next turn.
- **Summaries**: older turns condensed into a short note to save space.
- **Cached tool results**: full outputs of earlier tool calls, kept outside the prompt and fetched again when needed.
- **Long-term notes**: facts saved across sessions and looked up by search, often in a <Term id="vector-store">vector store</Term>.

Memory has limits. Everything reloaded uses space in the <Term id="context-window">context window</Term>, so history is cut or summarised, and a summary loses detail. Memory is also stored data, and it often holds personal data, so it needs a retention period and a way to delete one person's records.

## Example

On turn one a customer writes "My order 1182 hasn't arrived". On turn two they write "Can you cancel it instead?". Without memory the agent does not know what "it" means. With session memory, turn one's messages are loaded back into the prompt, and the agent cancels order 1182.

## Common confusion

Memory is not learning. The model's weights do not change: the application chooses what to save and what to show again. Memory is not the context window either. The window is what one call can read. Memory is what is kept between calls and chosen to go back into it.

## In L2M

An agent run with a session id keeps its conversation, stored per namespace and session id. Attach a Simple Memory node to the agent's `memory` port to give it its own namespace, a window (`maxMessages`, 20 by default) and the option to keep tool results (`persistToolMessages`, off by default). When a run has a session id, the [session tool cache](/runtime/agent-loop#session-tool-cache-multi-turn-reuse) keeps full MCP tool outputs and gives the model `session_cache_list` and `session_cache_get` to fetch them again. Memory is kept until you set the optional `AGENT_MEMORY_RETENTION_DAYS` ([data retention](/operations/data-retention)).

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering, December 2024)
