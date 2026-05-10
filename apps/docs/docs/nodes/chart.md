---
# Render `{{...}}` literally — they're workflow-template markers, not Vue interpolations.
---

<div v-pre>

# Chart Node

The `chart` node renders a [Vega-Lite](https://vega.github.io/vega-lite/) spec to SVG, server-side, with no browser. Pair it with `pdf_output` for branded reports, or drop the SVG directly into a `prompt_template` HTML body for an emailable summary.

Vega-Lite is the same JSON dialect used by Altair (Python), Streamlit, Observable, and the Vega Editor — operators can paste specs verbatim, and any LLM that knows the format can produce specs directly.

## Config

| Field | Type | Description |
|---|---|---|
| `spec` | object | Vega-Lite top-level spec. Required (or `specTemplate`). |
| `specTemplate` | string | Alternative to `spec` — a `{{...}}`-templated string that resolves to a JSON spec at runtime. Use when the spec itself depends on upstream data. |
| `dataPath` | string | Path into the workflow context to pull rows from (e.g. `"results.byCloud"`). Replaces `spec.data.values`. Ignored when `spec.data.url` or `spec.data.name` is set. |
| `width` | number | Default chart width in px. Spec-level `width` wins if set. |
| `height` | number | Default chart height in px. Spec-level `height` wins if set. |
| `theme` | object | Vega config block (background colour, axis style, etc.). Useful for consistent branding across many charts. |
| `outputKey` | string | Where on the node output to nest the chart (default `"chart"`). |

## Output

```json
{
  "chart": {
    "svg": "<svg ...>...</svg>",
    "dataUrl": "data:image/svg+xml;base64,..."
  },
  "svg": "<svg ...>...</svg>",
  "dataUrl": "data:image/svg+xml;base64,...",
  "imgTag": "<img src=\"data:image/svg+xml;base64,...\" alt=\"chart\" />"
}
```

`outputKey` lets you customize the nested key (the example above uses `"chart"`). Top-level `svg` / `dataUrl` / `imgTag` are always populated for convenience — drop `imgTag` straight into a Prompt Template's HTML body.

## Examples

### Bar chart from upstream data

```json
{
  "type": "chart",
  "config": {
    "spec": {
      "mark": "bar",
      "encoding": {
        "x": { "field": "category", "type": "nominal" },
        "y": { "field": "count", "type": "quantitative" }
      }
    },
    "dataPath": "byCloud",
    "width": 400,
    "height": 240
  }
}
```

### Pie / arc with brand color scheme

```json
{
  "type": "chart",
  "config": {
    "spec": {
      "mark": { "type": "arc", "innerRadius": 50 },
      "encoding": {
        "theta": { "field": "count", "type": "quantitative" },
        "color": {
          "field": "algorithm",
          "type": "nominal",
          "scale": { "scheme": "blues" }
        }
      }
    },
    "dataPath": "byAlgorithm"
  }
}
```

### Composing into a PDF report

Wire `chart` → `prompt_template` → `pdf_output`. The Prompt Template body references the chart's `svg` (or `imgTag`) field:

```html
<h2>Keys by Cloud Provider</h2>
<div class="chart">{{cloudChart.svg}}</div>
```

The full pattern is in [samples/workflows/report-with-charts-flow.json](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/report-with-charts-flow.json) — three charts (bar / arc / age-bucket) merged into one branded HTML report and rendered to PDF.

## When the spec is dynamic

Two approaches:

1. **Static spec, dynamic data** — keep `spec` static and use `dataPath` to inject upstream rows. Best for the common case (same chart shape, different data).
2. **Dynamic spec via `specTemplate`** — when *the spec itself* depends on runtime data (e.g. you don't know the field names yet). The string is rendered with the standard `{{...}}` template engine, then `JSON.parse`'d.

Prefer approach 1; reach for `specTemplate` only when the schema of the data isn't known until runtime.

## Tradeoffs

- **SVG only.** PNG output would need `node-canvas` (native bindings, platform-fragile). SVG embeds cleanly into HTML and renders crisply at any size; the existing `pdf_output` node already runs Chromium and rasterizes the SVG to the final PDF. PNG is the obvious follow-up if a non-Chromium consumer needs it.
- **Render time scales with data size.** Vega's render is CPU-bound. For >50k data points, downsample upstream first (a `code_execution` or `set_node` aggregating into bucket counts).
- **No interactivity.** Output SVG is static — no Vega tooltips / pan-zoom in the rendered output. For interactive dashboards, use the spec's `dataUrl` in a browser-side embed instead.

</div>
