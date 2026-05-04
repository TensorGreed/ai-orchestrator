import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { getL2MAgentConfig } from "./config";
import { L2MClient } from "./l2mClient";
import type { ExtensionToWebviewMessage, WebviewMessage } from "./protocol";

const SESSION_ID_KEY = "l2mAgent.sessionId";
const PINNED_FILES_KEY = "l2mAgent.pinnedFiles";

export function activate(context: vscode.ExtensionContext) {
  const sessionStore = new SessionStore(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("l2mAgent.openChat", () => {
      L2MAgentChatPanel.show(context.extensionUri, sessionStore);
    }),
    vscode.commands.registerCommand("l2mAgent.newSession", async () => {
      const sessionId = await sessionStore.rotateSession();
      L2MAgentChatPanel.show(context.extensionUri, sessionStore);
      L2MAgentChatPanel.current?.postSystemMessage(`Started new session: ${sessionId}`);
      void vscode.window.showInformationMessage("L2M Agent session reset.");
    }),
    vscode.commands.registerCommand("l2mAgent.pinActiveFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("Open a file before pinning it for L2M Agent context.");
        return;
      }

      const pinned = await sessionStore.pinFile(editor.document.uri);
      L2MAgentChatPanel.current?.postSystemMessage(`Pinned file: ${pinned}`);
      void vscode.window.showInformationMessage(`Pinned ${pinned} for L2M Agent context.`);
    }),
    vscode.commands.registerCommand("l2mAgent.sendSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("Open a file and select text before sending selection to L2M Agent.");
        return;
      }

      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        void vscode.window.showWarningMessage("Select text before sending it to L2M Agent.");
        return;
      }

      const relativePath = workspaceRelativePath(editor.document.uri);
      const draft = `Review this selection from ${relativePath}:\n\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``;
      L2MAgentChatPanel.show(context.extensionUri, sessionStore, draft);
    })
  );
}

export function deactivate() {
  // No background resources in Phase 1.
}

class SessionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSessionId(): string {
    const existing = this.context.workspaceState.get<string>(SESSION_ID_KEY);
    if (existing) {
      return existing;
    }

    const next = this.createSessionId();
    void this.context.workspaceState.update(SESSION_ID_KEY, next);
    return next;
  }

  async rotateSession(): Promise<string> {
    const next = this.createSessionId();
    await this.context.workspaceState.update(SESSION_ID_KEY, next);
    return next;
  }

  getPinnedFiles(): string[] {
    return this.context.workspaceState.get<string[]>(PINNED_FILES_KEY, []);
  }

  async pinFile(uri: vscode.Uri): Promise<string> {
    const relative = workspaceRelativePath(uri);
    const pinned = this.getPinnedFiles();
    if (!pinned.includes(relative)) {
      pinned.push(relative);
      await this.context.workspaceState.update(PINNED_FILES_KEY, pinned);
    }
    return relative;
  }

  private createSessionId(): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "no-workspace";
    const workspaceHash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
    return `vscode:${workspaceHash}:${crypto.randomUUID()}`;
  }
}

class L2MAgentChatPanel {
  static current: L2MAgentChatPanel | undefined;

  static show(extensionUri: vscode.Uri, sessionStore: SessionStore, draft = "") {
    if (L2MAgentChatPanel.current) {
      L2MAgentChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      if (draft) {
        L2MAgentChatPanel.current.setDraft(draft);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "l2mAgentChat",
      "L2M Agent",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    L2MAgentChatPanel.current = new L2MAgentChatPanel(panel, sessionStore);
    if (draft) {
      L2MAgentChatPanel.current.setDraft(draft);
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly sessionStore: SessionStore
  ) {
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => {
      L2MAgentChatPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === "sendPrompt") {
        this.handlePrompt(message.text);
      }
    });
  }

  postSystemMessage(text: string) {
    void this.panel.webview.postMessage({ type: "systemMessage", text });
  }

  setDraft(text: string) {
    void this.panel.webview.postMessage({ type: "setDraft", text });
  }

  private async handlePrompt(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const config = getL2MAgentConfig();
    const client = new L2MClient(config);
    const variables = this.buildRequestVariables();
    this.postToWebview({ type: "requestStarted" });
    this.postToWebview({
      type: "progressMessage",
      text: `Calling ${config.streamResponses ? "streaming" : "non-streaming"} L2M webhook at ${config.apiBaseUrl}.`
    });

    try {
      const result = await client.execute(
        {
          sessionId: this.sessionStore.getSessionId(),
          systemPrompt: buildDefaultSystemPrompt(),
          userPrompt: trimmed,
          variables
        },
        {
          onProgress: (message) => this.postToWebview({ type: "progressMessage", text: message }),
          onDelta: (delta) => this.postToWebview({ type: "progressMessage", text: `LLM: ${delta}` })
        }
      );
      this.postToWebview({ type: "assistantMessage", text: extractAssistantText(result) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "L2M request failed.";
      this.postToWebview({ type: "errorMessage", text: message });
    } finally {
      this.postToWebview({ type: "requestFinished" });
    }
  }

  private buildRequestVariables(): Record<string, unknown> {
    const activeEditor = vscode.window.activeTextEditor;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const activeFile = activeEditor
      ? {
          path: workspaceRelativePath(activeEditor.document.uri),
          languageId: activeEditor.document.languageId,
          isDirty: activeEditor.document.isDirty,
          selection: activeEditor.selection.isEmpty
            ? ""
            : activeEditor.document.getText(activeEditor.selection)
        }
      : null;

    return {
      client: "vscode-l2m-agent",
      phase: "phase-2-streaming-client",
      workspace: workspaceFolder
        ? {
            name: workspaceFolder.name,
            path: workspaceFolder.uri.fsPath
          }
        : null,
      activeFile,
      openFiles: vscode.window.visibleTextEditors.map((editor) => ({
        path: workspaceRelativePath(editor.document.uri),
        languageId: editor.document.languageId,
        isDirty: editor.document.isDirty
      })),
      pinnedFiles: this.sessionStore.getPinnedFiles()
    };
  }

  private postToWebview(message: ExtensionToWebviewMessage) {
    void this.panel.webview.postMessage(message);
  }

  private renderHtml(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const sessionId = escapeHtml(this.sessionStore.getSessionId());
    const pinnedFiles = this.sessionStore.getPinnedFiles();
    const pinnedHtml = pinnedFiles.length
      ? pinnedFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join("")
      : "<li>No pinned files yet.</li>";

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>L2M Agent</title>
    <style>
      body {
        margin: 0;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
      }
      .shell {
        display: grid;
        grid-template-rows: auto 1fr auto;
        height: 100vh;
      }
      header {
        padding: 12px 14px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      h1 {
        margin: 0 0 6px;
        font-size: 15px;
      }
      .meta {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      main {
        overflow: auto;
        padding: 14px;
      }
      .message {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 10px;
        white-space: pre-wrap;
      }
      .message.user {
        background: var(--vscode-input-background);
      }
      .message.assistant {
        background: var(--vscode-editor-inactiveSelectionBackground);
      }
      .pinned {
        margin-top: 12px;
        padding: 10px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
      }
      .pinned h2 {
        margin: 0 0 6px;
        font-size: 13px;
      }
      .pinned ul {
        margin: 0;
        padding-left: 18px;
      }
      footer {
        display: grid;
        gap: 8px;
        padding: 12px;
        border-top: 1px solid var(--vscode-panel-border);
      }
      textarea {
        min-height: 90px;
        resize: vertical;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
        border-radius: 6px;
        padding: 8px;
        font-family: var(--vscode-editor-font-family);
      }
      .message.progress {
        color: var(--vscode-descriptionForeground);
        background: transparent;
        border-style: dashed;
        font-size: 12px;
      }
      .message.error {
        color: var(--vscode-errorForeground);
        border-color: var(--vscode-inputValidation-errorBorder);
        background: var(--vscode-inputValidation-errorBackground);
      }
      button {
        width: max-content;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: 0;
        border-radius: 4px;
        padding: 7px 12px;
        cursor: pointer;
      }
      button:hover {
        background: var(--vscode-button-hoverBackground);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <h1>L2M Agent</h1>
        <div class="meta">Session: ${sessionId}</div>
      </header>
      <main id="messages">
        <div class="message assistant">Phase 1 scaffold loaded. Use this panel to verify extension activation and command wiring.</div>
        <section class="pinned">
          <h2>Pinned files</h2>
          <ul>${pinnedHtml}</ul>
        </section>
      </main>
      <footer>
        <textarea id="prompt" placeholder="Ask L2M Agent..."></textarea>
        <button id="send" type="button">Send</button>
      </footer>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const messages = document.getElementById("messages");
      const prompt = document.getElementById("prompt");
      const send = document.getElementById("send");

      function appendMessage(role, text) {
        const item = document.createElement("div");
        item.className = "message " + role;
        item.textContent = text;
        messages.appendChild(item);
        messages.scrollTop = messages.scrollHeight;
      }

      send.addEventListener("click", () => {
        const text = prompt.value.trim();
        if (!text) return;
        appendMessage("user", text);
        prompt.value = "";
        vscode.postMessage({ type: "sendPrompt", text });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "setDraft") {
          prompt.value = message.text || "";
          prompt.focus();
        }
        if (message.type === "systemMessage") {
          appendMessage("assistant", message.text || "");
        }
        if (message.type === "assistantMessage") {
          appendMessage("assistant", message.text || "");
        }
        if (message.type === "progressMessage") {
          appendMessage("progress", message.text || "");
        }
        if (message.type === "errorMessage") {
          appendMessage("error", message.text || "");
        }
        if (message.type === "requestStarted") {
          send.disabled = true;
        }
        if (message.type === "requestFinished") {
          send.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
  }
}

function workspaceRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return uri.fsPath;
  }

  return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildDefaultSystemPrompt(): string {
  return [
    "You are L2M Agent, an interactive VS Code coding and data analytics assistant.",
    "Use the provided variables as bounded workspace context.",
    "Return a concise answer. When possible, return structured JSON with message, actions, codes, attachments, context_update, and follow_up_question.",
    "Do not claim to have modified files unless the response includes an explicit patch action for the extension to apply."
  ].join("\n");
}

function extractAssistantText(value: unknown): string {
  const structured = extractStructuredText(value, 0);
  if (structured) {
    return structured;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractStructuredText(value: unknown, depth: number): string {
  if (depth > 6 || value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    if (parsed) {
      return extractStructuredText(parsed, depth + 1) || value;
    }
    return value;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const record = value as Record<string, unknown>;
  for (const key of ["message", "answer", "text", "content", "response", "follow_up_question", "final_html"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key];
    }
  }

  if (typeof record.python_code === "string" && record.python_code.trim()) {
    return `\`\`\`python\n${record.python_code}\n\`\`\``;
  }

  const actionSummary = summarizeActions(record.actions);
  if (actionSummary) {
    return actionSummary;
  }

  for (const key of ["output", "result", "answer", "data"]) {
    const nested = extractStructuredText(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function summarizeActions(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }

  const labels = value
    .map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return `Action ${index + 1}`;
      }
      const record = item as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "action";
      const title = typeof record.title === "string" ? record.title : `Action ${index + 1}`;
      return `${title} (${type})`;
    })
    .join("\n");

  return `L2M returned actions:\n${labels}\n\nAction preview and approval will be implemented in a later phase.`;
}
