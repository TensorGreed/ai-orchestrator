import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActionService } from "./actionService";
import { getL2MAgentConfig } from "./config";
import { collectWorkspaceContext } from "./contextCollector";
import { L2MClient } from "./l2mClient";
import { parseAssistantResponse } from "./responseParser";
import {
  buildRecentTurns,
  buildSessionMemorySnapshot,
  compactSessionMemory,
  EMPTY_SESSION_MEMORY,
  mergeContextUpdate
} from "./sessionMemory";
import type { L2MAgentConfig } from "./protocol";
import type { ActionResult, ChatAction, ChatAttachment, ChatMessage, ExtensionToWebviewMessage, WebviewMessage } from "./protocol";
import type { SessionMemorySnapshot, SessionMemoryState } from "./sessionMemory";

const SESSION_ID_KEY = "l2mAgent.sessionId";
const PINNED_FILES_KEY = "l2mAgent.pinnedFiles";
const MESSAGES_KEY = "l2mAgent.messages";
const SESSION_MEMORY_KEY = "l2mAgent.sessionMemory";
const ACTION_RESULTS_KEY = "l2mAgent.actionResults";
const MAX_PERSISTED_MESSAGES = 100;
const MAX_ACTION_RESULTS = 50;

export function activate(context: vscode.ExtensionContext) {
  const sessionStore = new SessionStore(context);
  const actionService = new ActionService(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("l2mAgent.openChat", () => {
      L2MAgentChatPanel.show(context, sessionStore, actionService);
    }),
    vscode.commands.registerCommand("l2mAgent.newSession", async () => {
      const sessionId = await sessionStore.rotateSession();
      await sessionStore.clearMessages();
      await sessionStore.clearActionResults();
      await sessionStore.resetMemory();
      L2MAgentChatPanel.show(context, sessionStore, actionService);
      L2MAgentChatPanel.current?.refresh();
      await L2MAgentChatPanel.current?.postSystemMessage(`Started new session: ${sessionId}`);
      void vscode.window.showInformationMessage("L2M Agent session reset.");
    }),
    vscode.commands.registerCommand("l2mAgent.pinActiveFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("Open a file before pinning it for L2M Agent context.");
        return;
      }

      const pinned = await sessionStore.pinFile(editor.document.uri);
      const message = `Pinned file: ${pinned}`;
      if (L2MAgentChatPanel.current) {
        L2MAgentChatPanel.current.refresh();
        await L2MAgentChatPanel.current.postSystemMessage(message);
      } else {
        await sessionStore.appendMessage(createChatMessage("system", message));
      }
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
      L2MAgentChatPanel.show(context, sessionStore, actionService, draft);
    }),
    vscode.commands.registerCommand("l2mAgent.resetMemory", async () => {
      await sessionStore.resetMemory();
      const message = "Reset compacted session memory.";
      if (L2MAgentChatPanel.current) {
        L2MAgentChatPanel.current.refresh();
        await L2MAgentChatPanel.current.postSystemMessage(message);
      } else {
        await sessionStore.appendMessage(createChatMessage("system", message));
      }
      void vscode.window.showInformationMessage("L2M Agent memory reset.");
    })
  );
}

export function deactivate() {
  // No background resources yet.
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

  getMessages(): ChatMessage[] {
    return this.context.workspaceState.get<ChatMessage[]>(MESSAGES_KEY, []);
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    const messages = [...this.getMessages(), message].slice(-MAX_PERSISTED_MESSAGES);
    await this.context.workspaceState.update(MESSAGES_KEY, messages);
  }

  async clearMessages(): Promise<void> {
    await this.context.workspaceState.update(MESSAGES_KEY, []);
  }

  getActionResults(): ActionResult[] {
    return this.context.workspaceState.get<ActionResult[]>(ACTION_RESULTS_KEY, []);
  }

  async appendActionResult(result: ActionResult): Promise<void> {
    const results = [...this.getActionResults(), result].slice(-MAX_ACTION_RESULTS);
    await this.context.workspaceState.update(ACTION_RESULTS_KEY, results);
  }

  async clearActionResults(): Promise<void> {
    await this.context.workspaceState.update(ACTION_RESULTS_KEY, []);
  }

  async updateActionStatus(actionId: string, status: ActionResult["status"]): Promise<void> {
    const messages = this.getMessages().map((message) => ({
      ...message,
      actions: message.actions?.map((action) =>
        action.id === actionId ? { ...action, status } : action
      )
    }));
    await this.context.workspaceState.update(MESSAGES_KEY, messages);
  }

  getSessionMemory(): SessionMemoryState {
    const stored = this.context.workspaceState.get<Partial<SessionMemoryState>>(SESSION_MEMORY_KEY, {});
    return {
      ...EMPTY_SESSION_MEMORY,
      ...stored
    };
  }

  getMemorySnapshot(config: L2MAgentConfig): SessionMemorySnapshot {
    return buildSessionMemorySnapshot(this.getMessages(), this.getSessionMemory(), {
      recentTurnCount: config.recentTurnCount,
      maxCompactedMemoryChars: config.maxCompactedMemoryChars
    });
  }

  getRecentTurns(config: L2MAgentConfig): Array<Record<string, unknown>> {
    return buildRecentTurns(this.getMessages(), config.recentTurnCount);
  }

  async compactMemory(config: L2MAgentConfig): Promise<number> {
    const result = compactSessionMemory(this.getMessages(), this.getSessionMemory(), {
      recentTurnCount: config.recentTurnCount,
      maxCompactedMemoryChars: config.maxCompactedMemoryChars
    });
    await this.updateSessionMemory(result.state);
    return result.compactedCount;
  }

  async mergeContextUpdate(contextUpdate: string, config: L2MAgentConfig): Promise<void> {
    const next = mergeContextUpdate(this.getSessionMemory(), contextUpdate, config.maxCompactedMemoryChars);
    await this.updateSessionMemory(next);
  }

  async resetMemory(): Promise<void> {
    const lastMessage = this.getMessages().at(-1);
    await this.updateSessionMemory({
      ...EMPTY_SESSION_MEMORY,
      compactedThroughMessageId: lastMessage?.id ?? "",
      compactedThroughCreatedAt: lastMessage?.createdAt ?? "",
      updatedAt: new Date().toISOString()
    });
  }

  private async updateSessionMemory(memory: SessionMemoryState): Promise<void> {
    await this.context.workspaceState.update(SESSION_MEMORY_KEY, memory);
  }

  private createSessionId(): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "no-workspace";
    const workspaceHash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
    return `vscode:${workspaceHash}:${crypto.randomUUID()}`;
  }
}

class L2MAgentChatPanel {
  static current: L2MAgentChatPanel | undefined;

  static show(context: vscode.ExtensionContext, sessionStore: SessionStore, actionService: ActionService, draft = "") {
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
        localResourceRoots: [context.extensionUri]
      }
    );

    L2MAgentChatPanel.current = new L2MAgentChatPanel(context, panel, sessionStore, actionService);
    if (draft) {
      L2MAgentChatPanel.current.setDraft(draft);
    }
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly sessionStore: SessionStore,
    private readonly actionService: ActionService
  ) {
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => {
      L2MAgentChatPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleWebviewMessage(message);
    });
  }

  async postSystemMessage(text: string): Promise<void> {
    const message = createChatMessage("system", text);
    await this.sessionStore.appendMessage(message);
    this.postToWebview({ type: "appendMessage", message });
  }

  setDraft(text: string) {
    this.postToWebview({ type: "setDraft", text });
  }

  refresh() {
    this.panel.webview.html = this.renderHtml();
  }

  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "sendPrompt") {
      await this.handlePrompt(message.text);
    } else if (message.type === "copyCode") {
      await vscode.env.clipboard.writeText(message.source);
      void vscode.window.showInformationMessage("Copied code to clipboard.");
    } else if (message.type === "insertCode") {
      await this.insertCode(message.source);
    } else if (message.type === "openAttachment") {
      await this.openAttachment(message.attachment);
    } else if (message.type === "resetMemory") {
      await this.resetMemoryFromWebview();
    } else if (message.type === "previewAction") {
      await this.previewAction(message.action);
    } else if (message.type === "runAction") {
      await this.runAction(message.action);
    }
  }

  private async handlePrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const userMessage = createChatMessage("user", trimmed);
    await this.sessionStore.appendMessage(userMessage);
    this.postToWebview({ type: "appendMessage", message: userMessage });

    const config = getL2MAgentConfig();
    const client = new L2MClient(config);
    this.postToWebview({ type: "requestStarted" });

    try {
      this.postToWebview({ type: "progressMessage", text: "Collecting workspace context and session memory." });
      const variables = await this.buildRequestVariables(config);
      this.postToWebview({
        type: "progressMessage",
        text: `Calling ${config.streamResponses ? "streaming" : "non-streaming"} L2M webhook at ${config.apiBaseUrl}.`
      });
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
      const parsed = parseAssistantResponse(result);
      const assistantMessage = createChatMessage("assistant", parsed.text, {
        codes: parsed.codes,
        attachments: parsed.attachments,
        actions: parsed.actions
      });
      await this.sessionStore.appendMessage(assistantMessage);
      if (parsed.contextUpdate) {
        await this.sessionStore.mergeContextUpdate(parsed.contextUpdate, config);
        this.postToWebview({ type: "progressMessage", text: "Merged context update into local session memory." });
      }
      this.postToWebview({ type: "appendMessage", message: assistantMessage });
    } catch (error) {
      const text = error instanceof Error ? error.message : "L2M request failed.";
      const errorMessage = createChatMessage("assistant", text, { variant: "error" });
      await this.sessionStore.appendMessage(errorMessage);
      this.postToWebview({ type: "appendMessage", message: errorMessage });
    } finally {
      this.postToWebview({ type: "requestFinished" });
    }
  }

  private async buildRequestVariables(config: L2MAgentConfig): Promise<Record<string, unknown>> {
    const compactedCount = await this.sessionStore.compactMemory(config);
    if (compactedCount > 0) {
      this.postToWebview({
        type: "progressMessage",
        text: `Compacted ${compactedCount} older message${compactedCount === 1 ? "" : "s"} into local session memory.`
      });
    }
    const workspaceContext = await collectWorkspaceContext(config, this.sessionStore.getPinnedFiles());
    const sessionMemory = this.sessionStore.getMemorySnapshot(config);
    const activeFile = asRecord(workspaceContext.activeFile);
    const selection = asRecord(activeFile?.selection);
    const selectedText = extractLimitedText(selection?.text);

    return {
      client: "vscode-l2m-agent",
      phase: "phase-5-session-memory",
      ...workspaceContext,
      sessionMemory,
      compactedMemory: sessionMemory.compactedMemory,
      selection,
      selectedText,
      pinnedFilePaths: this.sessionStore.getPinnedFiles(),
      actionResults: this.sessionStore.getActionResults().slice(-20),
      conversationTail: sessionMemory.recentTurns,
      recentTurns: sessionMemory.recentTurns
    };
  }

  private async previewAction(action: ChatAction): Promise<void> {
    const result = await this.executeActionSafely(action, () => this.actionService.previewAction(action));
    await this.recordActionResult(result);
  }

  private async runAction(action: ChatAction): Promise<void> {
    const result = await this.executeActionSafely(action, () => this.actionService.runAction(action));
    await this.recordActionResult(result);
    await this.sessionStore.updateActionStatus(action.id, result.status);
    this.postToWebview({ type: "updateActionStatus", actionId: action.id, status: result.status, result });
  }

  private async executeActionSafely(
    action: ChatAction,
    execute: () => Promise<ActionResult>
  ): Promise<ActionResult> {
    try {
      return await execute();
    } catch (error) {
      return createActionResult(
        action,
        "failed",
        error instanceof Error ? error.message : "Action failed."
      );
    }
  }

  private async recordActionResult(result: ActionResult): Promise<void> {
    await this.sessionStore.appendActionResult(result);
    await this.postSystemMessage(`Action ${result.status}: ${result.message}`);
  }

  private async resetMemoryFromWebview(): Promise<void> {
    await this.sessionStore.resetMemory();
    await this.postSystemMessage("Reset compacted session memory.");
    this.refresh();
    void vscode.window.showInformationMessage("L2M Agent memory reset.");
  }

  private async insertCode(source: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open an editor before inserting code.");
      return;
    }

    await editor.edit((builder) => {
      builder.replace(editor.selection, source);
    });
  }

  private async openAttachment(attachment: ChatAttachment): Promise<void> {
    if (/^https?:\/\//i.test(attachment.downloadUrl)) {
      await vscode.env.openExternal(vscode.Uri.parse(attachment.downloadUrl));
      return;
    }

    const parsed = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(attachment.downloadUrl);
    if (!parsed) {
      void vscode.window.showWarningMessage("Attachment URL is not supported yet.");
      return;
    }

    const safeName = sanitizeFilename(attachment.filename);
    const targetDir = vscode.Uri.joinPath(this.context.globalStorageUri, "attachments");
    await vscode.workspace.fs.createDirectory(targetDir);
    const targetFile = vscode.Uri.joinPath(targetDir, safeName);
    await vscode.workspace.fs.writeFile(targetFile, Buffer.from(parsed[2] ?? "", "base64"));
    await vscode.env.openExternal(targetFile);
  }

  private postToWebview(message: ExtensionToWebviewMessage) {
    void this.panel.webview.postMessage(message);
  }

  private renderHtml(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const config = getL2MAgentConfig();
    const state = {
      sessionId: this.sessionStore.getSessionId(),
      pinnedFiles: this.sessionStore.getPinnedFiles(),
      messages: this.sessionStore.getMessages(),
      memory: this.sessionStore.getMemorySnapshot(config)
    };

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
      .pinned,
      .memory {
        margin-top: 10px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .pinned summary,
      .memory summary {
        cursor: pointer;
      }
      .pinned ul {
        margin: 6px 0 0;
        padding-left: 18px;
      }
      .memory-body {
        display: grid;
        gap: 6px;
        margin-top: 6px;
      }
      main {
        overflow: auto;
        padding: 14px;
      }
      .empty {
        color: var(--vscode-descriptionForeground);
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        padding: 14px;
      }
      .message {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 12px;
        background: var(--vscode-editor-background);
      }
      .message.user {
        background: var(--vscode-input-background);
      }
      .message.assistant {
        background: var(--vscode-editor-inactiveSelectionBackground);
      }
      .message.system {
        color: var(--vscode-descriptionForeground);
        background: transparent;
        border-style: dashed;
      }
      .message.error {
        color: var(--vscode-errorForeground);
        border-color: var(--vscode-inputValidation-errorBorder);
        background: var(--vscode-inputValidation-errorBackground);
      }
      .message-head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        text-transform: uppercase;
      }
      .message-text {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .code-card,
      .attachment-card,
      .action-card {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        margin-top: 10px;
        overflow: hidden;
      }
      .code-head,
      .attachment-head,
      .action-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 7px 8px;
        background: var(--vscode-sideBar-background);
        border-bottom: 1px solid var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .code-actions,
      .attachment-actions,
      .action-actions {
        display: flex;
        gap: 6px;
      }
      pre {
        margin: 0;
        padding: 10px;
        overflow: auto;
        background: var(--vscode-textCodeBlock-background);
      }
      code {
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
      }
      .attachments {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }
      .attachment-body {
        padding: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .action-body {
        display: grid;
        gap: 6px;
        padding: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .action-status {
        text-transform: uppercase;
        color: var(--vscode-foreground);
      }
      .progress-panel {
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        padding: 8px 10px;
        margin-bottom: 12px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .progress-panel summary {
        cursor: pointer;
      }
      .progress-panel ul {
        margin: 8px 0 0;
        padding-left: 18px;
      }
      footer {
        display: grid;
        gap: 8px;
        padding: 12px;
        border-top: 1px solid var(--vscode-panel-border);
      }
      textarea {
        min-height: 96px;
        resize: vertical;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
        border-radius: 6px;
        padding: 8px;
        font-family: var(--vscode-editor-font-family);
      }
      button {
        width: max-content;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: 0;
        border-radius: 4px;
        padding: 5px 9px;
        cursor: pointer;
      }
      button:hover {
        background: var(--vscode-button-hoverBackground);
      }
      button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      button:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <h1>L2M Agent</h1>
        <div class="meta">Session: <span id="sessionId"></span></div>
        <details class="pinned">
          <summary>Pinned files</summary>
          <ul id="pinnedFiles"></ul>
        </details>
        <details class="memory">
          <summary>Session memory</summary>
          <div class="memory-body">
            <div id="memoryStatus"></div>
            <button id="resetMemory" class="secondary" type="button">Reset Memory</button>
          </div>
        </details>
      </header>
      <main id="messages"></main>
      <footer>
        <textarea id="prompt" placeholder="Ask L2M Agent..."></textarea>
        <button id="send" type="button">Send</button>
      </footer>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const state = ${jsonForScript(state)};
      const messages = document.getElementById("messages");
      const pinnedFiles = document.getElementById("pinnedFiles");
      const memoryStatus = document.getElementById("memoryStatus");
      const sessionId = document.getElementById("sessionId");
      const prompt = document.getElementById("prompt");
      const send = document.getElementById("send");
      const resetMemory = document.getElementById("resetMemory");
      let currentProgressList = null;
      let currentProgressDetails = null;

      sessionId.textContent = state.sessionId;
      renderPinnedFiles();
      renderMemory();
      renderMessages();

      function renderPinnedFiles() {
        pinnedFiles.replaceChildren();
        const files = Array.isArray(state.pinnedFiles) ? state.pinnedFiles : [];
        if (files.length === 0) {
          const item = document.createElement("li");
          item.textContent = "No pinned files yet.";
          pinnedFiles.appendChild(item);
          return;
        }
        for (const file of files) {
          const item = document.createElement("li");
          item.textContent = String(file);
          pinnedFiles.appendChild(item);
        }
      }

      function renderMemory() {
        const memory = state.memory && typeof state.memory === "object" ? state.memory : {};
        const chars = typeof memory.compactedMemory === "string" ? memory.compactedMemory.length : 0;
        const updatedAt = memory.updatedAt ? formatTime(memory.updatedAt) : "never";
        const recent = typeof memory.recentTurnCount === "number" ? memory.recentTurnCount : 0;
        memoryStatus.textContent = chars + " compacted chars - recent turns: " + recent + " - updated: " + updatedAt;
      }

      function renderMessages() {
        messages.replaceChildren();
        if (!Array.isArray(state.messages) || state.messages.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Start a conversation with L2M Agent. Configure l2mAgent.apiBaseUrl and l2mAgent.workflowId if needed.";
          messages.appendChild(empty);
          return;
        }
        for (const message of state.messages) {
          messages.appendChild(renderMessage(message));
        }
        messages.scrollTop = messages.scrollHeight;
      }

      function appendMessage(message) {
        if (!message || typeof message !== "object") return;
        if (!Array.isArray(state.messages)) state.messages = [];
        if (!state.messages.some((item) => item.id === message.id)) {
          state.messages.push(message);
        }
        const empty = messages.querySelector(".empty");
        if (empty) empty.remove();
        messages.appendChild(renderMessage(message));
        messages.scrollTop = messages.scrollHeight;
      }

      function renderMessage(message) {
        const item = document.createElement("article");
        item.className = "message " + (message.role || "assistant") + (message.variant === "error" ? " error" : "");

        const head = document.createElement("div");
        head.className = "message-head";
        const role = document.createElement("span");
        role.textContent = message.role || "assistant";
        const time = document.createElement("span");
        time.textContent = formatTime(message.createdAt);
        head.append(role, time);
        item.appendChild(head);

        if (message.text) {
          const textWrap = document.createElement("div");
          textWrap.className = "message-text";
          renderTextWithFences(textWrap, String(message.text));
          item.appendChild(textWrap);
        }

        for (const code of normalizedArray(message.codes)) {
          item.appendChild(renderCodeBlock(code));
        }

        const attachments = normalizedArray(message.attachments);
        if (attachments.length) {
          const list = document.createElement("div");
          list.className = "attachments";
          for (const attachment of attachments) {
            list.appendChild(renderAttachment(attachment));
          }
          item.appendChild(list);
        }

        for (const action of normalizedArray(message.actions)) {
          item.appendChild(renderAction(action));
        }

        return item;
      }

      function renderTextWithFences(container, text) {
        const marker = String.fromCharCode(96, 96, 96);
        const fence = new RegExp(marker + "([\\\\w+-]*)\\\\n([\\\\s\\\\S]*?)" + marker, "g");
        let lastIndex = 0;
        let match;
        while ((match = fence.exec(text)) !== null) {
          const before = text.slice(lastIndex, match.index);
          if (before) {
            const part = document.createElement("div");
            part.textContent = before;
            container.appendChild(part);
          }
          container.appendChild(renderCodeBlock({ language: match[1] || "", source: match[2] || "" }));
          lastIndex = fence.lastIndex;
        }
        const tail = text.slice(lastIndex);
        if (tail) {
          const part = document.createElement("div");
          part.textContent = tail;
          container.appendChild(part);
        }
      }

      function renderCodeBlock(code) {
        const card = document.createElement("section");
        card.className = "code-card";
        const head = document.createElement("div");
        head.className = "code-head";
        const label = document.createElement("span");
        label.textContent = code.label || code.language || "code";
        const actions = document.createElement("div");
        actions.className = "code-actions";
        const copy = document.createElement("button");
        copy.className = "secondary";
        copy.type = "button";
        copy.textContent = "Copy";
        copy.addEventListener("click", () => vscode.postMessage({ type: "copyCode", source: code.source || "" }));
        const insert = document.createElement("button");
        insert.className = "secondary";
        insert.type = "button";
        insert.textContent = "Insert";
        insert.addEventListener("click", () => vscode.postMessage({ type: "insertCode", source: code.source || "" }));
        actions.append(copy, insert);
        head.append(label, actions);

        const pre = document.createElement("pre");
        const codeEl = document.createElement("code");
        codeEl.textContent = code.source || "";
        pre.appendChild(codeEl);
        card.append(head, pre);
        return card;
      }

      function renderAttachment(attachment) {
        const card = document.createElement("section");
        card.className = "attachment-card";
        const head = document.createElement("div");
        head.className = "attachment-head";
        const title = document.createElement("span");
        title.textContent = attachment.filename || "attachment";
        const actions = document.createElement("div");
        actions.className = "attachment-actions";
        const open = document.createElement("button");
        open.className = "secondary";
        open.type = "button";
        open.textContent = "Open";
        open.addEventListener("click", () => vscode.postMessage({ type: "openAttachment", attachment }));
        actions.appendChild(open);
        head.append(title, actions);
        const body = document.createElement("div");
        body.className = "attachment-body";
        body.textContent = [attachment.mimeType, formatBytes(attachment.sizeBytes)].filter(Boolean).join(" - ");
        card.append(head, body);
        return card;
      }

      function renderAction(action) {
        const card = document.createElement("section");
        card.className = "action-card";
        card.dataset.actionId = action.id || "";

        const head = document.createElement("div");
        head.className = "action-head";
        const title = document.createElement("span");
        title.textContent = action.title || actionLabel(action);
        const actions = document.createElement("div");
        actions.className = "action-actions";

        const preview = document.createElement("button");
        preview.className = "secondary";
        preview.type = "button";
        preview.textContent = "Preview";
        preview.addEventListener("click", () => vscode.postMessage({ type: "previewAction", action }));
        actions.appendChild(preview);

        const run = document.createElement("button");
        run.className = "secondary";
        run.type = "button";
        run.textContent = action.type === "command" ? "Run" : "Apply";
        run.disabled = action.status === "applied" || action.status === "running";
        run.addEventListener("click", () => vscode.postMessage({ type: "runAction", action }));
        actions.appendChild(run);
        head.append(title, actions);

        const body = document.createElement("div");
        body.className = "action-body";
        const status = document.createElement("div");
        status.className = "action-status";
        status.textContent = action.status || "pending";
        body.appendChild(status);
        const target = document.createElement("div");
        target.textContent = action.type === "command"
          ? (action.command || "")
          : (action.file || "workspace patch");
        body.appendChild(target);
        if (action.description) {
          const description = document.createElement("div");
          description.textContent = action.description;
          body.appendChild(description);
        }

        card.append(head, body);
        return card;
      }

      function startProgress() {
        currentProgressDetails = document.createElement("details");
        currentProgressDetails.className = "progress-panel";
        currentProgressDetails.open = true;
        const summary = document.createElement("summary");
        summary.textContent = "Execution activity";
        currentProgressList = document.createElement("ul");
        currentProgressDetails.append(summary, currentProgressList);
        messages.appendChild(currentProgressDetails);
        messages.scrollTop = messages.scrollHeight;
      }

      function appendProgress(text) {
        if (!currentProgressList) startProgress();
        const item = document.createElement("li");
        item.textContent = text;
        currentProgressList.appendChild(item);
        messages.scrollTop = messages.scrollHeight;
      }

      send.addEventListener("click", () => {
        const text = prompt.value.trim();
        if (!text) return;
        prompt.value = "";
        vscode.postMessage({ type: "sendPrompt", text });
      });

      resetMemory.addEventListener("click", () => {
        vscode.postMessage({ type: "resetMemory" });
      });

      prompt.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          send.click();
        }
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "setDraft") {
          prompt.value = message.text || "";
          prompt.focus();
        }
        if (message.type === "appendMessage") {
          appendMessage(message.message);
        }
        if (message.type === "updateActionStatus") {
          updateActionStatus(message.actionId, message.status);
          if (message.result && message.result.message) {
            appendProgress(message.result.message);
          }
        }
        if (message.type === "progressMessage") {
          appendProgress(message.text || "");
        }
        if (message.type === "errorMessage") {
          appendMessage({
            id: String(Date.now()),
            role: "assistant",
            variant: "error",
            text: message.text || "",
            createdAt: new Date().toISOString()
          });
        }
        if (message.type === "requestStarted") {
          send.disabled = true;
          startProgress();
        }
        if (message.type === "requestFinished") {
          send.disabled = false;
          if (currentProgressDetails) currentProgressDetails.open = false;
          currentProgressDetails = null;
          currentProgressList = null;
        }
      });

      function normalizedArray(value) {
        return Array.isArray(value) ? value : [];
      }

      function updateActionStatus(actionId, status) {
        if (!actionId || !Array.isArray(state.messages)) return;
        for (const message of state.messages) {
          for (const action of normalizedArray(message.actions)) {
            if (action.id === actionId) {
              action.status = status;
            }
          }
        }
        renderMessages();
      }

      function actionLabel(action) {
        return action.type === "command" ? "Command" : "Patch";
      }

      function formatTime(value) {
        if (!value) return "";
        try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
        catch { return ""; }
      }

      function formatBytes(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) return "";
        if (value < 1024) return value + " B";
        if (value < 1024 * 1024) return Math.round(value / 1024) + " KB";
        return (value / (1024 * 1024)).toFixed(1) + " MB";
      }
    </script>
  </body>
</html>`;
  }
}

function createChatMessage(
  role: ChatMessage["role"],
  text: string,
  extra: Partial<Omit<ChatMessage, "id" | "role" | "text" | "createdAt">> = {}
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
    variant: "normal",
    ...extra
  };
}

function workspaceRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return uri.fsPath;
  }

  return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
}

function buildDefaultSystemPrompt(): string {
  return [
    "You are L2M Agent, an interactive VS Code coding and data analytics assistant.",
    "Use the provided variables as bounded workspace context.",
    "Return a concise answer. When possible, return structured JSON with message, actions, codes, attachments, context_update, and follow_up_question.",
    "For file edits, return actions with type='patch', title, file, and a single-file unified diff.",
    "For shell work, return actions with type='command', title, command, and optional cwd.",
    "Do not claim to have modified files or run commands unless actionResults in the request show that the user approved and executed them."
  ].join("\n");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function sanitizeFilename(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned || "attachment.bin";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractLimitedText(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.text === "string" ? record.text : "";
}

function createActionResult(
  action: ChatAction,
  status: ActionResult["status"],
  message: string,
  details?: Record<string, unknown>
): ActionResult {
  return {
    id: crypto.randomUUID(),
    actionId: action.id,
    type: action.type,
    title: action.title,
    status,
    message,
    details,
    createdAt: new Date().toISOString()
  };
}
