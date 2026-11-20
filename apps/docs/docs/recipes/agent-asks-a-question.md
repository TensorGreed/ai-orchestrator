---
title: "Let an AI agent ask a clarifying question"
description: "A chat agent that pauses to ask the user a question when a request is ambiguous, then picks up where it stopped when the user replies."
keys: "model"
keysNote: "OpenAI API key, or any model with tool calling"
tags: ["agent","chat","human-in-the-loop"]
nodeCount: 5
sample: "agent-clarify-flow.json"
related: ["human-in-the-loop","ai-agent","agent-memory","tool-calling"]
---

<!--
  Generated from samples/workflows/agent-clarify-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Let an AI agent ask a clarifying question

**What you get:** A chat agent that asks one focused question instead of guessing, and carries on with the answer.

**Needs:** OpenAI API key, or any model with tool calling · **Time:** 10 minutes · **Nodes:** 5

A **Chat** trigger sends each message to one Agent Orchestrator with a chat model and session memory. Every agent in L2M has a built-in tool, `agent_clarify`, that the model can call when it cannot finish without something only the user knows. The agent then stops with the question as its answer, and the chat shows it as a question. The user's next message in the same session goes back to the agent as the answer to that question, and the agent carries on. The sample's system prompt tells the model to ask only when the ambiguity changes the answer. As shipped, the chat model is OpenAI `gpt-4o-mini`; any chat model that supports tool calling works.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/agent-clarify-flow.json" download>Download the workflow JSON</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/agent-clarify-flow.json" download>agent-clarify-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/l2m/blob/main/samples/workflows/agent-clarify-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Open the **GPT-4o-mini** chat model node and pick a stored secret that holds your OpenAI API key (or set `OPENAI_API_KEY` on the API server). Save the node and the workflow. Without a key the run fails with `Chat model node "GPT-4o-mini" (model_1) has no OpenAI API key`. To use another model, replace the node with any chat model node on the agent's `chat_model` port.
4. On the **Workflows** page, open the workflow's menu and choose **Chat**.
5. Send a request that is missing something, such as "Book me a table for Friday". If the model decides to ask, the reply bubble is labelled **Assistant is asking**.
6. Answer in the same chat. The agent resumes with your answer and replies normally.

## How it works

<figure class="recipe-diagram">
<svg viewBox="46 196 838 422" role="img" aria-labelledby="rd-agent-asks-a-question-title rd-agent-asks-a-question-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-agent-asks-a-question-title">Diagram of the Agent with Clarification workflow</title><desc id="rd-agent-asks-a-question-desc">Runs Chat, then Helpful Agent, then Output. GPT-4o-mini is attached to Helpful Agent as its chat model; Session Memory is attached to Helpful Agent as its memory.</desc><defs><marker id="rd-agent-asks-a-question-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M260 247 C309 247 309 247 358 247" marker-end="url(#rd-agent-asks-a-question-arrow)"/><path class="rd-edge is-port" d="M455 274 C455 327 165 327 165 380"/><path class="rd-edge is-port" d="M455 274 C455 407 165 407 165 540"/><path class="rd-edge" d="M550 247 C609 247 609 247 668 247" marker-end="url(#rd-agent-asks-a-question-arrow)"/><g class="rd-node" data-kind="step" transform="translate(70 220)"><title>Chat (chat_trigger)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat</text><text class="rd-type" x="12" y="40">chat_trigger</text></g><g class="rd-node" data-kind="model" transform="translate(70 380)"><title>GPT-4o-mini (openai_chat_model)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">GPT-4o-mini</text><text class="rd-type" x="12" y="40">openai_chat_model</text></g><g class="rd-node" data-kind="memory" transform="translate(70 540)"><title>Session Memory (local_memory)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Session Memory</text><text class="rd-type" x="12" y="40">local_memory</text></g><g class="rd-node" data-kind="agent" transform="translate(360 220)"><title>Helpful Agent (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Helpful Agent</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="step" transform="translate(670 220)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Chat | [`chat_trigger`](/nodes/reference/input#chat-trigger-—-chat-trigger) | Step in the run |
| Helpful Agent | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| GPT-4o-mini | [`openai_chat_model`](/nodes/reference/llm#openai-chat-model-—-openai-chat-model) | Attached to Helpful Agent on its `chat_model` port |
| Session Memory | [`local_memory`](/nodes/reference/utility#local-memory-—-simple-memory) | Attached to Helpful Agent on its `memory` port |

5 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## How agent_clarify pauses a run

The runtime adds `agent_clarify` to every agent's tools, next to any MCP tools, and adds one line to the system prompt: call it with a focused question when you cannot finish without the user, and not to confirm something that is already clear. The tool takes a required `question` and an optional `reason`. It is only offered while tool calling is on, as it is in the sample.

When the model calls it, nothing runs. The runtime:

1. stops the agent loop without running the tool, and records the step;
2. saves the conversation to session memory, ending with the model's unanswered `agent_clarify` call;
3. ends the agent with `stopReason: "clarification_requested"`, the question as its `answer`, and a `clarification` object (`question`, `reason`, `toolCallId`) on the node output.

The workflow does not stop there. Later nodes run as usual, so the sample's **Output** node returns the question as `result`. The run counts as a success, and the run result also carries a top-level `clarification` field with the same question, the reason and the id of the agent node. That field is how a caller can tell that the answer is a question and not the final reply. See [mid-turn clarification](/runtime/agent-loop#mid-turn-clarification-agent-clarify) for the reference.

## How the reply resumes it

There is no special resume call. The next run with the same `session_id` and a non-empty message loads session memory, finds the unanswered `agent_clarify` call at the end, and hands the new message to the model as that call's result, `{"ok":true,"output":{"user_reply":"..."}}`, instead of as a new user message. Model APIs expect every tool call to be followed by its result, so the conversation stays valid and the model reads the reply as the answer to its own question.

Memory normally leaves tool results out (the sample's memory node keeps the default), but `agent_clarify` results are always saved. Without that, the next message would find the old question still open and be treated as another answer.

In the studio's chat, every message in a chat session sends the same `session_id`, so this happens by itself. A webhook or API caller does the same thing by hand: when the result has `clarification`, show the question, then call the workflow again with the same `session_id` and the user's reply as `user_prompt`.

## What a run does

We ran the sample on a fresh install without a model key, in two ways.

**With the echo provider.** Echo repeats the prompt and never calls a tool, so it never asks. `Book me a table for Friday` came back as `Echo: Book me a table for Friday` with `stopReason: "final_answer"` after one model call. A second message in the same session showed the first exchange in the agent's messages: memory works, but this says nothing about the question itself.

**With a scripted stand-in model.** To watch the pause and the resume, we pointed the chat model at a small local OpenAI-compatible server that answers the first message with an `agent_clarify` call and answers a tool result with text. The model was offered `session_cache_list`, `session_cache_get` and `agent_clarify`. Then:

- Run 1, `Book me a table for Friday`: the agent stopped after 1 iteration with `stopReason: "clarification_requested"`. Output `result` was `Which restaurant, and for how many people?`, and the run result carried `clarification` with that question, the reason `The booking depends on both.`, the tool call id and `nodeId: "agent_1"`.
- Run 2, same session, `Luigi's, four people`: the model received no new user message. Its last message was the tool result `{"ok":true,"output":{"user_reply":"Luigi's, four people"}}` for the same call id, and the agent ended normally with `stopReason: "final_answer"`.

The scripted server shows the mechanism, not judgment: whether a real model asks, and when, depends on the model and the prompt. The demo has no copy of this workflow.

## Ask or guess?

A question costs the user a turn, so ask only when the answer would change what the agent does: "email him" with no name, "the report" when there are three. Let the agent infer what it reasonably can, and do not use the clarify tool as a confirmation step. A clarifying question is not an approval either: nobody approves anything, and the reply is just more input. To make a person approve an action before it runs, use [human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls). [Human in the loop](/learn/agents/human-in-the-loop) compares the two.

## Make it yours

- Attach MCP tools on the agent's `tool` port. The agent can then look things up first and ask only about what the tools cannot answer.
- Tune the system prompt: name the details that are worth a question in your domain (a customer id, a date range) and the ones the agent should assume.
- Call it from your own app: put a [Webhook Input](/nodes/reference/input) trigger in place of the Chat trigger, pass `user_prompt` and `session_id`, and check the result for `clarification`.

## Make it safer

These controls are optional; the recipe runs without them.

- Cap model spend per workflow with a [budget](/product/budgets).
- Keep `maxIterations` low (5 in the sample) so a confused agent stops early.
- When you add tools that change things, require a person's approval before they run: see [human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls).

## Further reading

- [Agent loop: mid-turn clarification](/runtime/agent-loop#mid-turn-clarification-agent-clarify)
- [Built-in agent tools](/runtime/built-in-agent-tools)
- [Human in the loop for AI agents](/learn/agents/human-in-the-loop)
- [Pattern library](/patterns/)
