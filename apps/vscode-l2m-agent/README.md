# L2M Agent VS Code Extension

Interactive coding and data analytics assistant for VS Code backed by L2M webhook workflows. The extension collects bounded workspace context, streams requests to L2M, renders structured assistant output, and lets users approve generated patches or terminal commands.

## Setup

Configure these VS Code settings before sending a prompt:

- `l2mAgent.apiBaseUrl`: L2M API base URL. Defaults to `http://localhost:4000`.
- `l2mAgent.workflowId`: Optional workflow ID for the coding-agent workflow.
- `l2mAgent.authToken`: Bearer API key for authenticated API calls. Create it in L2M Settings -> API Keys, then paste the plaintext key here.
- `l2mAgent.streamResponses`: Uses `/api/webhooks/execute/stream` when enabled.
- `l2mAgent.requestTimeoutMs`: Request timeout for L2M calls.
- `l2mAgent.maxContextChars`: Maximum approximate characters in one context bundle.
- `l2mAgent.maxFileChars`: Maximum characters from one active or pinned file.
- `l2mAgent.maxGitDiffChars`: Maximum characters from git diffs.
- `l2mAgent.maxDiagnostics`: Maximum VS Code diagnostics included.
- `l2mAgent.maxOpenEditors`: Maximum open editor tabs included.
- `l2mAgent.maxPinnedFiles`: Maximum pinned file contents included.
- `l2mAgent.nearbyLineCount`: Lines around the active selection or cursor.
- `l2mAgent.recentTurnCount`: Recent chat turns sent in full.
- `l2mAgent.maxCompactedMemoryChars`: Local compacted memory character limit.

## L2M Workflow

Use Template Gallery -> Agents -> VS Code L2M Coding Agent to create the recommended workflow, then set `l2mAgent.workflowId` to the imported workflow ID.

The extension calls:

```http
POST /api/webhooks/execute/stream
content-type: application/json
authorization: Bearer <api-key>
```

Payload shape:

```json
{
  "workflow_id": "optional-workflow-id",
  "session_id": "vscode:<workspace-hash>",
  "system_prompt": "Extension-controlled operating instructions",
  "user_prompt": "Current user message",
  "variables": {
    "client": "vscode-l2m-agent",
    "workspaceContext": {},
    "sessionMemory": {},
    "conversationTail": [],
    "compactedMemory": "",
    "actionResults": []
  }
}
```

## Output Contract

The target workflow should return an object under `output`, `answer`, or `result`. The parser also accepts common helper-chat fields such as `final_html`, `python_code`, `codes`, `attachments`, `patch`, and `command`.

Preferred response:

```json
{
  "status": "complete",
  "message": "Human-readable assistant response.",
  "actions": [
    {
      "type": "patch",
      "title": "Update API client",
      "file": "src/client.ts",
      "diff": "--- a/src/client.ts\n+++ b/src/client.ts\n@@ -1 +1 @@\n-old\n+new",
      "requiresApproval": true
    },
    {
      "type": "command",
      "title": "Run tests",
      "command": "pnpm test",
      "cwd": ".",
      "requiresApproval": true
    }
  ],
  "codes": [
    {
      "language": "python",
      "label": "nightly-report.py",
      "source": "print('hello')"
    }
  ],
  "attachments": [
    {
      "filename": "report.pdf",
      "mimeType": "application/pdf",
      "downloadUrl": "data:application/pdf;base64,...",
      "sizeBytes": 123
    }
  ],
  "context_update": "Facts to retain for later turns.",
  "follow_up_question": ""
}
```

## Commands

- `L2M Agent: Open Chat`: Opens the chat panel.
- `L2M Agent: New Session`: Clears chat history, compacted memory, pinned files, and action results for the workspace.
- `L2M Agent: Pin Active File`: Adds the current file to future context bundles.
- `L2M Agent: Send Selection`: Opens chat and seeds the draft with selected text.
- `L2M Agent: Reset Memory`: Clears local compacted memory while keeping the visible chat history.

## Safety

Patch actions are single-file unified diffs. The extension resolves target paths against the active workspace folder, rejects traversal outside the workspace, opens a diff preview, and asks for explicit approval before writing files.

Command actions are shown to the user and require explicit approval before the command is sent to a VS Code terminal. The extension records action results and includes recent results in the next L2M context bundle.

## Developer Run

Start the L2M product locally:

```bash
pnpm --filter @ai-orchestrator/api dev
pnpm --filter @ai-orchestrator/web dev
```

Build and test the extension:

```bash
pnpm --filter @ai-orchestrator/vscode-l2m-agent build
pnpm --filter @ai-orchestrator/vscode-l2m-agent test
```

To run in VS Code, open this repository, build the extension, then launch an Extension Development Host from VS Code with `apps/vscode-l2m-agent` as the extension project. Configure `l2mAgent.apiBaseUrl`, `l2mAgent.workflowId`, and `l2mAgent.authToken` in the development host before sending prompts.

## Test Coverage

The unit tests cover:

- Response parsing for messages, code blocks, attachments, actions, and helper-chat compatibility.
- Context budget truncation and session-memory compaction.
- L2M `context_update` merging into local memory.
- Patch path safety, single-file validation, unified diff application, and context mismatch detection.
