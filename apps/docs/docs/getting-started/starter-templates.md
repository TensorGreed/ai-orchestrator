---
title: "Starter templates that run without setup"
description: "Ten everyday automations to start from, from webhooks and forms to approvals and MCP tools. Each runs on built-in sample data, with no model or key."
---

# Starter templates

The **Starters** in **Templates** are ten small workflows you can run the moment you open them: no model, no API key, no MCP server and no outside service. Each one shows one everyday pattern, and each is a working base to change into your own automation.

To find them, open **Templates** and pick **Starters**, or turn on **Runs without setup** to see every template, starter or not, that needs nothing set up. Click **Use Template**: the workflow opens as a new draft. Nothing changes in the template.

Other templates say on their card what they need. One whose model or embedder calls a provider that needs a key is marked **Needs an OpenAI key** (or the provider it names); save the key under **Secrets** and pick it on the node, or set the provider's key variable on the API server. A run without the key stops at that node with a message that names the missing key.

A starter's webhook, form and schedule **start switched off**: nothing outside the editor can start a run until you turn them on. **Run** and **Webhook run** in the editor work straight away. To take live calls, open the trigger node and click **Turn on** in the line above its form, then save. Until then its production address answers `404` with `"code": "trigger_off"`.

| Starter | What it shows | How to try it |
|---|---|---|
| Webhook: reshape and reply | Webhook Input, Set, Webhook Response | **Webhook run** (the sample request is filled in). The webhook is off until you turn it on |
| Schedule: fetch, filter and notify | Schedule Trigger, HTTP Request, Filter (items), a POST | **Run**. The schedule is off until you turn it on |
| Form intake: route requests | Form Trigger, Switch, one Set per team | **Webhook run** with the sample answers. The form is off until you turn it on |
| CSV to JSON: parse, sort and total | Extract from File, Sort, Summarize, Convert to File | **Run**; paste your own CSV into **Parse CSV** |
| Approval before it goes out | Approval Gate with an editable amount | **Run**, then decide in **Approvals**. Self-approval is on: whoever starts a run may approve it themselves, so you can try it alone. The request says so, and so does the **Approve refund** node; before real use, clear **Let the person who started the run approve it** there |
| Retry, then fall back | HTTP Request retries and its **Error** output | **Run**; change `503` to `200` in the URL to see the success path |
| Loop over items and collect | Loop, a Set per item, Merge (collect loop passes) | **Run** |
| Call a sub-workflow | Execute Workflow with an input mapping | **Run**. Using the template also creates the sub-workflow it calls |
| Search a few documents | RAG Retrieve with the built-in local embedder | **Run**; change the question in **Question** |
| Call an MCP tool | MCP Tool against the built-in sample MCP server | **Run** |

## Where the sample data comes from

The HTTP starters call the API's own sample endpoints, so they work with no network access:

| Endpoint | Answers |
|---|---|
| `GET /api/sample-data/orders` | Six example orders (two pending, one refunded) |
| `POST /api/sample-data/notify` | `{ "delivered": true, "simulated": true, "received": <your JSON> }`: it stands in for a chat or email notification and sends nothing |
| `GET` or `POST /api/sample-data/status/<code>` | That HTTP status, 200 to 599 |

They need no sign-in, store nothing and answer the same to everyone. When the starters are loaded, their URLs get the API's own address (`http://127.0.0.1:<API_PORT>`, or `API_HOST` when the API listens on one address). If the deployment blocks private addresses for outbound requests (`OUTBOUND_DENY_PRIVATE=true`), add that address to `OUTBOUND_ALLOWLIST` or point the nodes at your own service. If `NETWORK_ALLOW_UI` limits which addresses may reach the studio, include `127.0.0.1`: the starters' requests carry no sign-in, so they are checked as studio traffic.

Once you turn on the **Webhook** or **Form intake** starter's trigger, its address is live, like any workflow without a release gate: anyone who can reach the API can call `/webhook/starter-reshape-…` or open `/api/forms/starter-contact-…`. Neither does anything outside the run. Turn it off again under **More** (**Live calls**), or delete the workflow, when you are done trying it.

The MCP starter uses the built-in sample MCP server (`mock-mcp`, with a calculator and a clock), and the search starter keeps its five help articles in the node and uses the local token embedder. That embedder is fine for a demo; pick a real embedder for real documents.

## Make it yours

- Replace the sample URLs in the HTTP Request nodes with your service, and add its key as a secret.
- Swap the sample notify call for **Slack: Send Message**, **Microsoft Teams: Send Message** or **SMTP: Send Email** when you have those credentials.
- Turn on the Schedule Trigger to run it on its schedule, and the Webhook or Form Trigger to take live calls.
- Edit Switch cases, Form Trigger fields and sub-workflow mappings as rows in the inspector; no JSON needed.
