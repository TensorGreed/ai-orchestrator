import * as vscode from "vscode";
import type { L2MAgentConfig } from "./protocol";

const CONFIG_SECTION = "l2mAgent";
const DEFAULT_API_BASE_URL = "http://localhost:4000";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function getL2MAgentConfig(): L2MAgentConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    apiBaseUrl: normalizeBaseUrl(config.get<string>("apiBaseUrl", DEFAULT_API_BASE_URL)),
    workflowId: normalizeString(config.get<string>("workflowId", "")),
    authToken: normalizeString(config.get<string>("authToken", "")),
    streamResponses: config.get<boolean>("streamResponses", true),
    requestTimeoutMs: normalizeTimeout(config.get<number>("requestTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MS))
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = normalizeString(value);
  return (trimmed || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function normalizeString(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  return Math.max(5_000, Math.min(30 * 60_000, Math.floor(value)));
}
