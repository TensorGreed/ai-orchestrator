/**
 * Phase 12.4 — safe argument summaries for MCP tool-call telemetry.
 *
 * Binds the mcp-sdk summariser to:
 *   - the detectors production capture masks with: the guard SDK's DLP
 *     patterns plus the international phone detector (`scanForCapture`), read
 *     over the decoded view of each string, so a URL-encoded or JSON-escaped
 *     value is found as well;
 *   - the summary hash key: HKDF-SHA-256 of the master key with its own info
 *     label (`l2m/tool-argument-summary/v1`), the same mechanism as the
 *     capture surrogate key. The API does not start without a valid master
 *     key (SecretService refuses), so a running server always derives the key
 *     from it.
 *
 * Returns null when summaries are switched off (MCP_TOOL_ARGUMENT_SUMMARIES=false)
 * and when the arguments cannot be summarised; a summary never fails a call
 * or its telemetry row.
 */

import { hkdfSync, randomBytes } from "node:crypto";
import { decodeView, scanForCapture } from "@ai-orchestrator/guard-sdk";
import { hashToolArgumentValue, summarizeToolArguments, type ToolArgumentDetector } from "@ai-orchestrator/mcp-sdk";
import type { ToolArgumentSummary } from "@ai-orchestrator/shared";

export type ToolArgumentSummarizer = (args: unknown, inputSchema?: unknown) => ToolArgumentSummary | null;

/** HKDF info for the summary hash key; distinct from every other key derived from the master key. */
export const TOOL_ARGUMENT_HASH_HKDF_INFO = "l2m/tool-argument-summary/v1";

/** Data classes the production-capture scan finds in `text`. */
export const captureDetector: ToolArgumentDetector = (text) => {
  const classes = new Set<string>();
  for (const match of scanForCapture(decodeView(text).text)) classes.add(String(match.dataClass));
  return [...classes];
};

/** The summary hash key: HKDF-SHA-256 of the 32-byte master key. Refuses any other key length. */
export function deriveToolArgumentHashKey(masterKey: Uint8Array): Uint8Array {
  if (masterKey.length !== 32) throw new Error("The tool argument hash key needs the 32-byte master key (SECRET_MASTER_KEY_BASE64).");
  return new Uint8Array(hkdfSync("sha256", masterKey, new Uint8Array(0), TOOL_ARGUMENT_HASH_HKDF_INFO, 32));
}

let processHashKey: Uint8Array | undefined;

/**
 * The deployment's hash key from SECRET_MASTER_KEY_BASE64. A master key that
 * is set but does not decode to 32 bytes is refused, as SecretService refuses
 * it. With no master key at all, one random key per process is used: the API
 * server never gets here (it does not boot without the master key), so this
 * only serves `createApp` built without one, as in tests and library use, and
 * its hashes compare only within that process.
 */
export function toolArgumentHashKey(masterKeyBase64: string | undefined): Uint8Array {
  if (masterKeyBase64 === undefined || masterKeyBase64 === "") {
    processHashKey ??= new Uint8Array(randomBytes(32));
    return processHashKey;
  }
  return deriveToolArgumentHashKey(Buffer.from(masterKeyBase64, "base64"));
}

/**
 * The hash a summary stores for `value` (a string is NFKC-normalised first).
 * Policy suggestions and simulation hash a rule's comparison value with the
 * same key to match it against recorded calls.
 */
export function hashSummaryValue(value: string | number | boolean, hashKey: Uint8Array): string {
  return hashToolArgumentValue(value, hashKey);
}

export function createToolArgumentSummarizer(options: {
  enabled: boolean;
  hashKey: Uint8Array;
  detect?: ToolArgumentDetector;
}): ToolArgumentSummarizer | undefined {
  if (!options.enabled) return undefined;
  const detect = options.detect ?? captureDetector;
  const { hashKey } = options;
  return (args, inputSchema) => {
    try {
      return summarizeToolArguments(args, { detect, hashKey, ...(inputSchema !== undefined ? { inputSchema } : {}) });
    } catch {
      return null;
    }
  };
}
