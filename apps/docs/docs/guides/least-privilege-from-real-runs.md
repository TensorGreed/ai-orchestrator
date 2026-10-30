---
title: "Least privilege from real runs: simulate and suggest MCP tool rules"
description: "Tighten MCP tool access from recorded calls: simulate a draft rule on the last 7 or 30 days, review suggested allow and deny rules, shadow them, then enforce."
---

# Least privilege from real runs

Writing tool rules by hand means guessing which tools an agent needs. L2M already records every MCP tool call with a safe summary of its arguments, so it can answer two questions from what really happened:

- **What would this rule have done?** Simulate a draft rule, or a whole edited rule set, on the calls of the last 7 or 30 days before you save it.
- **What is the least this agent needs?** Ask for suggestions: for each workflow and gateway client, an allow for every tool it actually used and a deny for the other tools on that server. Accept one in shadow mode, watch it, then enforce it.

It is all optional. Nothing is suggested until an admin clicks **Suggest rules**, a simulation never changes anything, and nothing new needs configuring. It works on SQLite and Postgres. Everything here is admin-only.

It builds on [Govern MCP tools](./govern-mcp-tools.md) and on the argument summaries described in [MCP tool-call telemetry](../product/mcp-tool-call-telemetry.md). Summaries are on by default. With `MCP_TOOL_ARGUMENT_SUMMARIES=false`, simulation counts calls as *not summarised* and suggestions get no argument constraints.

## 1. Simulate a rule before you save it

Open **MCP → Policies** and add or edit a rule. Under the form, click **What would this have done in the last 7 days?** (pick 30 days from **Window** for a longer look). L2M compares the current rules with the draft on each recorded workflow and gateway call:

| Bucket | Meaning |
| --- | --- |
| Newly denied / Newly needs approval | Allowed today; the draft would block it or hold it for approval. |
| No longer denied / No longer needs approval | Blocked or held today; the draft would let it through. |
| Unchanged | Same outcome either way. |
| Undetermined | The summary cannot say. For example, the value was hashed and the rule tests `starts_with`, or the list was too long to keep. |
| Not summarised | The call has no summary: summaries were off, or the call predates them. |

The report also gives counts per rule and per workflow or client. Click a bucket to see up to 20 example calls with their tool, time, caller, role, the rule that decided them, and the argument **summary**. Raw arguments are never stored, so they are never shown.

An edit is simulated in place of the rule it changes, among the current rules. A new rule is simulated as added after them. Either way, the draft rule counts as **enforced**, even if you tick **Shadow mode**, because the question is what it would do. Shadow rules never change an outcome, so they are left out on both sides.

The same check is available as `POST /api/mcp/policies/simulate`, with `{ addRule }` for one rule or `{ rules }` for a whole draft set (each entry a rule or `{ "keep": "<rule id>" }`), plus optional `filters` for workflow, client, server or tool.

## 2. Ask for suggestions

Below the rules, **Least privilege from real runs** has a **Suggest rules** button. It reads the last 30 days of calls. For every workflow and gateway client with at least 20 usable calls, it proposes, per server it used:

- **Allow** for each tool it called. Where the summaries support it, the allow gets argument constraints:
  - `one_of`, for a kept value with at most 10 distinct values, each seen in at least two calls (tokens, schema enum values, or a boolean that never changed);
  - `at most`, for a positive number, set to the observed maximum × 1.5, rounded up.
- **Deny** for every other tool on that server.

The rules name the workflow or client and apply to builders, operators and viewers, never to admins.

Usable calls are calls that reached the server, made by anyone but an admin. A call whose role was not recorded still counts: the tool was used, so the deny must not block it. Left out are:

- admins' own calls;
- playground calls;
- calls refused by a rule, the guard or a runtime limit;
- calls that failed before they were sent, or before they could connect (connection refused, unknown host, connect timeout);
- the gateway's own rows for workflow tools.

Suggestions are never built from part of the calls. When the last 30 days hold more than 50,000 calls, nothing is suggested and the status line says so: a tool used before the oldest call read would otherwise be denied.

Servers configured inline on nodes share their adapter id, so a suggestion for one covers every inline server of that adapter, with their tools taken together. The evidence says so.

Free text and hashed values never become constraints: their real value is unknown, so a rule cannot name it. Neither does text the summary kept in a normalised form (surrounding spaces, full-width characters), since the rule would name a value the call did not send. Summaries written before format 3 do not mark that, so their kept text outside plain ASCII gets no constraint either. Open **Evidence** on a suggestion to see the calls behind it, the constraints, and why other arguments got none.

Suggestions only tighten. If an allow would carve an exception out of an existing deny or needs-approval rule, the suggestion is skipped. The check runs again when you accept, and again when you enforce, in case the rules changed in between. A dismissed proposal is not offered again unless the calls change it. An accepted one is not offered again while its rules are in place; delete them and it can come back. Generating is rate-limited to once every 30 seconds per API instance.

Once a caller's suggestion is accepted, a later run of **Suggest rules** that finds it using new tools offers **Update accepted rules**: allows for just the new tools, added in shadow next to the accepted rules. Their own deny is meant to be carved by them, so it does not count as a rule they loosen while it is still the deny you accepted; once someone edits it (say, widens it to every workflow), it counts like any other deny.

The status line says how many calls were read and why some callers got nothing (too few calls, would loosen, dismissed before, already accepted, already in place).

## 3. Preview, accept in shadow, enforce

On a suggestion:

1. **Preview impact** simulates the current rules plus the suggested ones, as if enforced, on that server's calls of the last 30 days. You should see the scope's calls as *Unchanged*; anything *Newly denied* is a call it made that the rules would now block.
2. **Accept in shadow mode** adds the rules in **shadow** mode: every call records what they would have decided, nothing is applied. If the suggestion was regenerated after you looked at it, accepting is refused so you can review the new version. The audit log records `mcp_policy.suggestion_accepted` and a `mcp_policy.created` per rule.
3. While they run in shadow, each shadow rule shows **Last 7 days: matched N calls; if you enforce just this rule, M would change**: the rules enforced now plus that one rule, without the other shadow rules. So a suggestion's deny shows every call it matched, because on its own it would block them; its allows are what carve them out. The suggestion itself shows what its rules would change taken together. These counts come from the decisions recorded on each call (`GET /api/mcp/policies/shadow-hits`).
4. **Enforce suggestion** switches all of its rules to enforce in one step, allows first. It is marked ready after 7 days in shadow with no changed outcome, and never when the count stopped at the scan cap (it says *not ready (scan capped)*). You can enforce earlier; L2M asks first, and the audit event `mcp_policy.enforced` records the shadow counts at that moment.

A suggestion's rules have no **Enforce** button of their own, however old the suggestion is. Enforcing its deny alone through the API is refused while an allow of the same caller's accepted rules is still in shadow, since it would block the tools the caller uses. That holds for every accepted suggestion of the caller on that server, and still after you delete some of its rules. Enforcing is also refused when an allow would carve an exception out of a rule enforced now, such as a deny added during an incident after the suggestion was accepted. Both checks run again at the moment of the switch, so a rule changed while L2M was counting the shadow hits is taken into account. Each rule switches only while it is still in shadow, so two admins enforcing at once change and audit it once; the second is told the rules were enforced meanwhile. Shadow rules you wrote yourself keep their own **Enforce** button.

**Dismiss** keeps the decision on record (`mcp_policy.suggestion_dismissed`).

## How it works

Simulation reuses the policy evaluator's rules and reads them three-valued: a rule matches, does not match, or *cannot be decided from the summary*. A kept value is compared directly. A hashed value can prove equality or inequality, because L2M hashes the literal in the rule with the same key and compares. Text operators on a hashed value, a dropped list, a truncated summary or an unknown label make the rule undecided. The call is then tried with each undecided rule matching and not matching. It gets a bucket only when every reading agrees, otherwise it is *undetermined*. So a call is never reported as allowed or denied when its summary cannot tell.

Summaries say when they cannot be compared exactly ([summary format 3](../product/mcp-tool-call-telemetry.md#format-3-marks)), and simulation then leaves the condition undecided:

- text kept or hashed in a different form from the one rules compare (surrounding spaces, full-width or other compatibility characters);
- numbers rounded to 4 decimal places, or to 1 under a location key such as `lat` (kept location numbers are still compared with a ±0.05 margin for `<`, `>` and `between`; hashed ones never);
- hashes made under another master key, after a key rotation;
- summaries written before format 3: their kept text, non-integer numbers and hashes.

Two more limits:

- Annotation-hint rules use the tools' current snapshots, and are undecided for calls made before the snapshot was taken or the admin mark was set.
- A run that a gateway client started records its workflow but not the client, so client-scoped rules are undetermined for it.

Scans read newest first, in pages of 1,000, up to 50,000 calls. When a window holds more, the report says how far back it got. A simulation also stops early, and says so, when its rules need more evaluation work than one simulation may do, or after 5 seconds. Scans hand control back every few milliseconds, so the API keeps serving other requests while one runs. Measured with 100,000 recorded calls, a 30-day simulation took about 1.6 s on SQLite and 3.3 s on Postgres. Each simulation is recorded in the audit log as `mcp_policy.simulated`, with its rule hashes and filters, because a simulation can confirm a guessed argument value against the hashed ones.

## What it does not do

- It does not replay calls or contact servers; it reasons from what was recorded.
- It does not suggest rules for resources, prompts or sampling, for tools whose name contains `*`, or for admins.
- It does not run in the background. Suggestions appear only when an admin asks.
- It does not enforce anything on its own.

## Next steps

- Reference: [MCP tool policy](../product/mcp-tool-policy.md), [MCP tool-call telemetry](../product/mcp-tool-call-telemetry.md)
- Guides: [Govern MCP tools](./govern-mcp-tools.md), [Run a self-hosted MCP gateway](./self-hosted-mcp-gateway.md)
