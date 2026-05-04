import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  applyUnifiedDiff,
  extractPatchFile,
  resolveWorkspacePath,
  validateSingleFilePatch
} from "./patchUtils";
import type { ActionResult, ChatAction } from "./protocol";

const PREVIEW_SCHEME = "l2m-agent-preview";

interface ResolvedTarget {
  workspaceFolder: vscode.WorkspaceFolder;
  relativePath: string;
  uri: vscode.Uri;
}

export class ActionService implements vscode.TextDocumentContentProvider {
  private readonly previewDocuments = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this)
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.previewDocuments.get(uri.toString()) ?? "";
  }

  async previewAction(action: ChatAction): Promise<ActionResult> {
    if (action.type === "command") {
      const preview = [
        `Command: ${action.command ?? ""}`,
        action.cwd ? `Working directory: ${action.cwd}` : ""
      ].filter(Boolean).join("\n");
      const uri = this.createPreviewDocument("command-preview.txt", preview);
      await vscode.window.showTextDocument(uri, { preview: true });
      return this.createResult(action, "pending", "Opened command preview.");
    }

    const patch = await this.resolvePatch(action);
    const originalText = await this.readTextIfExists(patch.uri);
    const previewText = applyUnifiedDiff(originalText, patch.diff);
    const originalUri = originalText === ""
      ? this.createPreviewDocument(`${patch.relativePath}.original`, "")
      : patch.uri;
    const previewUri = this.createPreviewDocument(patch.relativePath, previewText);
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      previewUri,
      `L2M Patch Preview: ${patch.relativePath}`
    );
    return this.createResult(action, "pending", `Opened patch preview for ${patch.relativePath}.`, {
      file: patch.relativePath
    });
  }

  async runAction(action: ChatAction): Promise<ActionResult> {
    if (action.type === "command") {
      return this.runCommand(action);
    }

    return this.applyPatch(action);
  }

  private async applyPatch(action: ChatAction): Promise<ActionResult> {
    const patch = await this.resolvePatch(action);
    const approval = await vscode.window.showWarningMessage(
      `Apply L2M patch to ${patch.relativePath}?`,
      { modal: true },
      "Apply Patch"
    );
    if (approval !== "Apply Patch") {
      return this.createResult(action, "rejected", `Patch rejected for ${patch.relativePath}.`, {
        file: patch.relativePath
      });
    }

    const originalText = await this.readTextIfExists(patch.uri);
    const nextText = applyUnifiedDiff(originalText, patch.diff);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(patch.uri.fsPath)));
    await vscode.workspace.fs.writeFile(patch.uri, Buffer.from(nextText, "utf8"));

    return this.createResult(action, "applied", `Applied patch to ${patch.relativePath}.`, {
      file: patch.relativePath
    });
  }

  private async runCommand(action: ChatAction): Promise<ActionResult> {
    const command = action.command?.trim();
    if (!command) {
      return this.createResult(action, "failed", "Command action did not include a command.");
    }

    const approval = await vscode.window.showWarningMessage(
      `Run L2M command in a VS Code terminal?\n\n${command}`,
      { modal: true },
      "Run Command"
    );
    if (approval !== "Run Command") {
      return this.createResult(action, "rejected", "Command rejected.", {
        command
      });
    }

    const cwd = this.resolveCommandCwd(action.cwd);
    const terminal = vscode.window.createTerminal({
      name: "L2M Agent Action",
      cwd: cwd?.fsPath
    });
    terminal.show();
    terminal.sendText(command, true);

    return this.createResult(action, "running", "Started command in VS Code terminal.", {
      command,
      cwd: cwd?.fsPath
    });
  }

  private async resolvePatch(action: ChatAction): Promise<{ relativePath: string; uri: vscode.Uri; diff: string }> {
    const diff = action.diff?.trim();
    if (!diff) {
      throw new Error("Patch action did not include a unified diff.");
    }

    const relativePath = extractPatchFile(diff, action.file);
    if (!relativePath) {
      throw new Error("Patch action did not include a target file.");
    }

    const target = resolveWorkspaceTarget(relativePath);
    validateSingleFilePatch(diff, target.relativePath);
    return {
      relativePath: target.relativePath,
      uri: target.uri,
      diff
    };
  }

  private resolveCommandCwd(value: string | undefined): vscode.Uri | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder || !value?.trim()) {
      return workspaceFolder?.uri;
    }

    const target = resolveWorkspaceTarget(value);
    return target.uri;
  }

  private async readTextIfExists(uri: vscode.Uri): Promise<string> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return "";
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  }

  private createPreviewDocument(label: string, content: string): vscode.Uri {
    const safeLabel = sanitizePreviewPath(label);
    const uri = vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      path: `/${crypto.randomUUID()}-${safeLabel}`
    });
    this.previewDocuments.set(uri.toString(), content);
    this.changeEmitter.fire(uri);
    return uri;
  }

  private createResult(
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
}

function resolveWorkspaceTarget(filePath: string): ResolvedTarget {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("No workspace folder is open.");
  }

  const resolved = resolveWorkspacePath(workspaceFolder.uri.fsPath, filePath);
  return {
    workspaceFolder,
    relativePath: resolved.relativePath,
    uri: vscode.Uri.file(resolved.absolutePath)
  };
}

function sanitizePreviewPath(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "preview.txt";
}
