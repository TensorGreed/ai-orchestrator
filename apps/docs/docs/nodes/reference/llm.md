<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`
  (or `pnpm docs:build`) to regenerate.
-->

# LLM nodes

Chat-completion model adapters and prompt-template helpers.

15 nodes.

---
### `ai_gateway_chat_model` — AI Gateway Chat Model

Calls a corporate AI gateway using OpenAI-compatible, OpenAI, or Anthropic protocol.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `apiProvider` | `string` | yes | `openai_compatible` \| `openai` \| `anthropic` |
| `baseUrl` | `string` | yes | — |
| `model` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `temperature` | `number` | no | — |
| `maxTokens` | `number` | no | — |
| `enableThinking` | `boolean` | no | — |
| `thinkingTokens` | `number` | no | — |
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |

**Example config**

```json
{
  "apiProvider": "openai_compatible",
  "baseUrl": "https://llm.company.example/v1",
  "model": "claude-haiku-4-5-20251001",
  "temperature": 0.2,
  "maxTokens": 1024,
  "enableThinking": false,
  "thinkingTokens": 1024,
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt"
}
```

---

### `ai_transform` — AI Transform

Transform data using natural language instructions. The LLM generates and applies a transformation based on your description.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `instruction` | `string` | yes | — |
| `inputKey` | `string` | no | — |
| `outputFormat` | `string` | no | `text` \| `json` \| `code` |

**Example config**

```json
{
  "instruction": "Convert this data to a markdown table",
  "inputKey": "text",
  "outputFormat": "text"
}
```

---

### `anthropic_chat_model` — Anthropic Chat Model

Calls Anthropic Claude models with an API key or ANTHROPIC_API_KEY.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `baseUrl` | `string` | no | — |
| `model` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `temperature` | `number` | no | — |
| `maxTokens` | `number` | no | — |
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |

**Example config**

```json
{
  "model": "claude-3-5-sonnet-latest",
  "temperature": 0.2,
  "maxTokens": 1024,
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt"
}
```

---

### `azure_openai_chat_model` — Azure OpenAI Chat Model

Calls Azure OpenAI chat/completions using deployment + API version.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `endpoint` | `string` | yes | — |
| `deployment` | `string` | yes | — |
| `apiVersion` | `string` | no | — |
| `secretRef` | `object` | yes | — |
| `temperature` | `number` | no | — |
| `maxTokens` | `number` | no | — |
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |

**Example config**

```json
{
  "endpoint": "https://my-azure-openai.openai.azure.com",
  "deployment": "gpt-4o-mini",
  "apiVersion": "2024-10-21",
  "temperature": 0.2,
  "maxTokens": 1024,
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt"
}
```

---

### `basic_llm_chain` — Basic LLM Chain

Simple prompt-to-response chain with configurable system and user prompt templates.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |
| `outputFormat` | `string` | no | `text` \| `json` |

**Example config**

```json
{
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt",
  "outputFormat": "text"
}
```

---

### `google_gemini_chat_model` — Google Gemini Chat Model

Calls Google Gemini chat completions using an API key.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `model` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `temperature` | `number` | no | — |
| `maxTokens` | `number` | no | — |
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |

**Example config**

```json
{
  "model": "gemini-2.5-flash",
  "temperature": 0.2,
  "maxTokens": 1024,
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt"
}
```

---

### `information_extractor` — Information Extractor

Extracts structured information from text based on a configurable schema.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `textKey` | `string` | no | — |
| `extractionSchema` | `string` | no | — |

**Example config**

```json
{
  "textKey": "text",
  "extractionSchema": "{ \"name\": \"string\", \"email\": \"string\", \"company\": \"string\" }"
}
```

---

### `llm_call` — LLM Call

Executes a model completion call.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `provider` | `object` | yes | — |
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |

**Example config**

```json
{
  "provider": {
    "providerId": "ollama",
    "model": "llama3.1",
    "baseUrl": "http://localhost:11434/v1"
  },
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt"
}
```

---

### `ollama_chat_model` — Ollama Chat Model

Calls a local Ollama model through its OpenAI-compatible API.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `baseUrl` | `string` | no | — |
| `model` | `string` | yes | — |
| `temperature` | `number` | no | — |
| `maxTokens` | `number` | no | — |
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |

**Example config**

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "llama3.1",
  "temperature": 0.2,
  "maxTokens": 1024,
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt"
}
```

---

### `openai_chat_model` — OpenAI Chat Model

Calls OpenAI chat models with an API key or OPENAI_API_KEY.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `baseUrl` | `string` | no | — |
| `model` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `temperature` | `number` | no | — |
| `maxTokens` | `number` | no | — |
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |

**Example config**

```json
{
  "model": "gpt-4o-mini",
  "temperature": 0.2,
  "maxTokens": 1024,
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt"
}
```

---

### `openai_compatible_chat_model` — OpenAI Compatible Chat Model

Calls any OpenAI-compatible chat API such as OpenRouter, Groq, vLLM, or LM Studio.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `baseUrl` | `string` | yes | — |
| `model` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `temperature` | `number` | no | — |
| `maxTokens` | `number` | no | — |
| `promptKey` | `string` | no | — |
| `systemPromptKey` | `string` | no | — |

**Example config**

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "model": "local-model",
  "temperature": 0.2,
  "maxTokens": 1024,
  "promptKey": "prompt",
  "systemPromptKey": "system_prompt"
}
```

---

### `qa_chain` — Q&A Chain

Answers questions using provided context documents. Returns answer with source citations.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `contextKey` | `string` | no | — |
| `questionKey` | `string` | no | — |
| `maxContextLength` | `number` | no | — |

**Example config**

```json
{
  "contextKey": "context",
  "questionKey": "question",
  "maxContextLength": 4000
}
```

---

### `sentiment_analysis` — Sentiment Analysis

Analyzes sentiment of input text. Returns sentiment label, confidence score, and explanation.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `textKey` | `string` | no | — |

**Example config**

```json
{
  "textKey": "text"
}
```

---

### `summarization_chain` — Summarization Chain

Summarizes input text with configurable length and style.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `textKey` | `string` | no | — |
| `maxLength` | `number` | no | — |
| `style` | `string` | no | `brief` \| `detailed` \| `bullet_points` \| `executive` |

**Example config**

```json
{
  "textKey": "text",
  "maxLength": 500,
  "style": "brief"
}
```

---

### `text_classifier` — Text Classifier

Classifies input text into one of the configured categories.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `textKey` | `string` | no | — |
| `categories` | `string` | no | — |
| `multiLabel` | `boolean` | no | — |

**Example config**

```json
{
  "textKey": "text",
  "categories": "positive, negative, neutral",
  "multiLabel": false
}
```
