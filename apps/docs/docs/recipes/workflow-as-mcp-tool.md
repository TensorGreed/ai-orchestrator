---
title: "Serve an L2M workflow as an MCP tool"
description: "Turn a whole workflow into one MCP tool that agents and IDE clients can call, then serve it from a toolset with its own client token on the MCP gateway."
keys: "none"
keysNote: "No API key"
tags: ["mcp","gateway","agent"]
nodeCount: 5
sample: "workflow-as-mcp-tool-flow.json"
demo: "wf-workflow-as-mcp-tool"
demoRecorded: false
related: ["mcp-server","mcp-gateway","mcp-tool","model-context-protocol"]
---

<!--
  Generated from samples/workflows/workflow-as-mcp-tool-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Serve an L2M workflow as an MCP tool

**What you get:** A workflow that any MCP client can list and call as one tool, `answer_from_kb`, through L2M's MCP gateway.

**Needs:** No API key · **Nodes:** 5

An **Expose as MCP Tool** trigger turns the workflow into a tool named `answer_from_kb`, with one required argument, `question`. Inside, an agent with the echo model and the mock `lookup_kb` tool answers it. Put the workflow in a toolset on the [MCP gateway](/product/mcp-gateway) and any MCP client holding a client token can list the tool and call it; each call runs the whole workflow. It runs with no API key. With echo, the answer is the question repeated back.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/workflow-as-mcp-tool-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&amp;workflowId=wf-workflow-as-mcp-tool" target="_self">Open it in the demo</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/workflow-as-mcp-tool-flow.json" download>workflow-as-mcp-tool-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/workflow-as-mcp-tool-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. In the sidebar, open **MCP → Toolsets**, create a toolset and add the workflow. Its endpoint is `/mcp/<slug>` (we named ours `kb-helper`).
4. Open **MCP → Clients**, create a client for that toolset and copy its token. It is shown once.
5. Call the tool with curl (below), or paste the client's configuration snippet into your MCP client.

## How it works

<figure class="recipe-diagram">
<svg viewBox="56 176 878 282" role="img" aria-labelledby="rd-workflow-as-mcp-tool-title rd-workflow-as-mcp-tool-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-workflow-as-mcp-tool-title">Diagram of the Workflow as MCP Tool workflow</title><desc id="rd-workflow-as-mcp-tool-desc">Runs Expose as MCP Tool, then Agent, then Output. Chat Model (echo) is attached to Agent as its chat model; MCP: lookup_kb is attached to Agent as its tool.</desc><defs><marker id="rd-workflow-as-mcp-tool-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M270 227 C324 227 324 227 378 227" marker-end="url(#rd-workflow-as-mcp-tool-arrow)"/><path class="rd-edge" d="M570 227 C644 227 644 227 718 227" marker-end="url(#rd-workflow-as-mcp-tool-arrow)"/><path class="rd-edge is-port" d="M475 254 C475 317 535 317 535 380"/><path class="rd-edge is-port" d="M475 254 C475 317 755 317 755 380"/><g class="rd-node" data-kind="step" transform="translate(80 200)"><title>Expose as MCP Tool (mcp_server_trigger)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Expose as MCP Tool</text><text class="rd-type" x="12" y="40">mcp_server_trigger</text></g><g class="rd-node" data-kind="agent" transform="translate(380 200)"><title>Agent (agent_orchestrator)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Agent</text><text class="rd-type" x="12" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="model" transform="translate(440 380)"><title>Chat Model (echo) (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Chat Model (echo)</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="tool" transform="translate(660 380)"><title>MCP: lookup_kb (mcp_tool)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">MCP: lookup_kb</text><text class="rd-type" x="12" y="40">mcp_tool</text></g><g class="rd-node" data-kind="step" transform="translate(720 200)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Expose as MCP Tool | [`mcp_server_trigger`](/nodes/reference/input#mcp-server-trigger-—-expose-as-mcp-tool) | Step in the run |
| Agent | [`agent_orchestrator`](/nodes/reference/agent#agent-orchestrator-—-agent-orchestrator) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |
| Chat Model (echo) | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Attached to Agent on its `chat_model` port |
| MCP: lookup_kb | [`mcp_tool`](/nodes/reference/mcp#mcp-tool-—-mcp-tool) | Attached to Agent on its `tool` port |

5 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## Call it with curl

The gateway speaks MCP over Streamable HTTP. With the client token in `TOKEN` and the session id from step 1 in `SESSION`:

```bash
# 1. Open a session. The response carries an Mcp-Session-Id header.
curl -i http://localhost:4000/mcp/kb-helper \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# 2. Call the tool in that session. (List them first with the same request and
#    "method":"tools/list", "params":{}.)
curl http://localhost:4000/mcp/kb-helper \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"answer_from_kb","arguments":{"question":"What is MCP?"}}}'

# 3. End the session.
curl -X DELETE http://localhost:4000/mcp/kb-helper \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION"
```

What came back on our install:

- `initialize`: HTTP 200 with an `mcp-session-id` header and `{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"l2m-kb-helper","title":"KB helper",...}}`.
- `tools/list`: one tool, `answer_from_kb`, with the description and input schema from the trigger.
- `tools/call`: `content` with the workflow output as JSON text, the same object as `structuredContent` (`{"result":"Echo: What is MCP?"}`), and the run's id in `_meta.executionId`.
- `DELETE`: `204 No Content`.

Each call is a full run, listed in the execution history with the trigger type `mcp_gateway`. The gateway speaks MCP protocol versions 2025-11-25, 2025-06-18 and 2025-03-26. An MCP client library or app does these steps for you.

## The sample's legacy routes are public

The trigger also has a `path` (`kb-helper`) and `authMode: "public"`, which serve the older REST routes `GET /api/mcp-server/kb-helper/manifest` and `POST /api/mcp-server/kb-helper/invoke`. On our install both answered without any credentials, and `invoke` ran the workflow. They are not MCP, so MCP clients do not need them: set the trigger's auth mode to `bearer` with a stored secret, or remove the `path`, before you deploy. See [Expose a workflow as an MCP tool](/runtime/workflow-as-mcp-tool#legacy-rest-routes).

## Make it yours

- Change `toolName`, `toolDescription` and `inputSchema` on the trigger. The description is what other agents' models read to decide when to call your tool, so make it specific.
- Replace the agent's echo model with a real one, or replace the agent with a retrieval step and an LLM call, as in the [RAG knowledge base recipe](/recipes/rag-knowledge-base).
- Call it from another L2M instance: register `https://<l2m-host>/mcp/<slug>` there with the `http_mcp` adapter and the client token as a stored secret.

## Make it safer

These controls are optional; the recipe runs without them.

- Give each client only the toolsets it needs, the lowest role that works, and an expiry.
- Add [tool policy](/product/mcp-tool-policy) rules scoped to the client or the toolset, including require-approval rules.
- Cap each client with a [budget](/product/budgets) scoped to **MCP client** and a rate limit on the client.

## Further reading

- [Expose a workflow as an MCP tool](/runtime/workflow-as-mcp-tool)
- [MCP gateway](/product/mcp-gateway)
- [Run a self-hosted MCP gateway](/guides/self-hosted-mcp-gateway)
- [Pattern library](/patterns/)
