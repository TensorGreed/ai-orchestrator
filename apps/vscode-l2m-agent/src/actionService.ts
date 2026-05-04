import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ActionResult, ChatAction } from "./protocol";

const PREVIEW_SCHEME = "l2m-agent-preview";

interface ResolvedTarget {
  workspaceFolder: vscode.WorkspaceFolder;
  relativePath: string;
  uri: vscode.Uri;
}

interface Hunk {
  oldStart: number;
  lines: string[];
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

  const root = path.resolve(workspaceFolder.uri.fsPath);
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  if (!isSubpath(root, absolutePath)) {
    throw new Error(`Action target is outside the workspace: ${filePath}`);
  }

  return {
    workspaceFolder,
    relativePath: path.relative(root, absolutePath).replace(/\\/g, "/"),
    uri: vscode.Uri.file(absolutePath)
  };
}

function extractPatchFile(diff: string, explicitFile: string | undefined): string {
  if (explicitFile?.trim()) {
    return normalizeDiffPath(explicitFile);
  }

  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim().split(/\s+/)[0] ?? "";
      if (value && value !== "/dev/null") {
        return normalizeDiffPath(value);
      }
    }
  }

  return "";
}

function validateSingleFilePatch(diff: string, targetPath: string): void {
  const targets = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("+++ ")) {
      continue;
    }

    const value = line.slice(4).trim().split(/\s+/)[0] ?? "";
    if (value && value !== "/dev/null") {
      targets.add(normalizeDiffPath(value));
    }
  }

  if (targets.size > 1) {
    throw new Error("Only single-file patches are supported in one action.");
  }

  const onlyTarget = [...targets][0];
  if (onlyTarget && normalizeSlashes(onlyTarget) !== normalizeSlashes(targetPath)) {
    throw new Error(`Patch target ${onlyTarget} does not match action file ${targetPath}.`);
  }
}

function applyUnifiedDiff(originalText: string, diff: string): string {
  const originalLines = splitLines(originalText);
  const hunks = parseHunks(diff);
  if (hunks.length === 0) {
    throw new Error("Patch did not include any unified diff hunks.");
  }

  const result: string[] = [];
  let sourceIndex = 0;

  for (const hunk of hunks) {
    const expectedIndex = Math.max(0, hunk.oldStart - 1);
    while (sourceIndex < expectedIndex && sourceIndex < originalLines.length) {
      result.push(originalLines[sourceIndex] ?? "");
      sourceIndex += 1;
    }

    for (const line of hunk.lines) {
      if (line.startsWith("\\ No newline")) {
        continue;
      }

      const marker = line[0];
      const content = line.slice(1);
      if (marker === " ") {
        assertLineMatches(originalLines[sourceIndex], content);
        result.push(content);
        sourceIndex += 1;
      } else if (marker === "-") {
        assertLineMatches(originalLines[sourceIndex], content);
        sourceIndex += 1;
      } else if (marker === "+") {
        result.push(content);
      }
    }
  }

  while (sourceIndex < originalLines.length) {
    result.push(originalLines[sourceIndex] ?? "");
    sourceIndex += 1;
  }

  return result.join("\n");
}

function parseHunks(diff: string): Hunk[] {
  const lines = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[index] ?? "");
    if (!header) {
      index += 1;
      continue;
    }

    const hunk: Hunk = {
      oldStart: Number(header[1]),
      lines: []
    };
    index += 1;

    while (index < lines.length && !/^@@ /.test(lines[index] ?? "")) {
      const line = lines[index] ?? "";
      if (/^(diff --git |--- |\+\+\+ )/.test(line)) {
        break;
      }
      if (/^[ +\-\\]/.test(line)) {
        hunk.lines.push(line);
      }
      index += 1;
    }

    hunks.push(hunk);
  }

  return hunks;
}

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }

  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
}

function assertLineMatches(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new Error(`Patch context mismatch. Expected "${expected}" but found "${actual ?? "<end of file>"}".`);
  }
}

function normalizeDiffPath(value: string): string {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isSubpath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizePreviewPath(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "preview.txt";
}
