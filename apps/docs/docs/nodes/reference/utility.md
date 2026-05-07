<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`
  (or `pnpm docs:build`) to regenerate.
-->

# Utility nodes

DAG control flow: branching, looping, merging, sub-workflows, code execution, set/wait.

40 nodes.

---
### `aggregate_node` — Aggregate

Groups items and aggregates a numeric/text field (sum, avg, min, max, count, concatenate).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `sum` \| `avg` \| `min` \| `max` \| `count` \| `concatenate` |
| `field` | `string` | no | — |
| `groupBy` | `string` | no | — |
| `inputKey` | `string` | no | — |
| `separator` | `string` | no | — |

**Example config**

```json
{
  "operation": "sum",
  "field": "amount",
  "inputKey": "items"
}
```

---

### `chat_intent_router` — Chat Intent Router

Routes helper-chat requests into report, code, message, or missing-context branches without custom Switch conditions.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `inputTemplate` | `string` | no | — |
| `intentKey` | `string` | no | — |
| `artifactPath` | `string` | no | — |
| `requireArtifactForCode` | `boolean` | no | — |
| `reportKeywords` | `string` | no | — |
| `codeKeywords` | `string` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "inputTemplate": "{{user_prompt}}",
  "intentKey": "parsed.intent",
  "artifactPath": "latest_report",
  "requireArtifactForCode": false,
  "reportKeywords": "report, pdf, dashboard, chart, analytics, summary, visualize",
  "codeKeywords": "python, code, script, automate, nightly, regenerate, reproduce, without ai, without l2m",
  "outputKey": "intent"
}
```

---

### `code_node` — Code Node

Runs custom JavaScript transformation logic in a sandboxed VM context.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `code` | `string` | yes | — |
| `timeout` | `number` | no | — |

**Example config**

```json
{
  "timeout": 1500,
  "code": "const name = String(input.user_prompt ?? 'World');\nconst upper = name.toUpperCase();\nconsole.log('Transformed prompt to uppercase');\nreturn { transformed: upper, length: upper.length };"
}
```

---

### `compare_datasets_node` — Compare Datasets

Diffs two datasets by a key field and reports added/removed/changed/same items.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `inputA` | `string` | yes | — |
| `inputB` | `string` | yes | — |
| `keyField` | `string` | yes | — |

**Example config**

```json
{
  "inputA": "datasetA",
  "inputB": "datasetB",
  "keyField": "id"
}
```

---

### `compression_node` — Compression

Gzip / gunzip data using node:zlib. Zip/unzip not yet supported.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `gzip` \| `gunzip` \| `zip` \| `unzip` |
| `data` | `string` | no | — |
| `encoding` | `string` | no | `utf8` \| `base64` |

**Example config**

```json
{
  "operation": "gzip",
  "data": "hello",
  "encoding": "utf8"
}
```

---

### `convert_to_file_node` — Convert to File

Convert data to CSV, JSON, HTML, or text file output.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `format` | `string` | yes | `csv` \| `json` \| `html` \| `text` |
| `filename` | `string` | no | — |
| `inputKey` | `string` | no | — |
| `data` | `any` | no | — |

**Example config**

```json
{
  "format": "json",
  "filename": "out.json",
  "inputKey": "items"
}
```

---

### `crypto_node` — Crypto

Hash, HMAC, encrypt, decrypt, sign, verify using node:crypto.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `hash` \| `hmac` \| `encrypt` \| `decrypt` \| `sign` \| `verify` \| `random` |
| `algorithm` | `string` | no | — |
| `key` | `string` | no | — |
| `iv` | `string` | no | — |
| `data` | `string` | no | — |
| `encoding` | `string` | no | `hex` \| `base64` \| `utf8` |
| `signature` | `string` | no | — |
| `bytes` | `number` | no | — |

**Example config**

```json
{
  "operation": "hash",
  "algorithm": "sha256",
  "data": "hello",
  "encoding": "hex"
}
```

---

### `date_time_node` — Date & Time

Format, parse, add/subtract or compare dates using built-in Date and Intl.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `format` \| `parse` \| `add` \| `subtract` \| `compare` \| `now` |
| `value` | `string` | no | — |
| `format` | `string` | no | — |
| `unit` | `string` | no | `ms` \| `second` \| `minute` \| `hour` \| `day` \| `week` \| `month` \| `year` |
| `amount` | `number` | no | — |
| `compareTo` | `string` | no | — |
| `timezone` | `string` | no | — |

**Example config**

```json
{
  "operation": "format",
  "value": "{{now}}",
  "format": "iso"
}
```

---

### `edit_fields_node` — Edit Fields

Adds, modifies, removes or renames fields on items.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operations` | `array<object>` | yes | — |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "operations": [
    {
      "op": "set",
      "field": "active",
      "value": true
    },
    {
      "op": "remove",
      "field": "tmp"
    }
  ]
}
```

---

### `edit_image_node` — Edit Image

Image editing (resize/crop/rotate/text/watermark). Requires optional native dependency — currently not implemented in core.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `resize` \| `crop` \| `rotate` \| `text` \| `watermark` |
| `data` | `string` | no | — |
| `width` | `number` | no | — |
| `height` | `number` | no | — |
| `rotateDegrees` | `number` | no | — |
| `text` | `string` | no | — |

**Example config**

```json
{
  "operation": "resize",
  "width": 100,
  "height": 100
}
```

---

### `execute_workflow` — Execute Workflow

Executes another workflow as a reusable sub-workflow.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `workflowId` | `string` | yes | — |
| `inputMapping` | `object` | no | — |
| `mode` | `string` | no | `sync` \| `async` |
| `outputMapping` | `object` | no | — |

**Example config**

```json
{
  "workflowId": "",
  "inputMapping": {
    "user_prompt": "user_prompt",
    "session_id": "session_id"
  },
  "mode": "sync",
  "outputMapping": {}
}
```

---

### `extract_from_file_node` — Extract from File

Parse CSV, JSON, or XML strings/base64 into structured data.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `format` | `string` | yes | `csv` \| `json` \| `xml` \| `pdf` \| `excel` |
| `data` | `string` | no | — |
| `encoding` | `string` | no | `utf8` \| `base64` |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "format": "csv",
  "data": "a,b\n1,2",
  "encoding": "utf8"
}
```

---

### `filter_node` — Filter

Evaluates conditions against context data and routes to pass or filtered branches.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `conditions` | `array<object>` | no | — |
| `combineWith` | `string` | no | `AND` \| `OR` |
| `passMode` | `string` | no | `pass` \| `reject` |

**Example config**

```json
{
  "conditions": [
    {
      "field": "status",
      "operator": "eq",
      "value": "active"
    }
  ],
  "combineWith": "AND",
  "passMode": "pass"
}
```

---

### `html_node` — HTML

Extract data from HTML via simple CSS-like selectors, or generate HTML.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `extract` \| `generate` |
| `html` | `string` | no | — |
| `selectors` | `array<object>` | no | — |
| `template` | `string` | no | — |

**Example config**

```json
{
  "operation": "extract",
  "html": "<div class='title'>Hi</div>",
  "selectors": [
    {
      "key": "title",
      "selector": ".title"
    }
  ]
}
```

---

### `human_approval` — Human Approval

Pauses execution and waits for a human approve/reject action before resuming.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `approvalMessage` | `string` | yes | — |
| `timeoutMinutes` | `number` | yes | — |

**Example config**

```json
{
  "approvalMessage": "Approve before sending this response to the customer?",
  "timeoutMinutes": 60
}
```

---

### `if_node` — IF

Evaluates a condition and routes execution to the true or false branch.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `condition` | `string` | yes | — |
| `trueLabel` | `string` | no | — |
| `falseLabel` | `string` | no | — |

**Example config**

```json
{
  "condition": "{{answer}}",
  "trueLabel": "True",
  "falseLabel": "False"
}
```

---

### `input_validator` — Input Validator

Validates input fields against deterministic rules before downstream execution.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `rules` | `array<object>` | yes | — |
| `onFail` | `string` | yes | `error` \| `branch` |

**Example config**

```json
{
  "rules": [
    {
      "field": "email",
      "check": "required",
      "value": ""
    },
    {
      "field": "message",
      "check": "max_length",
      "value": "1200"
    }
  ],
  "onFail": "branch"
}
```

---

### `jwt_node` — JWT

Sign, decode, verify JWTs (HS256/HS384/HS512). HMAC-only, no external library.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `sign` \| `decode` \| `verify` |
| `secret` | `string` | no | — |
| `payload` | `object` | no | — |
| `token` | `string` | no | — |
| `algorithm` | `string` | no | `HS256` \| `HS384` \| `HS512` |
| `expiresInSeconds` | `number` | no | — |

**Example config**

```json
{
  "operation": "sign",
  "secret": "shh",
  "algorithm": "HS256",
  "payload": {
    "sub": "user1"
  }
}
```

---

### `limit_node` — Limit

Caps an array of items to N entries from the start or end.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `maxItems` | `number` | yes | — |
| `keep` | `string` | no | `first` \| `last` |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "maxItems": 10,
  "keep": "first",
  "inputKey": "items"
}
```

---

### `local_memory` — Simple Memory

SQLite-backed session memory that can be attached to an Agent Orchestrator node.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `namespace` | `string` | no | — |
| `sessionIdTemplate` | `string` | no | — |
| `maxMessages` | `number` | no | — |
| `persistToolMessages` | `boolean` | no | — |

**Example config**

```json
{
  "namespace": "default",
  "sessionIdTemplate": "{{session_id}}",
  "maxMessages": 20,
  "persistToolMessages": false
}
```

---

### `loop_node` — Loop / ForEach

Iterates over an input array and executes direct downstream nodes once per item.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `inputKey` | `string` | yes | — |
| `itemVariable` | `string` | yes | — |
| `maxIterations` | `number` | no | — |

**Example config**

```json
{
  "inputKey": "documents",
  "itemVariable": "item",
  "maxIterations": 100
}
```

---

### `merge_node` — Merge / Join

Merges outputs from multiple parent branches after fan-in.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `mode` | `string` | yes | `append` \| `combine_by_key` \| `choose_branch` |
| `combineKey` | `string` | no | — |

**Example config**

```json
{
  "mode": "append",
  "combineKey": "id"
}
```

---

### `noop_node` — No Operation

Pass-through node that performs no operation. Useful as a placeholder or visual marker.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `label` | `string` | no | — |

**Example config**

```json
{
  "label": "Placeholder"
}
```

---

### `output_guardrail` — Output Guardrail

Validates and optionally retries model output when guardrail checks fail.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `checks` | `array<string>` | yes | — |
| `onFail` | `string` | yes | `retry` \| `error` |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "checks": [
    "no_pii",
    "must_contain_json"
  ],
  "onFail": "retry",
  "inputKey": "answer"
}
```

---

### `output_parser` — Output Parser

Validates and transforms LLM output into structured data using JSON Schema, item list parsing, or auto-fix retry.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `mode` | `string` | yes | `json_schema` \| `item_list` \| `auto_fix` |
| `parsingMode` | `string` | no | `strict` \| `lenient` \| `anything_goes` |
| `jsonSchema` | `string` | no | — |
| `itemSeparator` | `string` | no | — |
| `maxRetries` | `number` | no | — |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "mode": "json_schema",
  "parsingMode": "strict",
  "jsonSchema": "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"},\"sentiment\":{\"type\":\"string\",\"enum\":[\"positive\",\"negative\",\"neutral\"]}},\"required\":[\"name\",\"sentiment\"]}",
  "maxRetries": 2,
  "inputKey": "answer"
}
```

---

### `prompt_template` — Prompt Template

Builds a prompt using handlebars-style placeholders.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `template` | `string` | yes | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "template": "Context: {{context}}\n\nQuestion: {{user_prompt}}",
  "outputKey": "prompt"
}
```

---

### `remove_duplicates_node` — Remove Duplicates

Removes duplicate items by all or specified fields.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `fields` | `array<string>` | no | — |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "fields": [
    "id"
  ],
  "inputKey": "items"
}
```

---

### `rename_keys_node` — Rename Keys

Renames keys on items in an array (or single object).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `renames` | `array<object>` | yes | — |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "renames": [
    {
      "from": "old",
      "to": "new"
    }
  ],
  "inputKey": "items"
}
```

---

### `session_artifact_load` — Session Artifact Load

Loads an exact JSON artifact saved for the current session, such as a prior report payload.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `namespace` | `string` | no | — |
| `sessionIdTemplate` | `string` | no | — |
| `artifactKey` | `string` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "namespace": "default",
  "sessionIdTemplate": "{{session_id}}",
  "artifactKey": "latest_report",
  "outputKey": "artifact"
}
```

---

### `session_artifact_save` — Session Artifact Save

Saves an exact JSON artifact for the current session so later turns can reuse it deterministically.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `namespace` | `string` | no | — |
| `sessionIdTemplate` | `string` | no | — |
| `artifactKey` | `string` | no | — |
| `valueKey` | `string` | no | — |
| `valueTemplate` | `string` | no | — |
| `fields` | `array<object>` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "namespace": "default",
  "sessionIdTemplate": "{{session_id}}",
  "artifactKey": "latest_report",
  "fields": [
    {
      "key": "final_html",
      "valueKey": "parsed.final_html"
    },
    {
      "key": "python_code",
      "valueKey": "parsed.python_code"
    },
    {
      "key": "chart_data",
      "valueKey": "parsed.chart_data"
    }
  ],
  "outputKey": "saved_artifact"
}
```

---

### `set_node` — Set / Transform

Builds a structured output object from key/template assignments.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `assignments` | `array<object>` | no | — |

**Example config**

```json
{
  "assignments": [
    {
      "key": "customerId",
      "valueTemplate": "{{webhook.customer.id}}"
    },
    {
      "key": "status",
      "valueTemplate": "active"
    },
    {
      "key": "metadata",
      "valueTemplate": "{\"source\":\"workflow\",\"index\":{{_loop_index}}}"
    }
  ]
}
```

---

### `sort_node` — Sort

Sorts items ascending, descending, randomly, or by custom expression.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `field` | `string` | no | — |
| `order` | `string` | no | `asc` \| `desc` \| `random` |
| `expression` | `string` | no | — |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "field": "name",
  "order": "asc",
  "inputKey": "items"
}
```

---

### `split_out_node` — Split Out

Splits an array field into multiple items.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `field` | `string` | yes | — |
| `destinationField` | `string` | no | — |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "field": "items",
  "destinationField": "item"
}
```

---

### `sticky_note` — Sticky Note

A visual-only annotation on the canvas (markdown supported). Not executed by the runtime.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `content` | `string` | no | — |
| `color` | `string` | no | `yellow` \| `blue` \| `green` \| `pink` \| `purple` \| `gray` |
| `fontSize` | `number` | no | — |

**Example config**

```json
{
  "content": "## Note\nExplain what this section of the workflow does.",
  "color": "yellow",
  "fontSize": 14
}
```

---

### `stop_and_error` — Stop and Error

Immediately stops the workflow with a custom error message and code.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `message` | `string` | no | — |
| `errorCode` | `string` | no | — |

**Example config**

```json
{
  "message": "Validation failed: {{error_message}}",
  "errorCode": "VALIDATION_ERROR"
}
```

---

### `summarize_node` — Summarize

Multi-field aggregate (pivot-like). Supports group-by and multiple aggregations per group.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `fieldsToSummarize` | `array<object>` | yes | — |
| `fieldsToGroupBy` | `array<string>` | no | — |
| `inputKey` | `string` | no | — |

**Example config**

```json
{
  "fieldsToSummarize": [
    {
      "field": "amount",
      "aggregation": "sum"
    }
  ],
  "fieldsToGroupBy": [
    "region"
  ],
  "inputKey": "items"
}
```

---

### `switch_node` — Switch

Routes execution to one of several branches based on a matched value.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `switchValue` | `string` | yes | — |
| `cases` | `array<object>` | yes | — |
| `defaultLabel` | `string` | no | — |

**Example config**

```json
{
  "switchValue": "{{sentiment}}",
  "cases": [
    {
      "value": "positive",
      "label": "positive"
    },
    {
      "value": "negative",
      "label": "negative"
    }
  ],
  "defaultLabel": "default"
}
```

---

### `try_catch` — Try / Catch

Wraps downstream execution in a try/catch block. Routes to an error branch on failure.

**Config fields**

_No configurable fields._

**Example config**

```json
{}
```

---

### `wait_node` — Wait / Delay

Pauses execution for a bounded amount of time before continuing.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `delayMs` | `number` | no | — |
| `maxDelayMs` | `number` | no | — |
| `resumeMode` | `string` | no | `timer` \| `webhook` \| `datetime` |
| `resumeWebhookPath` | `string` | no | — |
| `resumeAt` | `string` | no | — |

**Example config**

```json
{
  "delayMs": 1000,
  "maxDelayMs": 30000,
  "resumeMode": "timer"
}
```

---

### `xml_node` — XML

Convert XML to JSON or JSON to XML using a built-in lightweight parser.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `toJson` \| `toXml` |
| `data` | `any` | no | — |

**Example config**

```json
{
  "operation": "toJson",
  "data": "<root><item>1</item></root>"
}
```
