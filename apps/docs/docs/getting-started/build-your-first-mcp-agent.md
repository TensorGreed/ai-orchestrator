# Build your first MCP agent in 5 minutes

This is the shortest path from a fresh clone to an agent that calls real tools via the [Model Context Protocol](https://modelcontextprotocol.io/). No API keys, no Ollama, no setup.

By the end you'll have:
- L2M running locally with a Studio UI at `http://localhost:5173`.
- A working multi-tool agent that calls MCP tools (`get_current_time`, `calculator`) on your prompts.
- A clear next step for swapping the bundled echo provider for a real LLM and the in-process mock MCP server for a real one (filesystem, git, postgres, etc.).

## 0. Prerequisites

- Node.js 20+
- pnpm 10+

## 1. Clone and install (≈ 60 s)

```bash
git clone https://github.com/TensorGreed/ai-orchestrator.git
cd ai-orchestrator
pnpm install
```

## 2. Configure (≈ 20 s)

Generate a master key for secret encryption:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Create a `.env`:

```bash
cp .env.example .env
```

Open `.env` and set:

```
SECRET_MASTER_KEY_BASE64=<paste the key from above>
BOOTSTRAP_ADMIN_EMAIL=you@example.com
BOOTSTRAP_ADMIN_PASSWORD=ChangeMe123!
SEED_SAMPLE_WORKFLOWS=true
```

You don't need to set `OPENAI_API_KEY`, `OLLAMA_BASE_URL`, or anything else for this tutorial.

## 3. Run (≈ 60 s for first cold start)

```bash
pnpm dev
```

Wait for the API to log `listening on 4000` and the Web UI to log `Local: http://localhost:5173/`, then open `http://localhost:5173` in your browser and log in with the admin credentials from your `.env`.

## 4. Open the MCP Agent Quickstart template (≈ 30 s)

In the Studio:
1. Click **Templates** in the top nav.
2. Filter by category **Getting Started**.
3. Open **MCP Agent Quickstart** and click **Use template**.

What you should see on the canvas:

```
Manual Trigger ──▶ Agent ──▶ Output
                    │
                    ├── chat_model: Chat Model (echo)
                    ├── tool:       MCP: get_current_time
                    └── tool:       MCP: calculator
```

The three nodes hanging off the agent are **attachment ports**, not DAG steps — the agent runtime consumes them at execution time. See [the agent loop](/runtime/agent-loop) for the mental model.

## 5. Run it (≈ 30 s)

Click the **Run** button in the top-right of the canvas. In the dialog:

```
user_prompt: What time is it in UTC, and what is 12 times 7?
```

Click **Run**.

Open the **Execution history** panel (left sidebar). The most recent run shows:

- Manual Trigger → success
- Agent → success
- MCP: get_current_time → success (called by the agent, with the model's chosen `tz` argument)
- MCP: calculator → success (with `expression: "12*7"`)
- Output → success

Click the agent node to inspect the iteration trace: you'll see the model's tool-call requests and the tool responses interleaved. The bundled `echo` provider is not a real LLM, so it doesn't actually reason — but the runtime still drives the tool-calling loop, which is what we want to verify.

## 6. Make it real

You have two swaps to make. Both take a minute.

### Swap the chat model for a real LLM

In Studio: open the **Chat Model (echo)** node, change the **Provider** dropdown from `echo` to `openai` (or `anthropic`, `gemini`, `ollama`).

For OpenAI:
1. **Settings → Secrets → New** → name `OPENAI_API_KEY`, provider `openai`, paste your key.
2. Back on the node, set **Model** to `gpt-4o-mini` and pick the secret you just created.
3. Save the workflow and re-run with the same prompt.

You'll see the model actually reason about which tools to call, in what order, with what arguments — instead of the echo placeholder.

### Swap the mock MCP for a real MCP server

The `mock-mcp` adapter is in-process and ships with three demo tools. To plug in a community MCP server (e.g. `@modelcontextprotocol/server-filesystem` for filesystem access):

1. Replace one of the `MCP: …` nodes with a new **MCP Tool** node.
2. Set the connection:
    - **Transport**: `stdio`
    - **Command**: `npx`
    - **Args**: `["-y", "@modelcontextprotocol/server-filesystem", "/path/to/your/safe/dir"]`
3. Click **Test connection** — Studio will spawn the server, list its tools, and let you pick one.
4. Save and re-run with a prompt like `List files in the project root and tell me which ones look like documentation.`

That's the whole loop: visual workflow + agent runtime + MCP tool calls. See [the MCP integration page](/extensions/mcp) for transport options and best practices, and [agent loop](/runtime/agent-loop) for the iteration semantics.

## What if it didn't work

- Browser shows "blank page" or "API unreachable" → make sure both the API (`pnpm --filter @ai-orchestrator/api dev`) and Web (`pnpm --filter @ai-orchestrator/web dev`) processes are running. `pnpm dev` runs both, but your terminal needs to stay open.
- Login fails → the `BOOTSTRAP_ADMIN_*` env vars only seed the admin user on first boot when the user table is empty. If you've already logged in once with different credentials, those persist in `apps/api/data/orchestrator.db`. Delete the file and restart to re-seed.
- Templates panel is empty → set `SEED_SAMPLE_WORKFLOWS=true` in `.env` and restart. Seeding only runs when the workflow table is empty.
- Anything else → see [common issues](/troubleshooting/common-issues) or open an issue on [GitHub](https://github.com/TensorGreed/ai-orchestrator/issues).
