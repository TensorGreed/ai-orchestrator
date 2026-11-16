---
title: "Use Azure OpenAI in a self-hosted workflow"
description: "Call an Azure OpenAI deployment from an L2M workflow, with the API key stored as an encrypted secret and only its id in the workflow file."
keys: "services"
keysNote: "An Azure OpenAI resource, deployment and key"
tags: ["azure","model","secrets"]
nodeCount: 4
sample: "azure-openai-flow.json"
related: ["secret-reference","master-key","openai-compatible-api","llm-gateway"]
---

<!--
  Generated from samples/workflows/azure-openai-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Use Azure OpenAI in a self-hosted workflow

**What you get:** A workflow that sends a prompt to your Azure OpenAI deployment, with the key held by L2M's secret store, never in the workflow.

**Needs:** An Azure OpenAI resource, deployment and key · **Time:** 10 minutes · **Nodes:** 4

A **Text Input** and a **Prompt Template** build the prompt, the **Azure OpenAI Chat Model** node sends it to your deployment, and the **Output** returns the answer. The node has fields for the resource endpoint, the deployment name, the API version (`2024-10-21` as shipped) and the key, which is a reference to a stored secret. The workflow file holds only the secret's id. You need an Azure OpenAI resource with a chat deployment; there is no keyless way to run this one.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/azure-openai-flow.json" download>Download the workflow JSON</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/azure-openai-flow.json" download>azure-openai-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/azure-openai-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Store the key as a secret. In the node's config, open **Azure OpenAI Secret** and choose **+ Add New Credential...** (the provider is already set to Azure OpenAI), name it and paste the key. Or use the API (below).
4. On the **Azure OpenAI Chat Model** node, set **Endpoint** to `https://<your-resource>.openai.azure.com`, **Deployment** to your deployment's name (not the model's name, unless you named it after the model) and pick the secret under **Azure OpenAI Secret**. Save.
5. Run it. The answer is in the run's output as `result`.

## How it works

<figure class="recipe-diagram">
<svg viewBox="56 116 1168 102" role="img" aria-labelledby="rd-azure-openai-workflow-title rd-azure-openai-workflow-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-azure-openai-workflow-title">Diagram of the Azure OpenAI Basic Flow workflow</title><desc id="rd-azure-openai-workflow-desc">Runs Text Input, then Prompt Template, then Azure OpenAI Chat Model, then Output.</desc><defs><marker id="rd-azure-openai-workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M270 167 C314 167 314 167 358 167" marker-end="url(#rd-azure-openai-workflow-arrow)"/><path class="rd-edge" d="M550 167 C624 167 624 167 698 167" marker-end="url(#rd-azure-openai-workflow-arrow)"/><path class="rd-edge" d="M890 167 C949 167 949 167 1008 167" marker-end="url(#rd-azure-openai-workflow-arrow)"/><g class="rd-node" data-kind="step" transform="translate(80 140)"><title>Text Input (text_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Text Input</text><text class="rd-type" x="12" y="40">text_input</text></g><g class="rd-node" data-kind="step" transform="translate(360 140)"><title>Prompt Template (prompt_template)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Prompt Template</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="model" transform="translate(700 140)"><title>Azure OpenAI Chat Model (azure_openai_chat_model)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Azure OpenAI Chat Model</text><text class="rd-type" x="12" y="40">azure_openai_chat_model</text></g><g class="rd-node" data-kind="step" transform="translate(1010 140)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Text Input | [`text_input`](/nodes/reference/input#text-input-—-text-input) | Step in the run |
| Prompt Template | [`prompt_template`](/nodes/reference/utility#prompt-template-—-prompt-template) | Step in the run |
| Azure OpenAI Chat Model | [`azure_openai_chat_model`](/nodes/reference/llm#azure-openai-chat-model-—-azure-openai-chat-model) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

4 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## Store the key as a secret

```bash
# An API key with builder rights, from Settings → Account → API Keys.
curl -X POST http://localhost:4000/api/secrets \
  -H "Authorization: Bearer $L2M_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "azure-openai-prod", "provider": "azure_openai", "value": "<your-azure-openai-key>", "projectId": "<your-project>"}'
```

The answer holds the secret's `id` (`sec_...`) and never the value; no API returns the value again. It is encrypted at rest with AES-256-GCM under `SECRET_MASTER_KEY_BASE64`. Without `projectId` the secret lands in the default project and the answer carries a warning saying so. See [Secrets](/security/secrets).

The value can be the raw key, or JSON such as `{"apiKey": "..."}` (or `accessToken`). L2M sends it in the `api-key` header. A value with three dot-separated parts, or starting with `Bearer `, is sent as `Authorization: Bearer ...` instead, for Microsoft Entra ID tokens. L2M does not fetch or refresh such tokens itself.

## What a run does

We had no Azure resource, so we ran the sample two ways on a fresh install.

**As shipped**, the run fails at the Azure node: `Provider azure_openai requires an API key via secretRef or AZURE_OPENAI_API_KEY.` The placeholder secret id does not exist, and a missing secret does not fail on its own: the node falls back to the server's `AZURE_OPENAI_API_KEY`. If that is set, a workflow with a wrong secret id quietly uses the server's key.

**Against a local stand-in** for the Azure endpoint, with a stored secret, the node sent one request to `POST /openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21` with the key in the `api-key` header. The body held the prompt as the only message (the sample has no System Prompt node, so no system message is sent), `temperature: 0.2`, `max_tokens: 1024` and `stream: true` with `stream_options.include_usage`. The answer came back as `result`, and the node recorded the token usage the endpoint reported. With a key the endpoint refused, the run failed with `Provider azure_openai stream request failed (401): ...` and the endpoint's own message.

A real Azure endpoint was not called, so this page does not show Azure's own errors, content filtering or quotas.

## Costs

Workflow runs record tokens for Azure calls but no cost: the built-in price list has no Azure prices for runs, so Azure spend does not count toward a USD [budget](/product/budgets). To price it, add your deployment to `LLM_PRICING_OVERRIDES_JSON` under the provider id `azure_openai`, keyed by the deployment name, for example `{"azure_openai":{"gpt-4o-mini":{"inputUsdPer1M":0.15,"outputUsdPer1M":0.6}}}` (use your contract's prices).

## Serve the deployment to other apps (optional)

The node calls Azure directly from the workflow. To let applications outside L2M use the same deployment with L2M's client tokens, budgets and audit, add a route on the [/v1 AI gateway](/product/ai-gateway): provider `azure_openai`, the deployment name as the upstream model, your endpoint as the base URL and the same stored secret as the key. Apps then call `POST /v1/chat/completions` with a public model name. Unlike workflow runs, `/v1` traffic to a deployment named `gpt-4o` or `gpt-4o-mini` is priced by default. The gateway is off until you add a route set.

## Make it yours

- Add a **System Prompt** node before the Azure node; it reads `system_prompt`.
- Use the same node as the chat model of an agent, on its `chat_model` port.
- For embeddings, use the **Embeddings Azure OpenAI** node or the `azure-openai-embedder` in RAG Retrieve.

## Make it safer

These controls are optional; the recipe runs without them.

- Keep one secret per environment and per project, and share a default-project secret with other projects only on purpose: see [project scope](/security/secrets#project-scope).
- Restrict which deployments workflows may call with a [model allowlist](/security/model-allowlists).

## Further reading

- [Azure nodes](/nodes/azure-nodes)
- [Secrets](/security/secrets)
- [/v1 AI gateway](/product/ai-gateway)
- [Pattern library](/patterns/)
