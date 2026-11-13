---
title: "Human in the loop for AI agents: approvals that work"
sidebarTitle: "Human in the loop"
description: "Where a person belongs in an agent's path: before risky tool calls, on a draft, or as a question. Which actions need it, timeouts, and approval fatigue."
level: intermediate
about: human-in-the-loop
related: [human-in-the-loop, approval-gate, write-tool, signed-run-manifest, excessive-agency]
---

# Human in the loop for AI agents

Human in the loop means a person can stop an agent's action before it takes effect. In practice there are three places to put that person: before a risky tool call, on a draft before it goes out, and on a question the agent cannot answer alone. The design work is choosing which actions need a decision, who may make it, what happens when nobody answers, and how to prove later what was decided. Get those wrong and people approve everything without reading, which is no control at all.

## What the MCP spec and OWASP say

The Model Context Protocol leaves the user interface to each application, but its Tools page is direct about the person. It says that "there **SHOULD** always be a human in the loop with the ability to deny tool invocations", and that applications should "present confirmation prompts to the user for operations, to ensure a human is in the loop". Its security section adds that clients should "prompt for user confirmation on sensitive operations" and "show tool inputs to the user before calling the server, to avoid malicious or accidental data exfiltration".

OWASP says the same from the attacker's side. Its entry on prompt injection (LLM01:2025) lists, among its mitigations, "Implement human-in-the-loop controls for privileged operations to prevent unauthorized actions." The OWASP MCP Security Cheat Sheet is more specific: "Require explicit user confirmation for destructive, financial, or data-sharing operations", "Display full tool call parameters to the user — not just a summary name", and "Ensure the confirmation UI cannot be bypassed by LLM-crafted responses."

Read together, these give a working definition of <Term id="human-in-the-loop">human in the loop</Term> for agents: a person sees the real action with its real arguments, can say no, and the agent has no way to talk its way past the check.

## Three places for a human

A person can sit at three different points in an agent's path. They answer different risks, and most systems need more than one.

| Where | What the person sees | Good for |
|---|---|---|
| Before a tool call | The tool, its server and the exact arguments the model chose | Actions that change something outside the system: payments, deletes, messages, deploys |
| On a draft, before the next step | The agent's output, often with fields they can edit | Text that goes to a customer, a summary that goes into a record |
| On a question from the agent | A question the agent asks because it is missing information | Ambiguous requests ("email him": who?) |

**Approve a tool call.** This is the case the MCP spec describes. The agent's loop stops just before the call, and the run waits. The person approves the call as it stands or rejects it with a reason, and the agent continues or fails. The check sits inside the agent loop, so it catches calls nobody planned for, including calls an injected instruction asked for.

**Review an output.** Here the check sits between steps of a workflow rather than inside the agent. A drafting step writes a reply, a gate holds it, and a reviewer reads, edits and approves before a sending step runs. This works well when the risky step is fixed in the workflow, so you know in advance where it will happen.

**Answer a question.** Sometimes the agent should not guess. A good runtime gives the model a way to ask: it calls a "clarify" tool with a question, the run ends with that question as its answer, and the person's reply is fed back when the conversation continues. This is not an approval. Nobody decides anything, and the reply is just more input. It belongs on the list because it is the cheapest way to stop an agent from acting on a wrong guess.

## Picking which tools need approval

Asking a person before every tool call makes an agent slow and teaches people to click without reading. The useful split is between reads and writes. A <Term id="write-tool">write tool</Term> changes something: it sends, creates, updates, deletes, pays or deploys. A read-only tool only fetches. Approval belongs on writes.

The hard part is knowing which is which. MCP servers can describe their tools with <Term id="tool-annotations">tool annotations</Term> such as `readOnlyHint` and `destructiveHint`, but the spec itself warns that "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers". A server you have not reviewed can label `delete_records` read-only. So the safe default is the reverse of what feels convenient:

1. Treat every tool as a write tool until someone you trust has marked it read-only.
2. Mark the real read-only tools (search, get, list) once, by hand.
3. Let everything else ask.

Some tools are only risky with some arguments. A push to a sandbox repository is routine; a push to production is not. A refund of $20 is routine; a refund of $2,000 is not. Rules that look at the arguments let you ask only when it matters: "require approval for `push` when `repo` is `acme/prod`", or "for `issue_refund` when `amount` is greater than 500".

A third trigger is what the agent has read. An agent that has just read a web page or an inbound email may be carrying injected instructions. Asking before any write tool after outside content arrived is a reasonable rule, even for tools you would otherwise let run. This is the practical answer to OWASP's <Term id="excessive-agency">excessive agency</Term> risk: if you cannot take a tool away, at least make it ask.

## Timeouts and who may approve

**Decide what silence means.** A request nobody answers must end somehow. For a tool call, the safe ending is rejection: the action does not happen, and the run says why. For a review gate, you may want a fallback path instead, such as routing the draft to a queue for the next shift. What you must avoid is a timeout that approves.

**Pick the timeout from the work.** A refund queue staffed during office hours needs at least a day. A chat assistant that asks before sending an email needs minutes, because the user is waiting. Too short, and requests expire before anyone sees them; too long, and a forgotten request runs days later, when the context has changed.

**Separate the asker from the approver.** If the person who starts a run can also approve it, the gate is only a speed bump. For actions that matter, the approver should be someone else: a named team lead or a role. On a one-person install this is awkward, so a self-approval switch is useful, as long as it is off by default and turning it on is a visible choice.

**Check the approver at decision time.** Roles change. A person who was an approver when the request was created may have left the team by the time they click. The check belongs on the decision, not only on the request.

**Approve one action, not a session.** An approval should cover one call with its exact arguments. If the model then asks for the same tool with different arguments, that is a new decision. Otherwise an agent can get a harmless call approved and reuse the approval for a harmful one. OWASP's MCP cheat sheet points the same way: for "binding approvals to specific actions and arguments and preventing their reuse", it refers readers to its AI Agent Security Cheat Sheet.

## Proving the decision later

An approval that leaves no trace is hard to defend in a review or an incident. For each request you want to be able to answer: what was asked, by which run and step, who decided, when, what they decided, and why. If the approver edited the action, you also want to know which fields changed.

Two properties make that record trustworthy. It is written by the system, not typed by the person, so it cannot be skipped. And it is hard to change afterwards: an <Term id="audit-log">audit log</Term> that the system appends to and nobody can edit, plus a per-run record signed with a key, so anyone with the public key can check that the file was not edited. The OWASP MCP cheat sheet asks for the same evidence on the tool side: "Log all MCP tool invocations with full parameters, user context, and timestamps."

Do not store more than you need. A reviewer's edits may contain personal data. A digest of the edits proves they were made without copying them into every audit export.

See also: [audit trails for AI agents](/learn/operations/audit-trails-for-agents) covers what a full trail of a run holds and how to verify it.

## Approval fatigue and how to avoid it

The most common failure of human in the loop is not a missing gate. It is a gate that asks so often that people stop reading. Some habits that keep approvals meaningful:

- **Ask less, on purpose.** Mark read-only tools as read-only. Use argument rules so routine calls run and unusual ones ask. Every request you remove makes the remaining ones more likely to be read.
- **Show the real action.** The approver should see the tool name, the server and the arguments the call will actually use, not a sentence the model wrote about them. A model's summary is exactly the part an attacker can shape.
- **Make rejecting cheap.** One click and a short reason. If rejecting is harder than approving, people approve.
- **Let the approver fix small things.** If the only options are approve or reject, a reviewer who wants to change one word must reject and start over. Editable fields turn many rejections into quick approvals.
- **Send requests where people already are**, such as a chat channel or email, with a link back to the decision page.
- **Watch the numbers.** A gate that is approved every single time, within seconds, is probably not checking anything. Either the action is safe enough to run without it, or the people approving need better information.

## Human in the loop in L2M

L2M, a self-hosted workflow builder and agent runtime, has each of the three placements. All of them are optional, and a workflow that uses none runs without pausing.

- **Ask before write tools.** A workflow setting pauses an agent before any MCP write tool call. A tool counts as read-only only when an admin marked it so (L2M's own built-in tools, and workflow tools whose trigger declares them read-only, count too); a server's own `readOnlyHint` is not trusted for this. The approval covers one call (this agent node, this server and tool, these exact arguments), self-approval is off by default, and an unanswered request is rejected after the timeout (one day by default). The step-by-step setup is in [Human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls).
- **Approval rules on specific calls.** Optionally, an admin writes a <Term id="mcp-tool-policy">tool policy</Term> rule with the effect `require_approval`, with conditions on the arguments, such as `repo` equals `acme/prod`. It covers agents, direct MCP Tool nodes and MCP gateway clients, and admins decide these requests ([Require approval](/product/mcp-tool-policy#require-approval)).
- **An Approval Gate on a DAG edge.** An <Term id="approval-gate">Approval Gate</Term> node holds any step until a person decides. It names approver roles or users, can let the approver edit up to 20 fields, and has `approved`, `rejected` and `timed_out` outputs, with a timeout from one minute to 30 days. A run cannot be started after a gate to skip it ([Approval gates](/product/approvals)).
- **The agent asks a question.** Agents with tool calling get a built-in `agent_clarify` tool. When the model calls it, the run returns the question in a `clarification` field and the chat shows "Assistant is asking". The next message in the same session is handed to the agent as the answer. It does not go through the Approvals inbox ([mid-turn clarification](/runtime/agent-loop#mid-turn-clarification-agent-clarify)).
- **One inbox and a signed record.** Requests land in the **Approvals** inbox. An approver must be allowed to run the workflow, and that is checked again when they decide. Only the first decision counts. Each request and decision goes into the audit log and into the run's Ed25519-<Term id="signed-run-manifest">signed run manifest</Term>: request id, node, kind, outcome, who decided and when, the reason, and the keys and a digest of any edits ([Audit bundles](/security/audit-bundles)).

What it does not do yet: no reminders or escalation, no approve buttons inside Slack, Teams or email messages (a message can link to the inbox), and approvers are roles or users, not groups.

In the live demo, a refund workflow drafts a reply and pauses at an Approval Gate whose approver may edit the reply. The recorded run stops at the gate, waiting for a decision.

<TryInDemo workflow="wf-demo-refund-approval" recorded />

## Further reading

- [Human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls): set up approval before write tools in L2M
- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io): the human-in-the-loop guidance and the client security list
- [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) (genai.owasp.org): human approval for high-risk actions among the mitigations
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (owasp.org): human in the loop for sensitive actions, and logging tool calls
