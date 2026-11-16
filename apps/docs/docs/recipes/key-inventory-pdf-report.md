---
title: "Branded PDF inventory report with charts and MCP"
description: "Import a workflow that reads a brand from a web page with a model, counts records from an MCP tool, draws three charts and prints a branded PDF."
keys: "services"
keysNote: "A model key, an MCP server, Chromium and a Python sandbox"
tags: ["reports","charts","pdf","mcp","web"]
nodeCount: 14
sample: "key-inventory-report-flow.json"
related: ["mcp-tool","streamable-http","ssrf","indirect-prompt-injection","workflow-dag"]
---

<!--
  Generated from samples/workflows/key-inventory-report-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Branded PDF inventory report with charts and MCP

**What you get:** A two-page A4 PDF in a website's colors and logo, with three charts of records counted from an MCP tool's answer.

**Needs:** A model key, an MCP server, Chromium and a Python sandbox · **Time:** 30 minutes · **Nodes:** 14

One **Manual Trigger** starts two branches. The brand branch loads a URL with **Web Browse** in headless Chromium, and a **Prompt Template**, an **LLM Call** and an **Output Parser** turn the page's title, meta tags, image URLs and text into a brand kit: name, logo URL, two colors, a font and a tagline. The data branch calls a `list_keys` tool with an **MCP Tool** node, and a Python **Code Node** counts the records by cloud, by algorithm and by age. Three **Chart** nodes draw the counts as SVG in the brand colors, a second Prompt Template builds one HTML page, and **PDF Output** prints it. The sample counts encryption keys, but any MCP tool that returns a JSON list works. It combines two smaller recipes: [brand extraction](/recipes/brand-extraction-web) and [PDF report with charts](/recipes/pdf-report-with-charts).

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/key-inventory-report-flow.json" download>Download the workflow JSON</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/key-inventory-report-flow.json" download>key-inventory-report-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/key-inventory-report-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Install Chromium for Playwright on the API host once: `pnpm exec playwright install chromium` from the repo root, or point `PDF_CHROMIUM_EXECUTABLE_PATH` at a Chromium you have. Web Browse and PDF Output both need it.
4. Let Python code run. With the default `CODE_SANDBOX_MODE=auto`, **Aggregate Keys** runs in a throwaway container when docker or podman is installed and both sandbox images are present locally. Without a container, Python code nodes are off by default and the node fails. See [code execution](/security/code-execution#code-nodes).
5. Point **Key manager list_keys** at your MCP server: set `connection.endpoint` to its streamable HTTP URL (`http://key-manager-mcp.internal/mcp` is a placeholder). For a token, set `connection.authType` to `bearer` and a `secretRef` to a stored [secret](/security/secrets), or register the server in the [MCP server registry](/product/mcp-server-registry) and set `registryServerId`.
6. Give **Distill Branding** a model: pick a stored secret with your OpenAI API key under **API Key Secret** (or set `OPENAI_API_KEY` on the API server), or switch the provider. To try it without a key, set its `providerId` to `echo` in the JSON file and import it again: the **Provider** list has no echo entry.
7. Set **Brand URL** to your site, or send a `user_prompt` with the run: it replaces the Text Input's URL. Run it, open the run and click **Render PDF**: `pdf.downloadUrl` holds the file as a `data:application/pdf;base64,...` URL, and the **PDF Report** output returns it as `result`.

## How it works

<figure class="recipe-diagram">
<svg viewBox="46 96 2078 942" role="img" aria-labelledby="rd-key-inventory-pdf-report-title rd-key-inventory-pdf-report-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-key-inventory-pdf-report-title">Diagram of the Key manager — Key Inventory Report (PDF, branded) workflow</title><desc id="rd-key-inventory-pdf-report-desc">Runs Run report, then Brand URL, then Key manager list_keys, then Fetch Brand Site, then Aggregate Keys, then Extract Branding Prompt, then Distill Branding, then Parse Brand JSON, then Keys by Cloud, then Keys by Algorithm, then Key Aging, then Compose Branded HTML, then Render PDF, then PDF Report.</desc><defs><marker id="rd-key-inventory-pdf-report-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M260 347 C309 347 309 147 358 147" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M550 147 C609 147 609 147 668 147" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M860 147 C919 147 919 147 978 147" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1170 147 C1229 147 1229 147 1288 147" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1480 147 C1539 147 1539 147 1598 147" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M260 347 C309 347 309 547 358 547" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M550 547 C609 547 609 547 668 547" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M860 547 C919 547 919 467 978 467" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M860 547 C919 547 919 727 978 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M860 547 C919 547 919 987 978 987" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1790 147 C1384 147 1384 467 978 467" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1790 147 C1384 147 1384 727 978 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1790 147 C1384 147 1384 987 978 987" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1170 467 C1229 467 1229 727 1288 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1170 727 C1229 727 1229 727 1288 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1170 987 C1229 987 1229 727 1288 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1790 147 C1539 147 1539 727 1288 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M860 547 C1074 547 1074 727 1288 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M550 147 C919 147 919 727 1288 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1480 727 C1539 727 1539 727 1598 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><path class="rd-edge" d="M1790 727 C1849 727 1849 727 1908 727" marker-end="url(#rd-key-inventory-pdf-report-arrow)"/><g class="rd-node" data-kind="step" transform="translate(70 320)"><title>Run report (manual_trigger)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Run report</text><text class="rd-type" x="12" y="40">manual_trigger</text></g><g class="rd-node" data-kind="step" transform="translate(360 120)"><title>Brand URL (text_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Brand URL</text><text class="rd-type" x="12" y="40">text_input</text></g><g class="rd-node" data-kind="step" transform="translate(670 120)"><title>Fetch Brand Site (web_browse)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Fetch Brand Site</text><text class="rd-type" x="12" y="40">web_browse</text></g><g class="rd-node" data-kind="step" transform="translate(980 120)"><title>Extract Branding Prompt (prompt_template)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Extract Branding Prompt</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="model" transform="translate(1290 120)"><title>Distill Branding (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Distill Branding</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(1600 120)"><title>Parse Brand JSON (output_parser)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Parse Brand JSON</text><text class="rd-type" x="12" y="40">output_parser</text></g><g class="rd-node" data-kind="tool" transform="translate(360 520)"><title>Key manager list_keys (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Key manager list_keys</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="step" transform="translate(670 520)"><title>Aggregate Keys (code_node)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Aggregate Keys</text><text class="rd-type" x="12" y="40">code_node</text></g><g class="rd-node" data-kind="step" transform="translate(980 440)"><title>Keys by Cloud (chart)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Keys by Cloud</text><text class="rd-type" x="12" y="40">chart</text></g><g class="rd-node" data-kind="step" transform="translate(980 700)"><title>Keys by Algorithm (chart)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Keys by Algorithm</text><text class="rd-type" x="12" y="40">chart</text></g><g class="rd-node" data-kind="step" transform="translate(980 960)"><title>Key Aging (chart)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Key Aging</text><text class="rd-type" x="12" y="40">chart</text></g><g class="rd-node" data-kind="step" transform="translate(1290 700)"><title>Compose Branded HTML (prompt_template)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Compose Branded HTML</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="step" transform="translate(1600 700)"><title>Render PDF (pdf_output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Render PDF</text><text class="rd-type" x="12" y="40">pdf_output</text></g><g class="rd-node" data-kind="step" transform="translate(1910 700)"><title>PDF Report (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">PDF Report</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Run report | [`manual_trigger`](/nodes/reference/input#manual-trigger-—-manual-trigger) | Step in the run |
| Brand URL | [`text_input`](/nodes/reference/input#text-input-—-text-input) | Step in the run |
| Key manager list_keys | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Step in the run |
| Fetch Brand Site | [`web_browse`](/nodes/reference/connector#web-browse-—-web-browse) | Step in the run |
| Aggregate Keys | [`code_node`](/nodes/reference/utility#code-node-—-code-node) | Step in the run |
| Extract Branding Prompt | [`prompt_template`](/nodes/reference/utility#prompt-template-—-prompt-template) | Step in the run |
| Distill Branding | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Step in the run |
| Parse Brand JSON | [`output_parser`](/nodes/reference/utility#output-parser-—-output-parser) | Step in the run |
| Keys by Cloud | [`chart`](/nodes/reference/output#chart-—-chart) | Step in the run |
| Keys by Algorithm | [`chart`](/nodes/reference/output#chart-—-chart) | Step in the run |
| Key Aging | [`chart`](/nodes/reference/output#chart-—-chart) | Step in the run |
| Compose Branded HTML | [`prompt_template`](/nodes/reference/utility#prompt-template-—-prompt-template) | Step in the run |
| Render PDF | [`pdf_output`](/nodes/reference/output#pdf-output-—-pdf-output) | Step in the run |
| PDF Report | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

11 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## What a run does

We ran it on a local install with three stand-ins, so nothing left the machine: a brand page served on localhost (a title, an `og:image` logo, a `theme-color` tag and text naming two colors and a font), a local MCP server whose `list_keys` returned 12 keys, and a scripted OpenAI-compatible model that answered the brand prompt with one JSON object. Python ran in a container.

- **With the stand-ins**, the run took about 1.7 seconds: about 0.65 s each for Web Browse and the PDF, 0.3 s for the Python step (mostly starting the container) and 6 to 12 ms per chart. The PDF was 55,555 bytes on two A4 pages: the logo, brand name and tagline, a box with the total (12), the cloud bar chart in the page's primary color and the algorithm donut on page 1, and the age chart in the accent color on page 2. The age chart's heading was left at the foot of page 1; add `h2{break-after:avoid}.chart{break-inside:avoid}` to the template's CSS to keep headings with their charts.
- **With the echo provider**, the model only repeats the prompt. The parser picked up the image list from the echoed text, so every brand field was empty: the PDF had no brand name, tagline or logo, and the bar charts used default colors. The run still succeeded, so check the brand values.
- **With the MCP endpoint as shipped**, **Key manager list_keys** failed with `fetch failed` after about 8 seconds. The nodes that had not run yet, Web Browse included, were skipped, and the run ended with an error.

The file name template is <span v-pre>`{{results.brand_parse.parsed.brand}}-key-inventory-{{session_id}}.pdf`</span>: a run with `session_id: "q4-review"` gave the stand-in's brand name followed by `-key-inventory-q4-review.pdf` (spaces in the brand name are kept), and without a session the name ends in `-.pdf`. The stand-in shows the plumbing; how well a real model fills in the brand kit depends on the model and the page.

## How the branches meet

A node sees the outputs of the nodes that point at it. The three Chart nodes have edges from both **Aggregate Keys** and **Parse Brand JSON**, so they wait for both branches. **Compose Branded HTML** has edges from the parser, the Python step, the Text Input and the charts, so its template can use <span v-pre>`{{parsed.brand}}`</span>, <span v-pre>`{{totalKeys}}`</span> and <span v-pre>`{{cloudChart.svg}}`</span>. **Render PDF** has only the HTML node as a parent, so its file name reads the brand with <span v-pre>`{{results.brand_parse.parsed.brand}}`</span>, which reaches any finished node.

A Chart node fills in placeholders only in `specTemplate`, a JSON string, not in an inline `spec` object. The two bar charts use `specTemplate` with <span v-pre>`{{ parsed.primaryColor || '#4c78a8' }}`</span> as the bar color, so a missing color falls back to a default. The result must still be valid JSON: a color value with a quote in it fails the node. Each chart's `dataPath` (`byCloud`, `byAlgorithm`, `ageing`) names a list from the Python step. See the [Chart node](/nodes/chart) for the other fields.

## The Python step

**Aggregate Keys** gets the MCP Tool node's output as `items[0]`: the tool's text in `tool_output`, and its `structuredContent` in `structured` when the server sends one. The script prefers `structured`, parses `tool_output` as JSON otherwise, and accepts a list or an object with a `keys` list. It reads each record's `algorithm`, `labels.cloud` (or `cloud`) and `createdAt`. Missing values count as `unknown`, and a record without a readable date counts as under 30 days old.

A Python code node returns what the script assigns to `result`; `log()` only adds a line to `code_logs`. Here `result` is a dictionary (`byCloud`, `byAlgorithm`, `ageing`, `totalKeys`, `generatedAt`), and its keys also appear at the top level for the next nodes. `generatedAt` goes into the report as a raw ISO timestamp; format it in the script if you want a plain date.

## Outbound requests and untrusted input

Web Browse loads the page and everything it pulls in, and PDF Output loads whatever the HTML references, here the logo URL. Both go through L2M's [outbound URL checks](/security/outbound-url-checks): cloud metadata and link-local addresses are always refused, while private ranges and localhost are allowed by default, which is why our localhost page worked.

The brand values come from a web page through a model and go into the HTML without escaping, and Chromium renders that HTML with scripts on. Treat the brand URL as untrusted input. The counts have no model in their path: the charts come straight from the tool's answer.

## Make it yours

- Count something else: change the tool name and `argsTemplate` on the MCP Tool node, then the field names in the Python step. Keep the `byCloud`, `byAlgorithm` and `ageing` names, or change each chart's `dataPath`.
- Skip the model: delete the four brand nodes and put fixed colors in the chart specs and the HTML template.
- Let a chat follow up on a report: the [two-turn report and code helper](/recipes/two-turn-report-helper) saves a report per session and writes a script from it on the next turn.

## Make it safer

These controls are optional; the recipe runs without them.

- If people you do not control choose the brand URL, turn on `OUTBOUND_DENY_PRIVATE` (off by default): see [outbound URL checks](/security/outbound-url-checks#configuration).
- Keep Python in the container sandbox, not on the host: see [code execution](/security/code-execution#python-on-the-host).
- Give the workflow an MCP token that can only read. An optional [MCP tool policy](/glossary/mcp-tool-policy) can also refuse tools you did not mean to allow.
- The PDF is stored with the run as base64, so anyone who can read the run can read the report.

## Further reading

- [Chart node](/nodes/chart)
- [Web Browse node](/nodes/web-browse)
- [Code execution](/security/code-execution)
- [Outbound URL checks](/security/outbound-url-checks)
- [Pattern library](/patterns/)
