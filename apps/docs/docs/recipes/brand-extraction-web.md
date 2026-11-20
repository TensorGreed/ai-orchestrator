---
title: "Extract a brand's name, logo and colors from a website"
description: "Load a web page in headless Chromium, then have an LLM return the brand name, logo URL, colors, font and tagline as JSON. A small web-to-data workflow."
keys: "model"
keysNote: "OpenAI API key and Playwright Chromium"
tags: ["web","extraction","json"]
nodeCount: 6
sample: "branding-extract-flow.json"
related: ["ssrf","indirect-prompt-injection","workflow-dag"]
---

<!--
  Generated from samples/workflows/branding-extract-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Extract a brand's name, logo and colors from a website

**What you get:** A workflow that turns a website URL into one JSON object: brand name, logo URL, primary and accent color, font and tagline.

**Needs:** OpenAI API key and Playwright Chromium · **Time:** 15 minutes · **Nodes:** 6

A **Text Input** holds the URL (`https://example.com` as shipped). **Web Browse** opens it in headless Chromium, waits for the network to go quiet, and extracts the title, text, meta tags, images and a screenshot. A **Prompt Template** puts the title, the description, Open Graph image and theme-color meta tags, the first 10 images and the first 4,000 characters of text into an extraction prompt. An **LLM Call** answers it, an **Output Parser** checks the JSON, and the **Output** returns it. It needs an OpenAI key as shipped and Chromium for Playwright on the API host. Read [what the model really sees](#what-the-model-really-sees) before you rely on colors and fonts.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/branding-extract-flow.json" download>Download the workflow JSON</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/branding-extract-flow.json" download>branding-extract-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/l2m/blob/main/samples/workflows/branding-extract-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Install Chromium for Playwright on the API host once: `pnpm exec playwright install chromium` from the repo root (Playwright itself comes with the workflow engine). Or point `PDF_CHROMIUM_EXECUTABLE_PATH` at a Chromium you already have.
4. Open the **LLM** node and pick a stored secret with your OpenAI API key under **API Key Secret** (or set `OPENAI_API_KEY` on the API server), or switch the provider. Save. Without a key the **LLM** node fails with `Provider openai requires an API key via secretRef or OPENAI_API_KEY`.
5. Run it. A `user_prompt` sent with the run replaces the Text Input's URL, so you can try other sites without editing the workflow. Put an API key from **Settings → Account → API Keys** in `L2M_API_KEY`:

   ```bash
   curl -X POST http://localhost:4000/api/workflows/wf-branding-extract-flow/execute \
     -H "Authorization: Bearer $L2M_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"user_prompt": "https://www.wikipedia.org"}'
   ```
6. Open the run: **Parse JSON** holds the object, and the **Output** returns it as a JSON string in `result`.

## How it works

<figure class="recipe-diagram">
<svg viewBox="46 196 1768 102" role="img" aria-labelledby="rd-brand-extraction-web-title rd-brand-extraction-web-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-brand-extraction-web-title">Diagram of the Brand Extraction (Web Browse) workflow</title><desc id="rd-brand-extraction-web-desc">Runs Brand URL, then Fetch Brand Site, then Extract Branding, then LLM, then Parse JSON, then Output.</desc><defs><marker id="rd-brand-extraction-web-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M260 247 C309 247 309 247 358 247" marker-end="url(#rd-brand-extraction-web-arrow)"/><path class="rd-edge" d="M550 247 C609 247 609 247 668 247" marker-end="url(#rd-brand-extraction-web-arrow)"/><path class="rd-edge" d="M860 247 C919 247 919 247 978 247" marker-end="url(#rd-brand-extraction-web-arrow)"/><path class="rd-edge" d="M1170 247 C1229 247 1229 247 1288 247" marker-end="url(#rd-brand-extraction-web-arrow)"/><path class="rd-edge" d="M1480 247 C1539 247 1539 247 1598 247" marker-end="url(#rd-brand-extraction-web-arrow)"/><g class="rd-node" data-kind="step" transform="translate(70 220)"><title>Brand URL (text_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Brand URL</text><text class="rd-type" x="12" y="40">text_input</text></g><g class="rd-node" data-kind="step" transform="translate(360 220)"><title>Fetch Brand Site (web_browse)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Fetch Brand Site</text><text class="rd-type" x="12" y="40">web_browse</text></g><g class="rd-node" data-kind="step" transform="translate(670 220)"><title>Extract Branding (prompt_template)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Extract Branding</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="model" transform="translate(980 220)"><title>LLM (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">LLM</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(1290 220)"><title>Parse JSON (output_parser)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Parse JSON</text><text class="rd-type" x="12" y="40">output_parser</text></g><g class="rd-node" data-kind="step" transform="translate(1600 220)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Brand URL | [`text_input`](/nodes/reference/input#text-input-—-text-input) | Step in the run |
| Fetch Brand Site | [`web_browse`](/nodes/reference/connector#web-browse-—-web-browse) | Step in the run |
| Extract Branding | [`prompt_template`](/nodes/reference/utility#prompt-template-—-prompt-template) | Step in the run |
| LLM | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Step in the run |
| Parse JSON | [`output_parser`](/nodes/reference/utility#output-parser-—-output-parser) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

6 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## Web Browse: pages that need JavaScript

A plain HTTP request gets the HTML a server sends. Many sites build the page in the browser, so that HTML is nearly empty. [Web Browse](/nodes/web-browse) loads the page in headless Chromium through Playwright, runs its scripts and reads the result. The sample waits for `networkidle`, allows 45 seconds, and uses a 1440 x 900 viewport. Besides the nested `brandSite` object, it puts `url`, `title`, `text`, `html`, `screenshot`, `meta`, `links` and `images` at the top level for the next node. Each call starts and closes its own browser, so keep it to low-volume flows.

Without Chromium the run fails at this node. We pointed `PDF_CHROMIUM_EXECUTABLE_PATH` at a missing file to check: **Fetch Brand Site** failed with `browserType.launch: Failed to launch chromium because executable doesn't exist at ...`, the later nodes were skipped, and the run ended with an error.

## What a run does

We ran it with Chromium installed and no model key. On `https://example.com` the browse step took about 0.9 seconds and returned the title `Example Domain`, the page text and a screenshot, with no images and no Open Graph tags. On `https://www.wikipedia.org` it took about 1.5 seconds and found an `og:image`, a description and a list of image URLs, the Wikipedia logo first. The prompt then held the title, the description, the `og:image` URL, an empty theme color (the page sets none), the images and the first 4,000 of 4,077 characters of text.

- **With the echo provider**, the model only repeats the prompt, so there is nothing real to parse. The parser picked up the image list from the echoed prompt (see below), and the Output returned that list.
- **With a scripted stand-in model** that answers with one JSON object (the page title as `brand`, the `og:image` URL as the logo, empty colors and font), the parser accepted it on the first try, and the Output returned `{"brand":"Wikipedia","primaryLogoUrl":"https://upload.wikimedia.org/...","primaryColor":"",...}` as `result`.

The stand-in shows the plumbing. How well a real model fills in each field depends on the model and the page.

## What the model really sees

The prompt gives the model the page title, three meta tags (`description`, `og:image`, `theme-color`), up to 10 image URLs and up to 4,000 characters of visible text. It does not send the screenshot, the HTML or any CSS, so the model never sees a color or a font on the page. The prompt says so, and asks for a color or font only when the data states it, such as a `theme-color` meta tag, and an empty string otherwise. Expect empty colors on many sites. The brand name, the logo URL and the tagline come from real page data and are the reliable part.

The template reads meta tags with <span v-pre>`{{ meta["og:image"] }}`</span>: a simple path such as `meta.og:image` cannot hold a colon, and would render empty. It trims lists with <span v-pre>`{{ images.slice(0, 10) }}`</span> and <span v-pre>`{{ text.slice(0, 4000) }}`</span>. The browse node keeps the screenshot in the run so you can check the page yourself; set `screenshot: false` if you do not need it.

## Parsing and the final output

The **Parse JSON** node runs in `json_schema` mode with `lenient` parsing: it reads the first JSON value it finds in the reply. The schema requires `brand` and `primaryLogoUrl`. If the value fails the check, the node asks the same model up to 2 more times to fix it, then fails. The checks apply only when the value is an object: an array passes as it is. That is how the echo run passed with the image list. A real model that follows the prompt returns one object, but if it adds a list before the object, the parser takes the list. Check `parserTrace` on the node when the result looks wrong.

The **Output** node's response template is <span v-pre>`{{parsed}}`</span>, so the run returns the object as a JSON string in `result`.

## Outbound URL checks

The URL can come from whoever calls the workflow, so it is checked. Web Browse refuses `file:` URLs, and every request the page makes, including redirects and images, goes through L2M's [outbound URL checks](/security/outbound-url-checks): cloud metadata addresses and link-local ranges are always refused. Private ranges and localhost are allowed by default. Set `OUTBOUND_DENY_PRIVATE=true` if callers must not reach your internal network through this node. Page text is untrusted input: a page can carry instructions aimed at the model, so do not give this workflow tools that act on what a page says.

## Make it yours

- Take the URL from a webhook: replace the Text Input with a [Webhook Input](/nodes/reference/input); the browse node's URL template is already <span v-pre>`{{user_prompt}}`</span>.
- Set `screenshot: false` on the browse node: the prompt does not use it, and it adds a large base64 image to every run.
- Feed the JSON to a report: the [PDF report with charts recipe](/recipes/pdf-report-with-charts) builds an HTML page and a PDF, and can take colors from here.
- Swap OpenAI for another provider on the LLM node.

## Make it safer

These controls are optional; the recipe runs without them.

- Turn on `OUTBOUND_DENY_PRIVATE` and list the internal hosts you do want in `OUTBOUND_ALLOWLIST`: see [outbound URL checks](/security/outbound-url-checks#configuration).
- Cap model spend with a [budget](/product/budgets).
- Read [prompt injection](/learn/security/prompt-injection) before you add tools to any workflow that reads web pages.

## Further reading

- [Web Browse node](/nodes/web-browse)
- [Outbound URL checks](/security/outbound-url-checks)
- [Prompt injection](/learn/security/prompt-injection)
- [Pattern library](/patterns/)
