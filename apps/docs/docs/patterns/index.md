# Pattern library

Battle-tested topologies you can crib from when designing a workflow. Each pattern names the problem it solves, sketches the topology, points to a runnable sample, and calls out the sharp edges. Patterns are ordered roughly by how often they appear in real deployments.

Every sample lives under [`samples/workflows/`](https://github.com/TensorGreed/ai-orchestrator/tree/main/samples/workflows) and is auto-seeded into a fresh install when `SEED_SAMPLE_WORKFLOWS=true` is in your `.env`. Open the **Templates** panel in Studio, search by name, click **Use template**, and run it.

::: tip Zero-key first
Patterns marked **zero-key** boot end-to-end on a fresh install with no LLM credentials, no Ollama, and no external services. They use the bundled `echo` provider and the in-process `mock-mcp` adapter so you can verify the topology before swapping in real models and real MCP servers.
:::

---

## 1. Zero-key MCP agent (start here)

**Problem**: You want to verify the agent runtime + MCP tool-calling loop end-to-end before paying for an LLM key.

**Topology**:
```
Manual Trigger ──▶ Agent ──▶ Output
                    │
                    ├── chat_model: echo
                    ├── tool: MCP get_current_time (mock)
                    └── tool: MCP calculator (mock)
```

**Sample**: `MCP Agent Quickstart` — see the [5-minute tutorial](/getting-started/build-your-first-mcp-agent) for the full walkthrough.

**Sharp edges**: the `echo` provider doesn't actually reason — the agent loop runs but tool selection won't be intelligent. Swap to a real provider once you've seen the trace.

---

## 2. Webhook → Agent → MCP tools (the agentic SaaS pattern)

**Problem**: An external system (your app, a chatbot, a CRM, a CI hook) wants to send a payload and get back an agent-generated answer that may have called real tools along the way.

**Topology**:
```
Webhook Input ──▶ Agent ──▶ Output (HTTP response)
                    │
                    ├── chat_model: <real LLM>
                    ├── memory:    Simple Memory (per session_id)
                    └── tool:      one or more MCP Tool nodes
```

**Sample**: `Agentic MCP + Memory Webhook Flow` (`agentic-mcp-flow.json`).

**Sharp edges**:
- Pick an `authMode` on the Webhook Input node — `none` is fine for internal subnet calls but `bearer_token` or `hmac_sha256` is mandatory on the public internet. See [secure webhooks](/security/secure-webhooks).
- The `session_id` field threads memory across calls. Without it, every call is amnesiac.
- If the agent calls slow MCP tools, bump `WORKFLOW_EXECUTION_TIMEOUT_MS` in `.env`.

---

## 3. Supervisor + Worker swarm (multi-agent topology)

**Problem**: One generalist agent makes mediocre decisions across many domains. You want specialists per domain plus a coordinator that decides who handles what.

**Topology**:
```
Manual Trigger ──▶ Supervisor ──▶ Output
                       │
                       ├── chat_model: <coordinator LLM>
                       ├── worker: Agent (specialist A) ── chat_model + tools
                       └── worker: Agent (specialist B) ── chat_model + tools
```

The Supervisor sees each worker as a synthetic tool — it issues a "delegate to worker A" call, gets back the worker's final answer, and integrates results into its own reply. Workers can have completely different tool sets, system prompts, and even different models.

**Sample**: `Supervisor + Worker Swarm` (`supervisor-worker-swarm-flow.json`) — a researcher worker (knowledge-base lookup) and a computer worker (math + time), both backed by mock-mcp.

**Sharp edges**:
- Set `maxIterations` on the Supervisor higher than on workers — a Supervisor turn often spans multiple worker calls.
- Workers see only the prompt the Supervisor delegated, not the original user prompt. Have your Supervisor prompt template include enough context.
- Recursion stops at L2M's `MAX_SUB_WORKFLOW_DEPTH` (default 10). Don't build supervisor pyramids.

---

## 4. Workflow exposed as an MCP tool (compose-by-MCP)

**Problem**: You built a useful workflow (e.g. "answer from our internal knowledge base") and want other agents — including non-L2M ones in your IDE or in another runtime — to call it as a tool.

**Topology**:
```
Expose as MCP Tool ──▶ Agent (or any DAG) ──▶ Output
       (mcp_server_trigger)
```

The `mcp_server_trigger` node serves a manifest at `GET /api/mcp-server/<path>/manifest` and accepts calls at `POST /api/mcp-server/<path>/invoke`. Any MCP-compatible client wires it in by URL.

**Sample**: `Workflow as MCP Tool` (`workflow-as-mcp-tool-flow.json`) — exposes a knowledge-base helper at `kb-helper`. Test it with:

```bash
curl http://localhost:4000/api/mcp-server/kb-helper/manifest
curl -X POST http://localhost:4000/api/mcp-server/kb-helper/invoke \
  -H "content-type: application/json" \
  -d '{"question":"what is mcp?"}'
```

**Sharp edges**:
- `authMode: "public"` is fine for localhost; switch to `bearer` and supply a `secretRef` before exposing on the network.
- Downstream nodes receive the tool's input arguments as their input — design `inputSchema` on the trigger to match.
- Agent → workflow → agent recursion is bounded by `MAX_SUB_WORKFLOW_DEPTH`.

See the [workflow-as-MCP-tool runtime page](/runtime/workflow-as-mcp-tool) for the full request/response contract.

---

## 5. RAG with vector retrieval

**Problem**: An agent that needs to ground its answers in your private corpus (PDFs, Confluence dump, codebase, support tickets).

**Topology**:
```
Webhook Input ──▶ Embedder ──▶ Vector Retriever ──▶ Prompt Template ──▶ LLM Call ──▶ Output
                                  (Qdrant/Pinecone/in-memory)
```

The Vector Retriever returns the top-K matching chunks; Prompt Template stitches them into the user prompt as context.

**Samples**:
- `RAG Flow` (`rag-flow.json`) — Google Drive loader + in-memory vector store.
- `RAG Pinecone Flow` (`rag-pinecone-flow.json`) — Pinecone-backed.

**Sharp edges**:
- Embedding cost dominates first-time indexing. Cache aggressively.
- Retrieval recall is the failure mode that matters; instrument top-K hit rate per query type.
- For citation, include the chunk's source metadata in the Prompt Template — don't ask the LLM to invent it.

---

## 6. Conditional branching from a webhook

**Problem**: A webhook can carry several different intents (Slack slash command, GitHub issue event, payment status). You want one workflow that branches to the right downstream path.

**Topology**:
```
Webhook Input ──▶ Conditional ──▶ Branch A ──▶ ...
                       │
                       └────────▶ Branch B ──▶ ...
```

**Sample**: `Conditional Flow` (`conditional-flow.json`).

**Sharp edges**:
- Use a Set node before the Conditional to extract the discriminating field — keeps the Conditional config short.
- Each branch is a separate DAG path; if you need them to converge, end with a Merge node.

---

## 7. Multi-turn helper with session artifacts

**Problem**: A multi-turn chat where one early turn produces a structured artifact (a generated report, a parsed schema, a tool plan) and later turns must reference the *exact* artifact, not an LLM-paraphrased summary.

**Topology**:
```
Webhook Input ──▶ Chat Intent Router ──▶ {first-turn DAG ──▶ Session Artifact Save}
                                        OR
                                        {follow-up DAG ──▶ Session Artifact Load ──▶ ... }
```

`Session Artifact Save` writes JSON keyed by `(namespace, session_id, artifact_key)`; `Session Artifact Load` retrieves it verbatim. Survives across requests.

**Sample**: `Two-Turn Report + Code Helper` (`two-turn-report-code-helper-flow.json`) — first turn writes an MCP-backed report; follow-up turns load it byte-for-byte and pass it to a Python code node.

**Sharp edges**:
- The artifact_key is per-session, so a single workflow can store multiple distinct artifact slots per session.
- Don't store secrets in artifacts — they're plaintext in the DB. Use the SecretService for credentials.

---

## 8. Structured output extraction

**Problem**: You want the LLM's output as parseable JSON (e.g. `{ "category": ..., "confidence": ..., "rationale": ... }`) instead of prose.

**Topology**:
```
Input ──▶ Prompt Template ──▶ LLM Call ──▶ Output Parser ──▶ Output
```

The Output Parser node validates the LLM response against a Zod-style schema and emits the typed payload as `parsed` for downstream nodes.

**Sample**: `Structured Output Flow` (`structured-output-flow.json`).

**Sharp edges**:
- Use the model provider's native structured-output mode if available (OpenAI's `response_format: json_schema`, Anthropic's tool use). Falls back to schema-guided text parsing otherwise.
- Be ready to retry. Even strict modes fail occasionally on edge inputs.

---

## 9. VS Code coding-agent surface

**Problem**: You want a coding agent that lives inside the editor, can read repo files, propose patches with workspace-path safety, and run commands behind an approval gate.

**Topology**:
```
Webhook Input (from VS Code extension) ──▶ Agent ──▶ Output (structured patches/commands)
                                              │
                                              ├── chat_model
                                              ├── memory
                                              └── tool: MCP filesystem / git / etc.
```

**Sample**: `VS Code L2M Coding Agent Flow` (`vscode-l2m-coding-agent-flow.json`) — the canonical wiring for the [L2M VS Code extension](/getting-started/vscode-extension).

**Sharp edges**:
- Patch actions are sandboxed to the workspace root by the extension; the workflow doesn't need to enforce path safety itself, but should validate that destinations stay relative.
- Command actions go through user approval in the IDE; design your prompts so the agent doesn't ratchet up to risky shell calls without obvious justification.

---

## 10. Cloud-LLM with Azure OpenAI

**Problem**: You're on Azure, your security team requires the LLM call to go through your Azure OpenAI deployment (private endpoint, AAD auth, region pinning).

**Topology**:
```
Input ──▶ Prompt Template ──▶ Azure OpenAI Chat Model ──▶ Output
```

Same shape as a basic flow, but the LLM Call is replaced with the dedicated Azure OpenAI node so credentials, deployment name, and API version are first-class fields.

**Sample**: `Azure OpenAI Flow` (`azure-openai-flow.json`).

**Sharp edges**:
- Azure deployment names are not OpenAI model names. Set the deployment, not `gpt-4o-mini`.
- Use `SecretService` for the API key and AAD client secret — never paste them into node config.
- Region pinning matters for data-residency compliance; pin via the endpoint URL.

---

## What's not here

- **Approval-gated tool calls** — use a Wait node downstream of the Agent's tool output to pause for human approval. No bundled sample yet; PRs welcome.
- **Streaming responses to the client** — webhook responses are buffered. For SSE/streaming, use the dedicated chat trigger and reach for the [helper chat page](/getting-started/quickstart) as a starting point.
- **Long-running batch workflows** — the queue + DLQ + leader election machinery is in place but the batch-runner pattern is still a one-off. Document yours in an issue if you build one.
