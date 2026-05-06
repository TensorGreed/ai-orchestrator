# VS Code Agent Extension

The L2M VS Code extension turns any L2M workflow into a coding agent inside the editor. Streaming chat, structured patch previews with workspace-path safety, command approval, and bounded context bundling — backed by a workflow you own and can edit visually.

## What you get

- A sidebar **L2M Agent** view with persistent chat per workspace.
- Streaming responses via `POST /api/webhooks/execute/stream` (SSE).
- Bounded context bundling: active file, selection, open tabs, diagnostics, git state, pinned files. Configurable budgets.
- Structured action handling: code blocks render with copy/insert, suggested file patches preview before apply with workspace-path validation, suggested commands run only after explicit approval in a VS Code terminal.
- Local session memory with deterministic compaction — older turns get summarised, recent turns sent in full.

## Install (development build)

Until the extension ships to the Marketplace, install the `.vsix` directly.

### From CI

Every CI run on `main` produces a `vscode-l2m-agent-vsix` workflow artifact. Download the latest one from the [Actions tab](https://github.com/TensorGreed/ai-orchestrator/actions), unzip, and:

```bash
code --install-extension vscode-l2m-agent.vsix
```

### From source

```bash
pnpm install
pnpm --filter ./apps/vscode-l2m-agent build
pnpm --filter ./apps/vscode-l2m-agent run package
code --install-extension apps/vscode-l2m-agent/vscode-l2m-agent.vsix
```

## Connect it to your L2M instance

The extension talks to L2M over the standard webhook routes (no special server changes needed). You'll wire up three things:

1. **Pick or import a workflow** — the easiest start is the bundled VS Code Coding Agent template.
2. **Mint an API key** so the extension can authenticate.
3. **Configure the extension** to point at your API and the workflow.

### 1. Import the VS Code Coding Agent template

Open the L2M web UI → **Templates** → click **Use Template** on **VS Code L2M Coding Agent Flow** (in the **Agents** category). Save it. Note the resulting workflow ID (visible in the editor URL or the workflow header).

The template implements the full structured-response contract the extension expects: `message`, `actions[]` (patch + command), `codes[]`, `attachments[]`, `context_update`, `follow_up_question`. It uses the built-in echo provider by default — replace the LLM Call provider with OpenAI / Anthropic / Ollama once you've verified the wiring.

### 2. Mint an API key

In the L2M web UI: **Settings** → **API Keys** → **Create**. Copy the full key (`ao_<prefix>.<secret>`) — it's only shown once.

### 3. Configure the extension

`Cmd/Ctrl + ,` to open VS Code Settings, search for **L2M Agent**. Set:

| Setting | Value |
|---|---|
| `l2mAgent.apiBaseUrl` | `http://localhost:4000` (or wherever your L2M API runs) |
| `l2mAgent.workflowId` | The workflow ID from step 1 |
| `l2mAgent.authToken` | The API key from step 2 |
| `l2mAgent.streamResponses` | `true` (recommended) |

`workflowId` is optional — leaving it blank falls back to looking up a workflow by `l2mAgent.webhookPath` (default `vscode-l2m-agent`).

### 4. Open the chat

Click the **L2M Agent** icon in the Activity Bar (left rail). Type a message in the sidebar chat. You'll see streaming progress events, then the assistant's response. Code blocks come with copy/insert buttons; patch and command actions show a preview before anything touches your workspace.

## Commands

| Command | Description |
|---|---|
| `L2M Agent: Open Chat` | Reveal the sidebar chat |
| `L2M Agent: New Session` | Clear visible chat history and reset session memory |
| `L2M Agent: Pin Active File` | Attach the current file to subsequent context bundles |
| `L2M Agent: Send Selection` | Send the current editor selection as a chat message |
| `L2M Agent: Reset Memory` | Clear the local compacted-memory cache (keeps chat history) |

## Context budget tuning

The extension truncates predictably to fit a model's context. The defaults are conservative; raise these if you have a large-context model (Claude, GPT-4o):

- `l2mAgent.maxContextChars` — total approximate chars sent per request (default 60000)
- `l2mAgent.maxFileChars` — per active or pinned file (default 12000)
- `l2mAgent.maxGitDiffChars` — per git diff (default 20000)
- `l2mAgent.maxDiagnostics` — max VS Code diagnostics included (default 50)
- `l2mAgent.recentTurnCount` — recent turns sent in full before older turns are summarised (default 12)

Lower these for small-context local models (8B Llama, etc.).

## Safety model

By design:

- **No file edit happens without explicit user approval.** Every patch action shows a preview with the diff and the target file path. Approval is a modal dialog, not a notification toast.
- **Patches cannot write outside the workspace.** Paths are validated against the workspace root; absolute paths and `..` segments are rejected.
- **Commands are visible and approved before execution.** The agent's suggested command renders in the chat with a Run button; clicking it runs in a VS Code terminal you can watch. The extension never auto-runs.

## Troubleshooting

**Streaming hangs or times out** — bump `l2mAgent.requestTimeoutMs`. The extension enforces this on the full stream, not just the initial response.

**"Workflow not found" in the chat** — the configured `workflowId` doesn't exist on the connected instance. Open the L2M web UI → Workflows and re-copy the ID.

**401 / 403 on every send** — the API key is missing, mistyped, or revoked. Re-create one in Settings → API Keys and re-paste.

**Patch preview shows the wrong content** — the workflow returned a malformed diff. The extension only applies single-file unified diffs; complex multi-file patches are out of scope. Tighten the system prompt in your workflow to constrain the output.

## What it isn't

- It does not call OpenAI/Anthropic/etc. directly. The agent's reasoning lives in the L2M workflow you point it at — swap models server-side without touching the extension.
- It does not give the workflow unrestricted filesystem access. Only the bounded context bundle is sent; the extension is a client, not a runtime.
- It does not run shell commands automatically. Approval is required.

## Related

- [Why L2M?](../why) — the agent-composability story the extension plugs into
- [Expose a Workflow as an MCP Tool](../runtime/workflow-as-mcp-tool) — the inverse direction (other agents calling your L2M workflows)
