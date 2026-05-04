import * as path from "node:path";

interface Hunk {
  oldStart: number;
  lines: string[];
}

export interface ResolvedWorkspacePath {
  relativePath: string;
  absolutePath: string;
}

export function resolveWorkspacePath(workspaceRootPath: string, filePath: string): ResolvedWorkspacePath {
  const root = path.resolve(workspaceRootPath);
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  if (!isSubpath(root, absolutePath)) {
    throw new Error(`Action target is outside the workspace: ${filePath}`);
  }

  return {
    relativePath: path.relative(root, absolutePath).replace(/\\/g, "/"),
    absolutePath
  };
}

export function extractPatchFile(diff: string, explicitFile: string | undefined): string {
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

export function validateSingleFilePatch(diff: string, targetPath: string): void {
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

export function applyUnifiedDiff(originalText: string, diff: string): string {
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
