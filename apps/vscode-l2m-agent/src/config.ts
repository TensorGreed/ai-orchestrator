import * as vscode from "vscode";
import type { L2MAgentConfig } from "./protocol";

const CONFIG_SECTION = "l2mAgent";
const DEFAULT_API_BASE_URL = "http://localhost:4000";
const DEFAULT_WEBHOOK_PATH = "vscode-l2m-agent";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONTEXT_CHARS = 60_000;
const DEFAULT_MAX_FILE_CHARS = 12_000;
const DEFAULT_MAX_GIT_DIFF_CHARS = 20_000;
const DEFAULT_MAX_DIAGNOSTICS = 50;
const DEFAULT_MAX_OPEN_EDITORS = 10;
const DEFAULT_MAX_PINNED_FILES = 8;
const DEFAULT_NEARBY_LINE_COUNT = 40;
const DEFAULT_RECENT_TURN_COUNT = 12;
const DEFAULT_MAX_COMPACTED_MEMORY_CHARS = 20_000;

export function getL2MAgentConfig(): L2MAgentConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    apiBaseUrl: normalizeBaseUrl(config.get<string>("apiBaseUrl", DEFAULT_API_BASE_URL)),
    workflowId: normalizeString(config.get<string>("workflowId", "")),
    webhookPath: normalizeWebhookPath(config.get<string>("webhookPath", DEFAULT_WEBHOOK_PATH)),
    authToken: normalizeString(config.get<string>("authToken", "")),
    streamResponses: config.get<boolean>("streamResponses", true),
    requestTimeoutMs: normalizeTimeout(config.get<number>("requestTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MS)),
    maxContextChars: normalizeInteger(
      config.get<number>("maxContextChars", DEFAULT_MAX_CONTEXT_CHARS),
      10_000,
      300_000,
      DEFAULT_MAX_CONTEXT_CHARS
    ),
    maxFileChars: normalizeInteger(
      config.get<number>("maxFileChars", DEFAULT_MAX_FILE_CHARS),
      1_000,
      80_000,
      DEFAULT_MAX_FILE_CHARS
    ),
    maxGitDiffChars: normalizeInteger(
      config.get<number>("maxGitDiffChars", DEFAULT_MAX_GIT_DIFF_CHARS),
      1_000,
      120_000,
      DEFAULT_MAX_GIT_DIFF_CHARS
    ),
    maxDiagnostics: normalizeInteger(
      config.get<number>("maxDiagnostics", DEFAULT_MAX_DIAGNOSTICS),
      0,
      500,
      DEFAULT_MAX_DIAGNOSTICS
    ),
    maxOpenEditors: normalizeInteger(
      config.get<number>("maxOpenEditors", DEFAULT_MAX_OPEN_EDITORS),
      0,
      100,
      DEFAULT_MAX_OPEN_EDITORS
    ),
    maxPinnedFiles: normalizeInteger(
      config.get<number>("maxPinnedFiles", DEFAULT_MAX_PINNED_FILES),
      0,
      50,
      DEFAULT_MAX_PINNED_FILES
    ),
    nearbyLineCount: normalizeInteger(
      config.get<number>("nearbyLineCount", DEFAULT_NEARBY_LINE_COUNT),
      0,
      200,
      DEFAULT_NEARBY_LINE_COUNT
    ),
    recentTurnCount: normalizeInteger(
      config.get<number>("recentTurnCount", DEFAULT_RECENT_TURN_COUNT),
      2,
      50,
      DEFAULT_RECENT_TURN_COUNT
    ),
    maxCompactedMemoryChars: normalizeInteger(
      config.get<number>("maxCompactedMemoryChars", DEFAULT_MAX_COMPACTED_MEMORY_CHARS),
      1_000,
      100_000,
      DEFAULT_MAX_COMPACTED_MEMORY_CHARS
    )
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = normalizeString(value);
  return (trimmed || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function normalizeString(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWebhookPath(value: string | undefined): string {
  return (normalizeString(value) || DEFAULT_WEBHOOK_PATH).replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  return Math.max(5_000, Math.min(30 * 60_000, Math.floor(value)));
}

function normalizeInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}
