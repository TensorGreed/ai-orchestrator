import * as crypto from "node:crypto";
import type { ChatAction, ChatAttachment, ChatCodeBlock, ParsedAssistantResponse } from "./protocol";

export function parseAssistantResponse(value: unknown): ParsedAssistantResponse {
  const record = findPrimaryRecord(value, 0);
  const text = extractText(record ?? value, 0);
  const codes = dedupeCodes(harvestCodes(record ?? value, 0));
  const attachments = dedupeAttachments(harvestAttachments(record ?? value, 0));
  const actions = dedupeActions(harvestActions(record ?? value, 0));
  const contextUpdate = extractContextUpdate(record ?? value, 0);
  const fallback = text || (codes.length || attachments.length || actions.length ? "" : stringifyFallback(value));

  return {
    text: fallback,
    codes,
    attachments,
    actions,
    contextUpdate
  };
}

function findPrimaryRecord(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 8 || value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    return parsed ? findPrimaryRecord(parsed, depth + 1) : null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (hasResponseShape(record)) {
    return record;
  }

  for (const key of ["output", "result", "answer", "data", "response"]) {
    const nested = findPrimaryRecord(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return record;
}

function hasResponseShape(record: Record<string, unknown>): boolean {
  return [
    "message",
    "answer",
    "text",
    "content",
    "response",
    "follow_up_question",
    "final_html",
    "python_code",
    "codes",
    "attachments",
    "pdf",
    "actions",
    "context_update",
    "contextUpdate"
  ].some((key) => key in record);
}

function extractText(value: unknown, depth: number): string {
  if (depth > 8 || value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    return parsed ? extractText(parsed, depth + 1) || value : value;
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

  const actionSummary = summarizeActions(record.actions);
  if (actionSummary) {
    return actionSummary;
  }

  for (const key of ["output", "result", "answer", "data"]) {
    const nested = extractText(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function harvestCodes(value: unknown, depth: number): ChatCodeBlock[] {
  if (depth > 8 || value === undefined || value === null) {
    return [];
  }

  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    return parsed ? harvestCodes(parsed, depth + 1) : [];
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const codes: ChatCodeBlock[] = [];
  for (const [key, raw] of Object.entries(record)) {
    const match = /^([\w+-]+)_code$/i.exec(key);
    if (match && typeof raw === "string" && raw.trim()) {
      codes.push({ language: normalizeLanguage(match[1] ?? ""), source: raw });
    }
  }

  const code = record.code;
  if (typeof code === "string" && code.trim()) {
    codes.push({
      language: normalizeLanguage(record.code_language ?? record.language),
      source: code
    });
  } else if (code && typeof code === "object" && !Array.isArray(code)) {
    const codeRecord = code as Record<string, unknown>;
    if (typeof codeRecord.source === "string" && codeRecord.source.trim()) {
      codes.push({
        language: normalizeLanguage(codeRecord.language),
        source: codeRecord.source,
        label: typeof codeRecord.label === "string" ? codeRecord.label : undefined
      });
    }
  }

  if (Array.isArray(record.codes)) {
    for (const entry of record.codes) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const codeRecord = entry as Record<string, unknown>;
      if (typeof codeRecord.source === "string" && codeRecord.source.trim()) {
        codes.push({
          language: normalizeLanguage(codeRecord.language),
          source: codeRecord.source,
          label: typeof codeRecord.label === "string" ? codeRecord.label : undefined
        });
      }
    }
  }

  for (const key of ["output", "result", "answer", "data"]) {
    codes.push(...harvestCodes(record[key], depth + 1));
  }

  return codes;
}

function harvestActions(value: unknown, depth: number): ChatAction[] {
  if (depth > 8 || value === undefined || value === null) {
    return [];
  }

  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    return parsed ? harvestActions(parsed, depth + 1) : [];
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const actions: ChatAction[] = [];
  if (Array.isArray(record.actions)) {
    for (const entry of record.actions) {
      const action = normalizeAction(entry);
      if (action) {
        actions.push(action);
      }
    }
  }

  if (Array.isArray(record.patches)) {
    for (const entry of record.patches) {
      const action = normalizeAction(withDefaultType(entry, "patch"));
      if (action) {
        actions.push(action);
      }
    }
  }

  if (Array.isArray(record.commands)) {
    for (const entry of record.commands) {
      const action = normalizeAction(withDefaultType(entry, "command"));
      if (action) {
        actions.push(action);
      }
    }
  }

  const patch = typeof record.patch === "string"
    ? normalizeAction({ type: "patch", diff: record.patch, file: record.file, title: record.title })
    : normalizeAction(withDefaultType(record.patch, "patch"));
  if (patch) {
    actions.push(patch);
  }

  const command = normalizeAction(withDefaultType(record.command, "command"));
  if (command) {
    actions.push(command);
  }

  for (const key of ["output", "result", "answer", "data", "response"]) {
    actions.push(...harvestActions(record[key], depth + 1));
  }

  return actions;
}

function withDefaultType(value: unknown, type: ChatAction["type"]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return {
    type,
    ...value as Record<string, unknown>
  };
}

function normalizeAction(value: unknown): ChatAction | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string" && value.trim()) {
    return {
      id: crypto.randomUUID(),
      type: "command",
      title: value.trim(),
      command: value.trim(),
      requiresApproval: true,
      status: "pending"
    };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const rawType = firstString(record.type, record.action, record.kind).toLowerCase();
  const command = firstString(record.command, record.cmd, record.shell);
  const diff = firstString(record.diff, record.patch, record.unifiedDiff);
  const file = firstString(record.file, record.path, record.filename, record.target);

  if (rawType.includes("command") || command) {
    if (!command) {
      return null;
    }

    return {
      id: firstString(record.id) || crypto.randomUUID(),
      type: "command",
      title: firstString(record.title, record.name) || command,
      description: firstString(record.description, record.summary) || undefined,
      command,
      cwd: firstString(record.cwd, record.workingDirectory) || undefined,
      requiresApproval: record.requiresApproval !== false,
      status: "pending"
    };
  }

  if (rawType.includes("patch") || rawType.includes("edit") || diff) {
    if (!diff) {
      return null;
    }

    return {
      id: firstString(record.id) || crypto.randomUUID(),
      type: "patch",
      title: firstString(record.title, record.name) || `Patch ${file || "workspace"}`,
      description: firstString(record.description, record.summary) || undefined,
      file: file || undefined,
      diff,
      requiresApproval: record.requiresApproval !== false,
      status: "pending"
    };
  }

  return null;
}

function extractContextUpdate(value: unknown, depth: number): string {
  if (depth > 8 || value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    return parsed ? extractContextUpdate(parsed, depth + 1) : "";
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const record = value as Record<string, unknown>;
  for (const key of ["context_update", "contextUpdate", "memory_update", "memoryUpdate"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }

  for (const key of ["output", "result", "answer", "data", "response"]) {
    const nested = extractContextUpdate(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function harvestAttachments(value: unknown, depth: number): ChatAttachment[] {
  if (depth > 8 || value === undefined || value === null) {
    return [];
  }

  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    return parsed ? harvestAttachments(parsed, depth + 1) : [];
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const attachments: ChatAttachment[] = [];
  if (Array.isArray(record.attachments)) {
    for (const entry of record.attachments) {
      const attachment = normalizeAttachment(entry);
      if (attachment) {
        attachments.push(attachment);
      }
    }
  }

  for (const key of ["pdf", "csv", "excel", "file", "report"]) {
    const raw = record[key];
    if (typeof raw === "string" && raw.startsWith("data:")) {
      const attachment = normalizeAttachment({ downloadUrl: raw, filename: record[`${key}_filename`] });
      if (attachment) {
        attachments.push(attachment);
      }
    } else {
      const attachment = normalizeAttachment(raw);
      if (attachment) {
        attachments.push(attachment);
      }
    }
  }

  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw.startsWith("data:") && /url$|_url$/i.test(key)) {
      const attachment = normalizeAttachment({ downloadUrl: raw });
      if (attachment) {
        attachments.push(attachment);
      }
    }
  }

  for (const key of ["output", "result", "answer", "data"]) {
    attachments.push(...harvestAttachments(record[key], depth + 1));
  }

  return attachments;
}

function normalizeAttachment(value: unknown): ChatAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const directUrl = firstString(record.downloadUrl, record.dataUrl, record.url);
  const mimeType = firstString(record.mimeType, mimeFromDataUrl(directUrl)) || "application/octet-stream";
  const downloadUrl =
    directUrl ||
    (typeof record.base64 === "string" && record.base64.trim()
      ? `data:${mimeType};base64,${record.base64.trim()}`
      : "");
  if (!downloadUrl) {
    return null;
  }

  return {
    filename: firstString(record.filename, record.name) || defaultFilename(mimeType),
    mimeType,
    downloadUrl,
    sizeBytes: typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes)
      ? record.sizeBytes
      : undefined
  };
}

function dedupeCodes(codes: ChatCodeBlock[]): ChatCodeBlock[] {
  const seen = new Set<string>();
  return codes.filter((code) => {
    const key = `${code.language}\n${code.source}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    if (seen.has(attachment.downloadUrl)) {
      return false;
    }
    seen.add(attachment.downloadUrl);
    return true;
  });
}

function dedupeActions(actions: ChatAction[]): ChatAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = [action.type, action.file ?? "", action.command ?? "", action.diff ?? ""].join("\n");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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

function normalizeLanguage(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    sh: "bash",
    shell: "bash"
  };
  return aliases[raw] ?? raw;
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

  return `L2M returned actions:\n${labels}\n\nReview and approve actions below before they change the workspace or run commands.`;
}

function stringifyFallback(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function mimeFromDataUrl(value: string): string {
  const match = /^data:([^;,]+)/i.exec(value);
  return match ? match[1].toLowerCase() : "";
}

function defaultFilename(mimeType: string): string {
  const extensions: Record<string, string> = {
    "application/pdf": "pdf",
    "application/json": "json",
    "text/csv": "csv",
    "text/plain": "txt",
    "text/html": "html"
  };
  return `attachment.${extensions[mimeType] ?? "bin"}`;
}
