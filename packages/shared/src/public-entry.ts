import type { WorkflowValidationIssue } from "./types";

/** The validation code of a live trigger anyone who can reach the API can call (a warning; it never blocks a save). */
export const PUBLIC_ENTRY_WARNING_CODE = "public_entry";

type EntryNode = { id: string; type: string; config?: unknown };

function configOf(node: EntryNode): Record<string, unknown> {
  return node.config && typeof node.config === "object" && !Array.isArray(node.config) ? (node.config as Record<string, unknown>) : {};
}

/** The Auth Modes each live trigger knows. Unset is the trigger's default (open, as before); "none" reads as public. */
const KNOWN_AUTH_MODES: Readonly<Record<string, readonly string[]>> = {
  webhook_input: ["none", "bearer_token", "hmac_sha256"],
  form_trigger: ["none", "public", "session"],
  chat_trigger: ["none", "public", "session", "bearer"],
  mcp_server_trigger: ["none", "public", "bearer"]
};

/**
 * A set Auth Mode the trigger does not know (a typo, a padded value, a hand-edited import), or null. Its routes refuse
 * every call for it instead of treating it as public.
 */
export function unknownAuthMode(node: EntryNode): string | null {
  const modes = KNOWN_AUTH_MODES[node.type];
  if (!modes) return null;
  const value = configOf(node).authMode;
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && modes.includes(value) ? null : String(value);
}

/** The error code a trigger with an unknown Auth Mode answers with. */
export const UNKNOWN_AUTH_MODE_CODE = "unknown_auth_mode";

/** What a trigger with an unknown Auth Mode answers, and the editor's warning for it. */
export function unknownAuthModeMessage(mode: string): string {
  return `Auth Mode '${mode.slice(0, 40)}' is not one this trigger knows, so it refuses every call. Pick an Auth Mode in its settings.`;
}

/**
 * The open door a node leaves, or null: a webhook with no token or signature, a public form, an Expose as MCP Tool
 * trigger whose REST route takes no token, or a public chat. (App triggers verify their provider's signature or token
 * and refuse every call until it is set, so none of them is an open door.) Read as the routes read them: anything but a protected
 * mode is open (webhook: `bearer_token` or `hmac_sha256`; form: `session`; MCP trigger: `bearer`; chat: `session` or
 * `bearer`), so unset counts as public. A mode the trigger does not know is refused by its routes (`unknownAuthMode`). A trigger that is switched off (`active: false`) takes no
 * live calls, so it is not one.
 */
export function publicEntryMessage(node: EntryNode): string | null {
  const config = configOf(node);
  if (config.active === false) return null;
  // A mode the trigger does not know refuses every call: not open, but worth saying.
  const unknown = unknownAuthMode(node);
  if (unknown !== null) return unknownAuthModeMessage(unknown);
  const authMode = typeof config.authMode === "string" ? config.authMode : "";
  switch (node.type) {
    case "webhook_input":
      return authMode === "bearer_token" || authMode === "hmac_sha256"
        ? null
        : "Public webhook: anyone who can reach this server can call it. Set Auth Mode to a bearer token or HMAC signature, or turn it off.";
    case "form_trigger":
      return authMode === "session" ? null : "Public form: anyone who can reach this server can open and submit it. Set Auth Mode to Session, or turn it off.";
    case "mcp_server_trigger":
      return authMode === "bearer"
        ? null
        : "Public MCP tool: anyone who can reach this server can call its REST route without a token. Set Auth Mode to Bearer token, or turn it off.";
    case "chat_trigger":
      return authMode === "session" || authMode === "bearer"
        ? null
        : "Public chat: anyone who can reach this server can send it messages. Set Auth Mode to Session or Bearer, or turn it off.";
    default:
      return null;
  }
}

/** One warning per public live trigger in `workflow` (shown after a save). */
export function publicEntryWarnings(workflow: { nodes: readonly EntryNode[] }): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  for (const node of workflow.nodes) {
    const message = publicEntryMessage(node);
    if (message) issues.push({ code: PUBLIC_ENTRY_WARNING_CODE, message, nodeId: node.id, severity: "warning" });
  }
  return issues;
}
