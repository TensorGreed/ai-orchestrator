---
title: "Generate a PDF report with charts from data"
description: "Render Vega-Lite charts to SVG on the server, place them in an HTML template and print it to PDF with headless Chromium. No model and no API key needed."
keys: "none"
keysNote: "No API key; Playwright Chromium for the PDF"
tags: ["reports","charts","pdf"]
nodeCount: 7
sample: "report-with-charts-flow.json"
related: ["workflow-dag"]
---

<!--
  Generated from samples/workflows/report-with-charts-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Generate a PDF report with charts from data

**What you get:** A two-page A4 PDF with three charts (a bar chart, a donut and an ageing histogram), built from data in the workflow.

**Needs:** No API key; Playwright Chromium for the PDF · **Time:** 10 minutes · **Nodes:** 7

A **Set** node holds three small data sets: key counts by cloud, by algorithm and by age. Three **Chart** nodes turn them into SVG from [Vega-Lite](https://vega.github.io/vega-lite/) specs, on the server, with no browser. A **Prompt Template** places the SVGs in an HTML page, and **PDF Output** prints that page to A4 with headless Chromium. No model is involved, so it runs without a key. Swap the Set node for real data, such as an HTTP request, a database query or an MCP tool, and the rest stays the same.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/report-with-charts-flow.json" download>Download the workflow JSON</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/report-with-charts-flow.json" download>report-with-charts-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/report-with-charts-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Install Chromium for Playwright on the API host once: `pnpm exec playwright install chromium` from the repo root. Or point `PDF_CHROMIUM_EXECUTABLE_PATH` at a Chromium you already have.
4. Run it. Open the run and click **PDF**: the node output has the file as `pdf.downloadUrl` (a `data:application/pdf;base64,...` URL) and `pdf.base64`. The **Output** node returns that URL as `result`.
5. Save the PDF from the URL, or run the workflow from the studio's chat, which shows a **Download PDF** link when the answer is a PDF data URL.

## How it works

<figure class="recipe-diagram">
<svg viewBox="46 76 1488 582" role="img" aria-labelledby="rd-pdf-report-with-charts-title rd-pdf-report-with-charts-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-pdf-report-with-charts-title">Diagram of the Report with Charts (PDF) workflow</title><desc id="rd-pdf-report-with-charts-desc">Runs Sample Data, then Keys by Cloud, then Keys by Algorithm, then Keys by Age, then HTML Report, then PDF, then Output.</desc><defs><marker id="rd-pdf-report-with-charts-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M260 247 C309 247 309 127 358 127" marker-end="url(#rd-pdf-report-with-charts-arrow)"/><path class="rd-edge" d="M260 247 C309 247 309 367 358 367" marker-end="url(#rd-pdf-report-with-charts-arrow)"/><path class="rd-edge" d="M260 247 C309 247 309 607 358 607" marker-end="url(#rd-pdf-report-with-charts-arrow)"/><path class="rd-edge" d="M550 127 C634 127 634 367 718 367" marker-end="url(#rd-pdf-report-with-charts-arrow)"/><path class="rd-edge" d="M550 367 C634 367 634 367 718 367" marker-end="url(#rd-pdf-report-with-charts-arrow)"/><path class="rd-edge" d="M550 607 C634 607 634 367 718 367" marker-end="url(#rd-pdf-report-with-charts-arrow)"/><path class="rd-edge" d="M910 367 C964 367 964 367 1018 367" marker-end="url(#rd-pdf-report-with-charts-arrow)"/><path class="rd-edge" d="M1210 367 C1264 367 1264 367 1318 367" marker-end="url(#rd-pdf-report-with-charts-arrow)"/><g class="rd-node" data-kind="step" transform="translate(70 220)"><title>Sample Data (set_node)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Sample Data</text><text class="rd-type" x="12" y="40">set_node</text></g><g class="rd-node" data-kind="step" transform="translate(360 100)"><title>Keys by Cloud (chart)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Keys by Cloud</text><text class="rd-type" x="12" y="40">chart</text></g><g class="rd-node" data-kind="step" transform="translate(360 340)"><title>Keys by Algorithm (chart)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Keys by Algorithm</text><text class="rd-type" x="12" y="40">chart</text></g><g class="rd-node" data-kind="step" transform="translate(360 580)"><title>Keys by Age (chart)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Keys by Age</text><text class="rd-type" x="12" y="40">chart</text></g><g class="rd-node" data-kind="step" transform="translate(720 340)"><title>HTML Report (prompt_template)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">HTML Report</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="step" transform="translate(1020 340)"><title>PDF (pdf_output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">PDF</text><text class="rd-type" x="12" y="40">pdf_output</text></g><g class="rd-node" data-kind="step" transform="translate(1320 340)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Sample Data | [`set_node`](/nodes/reference/utility#set-node-—-set-transform) | Step in the run |
| Keys by Cloud | [`chart`](/nodes/reference/output#chart-—-chart) | Step in the run |
| Keys by Algorithm | [`chart`](/nodes/reference/output#chart-—-chart) | Step in the run |
| Keys by Age | [`chart`](/nodes/reference/output#chart-—-chart) | Step in the run |
| HTML Report | [`prompt_template`](/nodes/reference/utility#prompt-template-—-prompt-template) | Step in the run |
| PDF | [`pdf_output`](/nodes/reference/output#pdf-output-—-pdf-output) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

5 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## What a run does

On our install the whole run took about 1.2 seconds. The three charts took 10 to 30 ms each, and the PDF step about 1.1 seconds, most of it starting Chromium. The PDF was 34,859 bytes, two A4 pages titled `Key Inventory Report`: the cloud bar chart and the algorithm donut on page 1, and the age histogram on page 2, below a heading left at the foot of page 1. Add `h2{break-after:avoid}.chart{break-inside:avoid}` to the template's CSS to keep each heading with its chart.

The file name came out as `key-report-.pdf`: its template is <span v-pre>`key-report-{{session_id}}.pdf`</span> and a run without a session has an empty `session_id`. Pass a `session_id`, or use another value in the name.

**Without Chromium.** We pointed `PDF_CHROMIUM_EXECUTABLE_PATH` at a missing file. The three charts and the HTML still rendered, then the **PDF** node failed with `browserType.launch: Failed to launch chromium because executable doesn't exist at ...` and the run ended with an error. Chart rendering never needs the browser; only the HTML-to-PDF step does.

## The chart specs

Each Chart node holds a Vega-Lite spec without data. Vega-Lite describes a chart as a `mark` (bar, arc, line...) and an `encoding` that maps data fields to channels such as `x`, `y`, `theta` and `color`. The node's `dataPath` (`byCloud`, `byAlgorithm`, `ageing`) points at rows from the earlier node and fills in the data. The Set node's values are JSON strings, and the run turned them into arrays of rows.

The age chart sets `"sort": null` on its x axis so the buckets keep their order (`<30d`, `30-90d` and so on) instead of sorting by name. `width` and `height` on the node are defaults; a size in the spec wins. Each chart's `outputKey` (`cloudChart` and so on) holds `svg` and a `dataUrl`. The node also puts `svg`, `dataUrl` and a ready `imgTag` at the top level, but three charts feed one template here and those top-level keys overwrite each other, so the template uses <span v-pre>`{{cloudChart.svg}}`</span> to inline each SVG. See the [Chart node](/nodes/chart) for every field, and use `specTemplate` when the spec itself depends on the data.

## HTML template and PDF output

The **HTML Report** node is a Prompt Template used as an HTML template: a full page with inline CSS and the three SVGs. Nothing in it calls a model. **PDF Output** in `html` render mode reads the `html` key, loads it in Chromium, waits for the network to go quiet (up to 45 seconds) and prints with `printBackground` on and the `A4` page size (`Letter`, `Legal`, `A3` and `A5` also work).

Anything the HTML loads from the web, such as a font or an image URL, goes through the [outbound URL checks](/security/outbound-url-checks). The inline SVGs load nothing. PDF Output also has a `text` mode that writes plain text into a PDF without a browser, but it cannot show charts.

## Add an LLM summary (optional)

To open the report with a written summary, add a Prompt Template after **Sample Data** that asks for a short summary of the rows (for example with <span v-pre>`{{byCloud}}`</span> and <span v-pre>`{{ageing}}`</span>), then an LLM Call, and connect the LLM Call to **HTML Report** next to the charts. Then put its answer into the template as <span v-pre>`{{answer}}`</span>. The model only writes text; the numbers in the charts still come from the data.

## Make it yours

- Replace **Sample Data** with real data: an [HTTP Request](/nodes/reference/connector), a database connector or an MCP tool, as long as the rows reach the charts under the names in `dataPath`. The [branded PDF inventory report](/recipes/key-inventory-pdf-report) does this with an MCP tool and a Python step.
- Brand it: change the colors in the specs (`mark.color`, `scale.scheme`), or pass a Vega `theme` object on each Chart node so every chart shares one style. The [brand extraction recipe](/recipes/brand-extraction-web) finds a site's logo and colors.
- Run it on a schedule with a Schedule Trigger and send the PDF on with an email or storage node.

## Make it safer

These controls are optional; the recipe runs without them.

- If any HTML comes from user input or a model, turn on `OUTBOUND_DENY_PRIVATE` (off by default) so the page cannot load internal URLs: see [outbound URL checks](/security/outbound-url-checks#configuration).
- The PDF travels as base64 inside the run result and is stored with the run, so anyone who can read the run can read the report.

## Further reading

- [Chart node](/nodes/chart)
- [Output nodes reference](/nodes/reference/output)
- [Outbound URL checks](/security/outbound-url-checks)
- [Pattern library](/patterns/)
