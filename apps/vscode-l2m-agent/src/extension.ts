import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActionService } from "./actionService";
import { getL2MAgentConfig } from "./config";
import { collectWorkspaceContext } from "./contextCollector";
import { L2MClient } from "./l2mClient";
import { parseAssistantResponse } from "./responseParser";
import {
  applyMessageToSession,
  cloneSessionAsBranch,
  createChatSession,
  inferSessionTitle,
  limitSessionsKeepingActive,
  normalizeSessions,
  summarizeSessions
} from "./sessionArchive";
import {
  buildRecentTurns,
  buildSessionMemorySnapshot,
  compactSessionMemory,
  EMPTY_SESSION_MEMORY,
  mergeContextUpdate
} from "./sessionMemory";
import type { L2MAgentConfig } from "./protocol";
import type { ActionResult, ChatAction, ChatAttachment, ChatMessage, ExtensionToWebviewMessage, WebviewMessage } from "./protocol";
import type { ChatSession } from "./sessionArchive";
import type { SessionMemorySnapshot, SessionMemoryState } from "./sessionMemory";

const SESSION_ID_KEY = "l2mAgent.sessionId";
const SESSIONS_KEY = "l2mAgent.sessions";
const PINNED_FILES_KEY = "l2mAgent.pinnedFiles";
const MESSAGES_KEY = "l2mAgent.messages";
const SESSION_MEMORY_KEY = "l2mAgent.sessionMemory";
const ACTION_RESULTS_KEY = "l2mAgent.actionResults";
const MAX_PERSISTED_SESSIONS = 30;
const MAX_PERSISTED_MESSAGES = 100;
const MAX_ACTION_RESULTS = 50;
const CHAT_VIEW_ID = "l2mAgent.chatView";

export function activate(context: vscode.ExtensionContext) {
  const sessionStore = new SessionStore(context);
  const actionService = new ActionService(context);
  const chatViewProvider = new L2MAgentChatViewProvider(context, sessionStore, actionService);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("l2mAgent.openChat", () => {
      void chatViewProvider.show();
    }),
    vscode.commands.registerCommand("l2mAgent.newSession", async () => {
      const sessionId = await sessionStore.createNewSession();
      await sessionStore.appendMessage(createChatMessage("system", `Started new session: ${sessionId}`));
      await chatViewProvider.show();
      chatViewProvider.refresh();
      void vscode.window.showInformationMessage("L2M Agent started a new session.");
    }),
    vscode.commands.registerCommand("l2mAgent.pinActiveFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("Open a file before pinning it for L2M Agent context.");
        return;
      }

      const pinned = await sessionStore.pinFile(editor.document.uri);
      const message = `Pinned file: ${pinned}`;
      chatViewProvider.refresh();
      await chatViewProvider.postSystemMessage(message);
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
      void chatViewProvider.show(draft);
    }),
    vscode.commands.registerCommand("l2mAgent.resetMemory", async () => {
      await sessionStore.resetMemory();
      const message = "Reset compacted session memory.";
      chatViewProvider.refresh();
      await chatViewProvider.postSystemMessage(message);
      void vscode.window.showInformationMessage("L2M Agent memory reset.");
    })
  );
}

export function deactivate() {
  // No background resources yet.
}

class SessionStore {
  private sessionsCache: ChatSession[] | undefined;
  private activeSessionIdCache: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getSessionId(): string {
    return this.getActiveSession().id;
  }

  getSessionSummaries(): ReturnType<typeof summarizeSessions> {
    return summarizeSessions(this.getSessions());
  }

  async createNewSession(): Promise<string> {
    const session = createChatSession(this.createSessionId());
    await this.saveSessions([session, ...this.getSessions()], session.id);
    return session.id;
  }

  async branchSession(sessionId: string): Promise<string> {
    const source = this.getSessions().find((session) => session.id === sessionId) ?? this.getActiveSession();
    const branch = cloneSessionAsBranch(source, this.createSessionId());
    await this.saveSessions([branch, ...this.getSessions()], branch.id);
    return branch.id;
  }

  async switchSession(sessionId: string): Promise<boolean> {
    const sessions = this.getSessions();
    if (!sessions.some((session) => session.id === sessionId)) {
      return false;
    }

    await this.saveSessions(sessions, sessionId);
    return true;
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed) {
      return false;
    }

    const now = new Date().toISOString();
    const sessions = this.getSessions();
    let updated = false;
    const next = sessions.map((session) => {
      if (session.id !== sessionId) {
        return session;
      }
      updated = true;
      return {
        ...session,
        title: trimmed.slice(0, 80),
        updatedAt: now
      };
    });

    if (!updated) {
      return false;
    }

    await this.saveSessions(next, this.getSessionId());
    return true;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const remaining = this.getSessions().filter((session) => session.id !== sessionId);
    if (remaining.length === 0) {
      const replacement = createChatSession(this.createSessionId());
      await this.saveSessions([replacement], replacement.id);
      return;
    }

    const activeSessionId = this.getSessionId() === sessionId ? remaining[0].id : this.getSessionId();
    await this.saveSessions(remaining, activeSessionId);
  }

  getPinnedFiles(): string[] {
    return [...this.getActiveSession().pinnedFiles];
  }

  async pinFile(uri: vscode.Uri): Promise<string> {
    const relative = workspaceRelativePath(uri);
    const session = this.getActiveSession();
    const pinned = [...session.pinnedFiles];
    if (!pinned.includes(relative)) {
      pinned.push(relative);
      await this.saveActiveSession({
        ...session,
        pinnedFiles: pinned,
        updatedAt: new Date().toISOString()
      });
    }
    return relative;
  }

  getMessages(): ChatMessage[] {
    return [...this.getActiveSession().messages];
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    await this.saveActiveSession(applyMessageToSession(this.getActiveSession(), message, MAX_PERSISTED_MESSAGES));
  }

  async clearMessages(): Promise<void> {
    await this.saveActiveSession({
      ...this.getActiveSession(),
      messages: [],
      updatedAt: new Date().toISOString()
    });
  }

  getActionResults(): ActionResult[] {
    return [...this.getActiveSession().actionResults];
  }

  async appendActionResult(result: ActionResult): Promise<void> {
    const session = this.getActiveSession();
    await this.saveActiveSession({
      ...session,
      actionResults: [...session.actionResults, result].slice(-MAX_ACTION_RESULTS),
      updatedAt: result.createdAt || new Date().toISOString()
    });
  }

  async clearActionResults(): Promise<void> {
    await this.saveActiveSession({
      ...this.getActiveSession(),
      actionResults: [],
      updatedAt: new Date().toISOString()
    });
  }

  async updateActionStatus(actionId: string, status: ActionResult["status"]): Promise<void> {
    const session = this.getActiveSession();
    const messages = session.messages.map((message) => ({
      ...message,
      actions: message.actions?.map((action) =>
        action.id === actionId ? { ...action, status } : action
      )
    }));
    await this.saveActiveSession({
      ...session,
      messages,
      updatedAt: new Date().toISOString()
    });
  }

  getSessionMemory(): SessionMemoryState {
    return { ...this.getActiveSession().memory };
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
    await this.saveActiveSession({
      ...this.getActiveSession(),
      memory,
      updatedAt: memory.updatedAt || new Date().toISOString()
    });
  }

  private getActiveSession(): ChatSession {
    const sessions = this.getSessions();
    const activeSessionId = this.getActiveSessionId(sessions);
    const active = sessions.find((session) => session.id === activeSessionId);
    if (active) {
      return active;
    }

    const fallback = sessions[0] ?? createChatSession(this.createSessionId());
    void this.saveSessions([fallback, ...sessions.filter((session) => session.id !== fallback.id)], fallback.id);
    return fallback;
  }

  private getSessions(): ChatSession[] {
    if (this.sessionsCache) {
      return this.sessionsCache;
    }

    const stored = normalizeSessions(this.context.workspaceState.get<unknown>(SESSIONS_KEY));
    if (stored.length > 0) {
      this.sessionsCache = limitSessionsKeepingActive(stored, this.getActiveSessionId(stored), MAX_PERSISTED_SESSIONS);
      return this.sessionsCache;
    }

    const legacySession = this.createLegacySession();
    this.sessionsCache = [legacySession];
    this.activeSessionIdCache = legacySession.id;
    void this.saveSessions(this.sessionsCache, legacySession.id);
    return this.sessionsCache;
  }

  private createLegacySession(): ChatSession {
    const now = new Date().toISOString();
    const messages = this.context.workspaceState.get<ChatMessage[]>(MESSAGES_KEY, []).slice(-MAX_PERSISTED_MESSAGES);
    const storedMemory = this.context.workspaceState.get<Partial<SessionMemoryState>>(SESSION_MEMORY_KEY, {});
    return createChatSession(
      this.context.workspaceState.get<string>(SESSION_ID_KEY) || this.createSessionId(),
      now,
      {
        title: inferSessionTitle(messages),
        createdAt: messages[0]?.createdAt || now,
        updatedAt: messages.at(-1)?.createdAt || now,
        messages,
        pinnedFiles: this.context.workspaceState.get<string[]>(PINNED_FILES_KEY, []),
        memory: {
          ...EMPTY_SESSION_MEMORY,
          ...storedMemory
        },
        actionResults: this.context.workspaceState.get<ActionResult[]>(ACTION_RESULTS_KEY, []).slice(-MAX_ACTION_RESULTS)
      }
    );
  }

  private getActiveSessionId(sessions: ChatSession[]): string {
    const cached = this.activeSessionIdCache;
    if (cached && sessions.some((session) => session.id === cached)) {
      return cached;
    }

    const stored = this.context.workspaceState.get<string>(SESSION_ID_KEY);
    if (stored && sessions.some((session) => session.id === stored)) {
      this.activeSessionIdCache = stored;
      return stored;
    }

    const fallback = sessions[0]?.id ?? this.createSessionId();
    this.activeSessionIdCache = fallback;
    return fallback;
  }

  private async saveActiveSession(session: ChatSession): Promise<void> {
    const activeSessionId = this.getSessionId();
    const sessions = this.getSessions().map((candidate) =>
      candidate.id === activeSessionId ? session : candidate
    );
    await this.saveSessions(sessions, activeSessionId);
  }

  private async saveSessions(sessions: ChatSession[], activeSessionId: string): Promise<void> {
    const limited = limitSessionsKeepingActive(sessions, activeSessionId, MAX_PERSISTED_SESSIONS);
    const active = limited.find((session) => session.id === activeSessionId) ?? limited[0];
    const nextActiveSessionId = active?.id ?? activeSessionId;
    this.sessionsCache = limited;
    this.activeSessionIdCache = nextActiveSessionId;

    await Promise.all([
      this.context.workspaceState.update(SESSIONS_KEY, limited),
      this.context.workspaceState.update(SESSION_ID_KEY, nextActiveSessionId),
      this.context.workspaceState.update(PINNED_FILES_KEY, active?.pinnedFiles ?? []),
      this.context.workspaceState.update(MESSAGES_KEY, active?.messages ?? []),
      this.context.workspaceState.update(SESSION_MEMORY_KEY, active?.memory ?? EMPTY_SESSION_MEMORY),
      this.context.workspaceState.update(ACTION_RESULTS_KEY, active?.actionResults ?? [])
    ]);
  }

  private createSessionId(): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "no-workspace";
    const workspaceHash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
    return `vscode:${workspaceHash}:${crypto.randomUUID()}`;
  }
}

interface ChatWebviewHost {
  webview: vscode.Webview;
  onDidDispose: vscode.Event<void>;
  reveal: () => void;
}

class L2MAgentChatViewProvider implements vscode.WebviewViewProvider {
  private current: L2MAgentChatWebviewController | undefined;
  private pendingDraft = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionStore: SessionStore,
    private readonly actionService: ActionService
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    let controller: L2MAgentChatWebviewController;
    controller = new L2MAgentChatWebviewController(
      this.context,
      {
        webview: webviewView.webview,
        onDidDispose: webviewView.onDidDispose,
        reveal: () => webviewView.show()
      },
      this.sessionStore,
      this.actionService,
      () => {
        if (this.current === controller) {
          this.current = undefined;
        }
      }
    );
    this.current = controller;

    if (this.pendingDraft) {
      controller.setDraft(this.pendingDraft);
      this.pendingDraft = "";
    }
  }

  async show(draft = ""): Promise<void> {
    if (draft) {
      this.pendingDraft = draft;
    }

    try {
      await vscode.commands.executeCommand("workbench.view.extension.l2mAgent");
    } catch {
      // VS Code creates this command from the contributed view container.
    }

    try {
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    } catch {
      // Older hosts may not expose the generated focus command until the view is first resolved.
    }

    this.current?.reveal();
    if (draft && this.current) {
      this.current.setDraft(draft);
      this.pendingDraft = "";
    }
  }

  refresh(): void {
    this.current?.refresh();
  }

  async postSystemMessage(text: string): Promise<void> {
    if (this.current) {
      await this.current.postSystemMessage(text);
      return;
    }

    await this.sessionStore.appendMessage(createChatMessage("system", text));
  }
}

class L2MAgentChatWebviewController {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ChatWebviewHost,
    private readonly sessionStore: SessionStore,
    private readonly actionService: ActionService,
    onDispose: () => void
  ) {
    this.host.webview.html = this.renderHtml();
    this.host.onDidDispose(onDispose);
    this.host.webview.onDidReceiveMessage((message: WebviewMessage) => {
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

  reveal() {
    this.host.reveal();
  }

  refresh() {
    this.host.webview.html = this.renderHtml();
  }

  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "sendPrompt") {
      await this.handlePrompt(message.text);
    } else if (message.type === "newSession") {
      await this.startNewSessionFromWebview();
    } else if (message.type === "switchSession") {
      await this.switchSessionFromWebview(message.sessionId);
    } else if (message.type === "renameSession") {
      await this.renameSessionFromWebview(message.sessionId, message.title);
    } else if (message.type === "deleteSession") {
      await this.deleteSessionFromWebview(message.sessionId);
    } else if (message.type === "branchSession") {
      await this.branchSessionFromWebview(message.sessionId);
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

  private async startNewSessionFromWebview(): Promise<void> {
    const sessionId = await this.sessionStore.createNewSession();
    await this.sessionStore.appendMessage(createChatMessage("system", `Started new session: ${sessionId}`));
    this.refresh();
    void vscode.window.showInformationMessage("L2M Agent started a new session.");
  }

  private async switchSessionFromWebview(sessionId: string): Promise<void> {
    if (await this.sessionStore.switchSession(sessionId)) {
      this.refresh();
    }
  }

  private async renameSessionFromWebview(sessionId: string, title?: string): Promise<void> {
    const currentTitle = this.sessionStore.getSessionSummaries().find((session) => session.id === sessionId)?.title ?? "New chat";
    const nextTitle = title ?? await vscode.window.showInputBox({
      title: "Rename L2M Agent Session",
      prompt: "Enter a session name.",
      value: currentTitle,
      ignoreFocusOut: true
    });

    if (nextTitle === undefined) {
      return;
    }

    if (await this.sessionStore.renameSession(sessionId, nextTitle)) {
      this.refresh();
    }
  }

  private async deleteSessionFromWebview(sessionId: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Delete this L2M Agent session?",
      { modal: true, detail: "This removes the archived chat, pinned files, action results, and compacted memory for this session." },
      "Delete"
    );
    if (choice !== "Delete") {
      return;
    }

    await this.sessionStore.deleteSession(sessionId);
    this.refresh();
  }

  private async branchSessionFromWebview(sessionId: string): Promise<void> {
    const branchId = await this.sessionStore.branchSession(sessionId);
    await this.sessionStore.appendMessage(createChatMessage("system", `Branched session: ${branchId}`));
    this.refresh();
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
        text: `Calling ${config.streamResponses ? "streaming" : "non-streaming"} L2M webhook at ${config.apiBaseUrl} (${config.workflowId || config.webhookPath}).`
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
          onDelta: (delta) => this.postToWebview({ type: "assistantDelta", text: delta })
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
    void this.host.webview.postMessage(message);
  }

  private renderHtml(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const config = getL2MAgentConfig();
    const state = {
      sessionId: this.sessionStore.getSessionId(),
      sessions: this.sessionStore.getSessionSummaries(),
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
        margin: 0;
        font-size: 15px;
      }
      .title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      .meta {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      .session-history {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }
      .session-controls {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px;
      }
      .session-list {
        display: grid;
        gap: 6px;
        max-height: 220px;
        overflow: auto;
      }
      .session-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: stretch;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        overflow: hidden;
      }
      .session-row.active {
        border-color: var(--vscode-focusBorder);
      }
      .session-pick {
        width: auto;
        min-width: 0;
        display: grid;
        gap: 2px;
        text-align: left;
        color: var(--vscode-foreground);
        background: transparent;
        border-radius: 0;
      }
      .session-pick:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .session-title,
      .session-preview {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .session-title {
        font-size: 12px;
      }
      .session-preview {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }
      .session-actions {
        display: flex;
        align-items: stretch;
        border-left: 1px solid var(--vscode-panel-border);
      }
      .session-actions button {
        width: 28px;
        min-width: 28px;
        border-radius: 0;
        padding: 0;
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
        padding: 14px 16px;
      }
      .empty {
        color: var(--vscode-descriptionForeground);
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        padding: 14px;
      }
      .message {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr);
        gap: 10px;
        padding: 8px 0 14px;
        margin-bottom: 6px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .message:last-child {
        border-bottom: 0;
      }
      .message-icon {
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        margin-top: 1px;
        border-radius: 50%;
        color: var(--vscode-badge-foreground);
        background: var(--vscode-badge-background);
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
      }
      .message.assistant .message-icon {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      .message.user .message-body {
        width: fit-content;
        max-width: 100%;
        justify-self: end;
        border: 1px solid var(--vscode-input-border);
        border-radius: 8px;
        padding: 8px 10px;
        background: var(--vscode-input-background);
      }
      .message.system {
        color: var(--vscode-descriptionForeground);
      }
      .message.error {
        color: var(--vscode-errorForeground);
      }
      .message.error .message-body {
        border-left: 2px solid var(--vscode-inputValidation-errorBorder);
        padding-left: 10px;
      }
      .message.draft .message-text::after {
        content: "";
        display: inline-block;
        width: 7px;
        height: 1em;
        margin-left: 2px;
        vertical-align: -2px;
        background: var(--vscode-descriptionForeground);
        animation: caretBlink 1s step-end infinite;
      }
      .message-head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 5px;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }
      .message-text {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        line-height: 1.45;
      }
      .message-text > div + div {
        margin-top: 8px;
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
        padding: 12px;
        border-top: 1px solid var(--vscode-panel-border);
      }
      .composer {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: end;
        gap: 8px;
        padding: 6px;
        border: 1px solid var(--vscode-input-border);
        border-radius: 8px;
        background: var(--vscode-input-background);
      }
      input {
        min-width: 0;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
        border-radius: 4px;
        padding: 5px 7px;
        font-family: var(--vscode-font-family);
      }
      textarea {
        min-height: 32px;
        max-height: 160px;
        resize: none;
        color: var(--vscode-input-foreground);
        background: transparent;
        border: 0;
        border-radius: 0;
        padding: 7px 6px;
        font-family: var(--vscode-editor-font-family);
        line-height: 1.35;
        outline: none;
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
      button.icon-button {
        display: grid;
        place-items: center;
        font-size: 14px;
        line-height: 1;
      }
      button.send-button {
        width: 30px;
        height: 30px;
        padding: 0;
        border-radius: 6px;
        font-size: 15px;
      }
      button:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }
      @keyframes caretBlink {
        50% { opacity: 0; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div class="title-row">
          <h1>L2M Agent</h1>
          <button id="newSession" class="secondary" type="button">New</button>
        </div>
        <div class="meta">Session: <span id="sessionId"></span></div>
        <section class="session-history">
          <div class="session-controls">
            <input id="sessionFilter" type="search" placeholder="Search sessions" />
            <button id="branchSession" class="secondary" type="button">Branch</button>
          </div>
          <div id="sessionList" class="session-list"></div>
        </section>
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
        <div class="composer">
          <textarea id="prompt" rows="1" placeholder="Ask L2M Agent..."></textarea>
          <button id="send" class="send-button" type="button" title="Send (Enter)" aria-label="Send prompt">&#8593;</button>
        </div>
      </footer>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const state = ${jsonForScript(state)};
      const messages = document.getElementById("messages");
      const sessionList = document.getElementById("sessionList");
      const sessionFilter = document.getElementById("sessionFilter");
      const pinnedFiles = document.getElementById("pinnedFiles");
      const memoryStatus = document.getElementById("memoryStatus");
      const sessionId = document.getElementById("sessionId");
      const prompt = document.getElementById("prompt");
      const send = document.getElementById("send");
      const newSession = document.getElementById("newSession");
      const branchSession = document.getElementById("branchSession");
      const resetMemory = document.getElementById("resetMemory");
      let currentProgressList = null;
      let currentProgressDetails = null;
      let assistantDraftItem = null;
      let assistantDraftText = "";

      sessionId.textContent = state.sessionId;
      renderSessions();
      renderPinnedFiles();
      renderMemory();
      renderMessages();

      function renderSessions() {
        sessionList.replaceChildren();
        const query = String(sessionFilter.value || "").trim().toLowerCase();
        const sessions = normalizedArray(state.sessions).filter((session) => {
          if (!query) return true;
          return String(session.searchText || session.title || "").toLowerCase().includes(query);
        });

        if (sessions.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "No matching sessions.";
          sessionList.appendChild(empty);
          return;
        }

        for (const session of sessions) {
          const row = document.createElement("div");
          row.className = "session-row" + (session.id === state.sessionId ? " active" : "");

          const pick = document.createElement("button");
          pick.className = "session-pick";
          pick.type = "button";
          pick.title = session.id || "";
          pick.addEventListener("click", () => {
            if (session.id !== state.sessionId) {
              vscode.postMessage({ type: "switchSession", sessionId: session.id });
            }
          });

          const title = document.createElement("span");
          title.className = "session-title";
          title.textContent = session.title || "New chat";
          const preview = document.createElement("span");
          preview.className = "session-preview";
          preview.textContent = buildSessionPreview(session);
          pick.append(title, preview);

          const actions = document.createElement("div");
          actions.className = "session-actions";
          const load = document.createElement("button");
          load.className = "secondary icon-button";
          load.type = "button";
          load.disabled = session.id === state.sessionId;
          setIconButton(load, String.fromCodePoint(0x21bb), "Load session");
          load.addEventListener("click", () => {
            if (session.id !== state.sessionId) {
              vscode.postMessage({ type: "switchSession", sessionId: session.id });
            }
          });
          const rename = document.createElement("button");
          rename.className = "secondary icon-button";
          rename.type = "button";
          setIconButton(rename, String.fromCodePoint(0x270e), "Rename session");
          rename.addEventListener("click", () => {
            vscode.postMessage({ type: "renameSession", sessionId: session.id });
          });
          const remove = document.createElement("button");
          remove.className = "secondary icon-button";
          remove.type = "button";
          setIconButton(remove, String.fromCodePoint(0x1f5d1), "Delete session");
          remove.addEventListener("click", () => {
            vscode.postMessage({ type: "deleteSession", sessionId: session.id });
          });
          actions.append(load, rename, remove);
          row.append(pick, actions);
          sessionList.appendChild(row);
        }
      }

      function buildSessionPreview(session) {
        const count = Number(session.messageCount || 0);
        const pieces = [
          count + " message" + (count === 1 ? "" : "s"),
          session.updatedAt ? formatDateTime(session.updatedAt) : "",
          session.lastMessageText || ""
        ].filter(Boolean);
        return pieces.join(" - ");
      }

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
        updateActiveSessionSummary(message);
        const empty = messages.querySelector(".empty");
        if (empty) empty.remove();
        if (message.role === "assistant" && assistantDraftItem) {
          const rendered = renderMessage(message);
          assistantDraftItem.replaceWith(rendered);
          assistantDraftItem = null;
          assistantDraftText = "";
          messages.scrollTop = messages.scrollHeight;
          return;
        }
        messages.appendChild(renderMessage(message));
        messages.scrollTop = messages.scrollHeight;
      }

      function updateActiveSessionSummary(message) {
        const sessions = normalizedArray(state.sessions);
        const active = sessions.find((session) => session.id === state.sessionId);
        if (!active) return;
        active.messageCount = Number(active.messageCount || 0) + 1;
        active.updatedAt = message.createdAt || new Date().toISOString();
        active.lastMessageText = summarizeForUi(message.text || "", 180);
        active.searchText = String([active.searchText || "", message.text || ""].join(" ")).toLowerCase();
        if ((active.title || "New chat") === "New chat" && message.role === "user") {
          active.title = summarizeForUi(message.text || "", 60) || "New chat";
        }
        renderSessions();
      }

      function renderMessage(message) {
        const item = document.createElement("article");
        item.className = "message " + (message.role || "assistant") + (message.variant === "error" ? " error" : "");

        const icon = document.createElement("div");
        icon.className = "message-icon";
        icon.textContent = roleIcon(message.role || "assistant");

        const body = document.createElement("div");
        body.className = "message-body";
        const head = document.createElement("div");
        head.className = "message-head";
        const role = document.createElement("span");
        role.textContent = message.role || "assistant";
        const time = document.createElement("span");
        time.textContent = formatTime(message.createdAt);
        head.append(role, time);
        body.appendChild(head);

        const text = typeof message.text === "string" ? message.text : "";
        if (text || message.role === "assistant") {
          const textWrap = document.createElement("div");
          textWrap.className = "message-text";
          textWrap.dataset.messageText = "true";
          renderTextWithFences(textWrap, text);
          body.appendChild(textWrap);
        }

        for (const code of normalizedArray(message.codes)) {
          body.appendChild(renderCodeBlock(code));
        }

        const attachments = normalizedArray(message.attachments);
        if (attachments.length) {
          const list = document.createElement("div");
          list.className = "attachments";
          for (const attachment of attachments) {
            list.appendChild(renderAttachment(attachment));
          }
          body.appendChild(list);
        }

        for (const action of normalizedArray(message.actions)) {
          body.appendChild(renderAction(action));
        }

        item.append(icon, body);
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

      function appendAssistantDelta(text) {
        const delta = String(text || "");
        if (!delta) return;
        const draft = ensureAssistantDraft();
        assistantDraftText += delta;
        const textWrap = draft.querySelector("[data-message-text='true']");
        if (textWrap) {
          textWrap.replaceChildren();
          renderTextWithFences(textWrap, assistantDraftText);
        }
        messages.scrollTop = messages.scrollHeight;
      }

      function ensureAssistantDraft() {
        if (assistantDraftItem) return assistantDraftItem;
        const empty = messages.querySelector(".empty");
        if (empty) empty.remove();
        assistantDraftText = "";
        assistantDraftItem = renderMessage({
          id: "__assistant_draft",
          role: "assistant",
          text: "",
          createdAt: new Date().toISOString()
        });
        assistantDraftItem.classList.add("draft");
        messages.appendChild(assistantDraftItem);
        return assistantDraftItem;
      }

      function clearAssistantDraft() {
        if (assistantDraftItem) {
          assistantDraftItem.remove();
        }
        assistantDraftItem = null;
        assistantDraftText = "";
      }

      sessionFilter.addEventListener("input", renderSessions);

      newSession.addEventListener("click", () => {
        vscode.postMessage({ type: "newSession" });
      });

      branchSession.addEventListener("click", () => {
        vscode.postMessage({ type: "branchSession", sessionId: state.sessionId });
      });

      send.addEventListener("click", () => {
        const text = prompt.value.trim();
        if (!text) return;
        prompt.value = "";
        autoResizePrompt();
        vscode.postMessage({ type: "sendPrompt", text });
      });

      resetMemory.addEventListener("click", () => {
        vscode.postMessage({ type: "resetMemory" });
      });

      prompt.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          send.click();
        }
      });
      prompt.addEventListener("input", autoResizePrompt);
      autoResizePrompt();

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "setDraft") {
          prompt.value = message.text || "";
          autoResizePrompt();
          prompt.focus();
        }
        if (message.type === "appendMessage") {
          appendMessage(message.message);
        }
        if (message.type === "assistantDelta") {
          appendAssistantDelta(message.text || "");
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
          clearAssistantDraft();
          ensureAssistantDraft();
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

      function setIconButton(button, icon, label) {
        button.textContent = icon;
        button.title = label;
        button.setAttribute("aria-label", label);
      }

      function roleIcon(role) {
        if (role === "user") return "U";
        if (role === "system") return "S";
        return "A";
      }

      function autoResizePrompt() {
        prompt.style.height = "auto";
        prompt.style.height = Math.min(prompt.scrollHeight, 160) + "px";
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

      function formatDateTime(value) {
        if (!value) return "";
        try {
          return new Date(value).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          });
        } catch { return ""; }
      }

      function summarizeForUi(value, maxChars) {
        const normalized = String(value || "").replace(/\\s+/g, " ").trim();
        if (normalized.length <= maxChars) return normalized;
        return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
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
