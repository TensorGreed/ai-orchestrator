/** The output a failed node's item and error go to when its On Error is "Execute Fallback Branch" (Try/Catch's catch output uses the same id). */
export const ERROR_OUTPUT_HANDLE = "error";

/**
 * Whether a node shows an Error output: when its On Error is set to the
 * fallback branch, or while an edge still leaves that output. Try/Catch has
 * its own Catch output.
 */
export function showsErrorOutput(nodeType: string, config: Record<string, unknown> | undefined, connected = false): boolean {
  if (nodeType === "try_catch" || nodeType === "sticky_note") return false;
  return config?.onError === "branch" || connected;
}
