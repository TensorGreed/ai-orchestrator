---
title: "Least privilege for AI agents: tools, arguments, data"
sidebarTitle: "Least privilege for agents"
description: "Why AI agents drift to more access than they need, the layers to narrow (servers, tools, arguments, data, people, keys) and how to keep them narrow."
level: intermediate
about: least-privilege
related: [least-privilege, excessive-agency, mcp-tool-policy, shadow-mode, rbac, service-account]
---

# Least privilege for AI agents

<Term id="least-privilege">Least privilege</Term> for an AI agent means it can reach only the servers, tools, arguments and data its task needs, and the people and keys that run it hold only the access their job needs. Agents make this harder than for ordinary software, because they choose their own steps and anything they read can try to steer them. The practical method is to work from evidence: see what an agent actually calls, write narrow rules from that, test the rules on past traffic, run them in shadow mode, then enforce and review them on a schedule.

## Why agents drift to over-privilege

Nobody sets out to give an agent too much. It happens one reasonable step at a time:

- **Servers come with all their tools.** You connect a code-hosting server because the agent needs to read issues. The server also offers `delete_repository`, and the agent now sees it.
- **Servers grow.** A server update adds tools. Nothing in your configuration changed, but the agent's reach did.
- **Credentials are broad.** It is quicker to give the server one admin token than to work out which scopes it needs. The MCP specification's security guidance lists this as a common mistake: "using wildcard or omnibus scopes (`*`, `all`, `full-access`)" and "bundling unrelated privileges to preempt future prompts" ([MCP Security Best Practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices#scope-minimization)).
- **Debugging leaves doors open.** An allow added during an incident stays.
- **Tool names hide the risk.** `run_query` is harmless on the reporting replica and dangerous on production. The difference is in the arguments.

The result is what OWASP calls <Term id="excessive-agency">excessive agency</Term>. Its [LLM06 entry](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) names three root causes: "excessive functionality", "excessive permissions" and "excessive autonomy". It matters because of <Term id="prompt-injection">prompt injection</Term>. You cannot fully control what a fooled agent will try, so you control what it is able to do.

## The layers

Least privilege for agents is not one setting. It is a stack of narrower and narrower questions, each one a separate place to say no:

| Layer | Question | Example of a narrow answer |
|---|---|---|
| Servers | Which MCP servers can this agent reach at all? | The ticket server, not the code host |
| Tools | Which tools on those servers? | `search_tickets` and `add_comment`, not `close_ticket` |
| Arguments | With which values? | `add_comment` only where `visibility` is `internal` |
| Data | With what in its context? | No tool that sends data outside once customer data is in context |
| Autonomy | Which calls need a person first? | A refund over 100 waits for approval |
| People | Who can change the agent and its rules? | Builders edit workflows; only admins change rules |
| Keys | What can automation do with a key? | The CI key reaches one project, as operator, for 90 days |

The OWASP [MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) covers the server and credential layers: "grant each MCP server the minimum permissions needed for its function" and "use scoped, per-server credentials — never share tokens across servers". OWASP's [LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) entry lists "enforce privilege control and least privilege access" among its mitigations, next to human approval for high-risk actions.

Two layers deserve a closer look.

**Arguments.** A rule on a tool name is a blunt instrument. Rules that read arguments let you allow the safe uses of a tool and deny or hold the dangerous ones. When you write them, prefer allow-lists to deny-lists. A deny-list for `env = prod` misses `PROD`, `prod ` and `production`. An allow-list for `env` in `dev, staging` lets none of them through.

**Data.** What is safe depends on what the agent has already read. A tool that posts to an outside service is fine for a research summary and not fine once the context holds a customer's card number. Rules that look at where the data came from cover this; the guide on the [lethal trifecta](/learn/security/lethal-trifecta) explains the idea.

## Start from what agents actually call

The hard part of least privilege is knowing what "needs" means. Asking the agent's author is a guess. Reading the tool list is worse: it tells you what the agent could call, not what it does.

The better source is the record of real calls. If a support agent made 400 tool calls last month, all to `search_tickets` and `add_comment`, and `add_comment` always had `visibility: internal`, then a rule set almost writes itself:

1. Allow `search_tickets`.
2. Allow `add_comment` where `visibility` is one of `internal`.
3. Deny every other tool on the ticket server.

The deny is broad and the allows carve exceptions out of it. Anything the agent never needed is now closed, including tools the server adds next month.

Two cautions. A month of calls shows normal behaviour, not every legitimate edge case, so a rare but real task can be blocked. And the record has to be safe to keep: storing raw tool arguments to learn rules from them creates a second copy of the data you are trying to protect. Keep a summary that is enough to compare values against rules, such as enum values, numbers and keyed hashes of free text, not the text itself.

## Simulate before you enforce

A new rule is a change to production behaviour, and it can break things two ways. It can block a call the agent needs, or it can carve out an exception wider than intended. Before you save it, replay the decision against past calls:

- How many calls that were allowed would now be denied, or need approval?
- How many that were blocked would now go through?
- Which workflows and callers are affected?

A simulation should be honest about what it cannot know. If the record holds a hash of an argument and the rule tests "starts with", the answer is "undetermined", not a guess. An undetermined count that is large tells you the rule depends on data you did not keep.

## Shadow mode

Simulation answers "what would this have done last month?". <Term id="shadow-mode">Shadow mode</Term> answers "what is it doing now?". A shadow rule is evaluated on every live call and its verdict is recorded, but it changes nothing. You watch the hits for a while, look at each call it would have blocked, and enforce it when the list looks right.

A useful habit: give a new rule a fixed quiet period, for example a week of shadow with no unexpected hits, before enforcing it. A rule that would have blocked a legitimate call during that week is caught with no harm done.

## Roles and projects for people and keys

Agents are not the only principals. The people who build agents, and the keys that run them, need the same treatment:

- **People get roles.** <Term id="rbac">Role-based access control</Term> separates who can read workflows, who can edit them, who can run them and who can change security rules. The person who writes an agent should not also be the only one who can approve its risky calls.
- **Teams get projects.** Projects keep one team's workflows, secrets and runs away from another's. A membership can grant more or less inside one project than a person's global role.
- **Automation gets its own identity.** A CI pipeline should not use a person's key. A <Term id="service-account">service account</Term> has no password and cannot sign in, so its access is exactly what its keys allow, and it survives the person who created it leaving.
- **Keys get scopes and expiry.** A key for a deploy job needs one project and an operator's rights, not its owner's admin role, and it should expire.

Who runs the agent matters too. A scheduled or webhook-triggered agent has no signed-in user. Decide whose permissions it runs with, and make that the lowest that works.

## Review cadence

Least privilege decays. Servers add tools, workflows change, people move teams. A light routine keeps it current:

- **On every server change.** When an MCP server's tool list changes, check whether a broad allow now covers a new tool.
- **Monthly.** Compare each agent's rules with its last 30 days of calls. Tools it never used are candidates to close; new tools it started using need a decision.
- **Quarterly.** Review roles, project memberships and keys. Remove keys nobody used, and shorten long expiries.
- **After an incident.** An emergency allow or deny gets an owner and an end date.

## Least privilege in L2M

L2M, a self-hosted workflow builder and agent runtime, implements each layer as an option. With no rules, every tool is allowed and simple workflows need no setup.

- **Tool rules with conditions.** [MCP tool policy](/product/mcp-tool-policy#conditions) rules allow, deny or require approval by project, role, server and tool name, and optionally by the call's arguments (`one_of`, `starts_with`, number comparisons and more) and its <Term id="data-labels">data labels</Term>. Precedence is deny, then require approval, then allow; a strictly narrower rule carves an exception. Conditions fail closed: an odd argument can cause an extra deny, never a wider allow. Denied tools are removed before the model sees them, and every call is checked again.
- **No write tools.** A per-workflow switch blocks every tool that is not read-only. Here a tool's own annotations count: `readOnlyHint` or `destructiveHint` decide, a tool with neither counts as a <Term id="write-tool">write tool</Term>, and an admin's read-only or write mark overrides both. Mark tools by hand on servers you have not reviewed.
- **Rules from real runs.** An admin can simulate a draft rule on the recorded calls of the last 7 or 30 days, or ask for suggestions: for each workflow and gateway client with at least 20 usable calls in the last 30 days, an allow per tool it used, with argument constraints where the summaries support them, and a deny for that server's other tools. Suggestions only tighten, and are accepted in shadow mode. The [least privilege from real runs](/guides/least-privilege-from-real-runs) guide has the steps.
- **Shadow mode.** Any rule can run in [shadow mode](/product/mcp-tool-policy#shadow-mode). An accepted suggestion is marked ready to enforce after 7 days in shadow with no changed outcome.
- **People.** Four roles (admin, builder, operator, viewer) and project memberships, with optional strict isolation so people without a membership see nothing in a project ([project access](/security/auth-rbac#project-access)). Runs with no signed-in user, such as schedules and public webhooks, are evaluated with the workflow creator's role, or as viewer when the creator is unknown.
- **Keys.** An API key can carry a role ceiling and a project allow-list; a project-limited key acts as builder at most. Service accounts cannot sign in and never decide approvals ([key scopes](/security/service-accounts#key-scopes)). Clients of the MCP gateway get their own token, their own <Term id="toolset">toolsets</Term> and a role capped at their creator's current role.

In the live demo, a support agent answers customer questions with two MCP tools from one server: `lookup_kb` for product facts and `calculator` for prices. Even an agent this small raises the questions above: does it need both tools, should either be marked read-only, and which arguments should each accept?

<TryInDemo workflow="wf-demo-support-agent" recorded />

For the story of how argument-aware rules and suggestions came to L2M, see the post [least privilege for MCP tools, learned from real calls](/blog/least-privilege-mcp-tool-rules).

**See also:** [MCP tool annotations](/learn/mcp/tool-annotations), the server-side hints (read-only, destructive, open world) that rules like these build on.

## Further reading

- [MCP Security Best Practices: scope minimization](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices#scope-minimization) (Model Context Protocol)
- [MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (OWASP)
- [LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) (OWASP Gen AI Security Project)
- [MCP tool policy](/product/mcp-tool-policy): the rule reference in L2M
