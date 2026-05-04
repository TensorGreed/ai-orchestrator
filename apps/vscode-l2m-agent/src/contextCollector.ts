import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { L2MAgentConfig } from "./protocol";

interface LimitedText {
  text: string;
  truncated: boolean;
  originalChars: number;
  includedChars: number;
}

interface FileReadResult {
  text: string;
  readTruncated: boolean;
  binary: boolean;
  sizeBytes: number;
}

export async function collectWorkspaceContext(
  config: L2MAgentConfig,
  pinnedFiles: string[]
): Promise<Record<string, unknown>> {
  const budget = new ContextBudget(config.maxContextChars);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0] ?? null;

  const [activeFile, git, pinnedFileContexts] = await Promise.all([
    collectActiveFile(config, budget),
    collectGitContext(workspaceFolder, config, budget),
    collectPinnedFiles(workspaceFolder, pinnedFiles, config, budget)
  ]);

  return {
    workspace: collectWorkspaceMetadata(workspaceFolder),
    activeFile,
    openFiles: collectOpenFiles(config),
    diagnostics: collectDiagnostics(config, budget),
    git,
    pinnedFiles: pinnedFileContexts,
    contextBudget: budget.toJSON()
  };
}

function collectWorkspaceMetadata(workspaceFolder: vscode.WorkspaceFolder | null): Record<string, unknown> | null {
  if (!workspaceFolder) {
    return null;
  }

  return {
    name: workspaceFolder.name,
    path: workspaceFolder.uri.fsPath,
    folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath
    }))
  };
}

function collectActiveFile(config: L2MAgentConfig, budget: ContextBudget): Record<string, unknown> | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }

  const document = editor.document;
  const selection = editor.selection;
  const nearbyRange = getNearbyRange(document, selection, config.nearbyLineCount);
  const selectionText = selection.isEmpty ? "" : document.getText(selection);
  const nearbyText = document.getText(nearbyRange);

  return {
    path: workspaceRelativePath(document.uri),
    uriScheme: document.uri.scheme,
    languageId: document.languageId,
    isDirty: document.isDirty,
    lineCount: document.lineCount,
    selection: {
      isEmpty: selection.isEmpty,
      start: positionToContext(selection.start),
      end: positionToContext(selection.end),
      text: budget.take("activeFile.selection", selectionText, config.maxFileChars)
    },
    nearby: {
      startLine: nearbyRange.start.line + 1,
      endLine: nearbyRange.end.line + 1,
      text: budget.take("activeFile.nearby", nearbyText, config.maxFileChars)
    }
  };
}

function collectOpenFiles(config: L2MAgentConfig): Array<Record<string, unknown>> {
  if (config.maxOpenEditors <= 0) {
    return [];
  }

  const visibleByUri = new Map(
    vscode.window.visibleTextEditors.map((editor) => [editor.document.uri.toString(), editor])
  );
  const openFiles = new Map<string, Record<string, unknown>>();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = getTabUri(tab.input);
      if (!uri || openFiles.has(uri.toString())) {
        continue;
      }

      const visibleEditor = visibleByUri.get(uri.toString());
      openFiles.set(uri.toString(), {
        path: workspaceRelativePath(uri),
        uriScheme: uri.scheme,
        isActive: tab.isActive,
        isDirty: tab.isDirty,
        languageId: visibleEditor?.document.languageId ?? undefined
      });
    }
  }

  if (openFiles.size === 0) {
    for (const editor of vscode.window.visibleTextEditors) {
      openFiles.set(editor.document.uri.toString(), {
        path: workspaceRelativePath(editor.document.uri),
        uriScheme: editor.document.uri.scheme,
        isActive: editor === vscode.window.activeTextEditor,
        isDirty: editor.document.isDirty,
        languageId: editor.document.languageId
      });
    }
  }

  return [...openFiles.values()].slice(0, config.maxOpenEditors);
}

function collectDiagnostics(config: L2MAgentConfig, budget: ContextBudget): Array<Record<string, unknown>> {
  if (config.maxDiagnostics <= 0) {
    return [];
  }

  const diagnostics: Array<Record<string, unknown>> = [];
  const entries = vscode.languages.getDiagnostics();

  for (const [uri, fileDiagnostics] of entries) {
    if (!isWorkspaceUri(uri)) {
      continue;
    }

    const sortedDiagnostics = [...fileDiagnostics].sort((a, b) => a.severity - b.severity);
    for (const diagnostic of sortedDiagnostics) {
      if (diagnostics.length >= config.maxDiagnostics) {
        return diagnostics;
      }

      const message = budget.take("diagnostics.message", diagnostic.message, 500);
      diagnostics.push({
        path: workspaceRelativePath(uri),
        severity: diagnosticSeverityName(diagnostic.severity),
        source: diagnostic.source,
        code: diagnosticCodeToString(diagnostic.code),
        range: {
          start: positionToContext(diagnostic.range.start),
          end: positionToContext(diagnostic.range.end)
        },
        message
      });
    }
  }

  return diagnostics;
}

async function collectGitContext(
  workspaceFolder: vscode.WorkspaceFolder | null,
  config: L2MAgentConfig,
  budget: ContextBudget
): Promise<Record<string, unknown> | null> {
  if (!workspaceFolder) {
    return null;
  }

  const cwd = workspaceFolder.uri.fsPath;
  const root = firstLine(await runGit(cwd, ["rev-parse", "--show-toplevel"]));
  if (!root) {
    return {
      available: false,
      reason: "not a git workspace or git is unavailable"
    };
  }

  const [branch, status, unstagedDiff, stagedDiff] = await Promise.all([
    runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(root, ["status", "--short"]),
    runGit(root, ["diff", "--no-ext-diff", "--"]),
    runGit(root, ["diff", "--cached", "--no-ext-diff", "--"])
  ]);
  const normalizedUnstaged = normalizeNewlines(unstagedDiff);
  const normalizedStaged = normalizeNewlines(stagedDiff);
  const firstDiffLimit = normalizedStaged ? Math.floor(config.maxGitDiffChars / 2) : config.maxGitDiffChars;
  const unstaged = budget.take("git.diff.unstaged", normalizedUnstaged, firstDiffLimit);
  const stagedLimit = Math.max(0, config.maxGitDiffChars - unstaged.includedChars);

  return {
    available: true,
    root: normalizePath(root),
    branch: firstLine(branch),
    status: budget.take("git.status", normalizeNewlines(status), 8_000),
    diff: {
      unstaged,
      staged: budget.take("git.diff.staged", normalizedStaged, stagedLimit)
    }
  };
}

async function collectPinnedFiles(
  workspaceFolder: vscode.WorkspaceFolder | null,
  pinnedFiles: string[],
  config: L2MAgentConfig,
  budget: ContextBudget
): Promise<Array<Record<string, unknown>>> {
  if (!workspaceFolder || config.maxPinnedFiles <= 0) {
    return [];
  }

  const contexts: Array<Record<string, unknown>> = [];
  for (const pinned of pinnedFiles.slice(0, config.maxPinnedFiles)) {
    const resolved = resolvePinnedFile(workspaceFolder, pinned);
    if (!resolved) {
      contexts.push({
        path: pinned,
        skipped: true,
        reason: "outside workspace"
      });
      continue;
    }

    contexts.push(await collectPinnedFile(resolved.uri, resolved.path, config, budget));
  }

  return contexts;
}

async function collectPinnedFile(
  uri: vscode.Uri,
  relativePath: string,
  config: L2MAgentConfig,
  budget: ContextBudget
): Promise<Record<string, unknown>> {
  try {
    const openDocument = vscode.workspace.textDocuments.find((document) => sameUri(document.uri, uri));
    if (openDocument) {
      return {
        path: relativePath,
        uriScheme: uri.scheme,
        languageId: openDocument.languageId,
        isDirty: openDocument.isDirty,
        source: "openDocument",
        content: budget.take(`pinnedFiles.${relativePath}`, openDocument.getText(), config.maxFileChars)
      };
    }

    const read = await readTextFilePrefix(uri.fsPath, config.maxFileChars);
    if (read.binary) {
      return {
        path: relativePath,
        uriScheme: uri.scheme,
        skipped: true,
        reason: "binary file",
        sizeBytes: read.sizeBytes
      };
    }

    const content = budget.take(`pinnedFiles.${relativePath}`, read.text, config.maxFileChars);
    return {
      path: relativePath,
      uriScheme: uri.scheme,
      source: "disk",
      sizeBytes: read.sizeBytes,
      readTruncated: read.readTruncated,
      content: read.readTruncated ? { ...content, truncated: true } : content
    };
  } catch (error) {
    return {
      path: relativePath,
      uriScheme: uri.scheme,
      skipped: true,
      reason: error instanceof Error ? error.message : "failed to read file"
    };
  }
}

function getNearbyRange(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  nearbyLineCount: number
): vscode.Range {
  const radius = Math.max(0, nearbyLineCount);
  const startLine = Math.max(0, selection.start.line - radius);
  const endLine = Math.min(document.lineCount - 1, selection.end.line + radius);
  const endCharacter = document.lineAt(endLine).range.end.character;
  return new vscode.Range(startLine, 0, endLine, endCharacter);
}

async function readTextFilePrefix(filePath: string, maxChars: number): Promise<FileReadResult> {
  const stat = await fs.stat(filePath);
  const maxBytes = Math.min(stat.size, Math.max(maxChars * 4, 8_192), 1_000_000);
  if (maxBytes <= 0) {
    return {
      text: "",
      readTruncated: false,
      binary: false,
      sizeBytes: stat.size
    };
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const slice = buffer.subarray(0, bytesRead);
    return {
      text: slice.toString("utf8"),
      readTruncated: stat.size > bytesRead,
      binary: isLikelyBinary(slice),
      sizeBytes: stat.size
    };
  } finally {
    await handle.close();
  }
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    const isAllowedControl = byte === 9 || byte === 10 || byte === 13 || byte === 27;
    if (byte < 32 && !isAllowedControl) {
      suspicious += 1;
    }
  }

  return suspicious / sample.length > 0.08;
}

function resolvePinnedFile(
  workspaceFolder: vscode.WorkspaceFolder,
  pinned: string
): { uri: vscode.Uri; path: string } | null {
  const workspaceRoot = path.resolve(workspaceFolder.uri.fsPath);
  const absolute = path.isAbsolute(pinned)
    ? path.resolve(pinned)
    : path.resolve(workspaceRoot, pinned);
  if (!isSubpath(workspaceRoot, absolute)) {
    return null;
  }

  return {
    uri: vscode.Uri.file(absolute),
    path: path.relative(workspaceRoot, absolute).replace(/\\/g, "/")
  };
}

function isSubpath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function getTabUri(input: unknown): vscode.Uri | null {
  if (!input || typeof input !== "object" || !("uri" in input)) {
    return null;
  }

  const uri = (input as { uri?: unknown }).uri;
  return isUri(uri) ? uri : null;
}

function isUri(value: unknown): value is vscode.Uri {
  return !!value
    && typeof value === "object"
    && typeof (value as vscode.Uri).scheme === "string"
    && typeof (value as vscode.Uri).toString === "function";
}

function isWorkspaceUri(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") {
    return false;
  }

  return !!vscode.workspace.getWorkspaceFolder(uri);
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function workspaceRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || uri.scheme !== "file") {
    return uri.toString();
  }

  return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
}

function positionToContext(position: vscode.Position): Record<string, number> {
  return {
    line: position.line + 1,
    character: position.character + 1
  };
}

function diagnosticSeverityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "unknown";
  }
}

function diagnosticCodeToString(code: vscode.Diagnostic["code"]): string | undefined {
  if (code === undefined || code === null) {
    return undefined;
  }

  if (typeof code === "object" && "value" in code) {
    return String(code.value);
  }

  return String(code);
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: 5_000,
        maxBuffer: 2_000_000,
        windowsHide: true
      },
      (error, stdout) => {
        resolve(error ? "" : stdout);
      }
    );
  });
}

function firstLine(value: string): string {
  return normalizeNewlines(value).split("\n")[0]?.trim() ?? "";
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

class ContextBudget {
  private usedChars = 0;
  private readonly truncatedItems: string[] = [];

  constructor(private readonly maxChars: number) {}

  take(label: string, value: string, itemMaxChars: number): LimitedText {
    const normalized = normalizeNewlines(value);
    const originalChars = normalized.length;
    const remaining = Math.max(0, this.maxChars - this.usedChars);
    const allowedChars = Math.max(0, Math.min(itemMaxChars, remaining));

    if (originalChars <= allowedChars) {
      this.usedChars += originalChars;
      return {
        text: normalized,
        truncated: false,
        originalChars,
        includedChars: originalChars
      };
    }

    const suffix = `\n\n[truncated ${Math.max(0, originalChars - allowedChars)} chars from ${label}]`;
    const prefixLength = Math.max(0, allowedChars - suffix.length);
    const text = allowedChars <= 0
      ? ""
      : `${normalized.slice(0, prefixLength)}${suffix}`.slice(0, allowedChars);
    this.usedChars += text.length;
    this.truncatedItems.push(label);

    return {
      text,
      truncated: true,
      originalChars,
      includedChars: text.length
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      maxChars: this.maxChars,
      usedChars: this.usedChars,
      remainingChars: Math.max(0, this.maxChars - this.usedChars),
      truncated: this.truncatedItems.length > 0,
      truncatedItems: [...new Set(this.truncatedItems)]
    };
  }
}
