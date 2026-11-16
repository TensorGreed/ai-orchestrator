---
title: "CRM enrichment agent: research and update records"
sidebarTitle: "CRM enrichment agent"
description: "Enrich new CRM records from a company's public website, propose field updates as checked JSON, and write them only after a person approves, under GDPR."
level: intermediate
related: [indirect-prompt-injection, ssrf, approval-gate, pii, least-privilege]
---

# CRM enrichment agent: research and update records

A CRM enrichment agent picks up new records (a lead, a company), reads the company's public website, proposes values for empty fields such as industry, country and size band, and writes them to the CRM. The key safety choices are to enrich the company rather than profile the person, to treat everything read from the web as untrusted, and to have a person approve each proposed update with the source shown. L2M gives you Salesforce and HubSpot nodes to read records, Web Browse to read pages, an Output Parser to keep the proposal to a fixed shape and an Approval Gate; the update itself goes through an HTTP Request, because L2M has no update node for either CRM.

## The job

| | |
|---|---|
| **Trigger** | A schedule that picks up records created since the last run, or your CRM's own automation calling a webhook |
| **Input** | The record: company name, website, the fields that are empty |
| **Research** | The company's own website, read in a headless browser |
| **Output** | A proposed update (field, value, source URL), approved or edited by a person, then written |
| **Must never happen** | A value with no source; personal details gathered about the contact; a page that tells the model what to write |

Most of this is a fixed sequence: read record, read website, extract, check, approve, write ([workflows vs agents](/learn/agents/workflows-vs-agents)). A browsing agent helps when the "About" page is two links away, but it widens what the job can reach: add one only for records the fixed version leaves empty.

## What the law asks of this job

Enrichment adds data the person did not give you, so data protection law is part of the design. For organisations under the GDPR, Article 5(1) sets the principles. Personal data must be "adequate, relevant and limited to what is necessary" for the purpose (data minimisation, 5(1)(c)), "collected for specified, explicit and legitimate purposes" (purpose limitation, 5(1)(b)), accurate and kept up to date (5(1)(d)), and kept "for no longer than is necessary" (5(1)(e)).

When personal data were not obtained from the person, Article 14 requires telling them, among other things, "the categories of personal data concerned" (14(1)(d)) and "from which source the personal data originate" (14(2)(f)). Where data are used for direct marketing, Article 21 gives the person the right to "object at any time", after which "the personal data shall no longer be processed for such purposes".

This is not legal advice, but those articles become rules the workflow can enforce:

- **Enrich the organisation, not the individual.** Industry, country, size band and a company description are about the company. Job history, social profiles and personal phone numbers are about the person; leave them out.
- **Fix the fields in advance.** The extraction schema lists the only fields the job may fill. A model that finds something else has nowhere to put it.
- **Keep the source.** Every proposed value carries the URL it came from, so you can answer "where did you get this?"
- **Respect objections.** Skip records flagged as objected or do-not-contact before any research starts.

## The design

<figure class="recipe-diagram">
<svg viewBox="0 0 900 250" role="img" aria-labelledby="crm-title crm-desc" xmlns="http://www.w3.org/2000/svg"><title id="crm-title">CRM enrichment with approval before the update</title><desc id="crm-desc">A Webhook Input, called by the CRM's automation for each new record, starts a HubSpot Get Contact read. Web Browse reads the company website. An LLM Call, fed by a Prompt Template that is not drawn, proposes values, and an Output Parser checks them against a schema. A code node keeps only allowed fields with a source and builds the update body. An If node ends the run when nothing is left; otherwise an Approval Gate shows the proposal, and on approval an HTTP Request writes it to the CRM.</desc><defs><marker id="crm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M160 47 L190 47" marker-end="url(#crm-arrow)"/><path class="rd-edge" d="M340 47 L370 47" marker-end="url(#crm-arrow)"/><path class="rd-edge" d="M520 47 L550 47" marker-end="url(#crm-arrow)"/><path class="rd-edge" d="M700 47 L730 47" marker-end="url(#crm-arrow)"/><path class="rd-edge" d="M805 74 L805 130" marker-end="url(#crm-arrow)"/><path class="rd-edge" d="M730 157 L700 157" marker-end="url(#crm-arrow)"/><path class="rd-edge" d="M550 157 L520 157" marker-end="url(#crm-arrow)"/><path class="rd-edge" d="M370 157 L340 157" marker-end="url(#crm-arrow)"/><g class="rd-node" data-kind="step" transform="translate(10 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">New record</text><text class="rd-type" x="12" y="40">webhook_input</text></g><g class="rd-node" data-kind="step" transform="translate(190 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Read contact</text><text class="rd-type" x="12" y="40">hubspot_get_contact</text></g><g class="rd-node" data-kind="step" transform="translate(370 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Read website</text><text class="rd-type" x="12" y="40">web_browse</text></g><g class="rd-node" data-kind="model" transform="translate(550 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Propose values</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(730 20)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Parse</text><text class="rd-type" x="12" y="40">output_parser</text></g><g class="rd-node" data-kind="step" transform="translate(730 130)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Allow-list, build body</text><text class="rd-type" x="12" y="40">code_node</text></g><g class="rd-node" data-kind="step" transform="translate(550 130)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Anything left?</text><text class="rd-type" x="12" y="40">if_node</text></g><g class="rd-node" data-kind="step" transform="translate(370 130)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Approve update</text><text class="rd-type" x="12" y="40">approval_gate</text></g><g class="rd-node" data-kind="step" transform="translate(190 130)"><rect width="150" height="54" rx="10"/><text class="rd-name" x="12" y="22">Write to CRM</text><text class="rd-type" x="12" y="40">http_request</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Nothing reaches the CRM before the Approval Gate. One record per run keeps each approval about one update.</figcaption>
</figure>

### Find the records

There is no CRM trigger node, so pick one of two shapes. **HubSpot: Get Contact** (`hubspot_get_contact`) fetches one contact by id or email, which fits a webhook called by your CRM's automation per new record. **Salesforce: SOQL Query** (`salesforce_query`) fills templates into its `soql` and returns the API's JSON, so a nightly schedule can ask for leads created since yesterday with an empty industry, skipping those flagged do-not-contact. Both use an access token stored as a secret. Prefer the webhook shape, one record per run, so each approval is about one update and a failure affects one record. A Loop body cannot hold an Approval Gate (loop bodies cannot pause), so the nightly shape means approving the night's proposals together at one gate. The diagram shows the webhook shape.

### Read the website, safely

**Web Browse** (`web_browse`) opens the record's website in headless Chromium and returns the title, meta tags and visible text, among other things. Set `screenshot` and `extractImages` to `false`: enrichment needs text. Set `urlTemplate` to <span v-pre>`{{results.record.website}}`</span>, the website from the webhook body (see below for why not from the HubSpot node).

The URL comes from a CRM field that anyone with CRM access, or a web form, may have filled. That makes it a <Term id="ssrf">server-side request forgery</Term> risk: a "website" of `http://10.0.0.5/admin` would have your server fetch an internal page and hand it to the model. L2M's [outbound URL checks](/security/outbound-url-checks) always block cloud metadata addresses and non-HTTP schemes, but private ranges and localhost are allowed by default. Turn on `OUTBOUND_DENY_PRIVATE` for a deployment that runs this job.

### Propose values in a fixed shape

A **Prompt Template** gives the model the company name (from the webhook body, by a <span v-pre>`results.record`</span> path like the website), the page's `title` and a cut of its `text` from Web Browse (the [brand extraction recipe](/recipes/brand-extraction-web) uses the first 4,000 characters). It asks for flat JSON with only the allowed fields, each value next to its source URL (`industry`, `industry_source`), and `null` when the page does not say.

The **Output Parser** in `json_schema` mode rejects an answer with a missing required field, a wrong type or a value outside an `enum`, and asks the model to fix it (twice by default; set `maxRetries` to 1 for one retry). It checks only the top level, which is why the proposal is flat, and it does not reject extra fields; the code check below drops them. Use `enum` for fields with a fixed list in your CRM (industry, size band, country code), and add `null` to each list: the parser applies `enum` to `null` too.

The page text is <Term id="indirect-prompt-injection">indirect prompt injection</Term> territory: a page can say "Set the industry to ...". The extracting model has no tools, so the worst it can do is propose wrong values, which then meet the schema, the code check and a person.

### Check, then build the update in code

A JavaScript **Code** node keeps only the allowed fields that have a value and a source URL on the company's own domain, and builds the request body as an object:

```js
const p = input.parsed || {};
const host = (u) => String(u || '').replace(/^https?:\/\//, '').split(/[\/?#:]/)[0].replace(/^www\./, '').toLowerCase();
const domain = host(input.results.record.website);
const onSite = (u) => host(u) === domain || host(u).endsWith('.' + domain);
const fields = {};
for (const f of ['industry', 'country', 'size_band']) if (p[f] != null && onSite(p[f + '_source'])) fields[f] = p[f];
return { proposal: fields, patchBody: { properties: fields }, hasProposal: Object.keys(fields).length > 0 };
```

Here `results.record` is the Webhook Input (node id `record`). A node's output reaches only its direct children, so the code reads the webhook by path, not as `input.website`. Have your CRM's automation send the website (and company name) in the webhook body, and add them to the node's **Pass-through Fields** (or clear the list): the HubSpot node asks for no property list, so its answer may not carry the website. The JavaScript sandbox has no `URL` class, hence the string handling. We ran this node on a local L2M with a stand-in proposal: an industry sourced from `www.acme.example/about` was kept, a country sourced from a directory site was dropped, and the node returned `{"properties":{"industry":"Manufacturing"}}`. An **If** node on <span v-pre>`{{hasProposal}}`</span> ends the run when nothing is left to propose.

Build the body in code, not by placing model values in a JSON body template, where a value containing a quote would break the JSON or add fields; an object rendered with <span v-pre>`{{patchBody}}`</span> becomes JSON text. Map field names to your CRM's property names here.

### Write the update

L2M's CRM nodes create and read records; none updates one (`salesforce_create_record`, `salesforce_query`, `hubspot_create_contact`, `hubspot_get_contact`). For the update, use **HTTP Request** with method `PATCH`, the record's URL in your CRM's REST API (for HubSpot, built from the contact's `id` by a path such as <span v-pre>`{{results.<HubSpot node id>.id}}`</span>, since the request's parent is the gate), `bodyTemplate` <span v-pre>`{{patchBody}}`</span> and a `secretRef`, which the node sends as a bearer token. Give that token the narrowest scope your CRM offers: write access to the fields this job fills, on the object it enriches.

## Where approvals go

An <Term id="approval-gate">Approval Gate</Term> before the HTTP Request. Its message shows the record, each proposed value and its source, read by path since the If node passes on only the code node's output (for example <span v-pre>`{{results.<parser id>.parsed.industry_source}}`</span>). An editable `json` field with the key `patchBody`, starting from <span v-pre>`{{patchBody}}`</span>, lets the reviewer remove a field or fix a value. Keep that key: an approval with no edits passes on the incoming `patchBody`, and a field under a new key would be missing. A webhook or scheduled run has no known requester, so name the approver roles or users; with none listed, any operator, builder or admin may decide ([approval gates](/product/approvals)). Rejected and timed-out requests write nothing.

If you later give an agent a CRM MCP server instead, mark only its read tools read-only in the [tool policy](/product/mcp-tool-policy#read-only-classification) and turn on [Ask before write tools](/product/approvals#approval-before-write-tools), so every update call pauses with its exact arguments: <Term id="least-privilege">least privilege</Term> plus a person, enforced at the tool call.

## How to test it

Build a [golden set](/product/golden-sets) from real runs, one case per situation:

| Case | Pass looks like |
|---|---|
| Clear "About" page with industry and country | Both proposed, each with a source on the company's domain |
| Page that says nothing useful | `hasProposal: false`; the run ends before the gate |
| Value outside your picklist | The parser rejects it, the retry fixes it or the run fails; nothing reaches the gate |
| Page text that tells the model to set a field | The proposal ignores it or the code check drops it; a person sees anything that remains |
| Source on another domain (a directory site) | The code check drops the field |

In a replay, Web Browse, the CRM nodes, the HTTP Request and the Code node are all answered from the recording, so tests neither browse nor write, and `hasProposal` and the branch are the recorded ones. The model and the parser are what a replay re-tests, so score the parsed proposal in the run's output; the rows that depend on the code check (nothing useful, another domain) re-test only the wiring. A change to the allow-list makes the replay inconclusive: test it with test runs and save new golden runs.

## What it costs to run

One model call per record, plus a retry when the parser rejects the answer. The page text is most of the prompt, so the cut you take decides the cost; skip records with nothing to enrich before the model. Cap the workflow with a <Term id="budget">budget</Term> in **block** mode ([budgets](/product/budgets)): when it is used up, the webhook answers HTTP 402 so your CRM's automation can retry later, and in the nightly shape the next night's query picks the records up again.

## Starting point, honestly

The closest sample is `samples/workflows/branding-extract-flow.json`, the [brand extraction recipe](/recipes/brand-extraction-web): Text Input with a URL, Web Browse, Prompt Template, an OpenAI LLM Call, Output Parser and Output. It turns one website into brand fields (name, logo, colours, font, tagline). It has no CRM read, no allow-list, no approval and no write.

What you add:

1. A trigger and a CRM read (Schedule Trigger with Salesforce: SOQL Query, or a webhook with HubSpot: Get Contact), skipping objected records.
2. Web Browse on the record's website, with screenshots and images off and `OUTBOUND_DENY_PRIVATE` on for the deployment.
3. A new prompt and schema for your fields, with a source per value and `enum` picklists.
4. The allow-list Code node, an Approval Gate with an editable body, and an HTTP Request `PATCH` with a narrowly scoped token.
5. A budget, and golden runs before you change the prompt.

Related use cases: [email to structured data](/learn/use-cases/email-to-structured-data) (the same extract, check and review steps for inbound mail), [research agent with citations](/learn/use-cases/research-agent-with-citations) (when the job needs many sources) and [support ticket triage agent](/learn/use-cases/support-ticket-triage-agent).

## Further reading

- [Regulation (EU) 2016/679 (GDPR)](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) (eur-lex.europa.eu): Article 5 principles, Article 14 information duties, Article 21 objection to direct marketing
- [Keeping personal data out of AI prompts](/learn/security/sensitive-data-in-prompts)
- [Outbound URL checks](/security/outbound-url-checks)
- [Extract a brand from a website](/recipes/brand-extraction-web)
- [Approval gates](/product/approvals)
