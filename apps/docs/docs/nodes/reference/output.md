<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`
  (or `pnpm docs:build`) to regenerate.
-->

# Output nodes

Terminal nodes that shape the workflow's response payload.

5 nodes.

---
### `chart` — Chart

Renders a Vega-Lite chart spec to SVG (server-side, no browser). Pair with pdf_output for branded reports. The same spec format Altair / Streamlit / Observable / Vega Editor use, so an LLM can produce specs directly.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `spec` | `object` | no | — |
| `specTemplate` | `string` | no | — |
| `dataPath` | `string` | no | — |
| `width` | `number` | no | — |
| `height` | `number` | no | — |
| `theme` | `string` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "spec": {
    "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
    "mark": "bar",
    "encoding": {
      "x": {
        "field": "category",
        "type": "nominal"
      },
      "y": {
        "field": "count",
        "type": "quantitative"
      }
    }
  },
  "dataPath": "results",
  "width": 480,
  "height": 300,
  "outputKey": "chart"
}
```

---

### `helper_chat_response` — Helper Chat Response

Packages report HTML, code blocks, and file attachments into the response shape helper-chat understands.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `statusKey` | `string` | no | — |
| `finalHtmlKey` | `string` | no | — |
| `pythonCodeKey` | `string` | no | — |
| `followUpQuestionKey` | `string` | no | — |
| `messageKey` | `string` | no | — |
| `chartDataKey` | `string` | no | — |
| `artifactContextKey` | `string` | no | — |
| `pdfKey` | `string` | no | — |
| `includePdfAttachment` | `boolean` | no | — |
| `codeLanguage` | `string` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "statusKey": "parsed.status",
  "finalHtmlKey": "parsed.final_html",
  "pythonCodeKey": "parsed.python_code",
  "followUpQuestionKey": "parsed.follow_up_question",
  "messageKey": "parsed.message",
  "chartDataKey": "parsed.chart_data",
  "artifactContextKey": "parsed.artifact_context",
  "pdfKey": "pdf",
  "includePdfAttachment": true,
  "codeLanguage": "python",
  "outputKey": "answer"
}
```

---

### `output` — Output

Formats final workflow output payload.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `responseTemplate` | `string` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "responseTemplate": "{{answer}}",
  "outputKey": "result"
}
```

---

### `pdf_output` — PDF Output

Generates a downloadable PDF link from upstream content (plain text or HTML rendering).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `renderMode` | `string` | no | `text` \| `html` |
| `inputKey` | `string` | no | — |
| `textTemplate` | `string` | no | — |
| `htmlTemplate` | `string` | no | — |
| `pageFormat` | `string` | no | `A4` \| `Letter` \| `Legal` \| `A3` \| `A5` |
| `printBackground` | `boolean` | no | — |
| `htmlRenderTimeoutMs` | `number` | no | — |
| `filenameTemplate` | `string` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "renderMode": "text",
  "inputKey": "answer",
  "textTemplate": "",
  "htmlTemplate": "<html><body><h1>{{title}}</h1><div>{{answer}}</div></body></html>",
  "pageFormat": "A4",
  "printBackground": true,
  "htmlRenderTimeoutMs": 45000,
  "filenameTemplate": "workflow-output-{{session_id}}.pdf",
  "outputKey": "pdf"
}
```

---

### `webhook_response` — Webhook Response

Overrides the outgoing webhook HTTP response (status, headers, and body).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `statusCode` | `number` | no | — |
| `headersTemplate` | `string` | no | — |
| `bodyTemplate` | `string` | no | — |

**Example config**

```json
{
  "statusCode": 200,
  "headersTemplate": "{\n  \"content-type\": \"application/json\"\n}",
  "bodyTemplate": "{\"ok\":true,\"result\":\"{{result}}\"}"
}
```
