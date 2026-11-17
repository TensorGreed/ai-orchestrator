/**
 * Signs and checks the sensitive values marker (`_meta["com.lsquarem/sensitive-values"]`) the MCP gateway puts on a
 * `restore_sensitive_data` result. The key is derived from the deployment's master key, so only a marker this
 * deployment's gateway made verifies; the workflow engine puts back the tokens such a marker lists, and only masks
 * more for any other marker (see sensitive-results.ts in the engine).
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  SENSITIVE_VALUES_MARKER_VERSION,
  sensitiveValuesSigningPayload,
  type SensitiveValueEntry,
  type SensitiveValuesMarker
} from "@ai-orchestrator/shared";

const SIGNATURE_PREFIX = "v1:";

export interface SensitiveValuesSigner {
  sign(values: readonly SensitiveValueEntry[]): SensitiveValuesMarker;
  verify(marker: SensitiveValuesMarker): boolean;
}

/** Undefined without a 32-byte master key: then no marker is signed and none verifies (every marker only masks more). */
export function createSensitiveValuesSigner(masterKey: Uint8Array): SensitiveValuesSigner | undefined {
  if (masterKey.length !== 32) return undefined;
  const key = Buffer.from(hkdfSync("sha256", masterKey, new Uint8Array(0), "l2m/sensitive-values-marker/v1", 32));
  const mac = (values: readonly SensitiveValueEntry[]) => createHmac("sha256", key).update(sensitiveValuesSigningPayload(values)).digest();
  return {
    sign(values) {
      const copy = values.map((entry) => ({ token: entry.token, value: entry.value }));
      return { v: SENSITIVE_VALUES_MARKER_VERSION, values: copy, sig: `${SIGNATURE_PREFIX}${mac(copy).toString("base64url")}` };
    },
    verify(marker) {
      if (marker.v !== SENSITIVE_VALUES_MARKER_VERSION || typeof marker.sig !== "string" || !marker.sig.startsWith(SIGNATURE_PREFIX)) return false;
      const given = Buffer.from(marker.sig.slice(SIGNATURE_PREFIX.length), "base64url");
      const expected = mac(marker.values);
      return given.length === expected.length && timingSafeEqual(given, expected);
    }
  };
}
