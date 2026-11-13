---
title: "Agent memory: what an AI agent should remember"
sidebarTitle: "Agent memory"
description: "Short-term history, session memory and cached tool results: what each is for, how much to keep, and how agent memory meets retention and erasure."
level: beginner
about: agent-memory
related: [agent-memory, context-window, session-tool-cache, data-retention, data-subject-request]
---

# Agent memory

A language model remembers nothing between calls. <Term id="agent-memory">Agent memory</Term> is what the runtime around it stores and sends back: the conversation so far, the results of earlier tool calls, and values saved on purpose. Keep the smallest amount that lets the next turn work, bound it by size and by age, and treat it as personal data, because it holds whatever people typed and whatever your tools returned about them.

## Context vs memory

Two words get mixed up here. The <Term id="context-window">context window</Term> is what the model reads in one call: the system prompt, the messages, the tool definitions and the tool results, up to a token limit. Memory is what lives outside the model and is chosen, turn by turn, to go into that window.

Within one run, the <Term id="agent-loop">agent loop</Term> already has short-term memory: the growing list of messages, tool calls and tool results it sends with every model call. When the run ends, that list is gone unless something saves it. Memory across runs is a store keyed by conversation, so that the next question in the same chat starts with the earlier ones.

Anthropic's "Building effective agents" calls this one of the basic augmentations: "The basic building block of agentic systems is an LLM enhanced with augmentations such as retrieval, tools, and memory." Memory itself comes in several kinds, and it helps to keep them apart from each other and from retrieval:

| Kind | What it holds | Lives for |
|---|---|---|
| Conversation history | The user's and the agent's messages, sometimes tool results | One conversation (a session) |
| Cached tool results | Full outputs of tool calls already made in the session | One session |
| Saved values | Exact data a workflow stored on purpose, such as a report it built | One session, or longer |
| Knowledge (retrieval) | Documents searched at question time | As long as the knowledge base |

Retrieval is not memory in this sense. A knowledge base is shared and curated; memory is per conversation and written by the run itself.

## Session memory keyed by session

A **session id** names one conversation. The chat client or the calling app sends the same id with every message, and the runtime loads the history stored under it before the model call and saves the new turns after. A **namespace** keeps different agents apart, so a support agent and a sales agent never read each other's history for the same session id. The store's key is the pair: namespace plus session id.

Three practical points about the session id:

- **Whoever knows the id can read the memory.** If a public webhook accepts any `session_id` in its body, a caller who guesses another user's id gets that user's history in the model's context. Have your app issue long random ids, tie them to a signed-in user, and authenticate the webhook.
- **The id itself may be personal data.** Using an email address or a phone number as the session id is convenient, but it puts that value in the key of every stored row.
- **Different jobs, different namespaces.** Two workflows that share a namespace and a session id share one conversation. That is sometimes what you want, and often not.

What goes into the store matters as much as the key. The user's and the agent's messages are the minimum. The system prompt does not need saving, since it comes from configuration on every run. Tool results are the large and sensitive part: storing them makes follow-up questions easier and the memory much bigger.

## Cached tool results across turns

Follow-up questions often point back at data the agent already fetched. "Which of those orders shipped late?" refers to the list from the previous turn. There are three ways to answer:

1. **Call the tool again.** Simple, but slow and costly, and the answer may differ from what the user saw.
2. **Keep the full tool result in the conversation history.** The model sees everything, but every later turn pays for those tokens, and a large result can crowd out the rest of the window.
3. **Cache the result outside the context.** Store the full output with its arguments, give the model a short version, and give it a tool to fetch the cached record by id when it needs the detail.

The third option, a <Term id="session-tool-cache">session tool cache</Term>, keeps the window small and avoids repeat calls. Two costs come with it. The cache is a copy of whatever the tool returned, often customer records, so it needs the same retention and deletion as the conversation. And a cached result can be stale: the order that had not shipped an hour ago may have shipped since. Tell the model, in its tool description or system prompt, when to use the cache and when to call the tool again.

## How much to keep

Every stored message that is sent back costs tokens on every later turn, and long histories leave less room for tool results. So memory needs a limit. There are two common shapes.

**A window.** Keep the last N messages and drop older ones. It is predictable and cheap, and the agent forgets the start of a long conversation. Trimming has a technical catch: a tool call and its result are separate messages, and a cut between them leaves a call with no answer, which model APIs reject. A runtime that trims must drop unpaired calls and results.

**Compaction.** Replace older turns with a summary written by a model. The agent keeps the gist of a long conversation, at the cost of an extra model call, and the summary can drop or distort a detail the user cares about.

A reasonable starting point is a short window, 10 to 30 messages, without tool results, plus a tool-result cache for follow-ups. Raise the window when users really do refer back further; switch to compaction only when a window is not enough. Also cap the length of each stored message, so one pasted document cannot fill the window by itself.

## Memory is personal data

People type names, addresses, order numbers and health details into chats. Tools return customer records. Memory stores both, often with no expiry. That makes it personal data, and in the EU the General Data Protection Regulation (GDPR) applies to it. This is not legal advice, but three of its principles shape memory design directly:

- **Data minimisation**: personal data must be "adequate, relevant and limited to what is necessary in relation to the purposes for which they are processed" (Article 5(1)(c)). Store the turns you need, not every tool payload.
- **Storage limitation**: personal data must be "kept in a form which permits identification of data subjects for no longer than is necessary" (Article 5(1)(e)). Give memory a <Term id="data-retention">retention period</Term>, as you would any log.
- **Right to erasure**: a person can ask for "the erasure of personal data concerning him or her" (Article 17(1)). A <Term id="data-subject-request">data-subject request</Term> must find the person's memory sessions and delete them, with every copy: cached tool results, saved values, and backups as they age out. Article 17(3)(e) makes an exception for data needed "for the establishment, exercise or defence of legal claims", which is what a <Term id="legal-hold">legal hold</Term> protects.

Finding a person's memory is the hard part. A search for their email only finds the sessions that mention it. Recording, when each run finishes, which person a session is about makes the later lookup fast and complete.

Memory has a security side too. A stored message is replayed on every later turn of the session, so instructions hidden in a web page or a tool result can keep acting long after the run that read them. See also: [prompt injection](/learn/security/prompt-injection) explains how outside content steers an agent and how to limit what it can do.

## Agent memory in L2M

In L2M, a self-hosted workflow builder and agent runtime, memory is on whenever an agent runs with a session id. Everything below is optional; an agent without a session id keeps nothing between runs.

- **Session memory.** An Agent Orchestrator node reads its session id from the run (the template defaults to <span v-pre>`{{session_id}}`</span>, which chat triggers and webhook payloads can supply). With an id, the agent loads the stored conversation before its first model call and saves it at the end. Without a **Simple Memory** node it uses the namespace `default`; attach one to give the agent its own namespace (by default the workflow id and the agent node id), a window size (`maxMessages`, default 20) and **Persist Tool Messages** (off by default). Memory is stored per project, so workflows in different projects never share it. Give agents a Simple Memory node when two workflows in one project must not share a conversation.
- **What is stored.** The user's and the agent's messages, but not the system prompt. Tool calls and their results are kept only when Persist Tool Messages is on; an `agent_clarify` question and its answer are always kept. The window is a plain "last N messages"; L2M does not summarise older turns. When the window cuts a tool call from its result, the unpaired messages are dropped before the history goes to the model.
- **Session tool cache.** With a session id, every MCP tool result the agent gets is stored in full with its arguments, by namespace and session id, and the model gets a compact version in context. Two built-in tools, `session_cache_list` (10 records by default, at most 50) and `session_cache_get` (one record by id, optionally one path inside it), let the model reuse the data on later turns ([session tool cache](/runtime/agent-loop#session-tool-cache-multi-turn-reuse)).
- **Saved values.** **Session Artifact Save** and **Session Artifact Load** nodes keep an exact JSON value per session, such as a report a later turn must reuse word for word.
- **Retention.** Optionally, `AGENT_MEMORY_RETENTION_DAYS` deletes memory sessions and saved values by last update and cached tool results by creation; unset, they are kept. A project can set its own value, and nothing under a legal hold is deleted ([per-project retention](/operations/data-retention#per-project-retention)).
- **Data-subject requests.** Optionally, a workflow records a hashed subject reference for the run's `session_id`, which links its memory session to the person. An admin's request then finds the person's memory sessions and saved values, by reference and by search, and exports them or, after a confirmed preview, deletes them. Deleting a memory session also deletes its cached tool results. Logs, backups already written, and model providers or MCP servers the runs sent data to are not covered; an erasure is applied again when a backup is restored ([deleting a person's data](/security/data-subject-requests#deleting-a-persons-data)).

**Try it.** The [webhook agent with memory recipe](/recipes/webhook-agent-with-memory) puts an agent with a Simple Memory node behind a webhook. Two requests with the same `session_id` show the second run reading the first exchange. To check memory without an API key, set the chat model to the built-in echo provider: it repeats the prompt and never calls a tool, so it tests the memory and not tool use.

## Further reading

- [Agent loop: session tool cache](/runtime/agent-loop#session-tool-cache-multi-turn-reuse): how L2M stores and reuses tool results
- [Data-subject requests](/security/data-subject-requests): finding, exporting and deleting a person's data in L2M
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering, December 2024): memory as one of the augmentations of an agent
- [GDPR Article 5](https://gdpr-info.eu/art-5-gdpr/) and [Article 17](https://gdpr-info.eu/art-17-gdpr/) (text of Regulation (EU) 2016/679, gdpr-info.eu): data minimisation, storage limitation and the right to erasure
