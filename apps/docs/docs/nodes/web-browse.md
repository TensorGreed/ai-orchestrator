---
# Render `{{...}}` literally — they're workflow-template markers, not Vue interpolations.
---

<div v-pre>

# Web Browse Node

The `web_browse` node drives a headless Chromium (via Playwright) to fetch a URL, wait for JS to execute, and extract structured page data: rendered HTML, page text, screenshot, title, meta tags, links, and images.

Use it whenever `http_request` can't see the page — single-page apps, content hidden behind client-side rendering, sites that require viewport-based layout calculations — or whenever an LLM needs to reason about a page's *actual* look (e.g. extracting branding).

Browser binaries must be installed once: `pnpm exec playwright install chromium` (same Chromium the existing `pdf_output` node uses).

## Config

| Field | Type | Description |
|---|---|---|
| `url` | string | Target URL. Required (or `urlTemplate`). |
| `urlTemplate` | string | Templated alternative — `{{...}}` resolved against upstream context. |
| `waitUntil` | enum | `"load"` / `"domcontentloaded"` / `"networkidle"` / `"commit"`. Default `domcontentloaded`. Use `networkidle` for SPAs that hydrate after the initial HTML lands. |
| `timeoutMs` | number | Total navigation + extraction timeout. Default 30000. |
| `userAgent` | string | Custom UA string. |
| `viewportWidth` / `viewportHeight` | number | Default 1280×800. Larger viewport → larger screenshot, larger HTML for some responsive sites. |
| `extraHeadersJson` | string | JSON object of extra HTTP headers (auth tokens, etc.). |
| `screenshot` | boolean / `"fullPage"` | Default `true` (captures viewport). `"fullPage"` captures the entire scrollable page. `false` skips entirely (smallest output, fastest). |
| `extractText` | boolean | Run `document.body.innerText`. Default true. |
| `extractLinks` | boolean | Collect `<a href>` elements. Default true. Capped at 500 to bound output. |
| `extractImages` | boolean | Collect `<img src>` elements. Default true. Capped at 200. |
| `waitForSelector` | string | CSS selector to wait for before extraction. Use for SPAs where `domcontentloaded` fires before the real content lands. |
| `outputKey` | string | Where to nest the page object. Default `"page"`. |

## Output

```json
{
  "page": {
    "url": "https://example.com",
    "finalUrl": "https://www.example.com/",
    "status": 200,
    "title": "Example Domain",
    "html": "<!DOCTYPE html>...",
    "text": "Example Domain. This domain is for use in...",
    "meta": {
      "description": "Example domain for documentation",
      "og:title": "Example",
      "og:image": "https://example.com/cover.png",
      "twitter:card": "summary_large_image"
    },
    "linkTags": [
      { "rel": "icon", "href": "/favicon.ico", "type": "image/x-icon" },
      { "rel": "canonical", "href": "https://www.example.com/", "type": null }
    ],
    "links": [
      { "href": "https://...", "text": "About", "rel": "nofollow" }
    ],
    "images": [
      { "src": "https://images.example.com/logo.png", "alt": "Logo", "width": 200, "height": 80 }
    ],
    "screenshot": "data:image/png;base64,...",
    "durationMs": 1247
  },
  "url": "https://www.example.com/",
  "title": "Example Domain",
  "text": "Example Domain. This domain is for use in...",
  "html": "<!DOCTYPE html>...",
  "screenshot": "data:image/png;base64,...",
  "meta": { ... },
  "links": [ ... ],
  "images": [ ... ]
}
```

`outputKey` lets you customize the nested key. The most-used fields (`url`, `title`, `text`, `html`, `screenshot`, `meta`, `links`, `images`) are also mirrored at the top level so downstream `prompt_template` nodes can reference them without nesting.

## Examples

### Brand-asset extraction (the CipherTrust scenario)

```json
{
  "type": "web_browse",
  "config": {
    "urlTemplate": "{{brandUrl}}",
    "waitUntil": "networkidle",
    "screenshot": true,
    "viewportWidth": 1440,
    "viewportHeight": 900
  }
}
```

Pair with a `prompt_template` + `llm_call` to extract structured branding data. Full sample at [samples/workflows/branding-extract-flow.json](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/branding-extract-flow.json).

### Lean text extraction (no screenshot)

```json
{
  "type": "web_browse",
  "config": {
    "url": "https://docs.example.com/api",
    "screenshot": false,
    "extractLinks": false,
    "extractImages": false
  }
}
```

Use for "fetch this docs page and answer a question about it" workflows where the screenshot bloats the LLM context budget.

### Wait for a SPA to hydrate

```json
{
  "type": "web_browse",
  "config": {
    "url": "https://app.example.com/dashboard",
    "waitUntil": "networkidle",
    "waitForSelector": "[data-loaded='true']",
    "timeoutMs": 60000
  }
}
```

`waitForSelector` is the reliable way to handle apps that report `networkidle` before their actual content lands.

## Security: protocol allowlist

Only `http`, `https`, and `data:` URLs are accepted. `file://` is explicitly blocked — letting workflow authors drive the headless browser at arbitrary local files would expose the API host's filesystem to anyone with workflow-edit access. (Standard SSRF threat model; same reasoning as the audit-export file-root sandbox.)

Localhost and private-network http(s) URLs are *allowed* — use cases include local dev and intra-cluster scraping. A hardening follow-up could add a `WEB_BROWSE_URL_ALLOWLIST` env var if operators need to restrict targets.

## Tradeoffs

- **Slow per call.** Launching Chromium adds ~500–800ms of overhead before the actual navigation. A persistent browser pool would cut that materially; out of scope for the MVP since most workflows visit one URL per execution. If you visit many URLs, batch them into a `loop_node` or accept the per-iteration cost.
- **Memory-heavy.** Each invocation spawns a new browser process. Not suitable for high-RPS scenarios — keep `web_browse` to lower-volume report / extraction flows.
- **Screenshot bloat.** A 1440×900 PNG base64 is ~80–200 KB. Set `screenshot: false` for high-volume text-extraction flows.
- **No JS execution.** We don't expose `page.evaluate()` — workflow authors can't run arbitrary scripts on the target page. This is intentional (security + reproducibility); a separate `web_eval` node could expose it later for trusted use cases.
- **No form filling / clicking.** Single-pass fetch only. Multi-step flows (login, click-through, extract) would warrant a richer `web_session` node — also a reasonable follow-up.

</div>
