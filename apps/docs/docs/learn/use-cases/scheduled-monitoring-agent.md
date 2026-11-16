---
title: "Scheduled monitoring agent that reports changes"
sidebarTitle: "Scheduled monitoring agent"
description: "Run a check on a cron schedule, compare the result with the last run, and alert only on real changes. How to build the comparison in L2M, and cap its cost."
level: intermediate
related: [workflow-dag, budget, golden-run, max-iterations, least-privilege]
---

# Scheduled monitoring agent that reports changes

A monitoring agent wakes up on a schedule, checks a few sources (status endpoints, a price list, a policy page, a dashboard's API), compares what it sees with what it saw last time, and tells someone only when something changed. The key design choice is to make "did it change?" a deterministic comparison in the workflow, and to call a model only when there is a change to explain. L2M has the schedule, the fetch nodes, a Compare Datasets node and a way to keep the last result between runs; it does not compare a run with the previous one by itself, so this page shows how to build that, with a version we ran.

## The job

| | |
|---|---|
| **Trigger** | A cron schedule: every 15 minutes, every hour, every weekday morning |
| **Input** | The current state of each source, fetched fresh |
| **Memory** | The state the last run saw |
| **Output** | A message in Slack or Teams listing what was added, removed or changed, with a short explanation; nothing when nothing changed |
| **Must never happen** | An alert every run (noise), an alert missed because two runs overlapped, a model call on every tick |

The schedule, fetch, comparison and alert are the same every time, so they belong in a fixed <Term id="workflow-dag">workflow DAG</Term> ([workflows vs agents](/learn/agents/workflows-vs-agents)). A model adds value at one point: turning a diff such as `{"key": "b", "a": {"status": 200}, "b": {"status": 503}}` into "The billing page started returning 503", or judging whether a changed paragraph on a policy page matters. An agent with tools fits only when the check itself needs judgement; even then, keep the before/after comparison outside the model.

## The design

<figure class="recipe-diagram">
<svg viewBox="0 0 900 290" role="img" aria-labelledby="sma-title sma-desc" xmlns="http://www.w3.org/2000/svg"><title id="sma-title">Scheduled check with a comparison against the last run</title><desc id="sma-desc">A Schedule Trigger starts two steps: a Session Artifact Load that reads the last saved state and an HTTP Request that fetches the current state, followed by a code node that normalises it. Compare Datasets diffs the two. A code node counts the changes, reading the load result to spot the first run. A Session Artifact Save stores the current state. An If node continues only when something changed: an LLM Call explains the diff and Slack Send Message posts it.</desc><defs><marker id="sma-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M160 100 L175 100 L175 47 L190 47" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M175 100 L175 157 L190 157" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M340 157 L370 157" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M340 47 L550 47" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M520 157 L535 157 L535 60 L550 60" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M700 47 L730 47" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M265 20 L265 8 L790 8 L790 20" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M805 74 L805 130" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M730 157 L700 157" marker-end="url(#sma-arrow)"/><path class="rd-edge" d="M625 184 L625 222" marker-end="url(#sma-arrow)"/><text class="rd-type" x="633" y="208">true</text><path class="rd-edge" d="M550 249 L520 249" marker-end="url(#sma-arrow)"/><g class="rd-node" data-kind="step" transform="translate(10 73)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Every 15 minutes</text><text class="rd-type" x="12" y="40">schedule_trigger</text></g><g class="rd-node" data-kind="memory" transform="translate(190 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Load last state</text><text class="rd-type" x="12" y="40">session_artifact_load</text></g><g class="rd-node" data-kind="step" transform="translate(190 130)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Fetch now</text><text class="rd-type" x="12" y="40">http_request</text></g><g class="rd-node" data-kind="step" transform="translate(370 130)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Normalise</text><text class="rd-type" x="12" y="40">code_node</text></g><g class="rd-node" data-kind="step" transform="translate(550 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Compare</text><text class="rd-type" x="12" y="40">compare_datasets_node</text></g><g class="rd-node" data-kind="step" transform="translate(730 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Count changes</text><text class="rd-type" x="12" y="40">code_node</text></g><g class="rd-node" data-kind="memory" transform="translate(730 130)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Save state</text><text class="rd-type" x="12" y="40">session_artifact_save</text></g><g class="rd-node" data-kind="step" transform="translate(550 130)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Changed?</text><text class="rd-type" x="12" y="40">if_node</text></g><g class="rd-node" data-kind="model" transform="translate(550 222)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Explain the diff</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(370 222)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Post alert</text><text class="rd-type" x="12" y="40">slack_send_message</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Save state passes the count through to the If node. The model runs only on the changed branch.</figcaption>
</figure>

### Fetch and normalise

Fetch each source with the node that fits: **HTTP Request** for a JSON API or a health endpoint, **Web Browse** for a page that needs JavaScript, an **MCP Tool** node for a system behind an MCP server. HTTP Request and Web Browse go through the [outbound URL checks](/security/outbound-url-checks), which is where internal hosts are allowed or denied.

Then normalise in a JavaScript **Code** node into a list of small objects with a stable key and only the fields that matter: `[{ "url": "/billing", "status": 503 }]`. Return the list under a key, for example `return { now: list };`; a bare array comes back as `code_result`. This step decides how noisy the monitor is: drop timestamps, request ids and counters that change on every fetch, and write the fields in a fixed order, because the comparison treats two items as the same only when their JSON text is identical.

For RSS and Atom feeds you may not need any of this: the **RSS / Atom Trigger** already remembers the item ids it has seen (the last 500), treats its first poll as a baseline that fires nothing, and starts a run only for new items.

### Keep the last result between runs

Nothing carries over between runs by default. The simplest store is the pair **Session Artifact Save** and **Session Artifact Load**, which save and load a JSON value under a namespace, a session id and a key in L2M's own database. For a monitor, use fixed values: namespace `monitor`, session id `status-pages`, key `last`. On the save, set **valueKey** to the normalised list (for example `results.normalise.now`); without one it saves everything the run holds so far. On the load, set **outputKey** to `last` (the default is `artifact`).

Set the same `namespace` on both nodes. When it is empty, each node defaults to its own workflow and node id, so the load would never find what the save wrote. On a schedule, the session id must be a literal (there is no chat session to fill <span v-pre>`{{session_id}}`</span>); with an empty one, the save does nothing and reports `missing_session_id`. Saved artifacts fall under the agent memory retention setting (`AGENT_MEMORY_RETENTION_DAYS`, by last update), so a monitor that saves on every run keeps its state as long as the retention is longer than its interval.

Other stores work too: a Redis Command node (`GET` and `SET`, whose arguments are templates), or a sheet cell with Google Sheets: Read and Update. The PostgreSQL and MySQL query nodes cannot store a result, because they fill no templates into their SQL.

### Compare with the last run

**Compare Datasets** (`compare_datasets_node`) takes two lists and a key field and returns four lists: `added` (in the new list only), `removed` (in the old list only), `changed` (same key, different content, with both versions as `a` and `b`) and `same`. Its `inputA` and `inputB` are paths, and <span v-pre>`results.<nodeId>.<key>`</span> paths reach any earlier node, so with node ids `load` and `normalise`, `inputA` is `results.load.last` and `inputB` is `results.normalise.now`. Put the old list in `inputA`; otherwise added and removed swap.

A small Code node turns the diff into a decision, and handles the first run, when there is nothing to compare with:

```js
const first = !input.found;
const n = input.added.length + input.removed.length + input.changed.length;
return { firstRun: first, changeCount: n, hasChanges: !first && n > 0 };
```

`found` comes from the load node, so connect the load node to this Code node too. An **If** node on <span v-pre>`{{hasChanges}}`</span> continues only when there is something to say; keep its condition that single template.

We ran this part on a local L2M, with a Code node standing in for the fetch: the first run saved its state and took the false branch (`firstRun: true`); the second, with the same data, found it and reported 0 changes; the third, with one status changed from 200 to 503, reported 1 change and took the alert branch; the fourth, with the same data again, reported 0. The saved state carried from each run to the next.

### Save before or after the alert?

Saving before the alert (as in the diagram) means a failed Slack post loses that alert: the next run compares against the new state and sees no change. Saving after the alert means a failed post fails the run before the save, so the next run alerts again. For most monitors a repeat beats a gap: move the save to the end of the alert branch and add a second save on the no-change branch.

### Explain and alert

On the changed branch, an **LLM Call** gets the diff (not the fetched data) and writes two or three lines. The diff does not reach it through the If node, and the LLM Call reads its prompt from the `prompt` key, so put a **Prompt Template** (not drawn) between them that places <span v-pre>`{{results.compare.added}}`</span>, `removed` and `changed` (with your Compare node's id) in the instruction. **Slack: Send Message** (`slack_send_message`, through an incoming webhook URL or a bot token stored as a secret) or **Teams: Send Message** (`teams_send_message`) posts the LLM Call's `answer`. Put the raw diff under it, read by the same <span v-pre>`results.`</span> paths, so a reader can check the model against the facts.

## The schedule, and runs that overlap

The **Schedule Trigger** needs a cron expression, a time zone and `active` on; the [data reporting agent](/learn/use-cases/data-reporting-agent#the-schedule) page covers its rules, including how day of month and day of week combine differently from POSIX cron.

Each tick starts a run whether or not the previous one has finished. If a check can take longer than the interval, two runs can load the same old state and both alert. Keep the interval comfortably longer than the slowest run, and give HTTP Request and Web Browse a timeout well under it.

## Where approvals go

A monitor that only reads and posts needs no approval: the read tools are read-only and the alert is the point. Keep it that way. Use read-only credentials for every source, and if a monitoring agent gets MCP tools, have an admin mark each one read-only or write in the [tool policy](/product/mcp-tool-policy#read-only-classification) and switch on **No write tools** for the workflow (the switch trusts a server's own `readOnlyHint` unless an admin's mark overrides it). That is <Term id="least-privilege">least privilege</Term> doing the work an approval would otherwise do.

Add a person only if the monitor is allowed to act on what it finds (restart a service, open a ticket, pause a campaign). Then put an Approval Gate before that step, or turn on [Ask before write tools](/product/approvals#approval-before-write-tools) for the agent, so the action waits for a decision while the alert still goes out at once.

## How to test it

In a replay, Session Artifact nodes run against an empty store that exists only for that replay, while the fetch nodes and every Code node (normalise, count) are answered from the recording. The count, and so the branch, is the recorded one, so a replay of the whole monitor tests neither the normalisation nor the comparison.

Test the parts separately:

- **The comparison:** run a test copy of the workflow two or three times with a Code node in place of the fetch, as we did above, and check `changeCount` and the branch taken. Cases: same data twice (no alert), one value changed, one item added, one removed, a timestamp-only change (no alert, if normalisation is right).
- **The explanation:** move "explain and alert" into a sub-workflow whose input is the diff, called with an Execute Workflow node. Save its runs as <Term id="golden-run">golden runs</Term> in a [golden set](/product/golden-sets): input a diff, pass if the message names every changed key and invents none (a `text_similarity` or `llm_judge` scorer, plus `status`).

## What it costs to run

The schedule, fetches and comparison cost no tokens. The model runs only on the changed branch, so cost follows the number of changes, not ticks: a 15-minute monitor that sees two changes a day makes two model calls a day. Send the model the diff, not the fetched pages.

If you use an agent for the check itself, every tick costs tokens. Keep <Term id="max-iterations">max iterations</Term> low (an Agent Orchestrator added in the editor starts at 6), keep tool results small, and cap the workflow with a <Term id="budget">budget</Term> using the **block** action ([budgets](/product/budgets)). When a budget refuses a scheduled run, L2M records one failed run per schedule, budget and period, not one per tick. An agent that reaches its iteration limit on every tick is usually stuck on the same call ([agent stuck in a tool loop](/learn/troubleshooting/agent-stuck-in-tool-loop)).

## Starting point, honestly

There is no sample for this job. The nodes all exist, and the comparison above is one we ran on a local install with stand-ins, not a shipped workflow. To build it:

1. Add a Schedule Trigger with your cron expression, time zone and `active` on.
2. Add the fetch nodes and a Code node that normalises each source to a list with a stable key.
3. Add Session Artifact Load and Save with the same fixed namespace, session id and key.
4. Add Compare Datasets (old list in `inputA`), the counting Code node and an If node on <span v-pre>`{{hasChanges}}`</span>.
5. On the true branch, add an LLM Call for the explanation and a Slack or Teams node, then move the save to suit the failure you prefer.
6. Add a block budget before you shorten the interval.

Related use cases: [data reporting agent](/learn/use-cases/data-reporting-agent) (a fixed report on a schedule), [incident triage agent](/learn/use-cases/incident-triage-agent) (what happens after the alert) and [Slack assistant with tools](/learn/use-cases/slack-assistant-with-tools).

## Further reading

- [POSIX crontab](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/crontab.html) (opengroup.org): the five time fields and the POSIX rule for day of month and day of week
- [Budgets](/product/budgets)
- [Golden runs and replay](/product/golden-runs)
- [Outbound URL checks](/security/outbound-url-checks)
- [Workflows vs agents](/learn/agents/workflows-vs-agents)
