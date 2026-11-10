/**
 * Events the server sends to notification channels. The settings UI and the dispatcher both read this list, so a
 * channel can only subscribe to a name the server actually emits.
 */
export const NOTIFICATION_EVENT_TYPES = [
  "execution.failure",
  "approval.requested",
  "approval.timed_out",
  "network.break_glass_used",
  "auth.break_glass_used"
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/** Short labels for the settings picker. */
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  "execution.failure": "Workflow failure",
  "approval.requested": "Approval requested",
  "approval.timed_out": "Approval timed out",
  "network.break_glass_used": "Break-glass access used",
  "auth.break_glass_used": "Break-glass sign-in"
};

/** Names an earlier settings UI stored for channels; they map to the names the server emits. */
export const LEGACY_NOTIFICATION_EVENT_ALIASES: Readonly<Record<string, string>> = {
  workflow_failure: "execution.failure",
  workflow_success: "execution.success"
};

/** Maps legacy event names to current ones and drops duplicates; unknown names pass through unchanged. */
export function normalizeNotificationEvents(events: readonly string[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    const name = LEGACY_NOTIFICATION_EVENT_ALIASES[event] ?? event;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
