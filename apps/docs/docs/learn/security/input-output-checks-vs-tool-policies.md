---
title: "Checking model text vs controlling tool calls"
sidebarTitle: "Text checks vs tool policy"
description: "Checks on prompts and outputs catch text; tool policies decide which actions may run. Why an agent needs action controls even when text checks pass."
level: intermediate
about: mcp-tool-policy
related: [mcp-tool-policy, least-privilege, excessive-agency, output-checks, prompt-injection, write-tool]
---

# Checking model text vs controlling tool calls

There are two places to stop an AI agent from doing harm. You can check the text: scan prompts for attacks, scan answers and tool arguments for secrets or unsafe content, and block what matches. Or you can control the actions: decide, outside the model, which tools this agent may call, with which arguments, for which caller, and which calls must wait for a person. Text checks judge what words mean, so they are probabilistic and an attacker can rephrase around them. A <Term id="mcp-tool-policy">tool policy</Term> judges a structured request against fixed rules, so it gives the same answer every time, whatever wording led to the call. You want both, but they are not interchangeable: for an agent with tools, the tool policy is the control that still holds when a text check misses.

## Two questions, asked at different points

A text check asks: *does this text look dangerous?* It runs on strings: the user's prompt, a retrieved document, a tool result, a tool call's arguments, the final answer. It might be a pattern match for card numbers, a classifier for injection attempts, or a second model asked to judge the answer.

A tool policy asks: *is this caller allowed to take this action, here?* It runs on a structured request: tool name, server, argument values, the role or client behind the run, the workflow, and sometimes what data the run has touched. It does not try to understand language at all.

<figure>
<svg viewBox="0 0 640 240" role="img" aria-labelledby="tvp-fig-title tvp-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="tvp-fig-title">Where text checks and tool policy sit in an agent run</title>
  <desc id="tvp-fig-desc">Text enters the agent from the user and from tool results, and text leaves as the answer; text checks sit on those flows. When the model asks for a tool call, the request passes a tool policy decision of allow, deny or require approval before the tool server runs it.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="20" y="40" width="120" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="80" y="65" text-anchor="middle">User prompt</text>
    <rect x="250" y="40" width="140" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="320" y="65" text-anchor="middle">Agent + model</text>
    <rect x="500" y="40" width="120" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="560" y="65" text-anchor="middle">Answer</text>
    <path d="M140 60 L250 60" stroke="currentColor" fill="none"/>
    <path d="M390 60 L500 60" stroke="currentColor" fill="none"/>
    <text x="195" y="35" text-anchor="middle" font-size="12">text check</text>
    <text x="445" y="35" text-anchor="middle" font-size="12">text check</text>
    <rect x="235" y="140" width="170" height="44" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="320" y="160" text-anchor="middle">Tool policy</text>
    <text x="320" y="176" text-anchor="middle" font-size="11">allow · deny · approval</text>
    <rect x="480" y="140" width="140" height="44" rx="8" fill="none" stroke="currentColor"/>
    <text x="550" y="167" text-anchor="middle">Tool server</text>
    <path d="M300 80 L300 140" stroke="currentColor" fill="none"/>
    <text x="292" y="115" text-anchor="end" font-size="12">tool call</text>
    <path d="M405 162 L480 162" stroke="currentColor" fill="none"/>
    <path d="M550 140 L360 82" stroke="currentColor" fill="none" stroke-dasharray="4 3"/>
    <text x="470" y="105" font-size="12">tool result (text check)</text>
  </g>
</svg>
<figcaption>Text checks sit on the flows of text in and out. The tool policy sits on the one path that changes other systems: the tool call.</figcaption>
</figure>

## Why text checks alone are not enough for agents

Text checks are useful, and for a chatbot they may be most of what you need. For an agent they have four limits that matter.

**They can be talked around.** Any check that judges meaning can be beaten by text that means the same thing in another form: a paraphrase, another language, an encoding, an instruction split across two documents. OWASP's entry on prompt injection is direct about the state of the art: "it is unclear if there are fool-proof methods of prevention for prompt injection." Its list of mitigations includes input and output filtering, and also least-privilege access with tool calls handled in code and human approval for high-risk actions, because filtering will sometimes miss.

**A harmful call can be made of harmless words.** `refund_order({"order_id": "A-1042", "amount": 900})` contains no attack string, no secret and no unsafe content. Whether it is harmful depends on facts no text check sees: is this agent supposed to issue refunds, is 900 within its limit, did a customer actually ask? Those are authorization questions.

**They decide nothing about who.** The same call is fine for a support lead and wrong for an anonymous webhook. Text checks look at content, not at the caller.

**A miss is silent.** When a filter fails, nothing marks the miss. The action runs, and you learn about it afterwards.

OWASP's guidance on <Term id="excessive-agency">excessive agency</Term> points the same way: "Implement authorization in downstream systems rather than relying on an LLM to decide". A text check that asks a model whether a call looks safe is still relying on a model to decide.

## Why tool policy alone is not enough either

A tool policy has the opposite blind spot. It sees the shape of a call, not the meaning of the values in it.

- **Allowed tool, harmful content.** Policy can allow `send_email` only to addresses at your own domain. It cannot tell whether the body of that email holds a customer's card number. A text check on the arguments can.
- **Bad text with no action.** An agent that answers a customer with something false, offensive or confidential calls no tool at all. Only a check on the answer sees it.
- **Rules only cover what you foresaw.** A rule on `env one_of ["dev", "staging"]` is exact, but someone has to know that `env` is the argument that matters. That is why least-privilege rules are best written from the calls agents actually make ([least privilege for agents](/learn/security/least-privilege-for-agents) covers how).

## The comparison

| Question | Text checks | Tool policy |
| --- | --- | --- |
| What does it look at? | Strings: prompts, documents, tool results, arguments, answers | A structured call: tool, server, argument values, caller, workflow |
| How does it decide? | Patterns, classifiers or a judge model; a score or a match | Fixed rules: allow, deny or require approval |
| Same input, same answer? | Not always, for model-based checks | Yes |
| Can wording get around it? | Yes: paraphrase, encoding, splitting | No: the rule never reads the wording |
| Knows who is calling? | No | Yes: role, client, project |
| Catches a secret in an allowed call? | Yes, if it matches a detector | No |
| Catches a harmful answer with no tool call? | Yes | No |
| Typical failure | A miss that nobody notices | A rule that is too broad, or too narrow and blocks real work |

## How to combine them

Treat the tool policy as the boundary and text checks as the filters inside it.

1. **Decide the actions first.** List what the agent must be able to do and allow only that: these tools, these argument values, for these callers. Everything else is denied, whatever the model is persuaded to try. The design patterns paper by Beurer-Kellner et al. (2025) takes this approach. It calls detection-based defenses "fundamentally heuristic", and argues that once an agent has read untrusted input, "it must be constrained so that it is impossible for that input to trigger any consequential actions".
2. **Hold the calls that matter for a person.** Writes above a threshold, sends to outside addresses and deletes go to an approval. A person sees the actual call, with its arguments, not the model's description of it.
3. **Add text checks where meaning matters.** Detect secrets and personal data in arguments and answers, flag likely injection in retrieved text, and check answers against their sources. These catch what rules cannot express.
4. **Let what the run has read narrow what it may do.** Once a run has read untrusted content or sensitive data, tighten the tool rules for the rest of the run. This joins the two: content decides the labels, and the policy acts on them.

Then measure both. For tool rules, check how many real calls each rule would have changed before you enforce it. For text checks, track false positives and known misses against a test set.

## In L2M

Both controls are optional in L2M, and a simple workflow needs neither.

- **[MCP tool policy](/product/mcp-tool-policy)** rules allow, deny or require approval by project, role, server and tool name, and optionally by the call's argument values, the run's data labels, the workflow and the gateway client. Precedence is deny, then require approval, then allow. Denied tools are removed from the agent's tool list before the model sees them, and every call is checked again when it is made, so a model that names a hidden tool is still refused.
- **Conditions fail closed.** A missing, oddly typed or oversized argument can cause an extra deny or approval, never a wider allow, and allow-lists (`one_of`) avoid the spelling tricks that beat deny-lists.
- **Approvals.** A `require_approval` rule pauses the run before the call and puts a request in the **Approvals** inbox naming the tool, the rule and the matched conditions. A workflow's **Ask before write tools** switch does the same for every <Term id="write-tool">write tool</Term>, and a **No write tools** switch blocks them outright.
- **Labels from content.** Rules can match `label_present` or `label_absent` on the run's [data labels](/product/data-labels-and-destinations), so a send tool can be denied once untrusted or sensitive data is in the run.
- **Text checks.** Optional [content rules](/product/content-rules) check prompts, tool arguments, tool results and answers, and can block, rewrite or pause at each point.
- **Shadow mode and simulation.** Any policy rule can run in shadow mode, and admins can simulate a draft rule on recorded calls before enforcing it.

## Try it in L2M

The [govern MCP tools guide](/guides/govern-mcp-tools) walks through a first set of rules, and [human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls) sets up approvals. For the attack these controls defend against, read [prompt injection](/learn/security/prompt-injection) and [the lethal trifecta](/learn/security/lethal-trifecta).

## Further reading

- [LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) (OWASP Gen AI Security Project): why prevention is uncertain, and the layered mitigations
- [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) (OWASP Gen AI Security Project): least functionality, least permission, complete mediation
- [Beurer-Kellner et al., Design Patterns for Securing LLM Agents against Prompt Injections](https://arxiv.org/abs/2506.08837) (arXiv 2506.08837, 2025)
- In L2M: [MCP tool policy](/product/mcp-tool-policy), glossary: <Term id="least-privilege">least privilege</Term>, <Term id="output-checks">output checks</Term>
