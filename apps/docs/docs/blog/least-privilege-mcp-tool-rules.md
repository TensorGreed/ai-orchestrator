---
title: "Least privilege for MCP tools, learned from real calls"
description: "Argument-aware MCP tool rules, safe argument summaries in telemetry, and rule suggestions tested on the last 7 or 30 days of real calls before you enforce."
date: 2026-11-12
author: "The L2M team"
related: [least-privilege, mcp-tool-policy, human-in-the-loop]
socialCard: true
---

# Least privilege for MCP tools, learned from real calls

Allowing an agent to use an MCP server usually means allowing every tool on it, with any arguments. On 30 October 2026 we merged three changes that narrow that down in L2M: tool rules that read a call's arguments, a summary of each call's arguments that is safe to keep, and a way to test a rule, or ask for suggested rules, against the last 7 or 30 days of real calls before anything is enforced. This post explains the gap they close and how they fit together.

## The gap between "allowed server" and "allowed call"

Take a code-hosting MCP server with tools such as `list_issues`, `create_issue` and `push_files`. A support agent needs the first two, on one repository. A deploy bot needs `push_files`, but never to the production repository without someone looking.

A rule that says "this agent may use the code-hosting server" covers none of that. A rule per tool is better, but `push_files` to a sandbox and `push_files` to production are the same tool. The difference is in the arguments. OWASP's MCP Security Cheat Sheet puts it as "Grant each MCP server the minimum permissions needed for its function", and the MCP specification says a client should keep a human in the loop "with the ability to deny tool invocations". Doing either well means deciding on the actual call.

## Rules that read arguments

[MCP tool policy](/product/mcp-tool-policy) rules can now carry conditions on a call's arguments ([PR #117](https://github.com/TensorGreed/ai-orchestrator/pull/117)): `equals`, `one_of`, `starts_with`, `matches`, number comparisons, `between` and `exists`, with dot paths such as `options.branch` and `files[*].path`. A rule can also test the run's data labels, and can be limited to particular workflows or MCP gateway clients.

Rules have three effects: allow, deny and the new `require_approval`. Precedence is deny, then require approval, then allow, and a narrower rule carves an exception out of a broader one. So the deploy bot above becomes three rules, each limited to the deploy workflow:

- deny `push_files`;
- allow `push_files` where `repo` is one of `acme/sandbox`, `acme/docs`;
- require approval for `push_files` where `repo` equals `acme/prod`.

An agent or MCP Tool node that hits an approval rule pauses in the Approvals inbox until an admin decides. An MCP gateway client gets an "approval pending" error and retries the identical call once an admin has approved it.

We made conditions **fail closed**. A deny rule matches when any item of a list matches; an allow exception needs every item to match. A value a condition cannot read (an object where it expects text, a list over 1,000 items) matches a deny and never an allow. Padding a call with harmless values, or leaving an argument out, should not slip past a rule, and the [conditions reference](/product/mcp-tool-policy#conditions-fail-closed) lists each case.

## Argument summaries that are safe to keep

To learn rules from real calls, you need to know what the calls looked like. Storing raw arguments would put message bodies, email addresses and customer data into telemetry. So every tool-call row now keeps a **summary** of its arguments instead ([PR #118](https://github.com/TensorGreed/ai-orchestrator/pull/118)), described in [MCP tool-call telemetry](/product/mcp-tool-call-telemetry).

The summary is an allow-list. A value is kept as it is only when it is safe by construction: booleans, small numbers, values the tool's schema enumerates, and short lower-case tokens such as `open` or `main` that do not look like names, domains or keys. Repository owners, URL hosts, email domains and path roots are kept as prefixes, with home directories removed. Everything else keeps only its type, a length bucket and a keyed hash (HMAC-SHA-256 under a key derived from the master key). Keys that suggest personal data or secrets (`name`, `email`, `token`, `message` and many more) keep only shape and hash, whatever the schema says.

A hash cannot be read back, but it can be compared: L2M hashes the value in a rule with the same key and checks for equality. Summaries are on by default; `MCP_TOOL_ARGUMENT_SUMMARIES=false` turns them off.

## Simulate a rule on recent calls

With summaries in place, [PR #121](https://github.com/TensorGreed/ai-orchestrator/pull/121) lets an admin ask "what would this rule have done?" before saving it. The rule editor runs the draft against the workflow and gateway calls of the last 7 or 30 days and buckets each one: newly denied, newly needs approval, no longer denied or held, unchanged, or **undetermined**.

Undetermined is the honest answer when the summary cannot decide, for example when the value was hashed and the rule tests `starts_with`. Simulation reads each rule three ways (matches, does not match, cannot tell) and only places a call in a bucket when every reading agrees. A call it cannot decide is never reported as allowed or denied.

## Suggestions, shadow, enforce

**Suggest rules** reads the last 30 days and, for each workflow and gateway client with at least 20 usable calls, proposes per server an allow for each tool it actually used and a deny for the server's other tools. Where summaries support it, the allows get argument constraints: `one_of` for a small set of values seen repeatedly, and an upper bound for numbers. Hashed values and free text never become constraints, since their real value is unknown.

From there the path is deliberately slow:

1. **Preview impact** on the server's recent calls. The caller's own calls should show as unchanged.
2. **Accept in shadow mode.** Shadow rules are evaluated on every call and recorded, but never applied.
3. **Watch the counts.** Each shadow rule shows how many calls it matched in the last 7 days and how many outcomes would change if it alone were enforced.
4. **Enforce** the suggestion's rules together, allows first, so the deny never lands before the exceptions that keep the caller working. A suggestion is marked ready after 7 days in shadow with no changed outcome.

Suggestions only tighten: one that would loosen an existing deny is skipped, and that check runs again at accept and at enforce. Simulate, accept, dismiss and enforce are all audited.

## What it does not do

- It does not run in the background or enforce anything on its own. Nothing is suggested until an admin clicks **Suggest rules**.
- It does not replay calls or contact servers; it reasons from what was recorded.
- It does not suggest rules for admins' own calls, for resources, prompts or sampling, or from scans capped at 50,000 calls.
- It does not keep raw arguments, so an example call shows its summary, never its values.
- Rules are optional. With none, every call is allowed, as before.

## Read more

- Guides: [Least privilege from real runs](/guides/least-privilege-from-real-runs), [Govern MCP tools](/guides/govern-mcp-tools)
- Reference: [MCP tool policy](/product/mcp-tool-policy), [MCP tool-call telemetry](/product/mcp-tool-call-telemetry)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (owasp.org)
- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) (modelcontextprotocol.io): scope minimisation
- [CHANGELOG](https://github.com/TensorGreed/ai-orchestrator/blob/main/CHANGELOG.md) (GitHub)
