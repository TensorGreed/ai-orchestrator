---
title: "AI agent vs chatbot: the actual difference"
sidebarTitle: "Agent vs chatbot"
description: "A chatbot answers; an agent decides and acts through tools in a loop. What changes for risk, testing and cost when you move from one to the other."
level: beginner
about: ai-agent
related: [ai-agent, agent-loop, tool-calling, excessive-agency, write-tool, approval-gate]
---

# AI agent vs chatbot

A chatbot answers. You send a message, it sends text back, and a person decides what to do with that text. An <Term id="ai-agent">AI agent</Term> acts. It decides which tools to call, reads what they return, calls more, and keeps going in a loop until the task is done or a limit stops it, and some of those calls change things in other systems. The chat window can look identical; the difference is who carries out the next step. That one change moves the risk from "the answer was wrong" to "the action was wrong", and it changes how you test, what you pay and what you must log.

## It is a spectrum, not two boxes

Most confusion comes from treating "chatbot" and "agent" as two products. In practice there are four steps, and each one adds something:

| Step | What it can do | Who acts on the result |
| --- | --- | --- |
| 1. Plain chatbot | Answer from the model's training and the conversation | The person |
| 2. Chatbot with retrieval | Answer from your documents, found by search before the model is called | The person |
| 3. Assistant with read tools | Choose to look things up (an order, a calendar) during the answer | The person |
| 4. Agent with write tools | Choose to change things (refund, file a ticket, push code) | The software |

Steps 1 and 2 are chatbots: one model call per turn, and retrieval is a fixed step the program runs, not a choice the model makes. Step 3 is where the model starts to choose its own steps through <Term id="tool-calling">tool calling</Term>, which is the <Term id="agent-loop">agent loop</Term> described in [what an AI agent is](/learn/agents/what-is-an-ai-agent). Step 4 is the one that changes your risk the most: the loop can now take actions with effects outside the conversation.

Anthropic's guide to building agents describes this middle ground for support: it "combines familiar chatbot interfaces with enhanced capabilities through tool integration." The interface stays a chat; what sits behind it is what you are choosing.

<figure>
<svg viewBox="0 0 640 220" role="img" aria-labelledby="avc-fig-title avc-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="avc-fig-title">One turn of a chatbot and one turn of an agent</title>
  <desc id="avc-fig-desc">Top: a chatbot turn is one straight line from the user's message to one model call to a text answer, which the user acts on. Bottom: an agent turn sends the message to a model call that may request tools; the runtime runs them, which can read or change other systems, and calls the model again until it answers.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <text x="20" y="20" font-size="12">Chatbot: one call, a person acts</text>
    <rect x="20" y="30" width="120" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="80" y="55" text-anchor="middle">Message</text>
    <rect x="200" y="30" width="120" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="260" y="55" text-anchor="middle">Model call</text>
    <rect x="380" y="30" width="110" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="435" y="55" text-anchor="middle">Text answer</text>
    <text x="510" y="55" font-size="12">→ person acts</text>
    <path d="M140 50 L200 50" stroke="currentColor" fill="none"/>
    <path d="M320 50 L380 50" stroke="currentColor" fill="none"/>
    <text x="20" y="110" font-size="12">Agent: a loop, the software acts</text>
    <rect x="20" y="120" width="120" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="80" y="145" text-anchor="middle">Message</text>
    <rect x="200" y="120" width="120" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="260" y="145" text-anchor="middle">Model call</text>
    <rect x="200" y="175" width="120" height="36" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="260" y="198" text-anchor="middle">Run tools</text>
    <rect x="380" y="175" width="160" height="36" rx="8" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <text x="460" y="198" text-anchor="middle" font-size="12">Other systems change</text>
    <rect x="380" y="120" width="110" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="435" y="145" text-anchor="middle">Answer</text>
    <path d="M140 140 L200 140" stroke="currentColor" fill="none"/>
    <path d="M320 140 L380 140" stroke="currentColor" fill="none"/>
    <path d="M245 160 L245 175" stroke="currentColor" fill="none"/>
    <path d="M275 175 L275 160" stroke="currentColor" fill="none"/>
    <text x="240" y="171" text-anchor="end" font-size="11">tool call</text>
    <text x="280" y="171" font-size="11">result</text>
    <path d="M320 193 L380 193" stroke="currentColor" fill="none"/>
  </g>
</svg>
<figcaption>In a chatbot, every action passes through a person. In an agent, the loop between the model and the tools can act before any person reads the answer.</figcaption>
</figure>

## What changes when you add actions

### Risk: wrong words vs wrong actions

A chatbot's worst case is a bad answer: wrong, rude, leaking something it was given. That harm is real, but a person stands between the text and any consequence. An agent removes that person from some steps. OWASP's Top 10 for LLM applications names the resulting risk <Term id="excessive-agency">excessive agency</Term>: "the vulnerability that enables damaging actions to be performed" in response to unexpected or manipulated model output, with root causes in excessive functionality, permissions or autonomy.

<Term id="prompt-injection">Prompt injection</Term> shows the difference most clearly. Text hidden in a web page that tells a chatbot to "say the product is free" produces a wrong answer a person may notice. The same text read by an agent with a refund tool can produce a refund. The attack is the same; the blast radius is set by the tools. That is why controls for agents sit on the actions themselves: which tools exist, which arguments are allowed, and which calls wait for a person ([least privilege for agents](/learn/security/least-privilege-for-agents)).

### Testing: the answer vs the path

You test a chatbot by its answers: given this question and these documents, is the reply correct, grounded and safe? One input, one output, judged on its own.

An agent needs that, plus a check on what it did. One run may reach the right answer through a tool it should never touch, so agent tests also assert on the calls: which tools ran, in what order, with which arguments, and which tools must never appear. Because the model chooses the path, run each case more than once; a single pass proves little. [Agent evals](/learn/testing/agent-evals) covers how to build such a test set.

### Cost and latency: one call vs several

A chatbot turn is one model call. An agent turn is as many calls as the loop takes, and each call resends the conversation, the tool definitions and earlier tool results. [Workflows vs agents](/learn/agents/workflows-vs-agents) covers the same cost for fixed steps against model-chosen ones. Agents need a stop: an iteration limit per run, and budgets per user or team ([LLM cost control](/learn/operations/llm-cost-control)).

### Operations: what you must record

For a chatbot, keeping the conversation is usually enough to explain what happened. For an agent, you also need every tool call with its arguments and result, who or what the run acted for, and who approved what. When a customer asks why their order was cancelled, "the model decided" is not an answer; the trace and the audit log are.

## The comparison

| Question | Chatbot | Agent |
| --- | --- | --- |
| Model calls per turn | One | One to many, up to a limit |
| Who picks the next step | The program, or the person | The model, inside the loop |
| Effects outside the chat | None; a person acts | Tool calls can read and change other systems |
| Worst case | A wrong or harmful answer | A wrong or harmful action |
| Main controls | Prompt, retrieval quality, output review | Tool lists, argument rules, approvals, limits |
| What a test checks | The answer | The answer and the tool calls |
| Cost per turn | Predictable | Varies with the path the model takes |
| What to log | The conversation | The conversation, every tool call, approvals |

## When a chatbot is the right choice

A chatbot is enough when a person will act on the answer anyway: drafting an email, explaining a policy, answering from documentation. Adding retrieval (step 2) often closes the gap people expect an agent to close: the bot can now answer from your content, with sources, at the cost of one search and one model call.

Move to an agent when the task needs steps that depend on what the run finds, such as looking up an account and then deciding what to check next, and when having the software carry out those steps is worth the extra controls. Start with read tools only. Add a write tool when you can say who approves its calls, or why they need no approval.

## In L2M

L2M builds both shapes on one canvas.

- **A chatbot** is a short workflow: a **Chat Trigger** or webhook, optionally **RAG Retrieve** for documents, a **Prompt Template** and one **LLM Call**. There is no loop and no tool call; the [RAG knowledge base recipe](/recipes/rag-knowledge-base) is this shape, with a fixed question as its input.
- **An agent** is an **Agent Orchestrator** node with a chat model on its `chat_model` port and MCP Tool or Workflow Tool nodes on its `tool` port. `maxIterations` is required and new nodes start at 6 ([agent loop](/runtime/agent-loop)).
- **Controls on actions:** tool policy and the write-tool switch are optional and off until you set them (built-in [content rules](/product/content-rules) do check an agent's tool arguments by default). [MCP tool policy](/product/mcp-tool-policy) rules allow, deny or require approval per tool and per argument, and a workflow's **Ask before write tools** switch pauses an agent before each <Term id="write-tool">write tool</Term> call for an <Term id="approval-gate">approval</Term> ([human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls)).
- **Tests on the path.** [Golden sets](/product/golden-sets) can score an agent's tool calls with the `tool_sequence` scorer, including tools that must never be called, not only its final answer.

## Try it in L2M

The [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) wires an agent to two MCP tools and runs with the built-in echo provider, which proves the wiring but never asks for a tool; attach a real chat model to see the loop call tools. To watch a recorded agent run that does call tools, open the support agent in the demo.

<TryInDemo workflow="wf-demo-support-agent" recorded />

## Further reading

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic engineering): the augmented LLM, workflows and agents, and agents for customer support
- [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) (OWASP Gen AI Security Project)
- [LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) (OWASP Gen AI Security Project)
- In L2M: [Agent loop](/runtime/agent-loop), [MCP tool policy](/product/mcp-tool-policy); see also [workflows vs agents](/learn/agents/workflows-vs-agents) for fixed steps vs model-chosen steps
