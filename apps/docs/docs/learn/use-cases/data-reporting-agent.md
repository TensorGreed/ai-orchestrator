---
title: "Automated data reports with an AI agent"
sidebarTitle: "Data reporting agent"
description: "Build a scheduled report: query a database read-only, chart it with Vega-Lite, let a model write the summary, and check its numbers before it is sent."
level: intermediate
related: [workflow-dag, least-privilege, approval-gate, golden-run, budget]
---

# Automated data reports with an AI agent

A reporting agent runs on a schedule, reads numbers from a database, turns them into charts and a short written summary, and sends the result to the people who need it. The key safety choice is to let the model write words, never fetch or compute the numbers: the query is fixed and runs under a read-only database role, and a check compares every number in the summary with the query result before anything goes out. L2M gives you the pieces (Schedule Trigger, PostgreSQL and MySQL query nodes, a Chart node that renders Vega-Lite, PDF Output and SMTP), plus a sample that already does the chart-to-PDF half.

## The job

| | |
|---|---|
| **Trigger** | A cron schedule, for example every Monday at 08:00 in your time zone |
| **Input** | Rows from a reporting view or a few aggregate queries |
| **Work** | Compute the figures, draw charts, write two or three sentences that explain them |
| **Output** | An email with the summary and the figures, and a PDF with the charts |
| **Must never happen** | A number in the email that is not in the data; a query that changes data |

Most of this job is a fixed sequence, and that is a good thing: the same query, charts and layout every week make reports comparable. The model only reads a handful of figures and says what changed, so the steps form a <Term id="workflow-dag">workflow DAG</Term> with the model in one node ([workflows vs agents](/learn/agents/workflows-vs-agents)). A tool-calling agent earns its place only for follow-up questions such as "why did refunds jump in week 46?", which need queries nobody wrote in advance.

## The design

<figure class="recipe-diagram">
<svg viewBox="0 0 900 300" role="img" aria-labelledby="dra-title dra-desc" xmlns="http://www.w3.org/2000/svg"><title id="dra-title">A scheduled data report with a number check</title><desc id="dra-desc">A Schedule Trigger starts a PostgreSQL query. A code node turns the rows into a few figures. The figures feed Chart nodes and an LLM Call that writes the summary. A second code node, which also reads the figures, checks that every number in the summary is one of them. An If node sends the email when the check passes and holds the report at an Approval Gate when it fails; an approved report goes to its own send step. The charts go into an HTML template and PDF Output.</desc><defs><marker id="dra-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M160 47 L190 47" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M340 47 L370 47" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M520 47 L550 47" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M445 74 L445 120 L475 145" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M700 47 L730 47" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M445 20 L445 8 L790 8 L790 20" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M805 74 L805 128" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M850 182 L850 235" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M760 182 L700 235" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M550 262 L520 262" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M475 155 L340 155" marker-end="url(#dra-arrow)"/><path class="rd-edge" d="M190 155 L160 155" marker-end="url(#dra-arrow)"/><g class="rd-node" data-kind="step" transform="translate(10 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Every Monday</text><text class="rd-type" x="12" y="40">schedule_trigger</text></g><g class="rd-node" data-kind="step" transform="translate(190 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Weekly query</text><text class="rd-type" x="12" y="40">postgres_query</text></g><g class="rd-node" data-kind="step" transform="translate(370 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Figures</text><text class="rd-type" x="12" y="40">code_node</text></g><g class="rd-node" data-kind="model" transform="translate(550 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Summary</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(730 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Check numbers</text><text class="rd-type" x="12" y="40">code_node</text></g><g class="rd-node" data-kind="step" transform="translate(730 128)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Numbers OK?</text><text class="rd-type" x="12" y="40">if_node</text></g><g class="rd-node" data-kind="step" transform="translate(760 235)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="12" y="22">Send report</text><text class="rd-type" x="12" y="40">smtp_send_email</text></g><g class="rd-node" data-kind="step" transform="translate(550 235)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Hold for a person</text><text class="rd-type" x="12" y="40">approval_gate</text></g><g class="rd-node" data-kind="step" transform="translate(370 235)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Send held report</text><text class="rd-type" x="12" y="40">smtp_send_email</text></g><g class="rd-node" data-kind="step" transform="translate(475 128)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Charts</text><text class="rd-type" x="12" y="40">chart</text></g><g class="rd-node" data-kind="step" transform="translate(190 128)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">HTML report</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="step" transform="translate(10 128)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">PDF</text><text class="rd-type" x="12" y="40">pdf_output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. The model sees only the computed figures, and its text is checked before the send step.</figcaption>
</figure>

### Read the data read-only, by construction

Give the report its own database user that can only `SELECT` from a reporting view, with its password stored as a secret (the node's `secretRef`). The database role is the access control.

**PostgreSQL: Query** (`postgres_query`) and **MySQL: Query** (`mysql_query`) send `query` and `params` exactly as written: no template is filled into either, so nothing from the run (not a webhook field, not a model's answer) can change the SQL. Put the date range in the SQL itself (`WHERE created_at >= date_trunc('week', now()) - interval '1 week'`). The node returns `rows` and `rowCount`.

### Compute figures in code, not in the model

A JavaScript **Code** node turns the rows into a small object of figures (this week's orders, last week's, the refund count) and returns it as `facts`. Models are poor at arithmetic over many rows, and every row in a prompt costs tokens. Use JavaScript: Python code nodes are off by default without the container sandbox ([code execution](/security/code-execution)).

### Charts and the PDF

Each **Chart** node renders a Vega-Lite spec to SVG on the server from the list of rows at its `dataPath`. A Code node outputs only what its code returns, so Charts below Figures do not see the query's `rows`: set `dataPath` to <span v-pre>`results.<query node id>.rows`</span>, or have Figures return the rows each chart needs. A **Prompt Template** places the SVGs in an HTML page and **PDF Output** prints it; the [PDF report with charts recipe](/recipes/pdf-report-with-charts) covers these nodes field by field.

### Let the model write, then check its numbers

The **LLM Call** gets only the figures and an instruction such as "Write two sentences for the weekly report. Use only these numbers." Instructions reduce made-up numbers; they do not prevent them. So a second code node checks the answer before the send step:

```js
const allowed = new Set(Object.values(input.facts).map(String));
const found = (String(input.answer).match(/\d[\d,]*(\.\d+)?/g) || []).map(n => n.replace(/,/g, ''));
const unknown = found.filter(n => !allowed.has(n));
return { summary: input.answer, unknownNumbers: unknown, numbersOk: unknown.length === 0 };
```

Two wiring details. The LLM Call's output carries its answer, not the figures, so connect **Figures** to this check node too; that edge is where `input.facts` comes from. And the LLM Call reads its prompt from the `prompt` key, so put a **Prompt Template** (not drawn) between Figures and the LLM Call, or have Figures return the instruction and figures as `prompt`.

An **If** node with the condition <span v-pre>`{{numbersOk}}`</span> sends the email on `true` and holds the report on `false`. Keep the condition one template: compute the decision in code and branch on the result.

We ran this part on a local L2M with a scripted stand-in model (a local server returning fixed answers, not a real model) and the figures 1240, 1180, 31 and 29. "Orders rose to 1,240 this week from 1,180 last week. Refunds were 31." went to the send branch; the same sentence with 1,420 went to the hold branch with `unknownNumbers: ["1420"]`. The check is strict on purpose: "60 more orders" fails, because 60 is not a figure. Add derived figures (differences, percentages) to the facts in code, or tell the model not to compute.

### Send it

**SMTP: Send Email** (`smtp_send_email`) renders `to`, `subject`, `text` and `html` from the run, so the email can carry the checked summary (<span v-pre>`{{summary}}`</span>, which the If node and the gate pass on) and a small HTML table of the figures, read by path, for example <span v-pre>`{{results.<figures node id>.facts.orders}}`</span>. The node cannot attach a file from the run, so the PDF stays on the run (PDF Output returns it as a `data:` URL in `pdf.downloadUrl`, and the studio's chat shows a **Download PDF** link): send the summary by email or Slack, and get the PDF from the run.

### The schedule

The **Schedule Trigger** takes a cron expression (minute, hour, day of month, month, day of week), a time zone (empty means UTC) and an `active` switch. It registers only when `active` is on, the expression is valid and the trigger is an entry point with an outgoing edge. When the workflow has a published version, the schedule runs that version, not your draft.

One trap: day of month and day of week combine differently from POSIX cron. POSIX fires on a day matching either field, so `0 8 1 * 1` would run on the 1st and on every Monday. L2M's scheduler (the node-cron library, 4.6 in this release) requires both: in our check of its matcher, `0 8 1 * 1` matched Monday 1 June 2026 but not Tuesday 1 December 2026 or Monday 16 November 2026. Restrict only one of the two fields.

## Follow-up questions: the agent part

For ad-hoc questions, attach a read-only SQL tool to an **Agent Orchestrator** through an MCP server that exposes your database ([read-only SQL access over MCP](/learn/mcp-servers/postgres-mcp-read-only) covers the database role and the choice of server). **Agent type** `sql` adds instructions such as "Only execute SELECT queries", but that is a prompt, not enforcement. The guarantees come from:

- The MCP server connects as the same read-only database user.
- In the [MCP tool policy](/product/mcp-tool-policy#read-only-classification), an admin marks the query tool read-only and marks or denies any tool that writes; the workflow's **No write tools** switch then blocks every write tool. The switch trusts a server's own `readOnlyHint` unless an admin's mark overrides it, which is why the marks matter.
- The run trace, which records every SQL statement the agent ran with its arguments.

Keep the agent out of the scheduled send path: its answers go to the person who asked.

## Where approvals go

For the scheduled report, the right control is an <Term id="approval-gate">Approval Gate</Term> on the hold branch: a person sees the summary next to the figures, can edit it and approve, and only then does the email go. Make the editable `text` field's key `summary`, the key the check node returns: an approval with no edits passes on the incoming `summary`, and a field under a new key would be missing. Give the approved output its own send step rather than joining the `true` branch's: a step with two parents takes shared keys from the parent whose edge was drawn last, so the If node's original `summary` could replace the edited one. A scheduled run has no known requester, so name the approver roles or users; with none listed, any operator, builder or admin may decide ([approval gates](/product/approvals)). While you build trust in the summaries, you can put the gate on every report.

**Ask before write tools** does not fit: the design has no write tools. A follow-up agent with a tool that can change data is a design error to fix with <Term id="least-privilege">least privilege</Term>, not an approval.

## How to test it

Save real runs as a <Term id="golden-run">golden run</Term> and group them in a [golden set](/product/golden-sets). In a replay, the query node is answered from the recording, so the test needs no database, and the email node never sends. Useful cases:

| Case | Input (recorded rows) | Pass looks like |
|---|---|---|
| Normal week | Orders and refunds both present | The new summary uses only figures from the facts; status `success` |
| Empty week | `rowCount: 0` | No summary claims a trend |
| Big change | Orders doubled | Summary says so; the `llm_judge` scorer, if you enable it, agrees the summary states the direction correctly |

Code nodes are answered from the recording in a replay, so the **Check numbers** verdict and its branch are the recorded ones: a new prompt or model that invents a number still takes the recorded branch. Judge the new summary itself with a scorer (`regex` or `llm_judge` on the summary, which the run's output must include, for example via an Output node after the send step). A changed checker makes the replay **inconclusive**; test it with test runs and fresh golden runs ([what a replay does](/product/golden-runs#what-a-replay-does)).

## What it costs to run

The scheduled report makes one model call per run; the query, charts and PDF use no tokens. The prompt is the instruction plus the figures: five numbers cost a fraction of five hundred rows. Each week costs about the same, so it is easy to cap with a workflow <Term id="budget">budget</Term> using the **block** action ([budgets](/product/budgets)). A scheduled run that a used-up budget refuses is recorded once per period as a failed run, not on every fire.

The follow-up agent is where cost varies: each iteration resends the conversation, and query results come back as tool messages. Keep **Max iterations** low (an Agent Orchestrator added in the editor starts at 6), make the SQL tool return few rows (a `LIMIT` in the server or the view), and keep the agent's tool message limit at its default of 6,000 characters or lower. See [controlling LLM and agent costs](/learn/operations/llm-cost-control). If the agent keeps rerunning the same query, see [agent stuck in a tool loop](/learn/troubleshooting/agent-stuck-in-tool-loop).

## Starting point, honestly

The closest sample is `samples/workflows/report-with-charts-flow.json`, the [PDF report with charts recipe](/recipes/pdf-report-with-charts). It is seven nodes: a **Set** node with three small data sets written into the workflow, three **Chart** nodes, a **Prompt Template** that builds the HTML, **PDF Output** and **Output**. It has no trigger, no database, no model and no send step.

`samples/workflows/key-inventory-report-flow.json` draws the charts from live data instead: an MCP tool (`list_keys`, on a key-manager server you provide) feeds a Python code node (container sandbox needed).

What you add to the first sample:

1. Replace **Set** with a Schedule Trigger and a PostgreSQL or MySQL query node, using a read-only user and a secret for its password.
2. Add the **Figures** code node, and point each Chart's `dataPath` at its rows (a `results.` path or a list Figures returns).
3. Add an LLM Call with the figures, the **Check numbers** code node and an If node.
4. Add SMTP: Send Email on the `true` branch, an Approval Gate on the `false` branch with a second SMTP: Send Email on its `approved` output, and a budget.
5. Save a few runs as golden runs before you change the prompt or the model.

Related use cases: [scheduled monitoring agent](/learn/use-cases/scheduled-monitoring-agent) (alert only on change), [email to structured data](/learn/use-cases/email-to-structured-data) (check before write, for extraction) and [incident triage agent](/learn/use-cases/incident-triage-agent).

## Further reading

- [Vega-Lite documentation](https://vega.github.io/vega-lite/docs/) (vega.github.io): the JSON grammar the Chart node renders
- [POSIX crontab](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/crontab.html) (opengroup.org): the five time fields and how day of month and day of week combine
- [PDF report with charts](/recipes/pdf-report-with-charts): the sample, step by step
- [Chart node](/nodes/chart)
- [Approval gates](/product/approvals)
- [Budgets](/product/budgets)
